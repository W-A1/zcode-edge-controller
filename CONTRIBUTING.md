# 贡献指南

感谢你考虑为 ZCode Edge Controller 做贡献。

## 开发环境

```bash
git clone <repo>
cd zcode-edge-controller
npm install          # 仅安装 ws（唯一运行时依赖）
npm run dev-check    # 环境自检（Node ≥18.17 / Edge 路径 / 文件完整性）
```

## 项目结构

```
extension/   Edge MV3 扩展（免构建，直接加载）
  manifest.json
  background/service-worker.js   SW：WS 长连接 + 命令分发 + 审批闸门 + 审计
  lib/protocol.js                ★ 命令注册表（与 server/protocol.mjs 必须同步）
  lib/security.js                三档模式 + 待批队列
  lib/cdp.js                     chrome.debugger 封装 + 熔断
  lib/dom.js                     自包含注入函数（executeScript 序列化执行）
  lib/commands/{read,write,net,inject}.js
  popup/                         状态面板 / CDP 开关 / 授权 / 日志
server/      本地网关（Node，仅依赖 ws）
  cli.mjs        统一入口（--gateway / --mcp）
  gateway.mjs    ★ 路由引擎 + REST + WS 桥
  protocol.mjs   ★ 命令注册表 + MCP 工具定义（25 核心 + 10 别名）
  mcp.mjs        MCP stdio server（手写 JSON-RPC，零依赖）
  cdp-manager.mjs  CDP 运行时启停 + 按需拉起 Edge
  cdp-backend.mjs  CDP 会话管理
  direct-eval.mjs  直连 eval/截图（隔离 SW 阻塞）
scripts/     dev / smoke / dev-check / launch-edge / pack / serve-sandbox
tests/       unit / e2e-mcp / e2e-gateway / pentest
docs/        INSTALL / ARCHITECTURE / TROUBLESHOOTING / ZCODE-INTEGRATION / 验收与渗透报告
```

## 关键约束（提交前必读）

1. **两侧协议表必须同步**
   `extension/lib/protocol.js` 与 `server/protocol.mjs` 的 `COMMANDS` 必须完全一致。
   `tests/unit.mjs` 会自动比对，不同步会直接失败。

2. **注入函数必须自包含**
   `extension/lib/dom.js` 里的 `actionFn` 会被 `chrome.scripting.executeScript` **序列化**后在页面执行，
   因此**不能引用任何外部变量**，参数一律通过 `args` 传入。CDP 后端也用 `String(actionFn)` 复用同一份代码。

3. **新增命令的完整清单**
   - [ ] 两侧 `COMMANDS` 加定义（含 `kind` / `chan` / `risk` / 可选 `strong`、`nativeStrong`）
   - [ ] `server/protocol.mjs` 的 `TOOLS` 加 MCP 工具（若需要）
   - [ ] `extension/background/service-worker.js` 的 `HANDLERS` 注册实现
   - [ ] `tests/unit.mjs` 自动覆盖校验；补 e2e/smoke 用例
   - [ ] README 命令矩阵 + CHANGELOG 更新

4. **安全红线**
   - 白名单校验用 `Object.hasOwn`（勿用属性访问，防原型链绕过）
   - 外部输入一律视为不可信：`__confirm` 等内部标志必须在入口剥离
   - 文件路径校验：绝对路径 + 存在性 + `isFile()` + 敏感文件规则
   - URL 协议白名单：默认禁 `file:` / `data:` / `javascript:`
   - 任何可能长时间阻塞的操作必须有超时；页面 JS 死循环类操作不得在扩展 SW 内执行

## 测试

```bash
npm test                              # 离线：unit + e2e-mcp + e2e-gateway
npm run smoke                         # 真机冒烟（扩展通路，写命令需在弹窗批准）
npm run smoke -- --port 9323 --cdp    # CDP 通路冒烟
node tests/pentest/pentest12.mjs      # 渗透：HTTP + WS 攻击面
node tests/pentest/pentest36.mjs      # 渗透：参数 / 文件 / DoS / 本地文件
node tests/pentest/v150-verify.mjs    # 死循环隔离性验证
```

## 代码风格

- 原生 ES2022，无需构建步骤（扩展直接加载）
- 不引入重型依赖：**唯一运行时依赖是 `ws`**
- 注释写「为什么」而不是「做什么」；跨版本踩坑处的注释保留（如 Edge 157 兼容性）
- 错误信息面向 Agent 与用户：说明**发生了什么 + 怎么恢复**

## 提交

```
fix(eval): 页面死循环不再阻塞 SW，改走 CDP 直连

死循环会阻塞 chrome.debugger.sendCommand 所在的 SW 事件循环，
导致超时定时器失效并拖累其他标签页。
改为网关进程直连调试端口执行，并加标签页熔断。
```

类型：`feat` / `fix` / `security` / `docs` / `test` / `refactor` / `chore`

## 提 PR 前自检

- [ ] `npm test` 全绿
- [ ] `node scripts/dev-check.mjs` 全绿
- [ ] 未提交 `server/.token`、`logs/`、`.edge-profile/`、`node_modules/`
- [ ] 新增/修改的安全相关代码有对应测试用例
