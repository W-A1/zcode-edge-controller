# 故障排查清单

按出现频率排序。先跑 `node scripts/dev-check.mjs` 确认环境，再对号入座。

## 0. Edge 157 真机兼容性（本版本已修复，排查时先确认扩展版本）

改过 `extension/` 代码后命令行为不符合预期，**99% 是扩展没有真正重载**：

| 症状 | 结论 |
|---|---|
| `Unexpected property: 'tabIds'` | v1 旧代码（target 单复数 bug） |
| `Unexpected property: 'awaitPromise'` | v2 旧代码 |
| `Evaluating a string as JavaScript violates CSP` | v3 旧代码（executeScript+eval） |
| page.eval 正常返回 | v4 当前版本 ✓ |

**正确重载姿势**：`edge://extensions` → ZCode 卡片 → 点「重新加载」。
⚠ 杀 SW 进程（浏览器任务管理器 Shift+Esc）/ 等待 SW 休眠都**不会**清 SW 脚本缓存（bytecode 缓存从磁盘恢复），只有「重新加载」按钮有效。验证方法：重载后扩展弹窗日志应出现最新一条「扩展已安装/更新」。

其余相关差异：
- `executeScript` 的 injection 校验拒绝 `awaitPromise` 属性（wait.for 已改轮询注入，page.eval 已改 CDP）
- CDP `Runtime.evaluate` 自 Chromium 105 起默认受 CSP 拦截 → 本项目统一带 `allowUnsafeEvalBlockedByCSP: true`（与 DevTools console 语义一致）
- **睡眠标签**（Edge 省电）会让 `executeScript` 无限等待 → v4 已加 12s 注入超时；遇到"注入超时"先 `tabs.activate` 唤醒该标签页

## 1. 弹窗显示"未连接" / 网关报"扩展桥未连接"

| 检查 | 方法 |
|---|---|
| 网关在跑吗 | 弹窗顶部圆点是否绿色；`curl http://127.0.0.1:9223/healthz` 是否 200 |
| token 一致吗 | 对比 `server/.token` 与弹窗粘贴值；网关重启后 token 复用（文件持久化），不会变 |
| 地址对吗 | 弹窗"网关地址"应为 `ws://127.0.0.1:9223/bridge`（改过 --port 要同步改） |
| 扩展重载了吗 | 改过扩展代码后到 `edge://extensions` 点该扩展的"重新加载"，再弹窗重连 |
| SW 被杀过 | `edge://serviceworker-internals` / `edge://extensions` → 扩展"服务 Worker"点"检查"看 console 是否有 `[ZC]` 日志 |

## 2. WebSocket 连接失败 / 反复重连

- 弹窗日志区会显示重连节奏（1s→2s→…→30s 指数退避）。**先启动网关，再点弹窗"重连"**
- 防火墙/杀软拦 127.0.0.1 出站的情况极少，但企业环境存在；换端口（`--port 9323`）试
- 网关侧日志 `logs/gateway.log` 出现 `token 校验失败` → 弹窗里的 token 与 `server/.token` 不一致

## 3. MCP 在 ZCode 中不可见 / 工具列表为空

1. 确认配置了 `command: node, args: [...server/cli.mjs, --mcp]`，路径为绝对路径且含项目目录名（中文路径已验证可用）
2. **端口冲突**：MCP 模式自带网关占 9223，若独立网关已在跑会 EADDRINUSE 退出——二选一，或给 MCP 加 `--port`
3. 手动验证协议：ZCode 外直接跑 `node server/cli.mjs --mcp`，从 stdin 输入一行
   `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}`
   应在 stdout 回一行 JSON；日志在 stderr 与 `logs/mcp.log`
4. node 路径问题：ZCode 以 `node` 命令拉起，若 PATH 里没有 node，用绝对路径如 `C:\\Program Files\\nodejs\\node.exe`
5. 重启 ZCode / 重载 MCP 配置后看工具是否出现（工具名 `mcp__edge-controller__edge_*`）

## 4. 命令超时（45s/90s）

- 目标页是否卡在加载：`nav.goto` 默认等 `complete`（30s 上限），`waitForLoad:false` 可跳过等待
- 截图大页面耗时：超时 90s，试 `format:"jpeg"`
- SW 刚被挂起又立即收到命令：重试一次即可（心跳已恢复保活）
- 网关侧 pending 泄漏不会发生：超时后 promise reject 并清理

## 5. 注入失败 / "页面可能是内部页"

- `chrome://` / `edge://` / 商店页 / `view-source:` **禁止脚本注入**，这是浏览器限制不是 bug
- chrome Web Store 页、PDF 查看器同样受限
- 页面还在 loading 时注入会失败：先 `wait.for` 或 `nav.goto`（自带等加载）

## 6. 截图失败 "Cannot attach to this target"

- 目标是内部页或已崩溃页；换普通 https 页
- 该 tab 处于 discarded（省电休眠）状态：先 `tabs.activate` 唤醒

## 7. 点击/输入不生效

- refs 过期（SPA 渲染变化）：重新 `page.refs`
- 元素在 **跨域 iframe** 内：注入无法跨 iframe（v1 限制），定位到 iframe 本身后用 `page.eval` 间接操作
- React 受控组件：确认用 `input.type`（已做原生 setter 兼容）；极端组件换 `native:true`
- 元素被遮挡：注入版 click 对不可见元素会先 `scrollIntoView`；仍失败试 `native:true`（CDP 可信坐标点击）
- 下拉框：`input.type` 支持 select 按 value/文本匹配 option

## 8. CDP 连接失败（--cdp-port 9222）

| 现象 | 原因 |
|---|---|
| `CDP http 404` | 目标 Edge 未带 `--remote-debugging-port` 启动 |
| 探测失败 | **同一 Edge 实例未关闭**：调试端口只在全新实例生效；必须用 `--user-data-dir` 指向新目录（launch-edge.mjs 已处理） |
| `Target 不可用` | 页面全部关闭；至少保留一个 tab |

启动命令（必须独立 profile）：

```
msedge.exe --remote-debugging-port=9222 --user-data-dir=<项目>\.edge-profile
```

## 9. `--load-extension` 不生效 / 被忽略

新版 Chromium/Edge 已禁用该参数（防恶意静默注入）。唯一正规途径：`edge://extensions` 开发人员模式手动加载解压目录。

## 10. 权限报错 / 想收紧 `<all_urls>`

- `manifest.json` 把 `host_permissions: ["<all_urls>"]` 改为 `optional_host_permissions`，并在 SW 的 `resolveTab` 后加 `chrome.permissions.request({origins:[tab.url.origin]})`（需用户手势触发，自动化顺畅度下降）
- 误报 `Cannot access contents of url`：确认加载的是 `extension/` 目录本身（manifest.json 在其根下）

## 11. 打包/zip 问题

- `npm run pack` 依赖 PowerShell `Compress-Archive`（Windows 自带）；公司策略禁 PowerShell 时手动压缩 `extension/` 全部内容（manifest.json 必须在 zip 根）
- zip 解压后加载失败：检查是否压缩成了"包含 extension 文件夹本身"的错误层级

## 12. 日志去哪看

| 位置 | 内容 |
|---|---|
| 扩展弹窗"运行日志" | SW 侧最近 120 条（命令 ✓/✗、连接状态、审批） |
| SW DevTools | `edge://extensions` → 扩展 → "服务 Worker" → 检查 → Console |
| `logs/gateway.log` | 网关侧（连接、转发、错误） |
| `logs/mcp.log` | MCP 模式（stderr 同步写入） |
