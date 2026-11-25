# ZCode Edge Controller

[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Manifest](https://img.shields.io/badge/Manifest-V3-0078D7?logo=microsoftedge&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Dependencies](https://img.shields.io/badge/deps-1%20(ws)-blueviolet)](package.json)
[![Tests](https://img.shields.io/badge/tests-unit%20%2B%20e2e%20%2B%20pentest-success)](tests/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

让 **AI Agent 安全地控制 Microsoft Edge** —— MV3 扩展 + 本地网关 + MCP，可选 CDP 增强。

支持 **ZCode / Claude Desktop / Cursor** 等任意 MCP 客户端，也可直接走 REST/WebSocket。

```
┌──────────────┐  MCP stdio   ┌────────────────────────┐  WebSocket   ┌──────────────┐
│  AI Agent    │ ───────────▶ │  本地网关 (Node)        │ ───────────▶ │  Edge 扩展    │
│ (ZCode 等)   │              │  · 路由 / 审批 / 审计   │              │  MV3 Service │
└──────────────┘  REST /call │  · 35 个 MCP 工具      │              │  Worker      │
                             └───────────┬────────────┘              └──────────────┘
                                         │ CDP (可选，默认关闭)
                                    ┌────▼─────────────┐
                                    │ Edge 调试实例     │
                                    └──────────────────┘
```

## 特性

- **双通道混合架构**：普通读写走扩展通路（轻量、带审批），强控制走 CDP（可信事件 / 网络拦截 / 深度 JS）
- **CDP 默认关闭**，运行时可一键启停；未启用时 CDP 专属工具**自动降级**到扩展实现，不报错
- **用户授权闸门**：三档模式（只读 / 写需确认 / 自动），`critical` 高危命令**任何模式下都强制弹窗确认**
- **最小权限**：扩展仅 5 项权限；网关只监听 `127.0.0.1`；token 配对
- **命令白名单双侧校验**（扩展 + 网关），测试自动比对防漂移
- **完整审计**：每条命令（含审批决策）持久化，popup 一键导出
- **故障隔离**：页面 JS 死循环不会阻塞其他标签页（`page.eval` 走网关直连 + 标签页熔断）
- **零构建**：扩展免打包直接加载；网关唯一依赖 `ws`

## 快速开始

```bash
npm install
npm run dev            # 启动网关(9223) + 沙箱服务器(8090)
```

**加载扩展**：Edge 打开 `edge://extensions` → 开发者模式 → 加载解压缩的扩展 → 选 `extension/` 目录

**配对**：点工具栏扩展图标 → 粘贴 `server/.token` 内容 → 保存并重连 → 圆点变绿

**接入 MCP 客户端**（以 ZCode 为例，`~/.zcode/cli/config.json`）：

```json
{
  "mcp": {
    "servers": {
      "edge-controller": {
        "command": "node",
        "args": ["<绝对路径>/server/cli.mjs", "--mcp"]
      }
    }
  }
}
```

**验证**：`npm run smoke`（写命令会弹批准卡片，点「批准执行」）

## MCP 工具（35 个）

### 通道别名工具 —— 工具名即通道

| 扩展通道（无需 CDP） | CDP 通道（需启用，未启用自动降级） |
|---|---|
| `list_tabs` 标签列表 | `native_click` 可信鼠标事件（isTrusted） |
| `get_page_text` 页面文本 | `network_intercept` 网络捕获（start/dump/stop） |
| `simple_click` 注入式点击 | `full_screenshot` 整页截图 |
| `simple_type` 注入式输入 | `evaluate_js_context` 页面主世界执行 JS |
| `basic_screenshot` 视口截图 | `page_capture` 组合快照（截图 + 文本） |

### 核心工具（`edge_*`，通道自动路由）

`edge_status` / `edge_tabs_list` / `edge_tab_get` / `edge_navigate` / `edge_nav_back` / `edge_nav_forward` /
`edge_nav_reload` / `edge_tabs_create` / `edge_tabs_close` / `edge_tabs_activate` / `edge_page_content` /
`edge_page_refs` / `edge_screenshot` / `edge_wait_for` / `edge_input_click` / `edge_input_type` /
`edge_input_key` / `edge_input_scroll` / `edge_form_fill` / `edge_eval_js` / `edge_input_upload` /
`edge_net_start` / `edge_net_dump` / `edge_net_stop` / `edge_cdp_control`

> 每条命令返回都带 `__via: "ext" | "cdp" | "cdp-direct" | "gateway"`，可断言实际通道。

## 通道路由规则

```
CDP 关闭（默认） → 全部走扩展桥（扩展离线则明确报错，不崩溃）
CDP 开启        → strong 命令（eval/upload/net）→ CDP
                  native=true（click/type/key/scroll）→ CDP 可信事件
                  其余普通读写 → 扩展桥（保留审批闸门）
                  扩展离线 → 自动降级 CDP
```

启用 CDP 三种方式：

1. **扩展弹窗**「启用 CDP」按钮（自动拉起调试 Edge，推荐）
2. Agent 调用 `edge_cdp_control {action:"enable"}`
3. 启动参数：`node server/cli.mjs --gateway --cdp-port 9222`

## 安全模型

| 层 | 措施 |
|---|---|
| 网络 | 仅监听 `127.0.0.1`；WS/HTTP origin 白名单；token 配对（恒定时间比较） |
| 白名单 | 24 条命令表双侧校验（`Object.hasOwn`，防原型链绕过）；路径严格白名单 |
| 审批 | 三档模式 + `critical` 6 条强制确认 + CDP 写命令 428 闸门 + 60s 超时自动拒 |
| 文件 | 上传需绝对路径 + 存在 + `isFile()`；9 条敏感文件规则拦截（`.token`/私钥/env） |
| 导航 | 协议白名单：默认禁 `file:` / `data:` / `javascript:`（防本地文件读取与脚本注入） |
| 熔断 | CDP 任务超时 → 该页隔离 2 分钟 → 后续快速失败；`nav.reload` 解除 |
| 审计 | `chrome.storage.local` 1000 条 + 网关日志（token 已掩码） |

更多细节与已修复漏洞清单见 [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md) 与 [docs/PENTEST-REPORT.md](docs/PENTEST-REPORT.md)。

## 常用命令

```bash
npm run dev            # 网关 + 沙箱服务器（-- --cdp 额外起 CDP 实例）
npm run smoke          # 真机全命令冒烟
npm test               # 离线测试：unit + e2e-mcp + e2e-gateway
npm run dev-check      # 环境自检
npm run pack           # 打包扩展 zip
node tests/pentest/pentest12.mjs   # 渗透：HTTP + WS
node tests/pentest/pentest36.mjs   # 渗透：参数 / 文件 / DoS
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | 安装、配对、MCP 配置、CDP 启用、打包 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、路由矩阵、协议设计、关键决策 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 12 类故障排查（含 Edge 157 兼容性实录） |
| [docs/ZCODE-INTEGRATION.md](docs/ZCODE-INTEGRATION.md) | ZCode 对接、调用示例、断点调试 |
| [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md) | 安全审计报告（含漏洞与修复） |
| [docs/PENTEST-REPORT.md](docs/PENTEST-REPORT.md) | 渗透测试报告（10 项发现全修复） |
| [docs/ACCEPTANCE-REPORT.md](docs/ACCEPTANCE-REPORT.md) | 正式验收报告（63 用例） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南（含新增命令清单、安全红线） |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

## 兼容性

已在 **Edge 157 / 158 + Node 26** 真机验证。开发过程中踩到并修复的 Edge 特有问题：

| 问题 | 说明 |
|---|---|
| `executeScript` 的 `tabIds` | 必须用单数 `tabId` |
| `injection.awaitPromise` | Edge 157 校验拒绝该属性 → 改 SW 侧轮询 |
| MV3 CSP 禁 `eval` | 字符串求值改走 CDP `Runtime.evaluate` |
| `Runtime.evaluate` CSP | Chromium 105+ 需 `allowUnsafeEvalBlockedByCSP` |
| 深度休眠标签 | 唤醒需轮询 `status=complete`，固定延时不够 |
| SW 脚本缓存 | 改代码后必须点扩展「重新加载」，杀 SW 无效 |

完整排查见 [docs/TROUBLESHOOTING.md §0](docs/TROUBLESHOOTING.md)。

## 已知边界

- 深层嵌套 iframe（>1 层）的 native 点击需改用注入式点击
- 页面 JS 死循环后该页必须刷新才能恢复（浏览器固有约束，已做故障隔离）
- `page.eval` / `page.screenshot` 默认走 CDP 直连（需 `--cdp-port`），可用 `__preferChannel:"ext"` 强制扩展通路
- `host_permissions: <all_urls>` —— 任意页注入所需，可改 `optional_host_permissions` 按站点授权

## License

[MIT](LICENSE)
