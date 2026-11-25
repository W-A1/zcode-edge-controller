# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.5.1] — 2026-11-26

### 修复
- **popup CDP 状态显示错误**：`/cdp/status` 返回 `routing.cdp.enabled` 而 popup 读 `st.cdp.enabled`，导致点击"启用 CDP"后界面无变化（实际已启用）
- 统一 `/cdp/enable|disable|status` 三端点返回结构为顶层 `{action, enabled, cdpPort, edgeSpawnedByUs}`
- popup 启用中禁用按钮并显示进度文案，避免重复点击

## [1.5.0] — 2026-11-26

### 架构级修复
- **页面 JS 死循环不再阻塞扩展 SW**：`page.eval` / `page.screenshot` 改由网关直连 CDP 执行（新增 `server/direct-eval.mjs`），独立于扩展 Service Worker
- 新增**标签页熔断机制**：CDP 任务超时后该页标记隔离态，后续操作快速失败，`nav.reload` 自动解除
- 死循环快失败从 30s 降至 3s，错误信息含恢复指引

### 安全修复（渗透测试发现）
- 🔴 原型链绕过命令白名单（`cmd="__proto__"`）→ 改用 `Object.hasOwn` 校验
- 🔴 `file://` / `data:` 导航可读取本地文件与注入脚本 → 协议白名单
- 🟠 REST 接受任意跨站 Origin → Origin 白名单
- 🟠 `/healthz` 未鉴权泄露内部信息 → 瘦身 + 新增鉴权 `/status`
- 🟠 目录/设备文件上传挂起 → `isFile()` 校验
- 🟡 参数越界返回 500 → 12 类数值范围校验 + 400
- 🟡 路径变体 `/./call` 可路由 → 9 条合法路径白名单
- 🟡 敏感文件（`.token`/私钥）可上传外泄 → 9 条规则拦截 403
- 🟡 token 明文写入日志 → 掩码显示

## [1.4.x] — 2026-11-22 ~ 11-25

### 安全加固
- 审批闸门 `params.__confirm` 伪造绕过修复（改用服务端私有标志）
- 敏感文件上传拦截、恒定时间 token 比较、`pendingCdp` 容量上限
- 扩展待批操作队列化（原单槽覆盖导致并发丢失）

### 功能
- 通道别名工具（10 个：`list_tabs` / `get_page_text` / `simple_click` / `simple_type` / `basic_screenshot` / `native_click` / `network_intercept` / `full_screenshot` / `evaluate_js_context` / `page_capture`）
- 命令级通道路由矩阵（`__preferChannel` 工具绑定 + 自动路由 + 降级）
- CDP 运行时可启停（弹窗按钮 / `edge_cdp_control` / `POST /cdp/enable`）
- `input.upload` 文件上传、`net.start/dump/stop` 网络捕获
- 跨域 iframe 元素操作（refs 带 frameId）
- 睡眠标签自动唤醒、深度休眠恢复

## [1.3.0] — 2026-11-22

- 命令级通道路由（strong / nativeStrong 分级）
- `critical` 高危命令强制确认（auto 模式也生效）
- CDP 会话管理器（按需拉起调试 Edge）
- 扩展上报能力集，网关据此路由

## [1.2.0] — 2026-11-22

- `wait.for` 跨 frame、`input.upload` 标记清理、badge 待批数字化
- 扩展侧待批队列、iframe native 点击坐标合成
- net 捕获持久化（storage.session + SW 冷启动恢复）

## [1.1.x] — 2026-11-22

- 深度休眠标签唤醒（轮询 `status=complete` 后重试）
- `Page.createIsolatedWorld` 补充必填 `frameId`
- debugger attach 15s 超时保护、截图失败自动唤醒重试

## [1.0.0] — 2026-11-22

首个可用版本：
- MV3 扩展（SW + popup + 动态注入）+ 本地网关 + MCP stdio server + CDP 备用通路
- 19 条命令（读/写分离）、三档安全模式、白名单双侧校验、审计日志
- 修复 Edge 157 四大兼容性问题（`tabIds` 单复数、`awaitPromise` 被拒、MV3 CSP 禁 eval、`Runtime.evaluate` CSP 拦截）
