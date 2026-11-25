# 架构与协议设计

## 总体拓扑

```
┌────────────────────────────┐
│ ZCode Agent                │
│ (MCP Client / HTTP Client) │
└──────────┬─────────────────┘
           │ A: MCP stdio（newline JSON-RPC 2.0）
           │ B: REST POST /call（Bearer token）
┌──────────▼─────────────────────────────────────┐
│ 本地网关 server/cli.mjs（Node ≥18，依赖仅 ws）   │
│  · MCP stdio 接口（server/mcp.mjs）             │
│  · REST /call + GET /healthz（server/gateway.mjs）│
│  · WS Server ws://127.0.0.1:9223/bridge         │
│  · 白名单二次校验 · token 鉴权 · 日志落盘         │
│  · CDP 后端（server/cdp-backend.mjs，可选）      │
└──────────┬─────────────────────────────────────┘
           │ C: WebSocket（扩展为客户端，token 配对）
┌──────────▼─────────────────────────────────────┐
│ Edge MV3 扩展                                    │
│  · service worker（module 型）：连接保活/分发/审批 │
│  · chrome.tabs：标签管理、导航                    │
│  · chrome.scripting：DOM 注入（ISOLATED world）  │
│  · chrome.debugger：CDP 截图 + 可信输入           │
│  · popup：模式开关 / token 配对 / 写审批 / 日志    │
└──────────────────────────────────────────────────┘
```

## 关键设计决策

| 决策 | 原因 |
|---|---|
| 扩展做 WS **客户端** | MV3 SW 无法监听端口；客户端可随时重连，网关重启无感 |
| 20s 心跳 + 30s alarm 兜底 | Edge/Chromium ≥116 中 WS 活动重置 SW 30s 空闲计时；alarm 负责被杀后唤醒重连 |
| 手写 MCP（零依赖） | stdio 协议面小（initialize/tools/list/tools/call/ping），避免 SDK 依赖树；e2e 全对话验证 |
| **page.eval 走 chrome.debugger（CDP）而非 executeScript** | MV3 扩展 CSP 禁止字符串 eval（ISOLATED world 也受限）；Edge 157 的 injection 校验拒绝 awaitPromise 属性。CDP Runtime.evaluate：MAIN world 原生、awaitPromise 原生、配 `allowUnsafeEvalBlockedByCSP` 放行字符串求值（Chromium 105+ 默认拦截，需显式放行）。CDP 后端同款实现，两端已实测 |
| **wait.for 用 SW 侧轮询注入** | executeScript 无法等待 Promise（injection 拒绝 awaitPromise 属性）；150ms 轮询 + 12s 注入超时（防睡眠标签挂起） |
| 网关写命令超时 90s ≥ 扩展批准窗 60s | 保证「用户未批准」与「真超时」错误语义分离（曾实测 45s 超时把拒绝误报成 extension timeout） |
| `page.refs` 索引存 ISOLATED world | 同扩展同 frame 的隔离世界共享全局；页面 JS 摸不到，SPA 重渲染只需重取 refs |
| React 兼容输入 | 用 `HTMLInputElement.prototype` 的原生 value setter 绕过框架劫持，再补 `input/change` 事件 |
| `native:true` 可信输入 | `chrome.debugger` 的 `Input.insertText`（中文 IME 友好）/`Input.dispatchMouseEvent`，等价真实用户事件 |
| CDP 后端复用 dom.js | `String(actionFn)` 注入同一份函数，两端行为一致 |
| 双侧命令白名单 | 扩展侧防网关被伪造，网关侧防恶意 MCP/REST 调用；`tests/unit.mjs` 比对两侧同步 |
| MCP 模式 stdout 只走协议 | 日志全走 stderr（`server/logger.mjs`）；MCP 启动时端口被占自动降级 REST 转发既有网关（已实测） |
| **跨域 iframe：refs 带 frameId，操作按 frame 注入** | 每个 frame 的隔离世界各自持有 `__zcodeRefs`（天然隔离）——refs 用 allFrames 收集并打 frameId，click/type/fill/scroll 以 `frameIds:[frameId]` 定点注入。native 坐标点击对 iframe 元素明确报错（主文档坐标换算未实现）。CDP 后端 v1.1 仅主 frame（标注） |
| **睡眠标签唤醒** | executeScript 注入超时（12s race）→ `tabs.update({active:true})` 唤醒 → 等 800ms 重试一次（不递归） |
| **多扩展连接并存** | hello 携带 `runtimeId`（扩展 ID）+ `build`（manifest 版本）；网关按 clientId 分桶：同 ID 新连接顶替旧连接（4000 replaced），异 ID 并存；命令默认路由最近活跃连接，多实例时 log 提示（tabId 不参与路由，跨实例请隔离网关） |
| **CDP 写命令审批闸门（可选）** | `--confirm-cdp-writes` 时 CDP 通路写命令返回 `428 CONFIRM_REQUIRED <id>` 并入队；`GET /pending` → `POST /confirm|/reject`；`/confirm` 复用 call() 完整校验链（白名单/上传路径校验/超时）。扩展桥通路始终受扩展侧审批约束，不受此开关影响 |
| **网络捕获（net.*）** | net.start 长持有 debugger attach（withDebugger 检测 "already attached" 时复用不 detach）；SW 顶层 `chrome.debugger.onEvent` → netHandler 合并 request/response；收集存 SW 内存（SW 被杀丢失，上限默认 300 条）；dump 时按最近 20 条响应取 body 摘要（≤8KB）。CDP 后端同款（pageConn 持久监听） |
| **审计持久化** | SW 每条命令（含审批决策 approved=true/false、耗时、错误摘要）追加 `chrome.storage.local.zcAudit`（上限 1000 条）；弹窗环形日志仅实时展示 |
| **版本可观测** | `/healthz` 与 `edge_status` 的 `connections[].build` 显示扩展 manifest 版本；`build:"?"` = 扩展未重载（hello 未带 build 字段的旧代码） |

## WS 桥协议（网关 ↔ 扩展）

```jsonc
// 扩展 → 网关：握手（token 配对）
{"type":"hello","token":"<48hex>","client":"zcode-edge-extension","v":1}
// 网关 → 扩展：命令
{"type":"call","id":"c1","cmd":"page.content","params":{"format":"markdown"}}
// 扩展 → 网关：结果
{"type":"result","id":"c1","ok":true,"data":{...}}
{"type":"result","id":"c2","ok":false,"error":"用户未批准该写操作（手动拒绝或 60s 超时）"}
// 心跳
{"type":"ping"} ↔ {"type":"pong"}
```

- 校验失败：`ws.close(4001, "bad token")`
- 单连接策略：新扩展连接顶替旧连接（`4000 replaced`）
- 超时：默认 45s，截图 90s，REST 可带 `timeoutMs`（上限 120s）

## 写操作审批流（confirm-writes 模式）

```
网关 call ──▶ SW: 白名单+模式校验 ──▶ storage.session 写 pendingApproval + badge "!"
                                      │
             popup 打开（1.5s 轮询）──▶ 显示命令+参数预览 → 用户 [批准|拒绝]
                                      │
             chrome.runtime.sendMessage(ui.approve) ──▶ SW resolve(bool)
                                      │
             超时 60s 自动拒绝 ──▶ result{ok:false}
```

SW 在等待期靠 WS 心跳保持活跃，不会休眠丢 Promise。

## CDP 通路

1. **扩展内**（主通路）：`chrome.debugger` attach → `Page.captureScreenshot`（`captureBeyondViewport` 整页）→ detach；`withDebugger` 按 tabId 互斥，避免重复 attach 报错
2. **外部**（备用通路）：`scripts/launch-edge.mjs` 以 `--remote-debugging-port=9222 --user-data-dir=.edge-profile` 启动独立实例 → 网关 `--cdp-port 9222` → HTTP `/json/list` 发现 target → browser 级 WS（`Target.createTarget/closeTarget`）+ page 级 WS（Runtime/Page/Input 域）
3. 命令子集见 `cdp-backend.mjs` 的 `SUPPORTED`；`page.refs/content/wait` 直接复用扩展的 `actionFn` 源码字符串

## 权限清单与最小化说明

| 权限 | 用途 | 可否缩减 |
|---|---|---|
| `tabs` | 读取 url/title（`chrome.tabs.query/get`） | 必需 |
| `scripting` | 动态注入读 DOM / 交互 | 必需 |
| `debugger` | 截图、CDP 可信输入 | 仅截图/输入用；删掉则截图与 native 输入不可用 |
| `storage` | token/模式/审批状态 | 必需 |
| `alarms` | SW 保活兜底重连 | 必需 |
| `host_permissions: <all_urls>` | 对任意 tab 注入 | 可降级：改 `optional_host_permissions`，运行时按站点请求（牺牲自动化顺畅度，见 TROUBLESHOOTING） |

不申请：`downloads`（截图以 base64 回传不落盘）、`notifications`（用 badge 提示审批）、`tabs` 之外的任何背景权限。
