// dsh-notepad — browser half.
//
// 钉在 dsh Web GUI 的常驻记事本（可拖动、可固定）：
// - 双作用域：全局页 + 本会话隔离页；可切换（single）或分屏同看（split）
// - 输入防抖自动保存 + 乐观锁冲突（合并/覆盖）；保存失败自动排队重试；
//   刷新后检测到未保存的本地内容时提示「恢复/丢弃」
// - SSE 实时推送（/api/notepad/stream）+ 30s 轮询兜底
// - Markdown 预览（安全渲染，勾选框可点击切换）；完成率统计；时间戳插入；
//   全文搜索（跳转到行）；历史快照恢复；复制/下载导出
// - 快捷键：Ctrl+Enter 立即保存，Esc 收起
// 样式只用 --dsw-* 主题 token，跟随明暗主题。

window.__ModuleLoader__.load({
	id: "dsh-notepad",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		const { useState, useEffect, useRef, useCallback } = react;
		const h = react.createElement;

		const API_PATH = "/api/notepad";
		const LS_OPEN_KEY = "dsh-notepad:open";
		const LS_WIDTH_KEY = "dsh-notepad:width";
		const LS_PIN_KEY = "dsh-notepad:pin";
		const SCOPE_PREFIX = "session:";
		const SAVE_DEBOUNCE_MS = 800;
		const POLL_FALLBACK_MS = 30000;
		const MIN_WIDTH = 220;
		const MAX_WIDTH = 480;
		const NARROW_MQ = "(max-width: 1199px)";

		// ---- 工具函数 ---------------------------------------------------
		function cacheKey(key) {
			return `dsh-notepad:cache:${key}`;
		}
		function pendingKey(key) {
			return `dsh-notepad:pending:${key}`;
		}
		function panelHeight() {
			return Math.max(240, Math.round(window.innerHeight * 0.56));
		}
		function clamp(v, min, max) {
			return Math.min(max, Math.max(min, v));
		}
		function fmtShort(d) {
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		}
		function formatTime(d) {
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
		}

		/** 位置以"到边缘的距离"锚定存储：窗口缩放跟随所锚边缘，放大后归位。 */
		function absToAnchor(x, y, width) {
			const ph = panelHeight();
			const rightOff = window.innerWidth - x - width;
			const leftOff = x;
			const hk = rightOff < leftOff ? "right" : "left";
			const ho = hk === "right" ? rightOff : leftOff;
			const bottomOff = window.innerHeight - y - ph;
			const topOff = y;
			const vk = bottomOff < topOff ? "bottom" : "top";
			const vo = vk === "bottom" ? bottomOff : topOff;
			return { h: hk, ho, v: vk, vo };
		}
		function anchorToAbs(anchor, width) {
			const ph = panelHeight();
			const x = anchor.h === "right" ? window.innerWidth - width - anchor.ho : anchor.ho;
			const y = anchor.v === "bottom" ? window.innerHeight - ph - anchor.vo : anchor.vo;
			return { x, y };
		}
		function renderOrigin(pin, width) {
			const abs = anchorToAbs(pin.anchor, width);
			return {
				left: clamp(abs.x, 0, Math.max(0, window.innerWidth - width)),
				top: clamp(abs.y, 0, Math.max(0, window.innerHeight - panelHeight()))
			};
		}

		/** 给 URL 追加作用域参数。 */
		function queryUrl(base, key) {
			const sep = base.includes("?") ? "&" : "?";
			if (key === "global") return `${base}${sep}scope=global`;
			return `${base}${sep}scope=session&sessionId=${encodeURIComponent(key.slice(SCOPE_PREFIX.length))}`;
		}

		/** PUT 核心（作用域感知，乐观锁）。 */
		async function apiPut(value, key, baseRev, force) {
			const payload = { text: value, baseRevision: baseRev, force: force === true, scope: "global" };
			if (key !== "global") {
				payload.scope = "session";
				payload.sessionId = key.slice(SCOPE_PREFIX.length);
			}
			const res = await fetch(API_PATH, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			let body = null;
			try { body = await res.json(); } catch {}
			if (res.status === 409 && body && body.ok === false) {
				return { conflict: true, serverText: body.text ?? "", serverRevision: body.revision ?? null };
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return { conflict: false, revision: body && typeof body.revision === "number" ? body.revision : null };
		}

		/** 行级并集合并：保留服务端全部行，追加草稿中新增的行（去重）。 */
		function mergeTexts(serverText, draftText) {
			const serverLines = String(serverText).split("\n");
			const seen = new Set(serverLines);
			const extra = [];
			for (const line of String(draftText).split("\n")) {
				if (!seen.has(line)) {
					seen.add(line);
					extra.push(line);
				}
			}
			return [...serverLines, ...extra].join("\n");
		}

		/** 历史 id → 本地时间 "MM-DD HH:mm" */
		function parseHistoryTime(id) {
			const t = String(id).replace(/^notes-/, "").replace(/\.md$/, "");
			const parts = t.split("T");
			if (parts.length < 2) return t;
			const [hh, mm, ss, msZ] = parts[1].split("-");
			if (!msZ) return t;
			const d = new Date(`${parts[0]}T${hh}:${mm}:${ss}.${msZ}`);
			if (Number.isNaN(d.getTime())) return t;
			return fmtShort(d);
		}

		/** 勾选统计：{ done, total }（匹配 "- [x]" / "- [ ]" 行）。 */
		function checkboxStats(text) {
			let done = 0;
			let total = 0;
			for (const line of String(text).split("\n")) {
				const m = /^[-*]\s+\[( |x|X)\]/.exec(line);
				if (m) {
					total += 1;
					if (m[1] !== " ") done += 1;
				}
			}
			return { done, total };
		}

		// ---- 安全 Markdown 渲染（所有内容经 createTextNode，杜绝 XSS）----
		const codeStyle = {
			fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
			fontSize: 12,
			background: "var(--dsw-alias-interactive-bg-hover)",
			borderRadius: 4,
			padding: "0 3px"
		};
		const linkStyle = { color: "var(--dsw-alias-brand-primary, #4f8cff)", textDecoration: "none" };
		const preStyle = {
			margin: "4px 0",
			padding: "8px 10px",
			background: "var(--dsw-alias-interactive-bg-hover)",
			borderRadius: 8,
			overflowX: "auto"
		};

		function mdInline(text) {
			const out = [];
			const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
			let last = 0;
			let m;
			const pushText = (s) => { if (s) out.push(s); };
			while ((m = re.exec(text)) !== null) {
				pushText(text.slice(last, m.index));
				const tok = m[0];
				if (tok.startsWith("**")) out.push(h("strong", { key: m.index }, tok.slice(2, -2)));
				else if (tok.startsWith("`")) out.push(h("code", { key: m.index, style: codeStyle }, tok.slice(1, -1)));
				else {
					const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
					if (mm) out.push(h("a", { key: m.index, href: mm[2], target: "_blank", rel: "noreferrer", style: linkStyle }, mm[1]));
					else pushText(tok);
				}
			}
			pushText(text.slice(last));
			return out;
		}

		function cbBoxStyle(checked) {
			return {
				flex: "none",
				width: 13,
				height: 13,
				marginTop: 3,
				borderRadius: 3,
				boxSizing: "border-box",
				border: "1.5px solid var(--dsw-alias-label-secondary)",
				background: checked ? "var(--dsw-alias-state-success-primary)" : "transparent",
				color: "var(--dsw-alias-bg-overlay)",
				fontSize: 10,
				lineHeight: "10px",
				textAlign: "center",
				cursor: "pointer",
				userSelect: "none",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center"
			};
		}

		function renderMarkdown(text, onToggleCheck) {
			const lines = String(text).split("\n");
			const els = [];
			let inCode = false;
			let codeBuf = [];
			const flushCode = () => {
				if (codeBuf.length > 0) {
					els.push(h("pre", { key: `pre-${els.length}`, style: preStyle },
						h("code", { style: { ...codeStyle, background: "transparent", padding: 0 } }, codeBuf.join("\n"))));
					codeBuf = [];
				}
			};
			lines.forEach((line, i) => {
				const t = line.trim();
				if (t.startsWith("```")) {
					if (inCode) { inCode = false; flushCode(); }
					else { flushCode(); inCode = true; }
					return;
				}
				if (inCode) { codeBuf.push(line); return; }
				if (!t) { els.push(h("div", { key: i, style: { height: 8 } })); return; }
				const heading = /^(#{1,6})\s+(.*)$/.exec(line);
				if (heading) {
					const lvl = heading[1].length;
					const size = lvl === 1 ? 16 : lvl === 2 ? 14 : 13;
					els.push(h(`h${lvl}`, { key: i, style: { margin: "6px 0 2px", fontSize: size, fontWeight: 700 } },
						...mdInline(heading[2])));
					return;
				}
				if (/^-{3,}$/.test(t)) { els.push(h("hr", { key: i, style: { border: 0, borderTop: "1px solid var(--dsw-alias-border-l1)", margin: "6px 0" } })); return; }
				if (t.startsWith("> ")) {
					els.push(h("blockquote", { key: i, style: { margin: "2px 0", padding: "2px 8px", borderLeft: "3px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)" } },
						...mdInline(line.replace(/^>\s*/, ""))));
					return;
				}
				const cb = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
				if (cb) {
					const checked = cb[1] !== " ";
					els.push(h("div", { key: i, style: { display: "flex", gap: 6, padding: "1px 0" } },
						h("span", {
							role: "checkbox",
							"aria-checked": checked,
							tabIndex: 0,
							title: "点击切换勾选并保存",
							style: cbBoxStyle(checked),
							onClick: () => onToggleCheck(i),
							onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleCheck(i); } }
						}, checked ? "✓" : ""),
						h("span", { style: checked ? { textDecoration: "line-through", color: "var(--dsw-alias-label-secondary)" } : void 0 },
							...mdInline(cb[2]))));
					return;
				}
				if (/^[-*]\s+/.test(line)) {
					els.push(h("div", { key: i, style: { display: "flex", gap: 6, padding: "1px 0" } },
						h("span", { style: { flex: "none", color: "var(--dsw-alias-label-secondary)" } }, "•"),
						h("span", null, ...mdInline(line.replace(/^[-*]\s+/, "")))));
					return;
				}
				els.push(h("p", { key: i, style: { margin: "2px 0" } }, ...mdInline(line)));
			});
			flushCode();
			return els;
		}

		// ---- 样式 -------------------------------------------------------
		const panel = {
			position: "absolute",
			zIndex: 20,
			boxSizing: "border-box",
			height: "56vh",
			minHeight: 240,
			display: "flex",
			flexDirection: "column",
			borderRadius: 12,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 8px 32px rgba(0, 0, 0, 0.18)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			overflow: "visible",
			pointerEvents: "auto"
		};

		const header = {
			display: "flex",
			alignItems: "center",
			gap: 4,
			padding: "8px 10px",
			borderBottom: "1px solid var(--dsw-alias-border-l1)",
			flex: "none"
		};

		const iconBtn = {
			flex: "none",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 22,
			height: 22,
			border: 0,
			borderRadius: 6,
			padding: 0,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer"
		};

		const modeBtn = {
			flex: "none",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			height: 20,
			border: 0,
			borderRadius: 6,
			padding: "0 6px",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer",
			fontSize: 11
		};

		const modeActive = {
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-primary)"
		};

		const textarea = {
			flex: 1,
			minHeight: 0,
			boxSizing: "border-box",
			width: "100%",
			padding: "8px 12px",
			border: 0,
			outline: "none",
			resize: "none",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			fontFamily: "inherit",
			fontSize: 13,
			lineHeight: "20px"
		};

		const preview = {
			flex: 1,
			minHeight: 0,
			overflowY: "auto",
			padding: "8px 12px 12px",
			fontSize: 13,
			lineHeight: "20px",
			wordBreak: "break-word"
		};

		const paneFooter = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			padding: "3px 10px",
			borderTop: "1px solid var(--dsw-alias-border-l1)",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 10,
			lineHeight: "14px",
			flex: "none"
		};

		const paneSpacer = { flex: 1 };

		const paneLabel = {
			flex: "none",
			padding: "2px 10px",
			fontSize: 10,
			lineHeight: "14px",
			color: "var(--dsw-alias-label-secondary)",
			borderBottom: "1px solid var(--dsw-alias-border-l1)",
			cursor: "pointer",
			userSelect: "none"
		};

		const conflictRow = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			padding: "5px 10px",
			borderTop: "1px solid var(--dsw-alias-state-warning-primary, #d97706)",
			background: "color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d97706) 10%, transparent)",
			color: "var(--dsw-alias-state-warning-primary, #d97706)",
			fontSize: 11,
			lineHeight: "16px",
			flex: "none"
		};

		const conflictBtn = {
			flex: "none",
			border: 0,
			borderRadius: 6,
			padding: "2px 8px",
			cursor: "pointer",
			fontSize: 11,
			lineHeight: "16px",
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-primary)"
		};

		const restoreBar = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			padding: "5px 10px",
			borderTop: "1px solid var(--dsw-alias-border-l1)",
			background: "color-mix(in srgb, var(--dsw-alias-state-info-primary, #4f8cff) 8%, transparent)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 11,
			lineHeight: "16px",
			flex: "none"
		};

		const tab = {
			position: "absolute",
			right: 0,
			top: "50%",
			transform: "translateY(-50%)",
			zIndex: 20,
			writingMode: "vertical-rl",
			textOrientation: "mixed",
			boxSizing: "border-box",
			padding: "10px 6px",
			borderRadius: "10px 0 0 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRight: "none",
			background: "var(--dsw-alias-bg-overlay)",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			fontWeight: 600,
			letterSpacing: 2,
			cursor: "pointer",
			userSelect: "none",
			pointerEvents: "auto"
		};

		const dragHandle = {
			position: "absolute",
			left: -5,
			top: 0,
			bottom: 0,
			width: 10,
			cursor: "ew-resize",
			zIndex: 5
		};

		const pop = {
			position: "absolute",
			top: 34,
			left: 0,
			right: 0,
			zIndex: 30,
			maxHeight: "55%",
			overflowY: "auto",
			borderRadius: "0 0 10px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderTop: "none",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)"
		};

		const popItem = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			width: "100%",
			border: 0,
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			padding: "6px 12px",
			cursor: "pointer",
			fontSize: 11,
			textAlign: "left"
		};

		const searchInput = {
			flex: 1,
			boxSizing: "border-box",
			width: "100%",
			padding: "6px 10px",
			border: 0,
			outline: "none",
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-primary)",
			borderRadius: 6,
			fontSize: 12,
			fontFamily: "inherit"
		};

		const divider = {
			flex: "none",
			height: 1,
			background: "var(--dsw-alias-border-l1)"
		};

		// ---- 编辑器面板（单作用域） -------------------------------------
		function EditorPane(props) {
			const { scopeKey, style, placeholder, previewMode, label, onActivate, apiRef } = props;

			const [text, setText] = useState("");
			const [loaded, setLoaded] = useState(false);
			const [phase, setPhase] = useState("idle"); // idle | saving | saved | error | conflict | draft
			const [savedAt, setSavedAt] = useState(null);
			const [conflict, setConflict] = useState(null); // { serverText, serverRevision }
			const [restoreOffer, setRestoreOffer] = useState(false);

			const dirty = useRef(false);
			const textRef = useRef("");
			const revisionRef = useRef(0);
			const timer = useRef(null);
			const pendingRef = useRef(null); // 保存失败待重试的内容
			const taRef = useRef(null);
			const keyRef = useRef(scopeKey);
			useEffect(() => { keyRef.current = scopeKey; }, [scopeKey]);
			useEffect(() => { textRef.current = text; }, [text]);

			// 加载
			useEffect(() => {
				let cancelled = false;
				const key = scopeKey;
				(async () => {
					let text0 = null;
					let fromCache = false;
					try {
						const res = await fetch(queryUrl(API_PATH, key), { cache: "no-store" });
						const body = await res.json();
						if (body && body.ok === true && typeof body.text === "string") {
							text0 = body.text;
							revisionRef.current = body.revision ?? 0;
						}
					} catch {}
					if (cancelled) return;
					if (text0 === null) {
						fromCache = true;
						try { text0 = localStorage.getItem(cacheKey(key)) ?? ""; } catch { text0 = ""; }
					}
					setText(text0);
					setLoaded(true);
					let pend = false;
					try { pend = localStorage.getItem(pendingKey(key)) === "1"; } catch {}
					if (pend && !fromCache) setRestoreOffer(true);
					setPhase(fromCache ? "error" : "idle");
				})();
				return () => { cancelled = true; };
			}, [scopeKey]);

			const saveNow = useCallback(async (value) => {
				const key = keyRef.current;
				setPhase("saving");
				try {
					const result = await apiPut(value, key, revisionRef.current ?? 0, false);
					if (result.conflict) {
						setConflict({ serverText: result.serverText, serverRevision: result.serverRevision });
						setPhase("conflict");
						return;
					}
					dirty.current = false;
					pendingRef.current = null;
					try { localStorage.removeItem(pendingKey(key)); } catch {}
					if (result.revision !== null) revisionRef.current = result.revision;
					setPhase("saved");
					setSavedAt(new Date());
				} catch (error) {
					// 离线：挂起等待自动重试
					pendingRef.current = value;
					try { localStorage.setItem(pendingKey(key), "1"); } catch {}
					setPhase("error");
				}
			}, []);

			const refreshFromServer = useCallback(async () => {
				const key = keyRef.current;
				if (dirty.current || pendingRef.current !== null) return;
				try {
					const res = await fetch(queryUrl(API_PATH, key), { cache: "no-store" });
					const body = await res.json();
					if (!body || body.ok !== true || typeof body.text !== "string") return;
					revisionRef.current = body.revision ?? revisionRef.current;
					if (body.text !== textRef.current) {
						textRef.current = body.text;
						setText(body.text);
						try { localStorage.setItem(cacheKey(key), body.text); } catch {}
						setPhase("saved");
						setSavedAt(new Date());
					}
				} catch {}
			}, []);

			// SSE 实时推送（按 scope 过滤）
			useEffect(() => {
				let closed = false;
				let es = null;
				try {
					es = new EventSource(`${API_PATH}/stream`);
					es.onmessage = (ev) => {
						if (closed) return;
						let m = null;
						try { m = JSON.parse(ev.data); } catch {}
						if (!m || typeof m.scope !== "string" || m.scope !== scopeKey) return;
						if (typeof m.revision === "number" && m.revision > (revisionRef.current ?? -1)) refreshFromServer();
					};
				} catch {}
				return () => { closed = true; if (es) es.close(); };
			}, [scopeKey, refreshFromServer]);

			// 轮询兜底（30s）+ 未保存自动重试
			useEffect(() => {
				let cancelled = false;
				const key = scopeKey;
				const tick = async () => {
					if (cancelled) return;
					if (pendingRef.current !== null) {
						await saveNow(pendingRef.current);
						return;
					}
					if (dirty.current) return;
					try {
						const since = revisionRef.current ?? 0;
						const res = await fetch(queryUrl(`${API_PATH}?since=${since}`, key), { cache: "no-store" });
						const body = await res.json();
						if (cancelled || !body || body.ok !== true) return;
						if (body.text === null) return;
						if (typeof body.text !== "string") return;
						revisionRef.current = body.revision ?? revisionRef.current;
						if (body.text !== textRef.current) {
							textRef.current = body.text;
							setText(body.text);
							try { localStorage.setItem(cacheKey(key), body.text); } catch {}
							setPhase("saved");
							setSavedAt(new Date());
						}
					} catch {}
				};
				const timerId = setInterval(tick, POLL_FALLBACK_MS);
				return () => { cancelled = true; clearInterval(timerId); };
			}, [scopeKey, saveNow]);

			const handleChange = (value) => {
				const key = keyRef.current;
				setText(value);
				try { localStorage.setItem(cacheKey(key), value); } catch {}
				dirty.current = true;
				setPhase("idle");
				if (timer.current !== null) clearTimeout(timer.current);
				timer.current = setTimeout(() => {
					if (dirty.current) saveNow(value);
				}, SAVE_DEBOUNCE_MS);
			};

			const resolveConflict = async (mode) => {
				if (!conflict) return;
				const key = keyRef.current;
				const draft = textRef.current;
				let value = draft;
				let force = false;
				if (mode === "merge") {
					value = mergeTexts(conflict.serverText, draft);
					setText(value);
					try { localStorage.setItem(cacheKey(key), value); } catch {}
				} else {
					force = true;
				}
				setConflict(null);
				setPhase("saving");
				try {
					const result = await apiPut(value, key, conflict.serverRevision, force);
					if (result.conflict) {
						setConflict({ serverText: result.serverText, serverRevision: result.serverRevision });
						setPhase("conflict");
						return;
					}
					dirty.current = false;
					pendingRef.current = null;
					try { localStorage.removeItem(pendingKey(key)); } catch {}
					if (result.revision !== null) revisionRef.current = result.revision;
					setPhase("saved");
					setSavedAt(new Date());
				} catch {
					setPhase("error");
				}
			};

			const acceptRestore = () => {
				try {
					const c = localStorage.getItem(cacheKey(keyRef.current));
					if (c !== null) {
						setText(c);
						dirty.current = true;
						pendingRef.current = c;
						saveNow(c);
					}
				} catch {}
				setRestoreOffer(false);
			};

			const discardRestore = () => {
				try {
					localStorage.removeItem(pendingKey(keyRef.current));
					localStorage.removeItem(cacheKey(keyRef.current));
				} catch {}
				pendingRef.current = null;
				setRestoreOffer(false);
				setPhase("idle");
			};

			const toggleCheck = (lineIndex) => {
				const lines = textRef.current.split("\n");
				if (lineIndex < 0 || lineIndex >= lines.length) return;
				const line = lines[lineIndex];
				const m = /^(\s*[-*]\s+\[)( |x|X)(\]\s*.*)$/.exec(line);
				if (!m) return;
				const checked = m[2] !== " ";
				lines[lineIndex] = `${m[1]}${checked ? " " : "x"}${m[3]}`;
				handleChange(lines.join("\n"));
			};

			// 暴露给外层（时间戳/强制保存/跳行/取文本/载入历史）
			useEffect(() => {
				if (apiRef) {
					apiRef.current = {
						scopeKey,
						getText: () => textRef.current,
						insertTimestamp: () => {
							const ta = taRef.current;
							if (!ta) return;
							const stamp = `[${fmtShort(new Date())}] `;
							const start = ta.selectionStart ?? textRef.current.length;
							const end = ta.selectionEnd ?? start;
							const next = textRef.current.slice(0, start) + stamp + textRef.current.slice(end);
							handleChange(next);
							requestAnimationFrame(() => {
								try { ta.focus(); ta.setSelectionRange(start + stamp.length, start + stamp.length); } catch {}
							});
						},
						forceSave: () => {
							if (timer.current !== null) clearTimeout(timer.current);
							if (dirty.current || pendingRef.current !== null) saveNow(textRef.current);
						},
						clearAll: () => {
							if (timer.current !== null) clearTimeout(timer.current);
							dirty.current = true;
							handleChange("");
							saveNow("");
						},
						applyHistory: (value) => {
							setText(value);
							setPhase("draft");
						},
						scrollToLine: (lineIdx) => {
							const ta = taRef.current;
							if (!ta) return;
							const lines = textRef.current.split("\n");
							const start = lines.slice(0, lineIdx).join("\n").length + (lineIdx > 0 ? 1 : 0);
							const end = start + (lines[lineIdx] ?? "").length;
							const total = textRef.current.length || 1;
							ta.scrollTop = (start / total) * (ta.scrollHeight - ta.clientHeight);
							ta.setSelectionRange(start, end);
							ta.focus();
						}
					};
				}
			});

			const stats = checkboxStats(text);
			const statusText =
				phase === "saving" ? "保存中…" :
				phase === "saved" && savedAt ? `已保存 ${formatTime(savedAt)}` :
				phase === "error" ? "保存失败，自动重试中…" :
				phase === "conflict" ? "检测到外部修改" :
				phase === "draft" ? "已载入历史版本（未保存）" :
				loaded ? "输入中…" : "加载中…";

			return h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, ...style } },
				label ? h("div", { style: paneLabel, onClick: onActivate, title: "点击切换到此页" }, label) : null,
				previewMode
					? h("div", { style: preview }, renderMarkdown(text, toggleCheck))
					: h("textarea", {
						ref: taRef,
						style: textarea,
						placeholder,
						value: text,
						onChange: (e) => handleChange(e.target.value),
						spellCheck: false
					}),
				restoreOffer ? h("div", { style: restoreBar },
					h("span", { style: { flex: 1 } }, "📥 检测到未保存的本地内容"),
					h("button", { type: "button", style: conflictBtn, onClick: acceptRestore }, "恢复"),
					h("button", { type: "button", style: conflictBtn, onClick: discardRestore }, "丢弃")
				) : null,
				phase === "conflict" ? h("div", { style: conflictRow },
					h("span", { style: { flex: 1 } }, "⚠ 已被其他窗口/Agent 修改"),
					h("button", { type: "button", style: conflictBtn, title: "保留双方内容（按行去重）", onClick: () => resolveConflict("merge") }, "合并"),
					h("button", { type: "button", style: conflictBtn, onClick: () => resolveConflict("overwrite") }, "覆盖")
				) : null,
				h("div", { style: paneFooter },
					h("span", null, statusText),
					h("span", { style: paneSpacer }),
					stats.total > 0 ? h("span", null, `☑ ${stats.done}/${stats.total}`) : null,
					h("span", null, `${text.length} 字`)
				)
			);
		}

		// ---- 外层面板 ---------------------------------------------------
		function NotepadPanel(props) {
			const useSessions = props && typeof props.useSessions === "function" ? props.useSessions : void 0;
			const currentSessionId = useSessions ? useSessions((s) => s.current) : void 0;

			const [scope, setScope] = useState("global"); // global | session
			const [viewMode, setViewMode] = useState("single"); // single | split
			const [open, setOpen] = useState(true);
			const [width, setWidth] = useState(280);
			const [editMode, setEditMode] = useState(true);
			const [searchOpen, setSearchOpen] = useState(false);
			const [searchQuery, setSearchQuery] = useState("");
			const [exportOpen, setExportOpen] = useState(false);
			const [copied, setCopied] = useState(false);

			const sessionKey = typeof currentSessionId === "string" && currentSessionId !== "" ? `${SCOPE_PREFIX}${currentSessionId}` : null;
			const scopeKey = scope === "session" && sessionKey !== null ? sessionKey : "global";
			const activeKey = scopeKey;

			const apiA = useRef(null); // 全局页 api
			const apiB = useRef(null); // 会话页 api
			const activeApiRef = viewMode === "split" ? (activeKey === "global" ? apiA : apiB) : apiA;
			const activeKeyRef = useRef(activeKey);
			useEffect(() => { activeKeyRef.current = activeKey; }, [activeKey]);

			const openRef = useRef(true);
			const prevOpenRef = useRef(true);
			const moveRef = useRef(null);
			const dragRef = useRef(null);

			const [pin, setPin] = useState(() => {
				try {
					const raw = localStorage.getItem(LS_PIN_KEY);
					if (raw) {
						const p = JSON.parse(raw);
						if (p && (p.mode === "pinned" || p.mode === "float")) {
							if (p.anchor && typeof p.anchor.ho === "number" && typeof p.anchor.vo === "number") {
								return { mode: "pinned", anchor: p.anchor };
							}
							if (typeof p.x === "number" && typeof p.y === "number") {
								return { mode: p.mode, anchor: absToAnchor(p.x, p.y, 280) };
							}
						}
					}
				} catch {}
				return {
					mode: "pinned",
					anchor: { h: "right", ho: 0, v: "top", vo: Math.max(0, (window.innerHeight - panelHeight()) / 2) }
				};
			});

			useEffect(() => { openRef.current = open; }, [open]);

			// 记忆：折叠 / 宽度
			useEffect(() => {
				try {
					if (localStorage.getItem(LS_OPEN_KEY) === "0") { setOpen(false); openRef.current = false; prevOpenRef.current = false; }
					const w = Number(localStorage.getItem(LS_WIDTH_KEY));
					if (Number.isFinite(w) && w >= MIN_WIDTH && w <= MAX_WIDTH) setWidth(w);
				} catch {}
			}, []);

			// 窄屏自动收起
			useEffect(() => {
				const mq = window.matchMedia(NARROW_MQ);
				const onChange = (e) => {
					if (e.matches) {
						if (openRef.current) { prevOpenRef.current = true; setOpen(false); }
					} else if (prevOpenRef.current) {
						setOpen(true);
					}
				};
				if (mq.matches && openRef.current) { prevOpenRef.current = true; setOpen(false); }
				mq.addEventListener("change", onChange);
				return () => mq.removeEventListener("change", onChange);
			}, []);

			// 快捷键：Ctrl+Enter 立即保存；Esc 收起
			useEffect(() => {
				const onKey = (e) => {
					if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
						e.preventDefault();
						const api = activeApiRef.current;
						if (api && typeof api.forceSave === "function") api.forceSave();
						return;
					}
					if (e.key === "Escape") {
						if (searchOpen) { setSearchOpen(false); return; }
						if (openRef.current) setOpen(false);
					}
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [searchOpen]);

			// 头部拖拽（仅浮动时）
			const onHeaderDown = (e) => {
				if (pin.mode === "pinned") return;
				if (e.target.closest("button")) return;
				const origin = renderOrigin(pin, width);
				const startAnchor = pin.anchor;
				moveRef.current = { mx: e.clientX, my: e.clientY, x: origin.left, y: origin.top, anchor: startAnchor, lastX: origin.left, lastY: origin.top };
				const onMove = (ev) => {
					const m = moveRef.current;
					if (!m) return;
					const ph = panelHeight();
					const x = clamp(m.x + ev.clientX - m.mx, 0, Math.max(0, window.innerWidth - width));
					const y = clamp(m.y + ev.clientY - m.my, 0, Math.max(0, window.innerHeight - ph));
					m.lastX = x;
					m.lastY = y;
					const a = m.anchor;
					const ho = a.h === "right" ? window.innerWidth - x - width : x;
					const vo = a.v === "bottom" ? window.innerHeight - y - ph : y;
					setPin((p) => ({ ...p, mode: "float", anchor: { h: a.h, ho, v: a.v, vo } }));
				};
				const onUp = () => {
					const m = moveRef.current;
					if (m) {
						const next = { mode: "float", anchor: absToAnchor(m.lastX, m.lastY, width) };
						try { localStorage.setItem(LS_PIN_KEY, JSON.stringify(next)); } catch {}
					}
					moveRef.current = null;
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
				};
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
				e.preventDefault();
			};

			const togglePin = () => {
				setPin((p) => {
					const next = { mode: p.mode === "pinned" ? "float" : "pinned", anchor: p.anchor };
					try { localStorage.setItem(LS_PIN_KEY, JSON.stringify(next)); } catch {}
					return next;
				});
			};

			const toggleOpen = () => {
				setOpen((v) => {
					const next = !v;
					prevOpenRef.current = next;
					try { localStorage.setItem(LS_OPEN_KEY, next ? "1" : "0"); } catch {}
					return next;
				});
			};

			const onDragStart = (e) => {
				dragRef.current = { startX: e.clientX, startW: width };
				const onMove = (ev) => {
					if (!dragRef.current) return;
					const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragRef.current.startW + (dragRef.current.startX - ev.clientX)));
					setWidth(w);
				};
				const onUp = () => {
					dragRef.current = null;
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
					try { localStorage.setItem(LS_WIDTH_KEY, String(width)); } catch {}
				};
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
				e.preventDefault();
			};

			const activeApi = () => activeApiRef.current;

			const insertTimestamp = () => { const api = activeApi(); if (api) api.insertTimestamp(); };

			const clearAll = () => { const api = activeApi(); if (api) api.clearAll(); };

			const toggleHist = async () => {
				if (histOpen) { setHistOpen(false); return; }
				setHistOpen(true);
				try {
					const res = await fetch(queryUrl(`${API_PATH}/history`, activeKeyRef.current), { cache: "no-store" });
					const body = await res.json();
					setHistItems(body && Array.isArray(body.items) ? body.items : []);
				} catch {
					setHistItems([]);
				}
			};

			const loadHistory = async (id) => {
				setHistOpen(false);
				try {
					const res = await fetch(queryUrl(`${API_PATH}/history/${encodeURIComponent(id)}`, activeKeyRef.current), { cache: "no-store" });
					const body = await res.json();
					if (body && body.ok === true && typeof body.text === "string") {
						const api = activeApi();
						if (api && typeof api.applyHistory === "function") api.applyHistory(body.text);
					}
				} catch {}
			};

			const doExport = async (kind) => {
				const api = activeApi();
				if (!api) return;
				const text = api.getText();
				if (kind === "copy") {
					try {
						await navigator.clipboard.writeText(text);
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					} catch {}
					return;
				}
				// 下载
				const safe = activeKeyRef.current.replace(/[^A-Za-z0-9_-]/g, "_");
				const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
				const a = document.createElement("a");
				a.href = URL.createObjectURL(blob);
				a.download = `dsh-notepad-${safe}-${new Date().toISOString().slice(0, 10)}.md`;
				a.click();
				setTimeout(() => URL.revokeObjectURL(a.href), 5000);
			};

			// 搜索：作用于当前活动页
			const searchResults = (() => {
				if (!searchOpen) return [];
				const q = searchQuery.trim().toLowerCase();
				if (!q) return [];
				const api = activeApi();
				if (!api) return [];
				const lines = String(api.getText()).split("\n");
				const out = [];
				lines.forEach((line, i) => {
					if (line.toLowerCase().includes(q)) out.push({ line: i, text: line.trim() });
				});
				return out.slice(0, 50);
			})();

			const [histOpen, setHistOpen] = useState(false);
			const [histItems, setHistItems] = useState([]);

			const origin = renderOrigin(pin, width);
			const isSessionScope = activeKey !== "global";
			const splitReady = sessionKey !== null;

			if (!open) {
				return h("div", {
					role: "button",
					tabIndex: 0,
					"data-plugin": "dsh-notepad",
					title: "展开记事本",
					"aria-label": "展开记事本",
					style: tab,
					onClick: toggleOpen,
					onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") toggleOpen(); }
				}, "记事本");
			}

			const splitMode = viewMode === "split" && splitReady;

			return h("div", {
				"data-plugin": "dsh-notepad",
				role: "complementary",
				"aria-label": "记事本",
				style: { ...panel, width, left: origin.left, top: origin.top }
			},
				h("div", { style: dragHandle, title: "拖动调整宽度", onMouseDown: onDragStart }),
				h("div", {
					style: { ...header, cursor: pin.mode === "pinned" ? "default" : "move" },
					onMouseDown: onHeaderDown,
					title: pin.mode === "pinned" ? "已固定（拖动无效）· 点 📌 解除" : "拖动移动窗口 · 点 📌 固定"
				},
					h("div", { style: { display: "flex", alignItems: "center", gap: 2, flex: 1, minWidth: 0 } },
						h("button", {
							type: "button",
							style: { ...modeBtn, ...(scope === "global" ? modeActive : {}) },
							title: "全局记事本（所有会话共享）",
							onClick: () => setScope("global")
						}, "全局"),
						h("button", {
							type: "button",
							style: { ...modeBtn, ...(scope === "session" ? modeActive : {}), ...(!splitReady ? { opacity: 0.4, cursor: "not-allowed" } : {}) },
							title: splitReady ? "本会话隔离记事本" : "需要先进入某个会话",
							disabled: !splitReady,
							onClick: () => setScope("session")
						}, "会话")),
					h("button", {
						type: "button",
						style: { ...iconBtn, ...(splitMode ? modeActive : {}) },
						title: splitMode ? "分屏中 · 点击返回单页" : "全局与本会话分屏同看",
						disabled: !splitReady,
						onClick: () => setViewMode((v) => (v === "single" ? "split" : "single"))
					}, "⇔"),
					h("button", {
						type: "button",
						style: { ...iconBtn, ...(pin.mode === "pinned" ? { color: "var(--dsw-alias-state-success-primary)" } : {}) },
						title: pin.mode === "pinned" ? "已固定在此位置 · 点击解除" : "点击固定在此位置",
						onClick: togglePin
					}, pin.mode === "pinned" ? "📍" : "📌"),
					h("button", { type: "button", style: iconBtn, title: "插入时间戳 [MM-DD HH:mm]", onClick: insertTimestamp }, "🕓"),
					h("button", { type: "button", style: { ...iconBtn, ...(searchOpen ? modeActive : {}) }, title: "搜索", onClick: () => setSearchOpen((v) => !v) }, "🔍"),
					h("button", { type: "button", style: { ...iconBtn, ...(histOpen ? modeActive : {}) }, title: "历史版本", onClick: toggleHist }, "⏱"),
					h("button", { type: "button", style: { ...iconBtn, ...(exportOpen ? modeActive : {}) }, title: "导出", onClick: () => setExportOpen((v) => !v) }, "⤓"),
					h("button", { type: "button", style: iconBtn, title: "清空", onClick: clearAll }, "✕"),
					h("button", { type: "button", style: iconBtn, title: "收起", onClick: toggleOpen }, "»")
				),
				splitMode
					? h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
						h(EditorPane, {
							scopeKey: "global",
							style: { flex: 1, minHeight: 0 },
							placeholder: "全局记事本（所有会话共享）…",
							previewMode: false,
							label: "🌐 全局",
							onActivate: () => setScope("global"),
							apiRef: apiA
						}),
						h("div", { style: divider }),
						h(EditorPane, {
							scopeKey: sessionKey,
							style: { flex: 1, minHeight: 0 },
							placeholder: "本会话专属记事本…",
							previewMode: false,
							label: `💬 会话 ${currentSessionId.slice(0, 8)}…`,
							onActivate: () => setScope("session"),
							apiRef: apiB
						})
					)
					: h(EditorPane, {
						scopeKey: activeKey,
						style: { flex: 1, minHeight: 0 },
						placeholder: isSessionScope ? "本会话专属记事本（其他会话看不到）…" : "随手记点什么…（所有会话共享，自动保存）",
						previewMode: !editMode,
						label: null,
						onActivate: null,
						apiRef: apiA
					}),
				searchOpen ? h("div", { style: { ...pop, top: 36 } },
					h("div", { style: { display: "flex", gap: 6, padding: "8px 10px" } },
						h("input", {
							style: searchInput,
							placeholder: "搜索当前页…（Enter 跳转第一条）",
							value: searchQuery,
							onChange: (e) => setSearchQuery(e.target.value),
							onKeyDown: (e) => {
								if (e.key === "Enter" && searchResults.length > 0) {
									const api = activeApi();
									if (api && typeof api.scrollToLine === "function") api.scrollToLine(searchResults[0].line);
								}
							}
						})),
					searchResults.length === 0
						? h("div", { style: { padding: "6px 12px", color: "var(--dsw-alias-label-secondary)", fontSize: 11 } },
							searchQuery.trim() ? "无匹配" : "输入关键词搜索当前页")
						: h("div", { style: { padding: "2px 0 6px" } },
							h("div", { style: { padding: "2px 12px", color: "var(--dsw-alias-label-secondary)", fontSize: 10 } }, `共 ${searchResults.length} 处匹配`),
							searchResults.map((r) => h("button", {
								key: r.line,
								type: "button",
								style: popItem,
								title: `跳到第 ${r.line + 1} 行`,
								onClick: () => {
									const api = activeApi();
									if (api && typeof api.scrollToLine === "function") api.scrollToLine(r.line);
								}
							}, h("span", { style: { flex: "none", color: "var(--dsw-alias-label-secondary)" } }, `L${r.line + 1}`),
								h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, r.text))))
				) : null,
				histOpen ? h("div", { style: pop },
					histItems.length === 0
						? h("div", { style: { padding: "8px 12px", color: "var(--dsw-alias-label-secondary)", fontSize: 11 } }, "暂无历史快照（每次保存前的版本会自动存档）")
						: histItems.map((item) => h("button", {
							key: item.id,
							type: "button",
							style: popItem,
							title: "载入此版本",
							onClick: () => loadHistory(item.id)
						}, `🕓 ${parseHistoryTime(item.id)}`))
				) : null,
				exportOpen ? h("div", { style: pop },
					h("button", { type: "button", style: popItem, onClick: () => doExport("copy") }, copied ? "✅ 已复制" : "📋 复制全文"),
					h("button", { type: "button", style: popItem, onClick: () => doExport("download") }, "⬇ 下载 .md")
				) : null,
				editMode && !splitMode ? h("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 10px 4px", flex: "none" } },
					h("button", {
						type: "button",
						style: modeBtn,
						title: "预览渲染效果（勾选框可点击）",
						onClick: () => setEditMode(false)
					}, "预览")
				) : null,
				!editMode && !splitMode ? h("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 10px 4px", flex: "none" } },
					h("button", { type: "button", style: modeBtn, title: "返回编辑", onClick: () => setEditMode(true) }, "编辑")
				) : null
			);
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-notepad",
				order: 50,
				label: "记事本"
			}, NotepadPanel));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
