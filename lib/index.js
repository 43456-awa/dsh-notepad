// dsh-notepad — host half.
//
// 常驻记事本的宿主办：
// - 双作用域：global（~/.dsh/notepad/notes.md，全部会话共享）与
//   session:<id>（~/.dsh/notepad/scopes/session-<id>/，会话隔离）
// - 便签以纯文本存储（UTF-8 BOM，原子写），各作用域 revision 独立单调递增
// - 每次覆盖写前自动快照到 history/（保留最近 20 份）
// - GET /api/notepad 支持 ?since=<revision> 瘦身轮询（未变则 text 为 null）
// - PUT 带 baseRevision 做乐观锁：外部已修改则 409 返回当前内容与 revision
// - 模型工具 notepad_read / notepad_write（append 按行去重），可按作用域读写
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const name = "dsh-notepad";
// 声明式依赖：加载器保证 webServer 与 tools 服务就绪后才 apply，
// 避免启动时序竞态导致 ctx.get("tools") 为空、工具静默注册失败。
const inject = ["webServer", "tools"];

const HISTORY_LIMIT = 20;
const SCOPE_GLOBAL = "global";
const SCOPE_PREFIX = "session:";

// ---- SSE 推送 ---------------------------------------------------------
const sseClients = new Set();

/** 向所有 SSE 订阅者广播一次变更。 */
function notifySse(key, revision) {
  const payload = `data: ${JSON.stringify({ scope: key, revision, at: new Date().toISOString() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

// ---- 作用域路径 -----------------------------------------------------
function notepadDir() {
  return join(resolveDshHome(), "notepad");
}

/** 归一化作用域键：global，或 session:<安全化 sessionId>。非法输入回落 global。 */
function scopeKeyOf(scope, sessionId) {
  if (scope === "session" && typeof sessionId === "string" && sessionId !== "") {
    return `${SCOPE_PREFIX}${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  }
  return SCOPE_GLOBAL;
}

function scopeDir(key) {
  // global 保持旧路径（兼容既有数据与外部编辑器），会话页进 scopes/s-<id>/
  // 注意：键内 "session:" 的冒号不能进 Windows 目录名，目录段用 "s-" 前缀
  if (key === SCOPE_GLOBAL) return notepadDir();
  return join(notepadDir(), "scopes", `s-${key.slice(SCOPE_PREFIX.length)}`);
}
function notesPathFor(key) {
  return join(scopeDir(key), "notes.md");
}
function metaPathFor(key) {
  return join(scopeDir(key), "meta.json");
}
function historyDirFor(key) {
  return join(scopeDir(key), "history");
}

// ---- 元数据 / 内容读写 ------------------------------------------------
function readMeta(key) {
  try {
    return JSON.parse(readFileSync(metaPathFor(key), "utf8"));
  } catch {
    return { revision: 0 };
  }
}

function writeMeta(key, meta) {
  try {
    writeFileSync(metaPathFor(key), JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // meta 写失败不致命，revision 回退到 0 只会放宽冲突检测
  }
}

function readNotes(key) {
  const p = notesPathFor(key);
  if (!existsSync(p)) return "";
  const raw = readFileSync(p, "utf8");
  // 兼容带/不带 UTF-8 BOM：BOM 用于让 Windows 编辑器正确识别编码，避免 GBK 误读
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

/** 把某作用域的当前内容快照进其 history 目录，并裁剪到 HISTORY_LIMIT 份。 */
function snapshot(key) {
  const text = readNotes(key);
  if (text.trim() === "") return;
  try {
    mkdirSync(historyDirFor(key), { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(historyDirFor(key), `notes-${ts}.md`), text, "utf8");
    const files = readdirSync(historyDirFor(key))
      .filter((f) => /^notes-[\dA-Z-]+\.md$/.test(f))
      .sort();
    while (files.length > HISTORY_LIMIT) {
      try { unlinkSync(join(historyDirFor(key), files.shift())); } catch {}
    }
  } catch {}
}

/**
 * 写入某作用域便签。baseRevision 为客户端最后见到的版本；服务端已前进且未 force
 * 时返回冲突（当前文本与版本），不落盘。返回 { conflict, revision, text? }。
 */
function writeNotes(text, key, baseRevision, force) {
  const meta = readMeta(key);
  if (baseRevision !== void 0 && baseRevision !== null && force !== true && baseRevision < meta.revision) {
    return { conflict: true, revision: meta.revision, text: readNotes(key) };
  }
  const prev = readNotes(key);
  if (prev !== text) snapshot(key);
  try {
    mkdirSync(scopeDir(key), { recursive: true });
    const tmp = `${notesPathFor(key)}.tmp`;
    const body = text.charCodeAt(0) === 0xFEFF ? text : `\uFEFF${text}`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, notesPathFor(key));
  } catch (error) {
    throw error;
  }
  const revision = meta.revision + 1;
  writeMeta(key, { revision, updatedAt: new Date().toISOString() });
  notifySse(key, revision);
  return { conflict: false, revision };
}

// ---- HTTP 工具 --------------------------------------------------------
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return null; // 非法 JSON
  }
}

function listHistory(key) {
  try {
    if (!existsSync(historyDirFor(key))) return [];
    return readdirSync(historyDirFor(key))
      .filter((f) => /^notes-[\dA-Z-]+\.md$/.test(f))
      .sort()
      .reverse()
      .map((f) => ({ id: f, time: f.replace(/^notes-/, "").replace(/\.md$/, "") }));
  } catch {
    return [];
  }
}

function readHistory(key, id) {
  if (!/^notes-[\dA-Z-]+\.md$/.test(id)) return null;
  const p = join(historyDirFor(key), id);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

/** 列出所有会话隔离页的会话 id（供 Agent 工具提示可用作用域）。 */
function listSessionScopes() {
  try {
    const base = join(notepadDir(), "scopes");
    if (!existsSync(base)) return [];
    return readdirSync(base)
      .filter((d) => d.startsWith("s-"))
      .map((d) => d.slice(2))
      .sort();
  } catch {
    return [];
  }
}

// ---- 插件主体 ----------------------------------------------------------
function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/api/notepad",
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const path = url.pathname;
        const qScope = url.searchParams.get("scope");
        const qSession = url.searchParams.get("sessionId");

        // 历史列表 / 单份历史（作用域来自 query）
        if (path === "/api/notepad/history" && req.method === "GET") {
          const key = scopeKeyOf(qScope, qSession);
          json(res, 200, { ok: true, items: listHistory(key) });
          return;
        }
        const histMatch = /^\/api\/notepad\/history\/([^/]+)$/.exec(path);
        if (histMatch !== null && req.method === "GET") {
          const key = scopeKeyOf(qScope, qSession);
          const id = decodeURIComponent(histMatch[1]);
          const text = readHistory(key, id);
          if (text === null) {
            json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "history entry not found" } });
            return;
          }
          json(res, 200, { ok: true, id, text });
          return;
        }

        // SSE 推送流（所有作用域的变更都会广播，客户端按 scope 过滤）
        if (path === "/api/notepad/stream" && req.method === "GET") {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive"
          });
          res.write("retry: 3000\n\n");
          sseClients.add(res);
          const keepalive = setInterval(() => {
            try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
          }, 25000);
          req.on("close", () => {
            clearInterval(keepalive);
            sseClients.delete(res);
          });
          return;
        }

        if (path !== "/api/notepad") {
          json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "unknown endpoint" } });
          return;
        }

        if (req.method === "GET") {
          const key = scopeKeyOf(qScope, qSession);
          const sinceRaw = url.searchParams.get("since");
          const since = sinceRaw === null ? NaN : Number(sinceRaw);
          const meta = readMeta(key);
          if (Number.isFinite(since) && since === meta.revision) {
            json(res, 200, { ok: true, text: null, revision: meta.revision });
            return;
          }
          json(res, 200, { ok: true, text: readNotes(key), revision: meta.revision });
          return;
        }

        if (req.method === "PUT") {
          const body = await readBody(req);
          if (body === null) {
            json(res, 400, { ok: false, error: { code: "INVALID", message: "invalid JSON body" } });
            return;
          }
          if (typeof body.text !== "string") {
            json(res, 400, { ok: false, error: { code: "INVALID", message: "text (string) required" } });
            return;
          }
          const key = scopeKeyOf(body.scope, body.sessionId);
          const result = writeNotes(body.text, key, body.baseRevision, body.force === true);
          if (result.conflict) {
            json(res, 409, {
              ok: false,
              error: { code: "VERSION_CONFLICT", message: "notepad changed elsewhere" },
              revision: result.revision,
              text: result.text
            });
            return;
          }
          json(res, 200, { ok: true, revision: result.revision });
          return;
        }

        json(res, 405, { ok: false, error: { code: "METHOD", message: "GET or PUT only" } });
      } catch (error) {
        ctx.logger.error(error);
        json(res, 500, { ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } });
      }
    }
  }));

  const tools = ctx.get("tools");
  if (tools === void 0) return;

  /** 从工具执行上下文取当前会话 id（exec.agent.session）。 */
  function currentSessionId(exec) {
    try {
      const s = exec && exec.agent && exec.agent.session;
      if (s && typeof s.id === "string" && s.id !== "") return s.id;
    } catch {}
    return void 0;
  }

  /**
  * 工具侧作用域解析：
  * - 显式 scope=global → 全局页
  * - 显式 scope=session → 当前会话页（sessionId 可省略，自动用当前会话）
  * - 未指定 scope → 默认当前会话页（无会话上下文时回落全局页）
  */
  function resolveToolScope(args, exec) {
    const sessionId = args.sessionId ?? currentSessionId(exec);
    if (args.scope === "session" && (sessionId === void 0 || sessionId === "")) {
      const pages = listSessionScopes();
      const hint = pages.length === 0
        ? "（目前没有任何会话隔离页）"
        : `现有会话页：${pages.map((p) => `"${p}"`).join(", ")}`;
      throw new Error(`当前执行没有可用的会话上下文（无法确定 sessionId）。${hint}`);
    }
    if (args.scope === "session") {
      return `${SCOPE_PREFIX}${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}`;
    }
    if (args.scope === "global") return SCOPE_GLOBAL;
    // 未指定：默认当前会话页，无会话上下文回落全局
    if (sessionId !== void 0 && sessionId !== "") {
      return `${SCOPE_PREFIX}${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}`;
    }
    return SCOPE_GLOBAL;
  }

  tools.register(defineTool({
    name: "notepad_read",
    description: "读取钉在 dsh Web GUI 右侧的常驻记事本内容（用户便签，纯文本，存于 ~/.dsh/notepad/）。默认读取当前会话的隔离记事本页；scope=global 读取全局页（所有会话共享）；scope=session 可指定 sessionId 读取指定会话页。",
    parameters: {
      scope: { type: "string", description: "作用域：global（全部会话共享的全局页）或 session（会话隔离页，默认当前会话）" },
      sessionId: { type: "string", description: "scope=session 时可选：目标会话 id；省略则用当前会话" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const key = resolveToolScope(args ?? {}, exec);
      const text = readNotes(key);
      return text.trim() === "" ? `（${key} 记事本为空）` : text;
    }
  }));
  tools.register(defineTool({
    name: "notepad_write",
    description: "写入/追加常驻记事本（钉在 dsh Web GUI 右侧的便签，存于 ~/.dsh/notepad/）。默认写入当前会话的隔离记事本页（Agent 各会话工作记忆互不干扰）；scope=global 写入全局页。mode=replace 覆盖全文；mode=append 在末尾追加且按行去重。timestamp=true 时给每行加 [MM-DD HH:mm] 前缀。",
    parameters: {
      text: { type: "string", required: true, description: "要写入的便签内容（可多行）" },
      mode: { type: "string", description: "replace（默认，覆盖全文）或 append（末尾追加，按行去重）" },
      timestamp: { type: "string", description: "true 时给写入的每一行加 [MM-DD HH:mm] 时间戳前缀（默认 false）" },
      scope: { type: "string", description: "作用域：session（默认，当前会话隔离页）或 global（全部会话共享）" },
      sessionId: { type: "string", description: "scope=session 时可选：目标会话 id；省略则用当前会话" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const key = resolveToolScope(args, exec);
      const current = readNotes(key);
      let incoming = String(args.text ?? "");
      if (args.timestamp === "true" || args.timestamp === true) {
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const stamp = `[${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}]`;
        incoming = incoming.split("\n").map((l) => (l.trim() === "" ? l : `${stamp} ${l}`)).join("\n");
      }
      if (args.mode === "append") {
        const lines = incoming.split("\n");
        const existing = new Set(current.split("\n").map((l) => l.trim()));
        const fresh = lines.filter((l) => l.trim() !== "" && !existing.has(l.trim()));
        if (fresh.length === 0) return "内容已存在于记事本，未重复追加。";
        const text = current.trim() === "" ? fresh.join("\n") : `${current}\n${fresh.join("\n")}`;
        writeNotes(text, key, void 0, false);
        return `已追加 ${fresh.length} 行，跳过 ${lines.length - fresh.length} 行重复（${key}）。`;
      }
      writeNotes(incoming, key, void 0, false);
      return `已写入记事本（${key}）。`;
    }
  }));
  tools.register(defineTool({
    name: "notepad_search",
    description: "在记事本中按关键词搜索（不区分大小写子串匹配）。默认搜索全局页 + 所有会话隔离页；scope=session 时只搜指定会话页（省略 sessionId 用当前会话）。返回匹配行、所在页与行号。",
    parameters: {
      query: { type: "string", required: true, description: "搜索关键词" },
      scope: { type: "string", description: "限定作用域：global 或 session（省略则搜全部页）" },
      sessionId: { type: "string", description: "scope=session 时可选：目标会话 id；省略则用当前会话" },
      limit: { type: "string", description: "最多返回行数（默认 20）" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const q = String(args.query ?? "").trim().toLowerCase();
      if (q === "") return "搜索关键词不能为空。";
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 20;
      const targets = [];
      if (args.scope === "session" || args.scope === "global") {
        const key = resolveToolScope({ ...args, scope: "session" }, exec);
        targets.push(key);
      } else {
        targets.push(SCOPE_GLOBAL);
        for (const id of listSessionScopes()) targets.push(`${SCOPE_PREFIX}${id}`);
      }
      const hits = [];
      for (const key of targets) {
        const text = readNotes(key);
        if (text.trim() === "") continue;
        text.split("\n").forEach((line, i) => {
          if (line.toLowerCase().includes(q)) hits.push({ key, line: i + 1, text: line.trim() });
        });
      }
      if (hits.length === 0) return `未找到包含「${args.query}」的内容。`;
      const shown = hits.slice(0, limit);
      const lines = shown.map((hit) => {
        const page = hit.key === SCOPE_GLOBAL ? "全局" : `会话:${hit.key.slice(SCOPE_PREFIX.length).slice(0, 12)}`;
        return `[${page}] L${hit.line} ${hit.text.slice(0, 120)}`;
      });
      const more = hits.length - shown.length;
      return `共 ${hits.length} 处匹配：\n${lines.join("\n")}${more > 0 ? `\n（还有 ${more} 处，可增大 limit）` : ""}`;
    }
  }));
}

export { apply, inject, name };
