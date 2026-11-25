# ZCode 集成指南（预览 / 启动 / 日志 / 断点调试 / 持续迭代）

## 1. MCP 挂载

ZCode 全局 MCP 配置（或项目级 `.zcode/mcp.json`）：

```json
{
  "mcpServers": {
    "edge-controller": {
      "command": "node",
      "args": ["C:\\path\\to\\zcode-edge-controller\\server\\cli.mjs", "--mcp"]
    }
  }
}
```

挂载后 ZCode 可调用 **35 个工具**，分两套命名体系：

**核心工具（25 个，`edge_*` 前缀）**：通道由网关路由矩阵自动选择（见 README「通道路由矩阵」）。

**通道别名工具（10 个，v1.4：工具名即通道）**：

| 工具 | 通道 | 说明 |
|---|---|---|
| `list_tabs` | 扩展 | 标签页列表 |
| `get_page_text` | 扩展 | 页面文本 |
| `simple_click` | 扩展 | 注入式点击（无需 CDP） |
| `simple_type` | 扩展 | 注入式输入 |
| `basic_screenshot` | 扩展 | 当前视口截图 |
| `native_click` | CDP | 可信鼠标事件（isTrusted=true） |
| `network_intercept` | CDP | 网络捕获会话（start/dump/stop） |
| `full_screenshot` | CDP | 整页截图 |
| `evaluate_js_context` | CDP | 页面主世界强制上下文执行 JS |
| `page_capture` | CDP | 组合快照（整页截图+文本+meta 一次返回） |

- CDP 未启用时，CDP 通道工具在 tools/list 中标注〔CDP 未启用：调用将自动降级到扩展通路〕，**调用不报错**
- 扩展通道工具始终可用（扩展离线且 CDP 开启时才降级到 CDP）
- 工具名前缀 `mcp__edge-controller__`

> MCP 模式自带网关（内嵌进程）；若端口已被独立网关占用，会自动降级为 REST 转发既有网关（实测可用），两种形态可共存。

## 2. 调用示例（给 ZCode 的任务指令）

```
# 只读探查（核心工具：通道自动路由）
用 edge_status 确认通道状态（扩展桥/CDP），然后 edge_tabs_list 列出我 Edge 的所有标签页

# 页面分析（扩展通道别名工具）
用 get_page_text 读取 http://127.0.0.1:8090/test/sandbox.html 的文本

# 交互操作（扩展通道；写需确认模式会弹批准卡片）
simple_click 点"按钮 A" → simple_type 在姓名框输入"ZCode" → basic_screenshot 截图确认

# CDP 强控制（先启用 CDP；写操作走审批闸门）
用 edge_cdp_control 的 action=enable 启用 CDP 通道
→ evaluate_js_context 执行 location.href（页面主世界）
→ native_click 以可信事件点击"按钮 B（提交）"
→ network_intercept action=start 开始捕获 → 刷新页面 → action=dump 看请求列表
→ full_screenshot 整页截图 → page_capture 一次拿整页快照
→ edge_cdp_control action=disable 关回默认关闭

# 混合搭配（推荐姿势）
get_page_text 拿文本（快、免 CDP）→ 需要可信事件/网络观测时才用 CDP 通道工具
```

Agent 侧惯例：先 `edge_page_refs` 拿 ref 再 `edge_input_click`（ref 优先于 selector，比 CSS 选择器抗变化）。

## 3. 预览

- **测试沙箱**：Edge 打开 `extension/test/sandbox.html`——按钮/输入/表单/表格/滚动区齐全，专供 `input.*` 命令验证，所有交互写入页面底部事件日志
- **截图自证**：`edge_screenshot` 直接把图像返回给 Agent（MCP image content），可让它截一张验证
- **popup 预览**：扩展图标弹窗即控制台（连接状态/模式/审批/日志）

## 4. 启动与日志

```bash
# ZCode 内置终端：
npm run gateway        # 前台运行，日志实时滚动 + logs/gateway.log
node server/cli.mjs --gateway --cdp-port 9222   # 带 CDP 备用通路
```

| 需求 | 位置 |
|---|---|
| 实时日志 | ZCode 终端（gateway 模式 stdout） |
| 历史日志 | `logs/gateway.log` / `logs/mcp.log` |
| 扩展侧日志 | 扩展弹窗"运行日志"区（120 条环形） |
| SW console | `edge://extensions` → 扩展 → "服务 Worker" → 检查 |

## 5. 断点调试

**网关/CDP 后端（Node 侧）：**

```bash
node --inspect-brk=127.0.0.1:9230 server/cli.mjs --gateway
# Edge 打开 edge://inspect → Configure → 添加 127.0.0.1:9230 → inspect
# 在 gateway.mjs / cdp-backend.mjs 的 call() 处下断点，再从 ZCode 发命令
```

**扩展 SW（浏览器侧）：**

```
edge://extensions → ZCode Edge Controller → 服务 Worker → 检查
# Sources 面板给 handleCall() 下断点，WS 命令会停在断点
```

**popup：** 右键扩展图标 → "检查弹出内容"。

## 6. 修改代码后的刷新顺序

1. 改 `extension/` → `edge://extensions` 点"重新加载" → 弹窗点"重连"
2. 改 `server/` → 重启网关进程（扩展会自动重连）
3. 改协议/命令 → **两侧同步**（`extension/lib/protocol.js` 与 `server/protocol.mjs`），然后 `npm test` 确认 unit 测过同步性检查

## 7. 持续迭代任务指令模板

```
在 zcode-edge-controller 项目上继续迭代：
1. 先跑 npm test 与 node scripts/dev-check.mjs 确认基线全绿
2. [本次目标：新增命令 file.upload（CDP DOM.setFileInputFiles）|
   修复 issue：xxx | 性能：page.content 增量读取]
3. 遵循既有约束：命令表两侧同步（extension/lib/protocol.js + server/protocol.mjs + TOOLS），
   unit/e2e 补对应断言；写命令要考虑 readonly/confirm-writes 两档模式；
   注入函数保持自包含（executeScript 序列化）；MCP stdout 只走协议
4. 完成后：npm test 全绿 + 更新 README 命令矩阵与 docs
```

## 8. Roadmap（候选迭代项）

v1.1 已落地：`input.upload` 文件上传、`net.start/dump/stop` 网络捕获、跨域 iframe 元素操作（refs 带 frameId）、睡眠标签自动唤醒、多扩展实例并存、命令审计持久化（storage.local）、CDP 写命令审批闸门（`--confirm-cdp-writes`）、popup 审计一键复制。

剩余候选：
- iframe 内元素的 **native（CDP 可信坐标）点击**（需主文档坐标换算）
- net 捕获持久化（当前存 SW 内存，SW 被杀丢失）
- 多实例下按 tabId 智能路由
- 扩展侧录制回放（用户演示一次，agent 复放）
- badge 数字化审批队列（多个写命令排队确认）
