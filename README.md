# dsh-notepad

钉在 DeepSeek Harness Web GUI 的常驻记事本插件（可拖动、可固定）。

- 双作用域：**全局页**（所有会话共享）+ **本会话隔离页**，可切换或分屏同看
- 输入自动保存到 `~/.dsh/notepad/`（UTF-8 BOM、原子写、revision 乐观锁、冲突可合并/覆盖）
- 保存失败自动重试；刷新后检测到未保存内容可一键恢复
- SSE 实时推送 + 轮询兜底；Markdown 预览（勾选框可点击）、完成率统计、时间戳插入、全文搜索、历史快照（每次保存前自动存档 20 份）、复制/下载导出
- Agent 工具：`notepad_read` / `notepad_write`（append 按行去重、可选时间戳）/ `notepad_search`（跨作用域）
- 窗口可拖到任意位置、可锁定固定；宽度可调；窄屏自动收起；`Ctrl+Enter` 立即保存、`Esc` 收起
- 纯客户端样式，只用 `--dsw-*` 主题 token，跟随明暗主题

## 安装

```sh
dsh plugin --profile web add dsh-notepad
```

重启 dsh web 后刷新页面即可。卸载：`dsh plugin --profile web remove dsh-notepad`（便签文件默认保留）。

### 本地开发

源码放在 `~/.dsh/profiles/` 树**内**（`link:` 安装按插件的 realpath 向上解析依赖，
放在树外会够不到 `profiles/node_modules` 里宿主自带的 `@deepseek-ai/*`）：

```sh
# <yourProfileDir> 为 ~/.dsh/profiles/ 下的实际路径
dsh plugin --profile web add link:<yourProfileDir>/dsh-notepad
```

## 结构

```
dsh-notepad/
├── package.json       # dsh.bundle + dsh.client（浏览器半区）
├── cordis.patch.yml   # 把宿主行插入组合的 patch
├── lib/
│   ├── index.js       # 宿主办：存储/API/SSE + 模型工具
│   └── client.js      # 浏览器半区：shell.overlay 常驻面板
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/notepad` | `?scope=global\|session&sessionId=&since=` 读取（未变返回 `text:null`） |
| PUT | `/api/notepad` | body `{ scope, sessionId?, text, baseRevision?, force? }`，冲突返回 409 |
| GET | `/api/notepad/stream` | SSE 推送：`{ scope, revision }` 变更广播 |
| GET | `/api/notepad/history` | `?scope=&sessionId=` 历史快照列表 |
| GET | `/api/notepad/history/<id>` | 载入单份快照 |
