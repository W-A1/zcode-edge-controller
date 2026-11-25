// 服务端命令注册表 + MCP 工具定义
// 与 extension/lib/protocol.js 保持同步（tests/unit.mjs 自动比对）。
// 注意：TOOLS 中每个非 null cmd 的工具与 COMMANDS 一一对应。

export const COMMANDS = {
  // ---------------- 读 ----------------
  "tabs.list":       { kind: "read",  required: [], props: {}, chan: "both", risk: "normal" },
  "tab.get":         { kind: "read",  required: [], props: { tabId: "int?" }, chan: "both", risk: "normal" },
  "page.content":    { kind: "read",  required: [], props: { tabId: "int?", format: "text|markdown|html", selector: "str?", maxBytes: "int?" }, chan: "both", risk: "normal" },
  "page.refs":       { kind: "read",  required: [], props: { tabId: "int?", max: "int?" }, chan: "both", risk: "normal" },
  "page.screenshot": { kind: "read",  required: [], props: { tabId: "int?", fullPage: "bool?", format: "png|jpeg", quality: "int?" }, chan: "both", risk: "normal" },
  "wait.for":        { kind: "read",  required: [], props: { tabId: "int?", selector: "str?", text: "str?", timeoutMs: "int?", frameId: "int?" }, chan: "both", risk: "normal" },
  "net.dump":        { kind: "read",  required: [], props: { tabId: "int?", tail: "int?", withBodies: "bool?" }, chan: "both", risk: "normal", strong: true },
  // ---------------- 写（普通） ----------------
  "tabs.create":   { kind: "write", required: ["url"],    props: { url: "str", active: "bool?" }, chan: "both", risk: "normal" },
  "tabs.close":    { kind: "write", required: ["tabId"],  props: { tabId: "int" }, chan: "both", risk: "critical" },
  "tabs.activate": { kind: "write", required: ["tabId"],  props: { tabId: "int" }, chan: "both", risk: "normal" },
  "nav.goto":      { kind: "write", required: ["url"],    props: { tabId: "int?", url: "str", waitForLoad: "bool?" }, chan: "both", risk: "normal" },
  "nav.back":      { kind: "write", required: [],         props: { tabId: "int?" }, chan: "both", risk: "normal" },
  "nav.forward":   { kind: "write", required: [],         props: { tabId: "int?" }, chan: "both", risk: "normal" },
  "nav.reload":    { kind: "write", required: [],         props: { tabId: "int?" }, chan: "both", risk: "normal" },
  "input.click":   { kind: "write", required: [],         props: { tabId: "int?", ref: "str?", selector: "str?", text: "str?", native: "bool?" }, chan: "both", risk: "normal", nativeStrong: true },
  "input.type":    { kind: "write", required: ["text"],   props: { tabId: "int?", ref: "str?", selector: "str?", text: "str", clear: "bool?", submit: "bool?", native: "bool?" }, chan: "both", risk: "normal", nativeStrong: true },
  "input.key":     { kind: "write", required: ["key"],    props: { tabId: "int?", key: "str", native: "bool?" }, chan: "both", risk: "normal", nativeStrong: true },
  "input.scroll":  { kind: "write", required: [],         props: { tabId: "int?", dx: "int?", dy: "int?", ref: "str?", selector: "str?", native: "bool?" }, chan: "both", risk: "normal", nativeStrong: true },
  "form.fill":     { kind: "write", required: ["fields"], props: { tabId: "int?", fields: "array" }, chan: "both", risk: "normal" },
  // ---------------- 写（高危 / 强控制） ----------------
  "page.eval":     { kind: "write", required: ["expression"], props: { tabId: "int?", expression: "str", world: "ISOLATED|MAIN", awaitPromise: "bool?", maxBytes: "int?" }, chan: "both", risk: "critical", strong: true },
  "input.upload":  { kind: "write", required: ["files"], props: { tabId: "int?", selector: "str?", ref: "str?", files: "array" }, chan: "both", risk: "critical", strong: true },
  "net.start":     { kind: "write", required: [], props: { tabId: "int?", max: "int?" }, chan: "both", risk: "critical", strong: true },
  "net.stop":      { kind: "write", required: [], props: { tabId: "int?" }, chan: "both", risk: "critical", strong: true },
  // ---------------- 网关本地内建 ----------------
  "cdp.control":   { kind: "write", required: ["action"], props: { action: "enable|disable|status", cdpPort: "int?" }, chan: "both", risk: "critical" },
};

export function classify(cmd) {
  return Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd].kind : null;
}

// ---------------- MCP 工具定义 ----------------
const S = { int: { type: "integer" }, str: { type: "string" }, bool: { type: "boolean" } };

function schema(props, required = []) {
  const properties = {};
  for (const [k, v] of Object.entries(props)) properties[k] = typeof v === "object" && v !== null ? v : { type: v };
  return { type: "object", properties, required, additionalProperties: false };
}

export const TOOLS = [
  {
    tool: "edge_status", cmd: null, kind: "read",
    desc: "查看网关状态：扩展桥是否在线、CDP 备用通路、命令白名单。排查连接问题先调它。",
    schema: schema({}),
  },
  {
    tool: "edge_tabs_list", cmd: "tabs.list", kind: "read",
    desc: "列出 Edge 当前所有标签页（id/title/url/active/pinned）。",
    schema: schema({}),
  },
  {
    tool: "edge_tab_get", cmd: "tab.get", kind: "read",
    desc: "获取单个标签页详情；tabId 省略 = 当前激活标签页。",
    schema: schema({ tabId: S.int }),
  },
  {
    tool: "edge_navigate", cmd: "nav.goto", kind: "write",
    desc: "在标签页中打开 URL（裸域名自动补 https），默认等待页面加载完成。",
    schema: schema({ url: S.str, tabId: S.int, waitForLoad: S.bool }, ["url"]),
  },
  { tool: "edge_nav_back", cmd: "nav.back", kind: "write", desc: "浏览器后退一步（无历史时返回 moved=false）。", schema: schema({ tabId: S.int }) },
  { tool: "edge_nav_forward", cmd: "nav.forward", kind: "write", desc: "浏览器前进一步（无历史时返回 moved=false）。", schema: schema({ tabId: S.int }) },
  { tool: "edge_nav_reload", cmd: "nav.reload", kind: "write", desc: "刷新页面并等待加载完成（最长 30s）。", schema: schema({ tabId: S.int }) },
  {
    tool: "edge_tabs_create", cmd: "tabs.create", kind: "write",
    desc: "新建标签页并打开 URL。",
    schema: schema({ url: S.str, active: S.bool }, ["url"]),
  },
  { tool: "edge_tabs_close", cmd: "tabs.close", kind: "write", desc: "关闭指定标签页。", schema: schema({ tabId: S.int }, ["tabId"]) },
  { tool: "edge_tabs_activate", cmd: "tabs.activate", kind: "write", desc: "激活标签页（切到前台）。", schema: schema({ tabId: S.int }, ["tabId"]) },
  {
    tool: "edge_page_content", cmd: "page.content", kind: "read",
    desc: "读取页面内容。format=text 纯文本（默认）/ markdown 简易 Markdown（链接/表格/图片）/ html 原始 HTML；selector 可限定区域；默认截断 400KB。",
    schema: schema({ tabId: S.int, format: { type: "string", enum: ["text", "markdown", "html"] }, selector: S.str, maxBytes: S.int }),
  },
  {
    tool: "edge_page_refs", cmd: "page.refs", kind: "read",
    desc: "枚举当前页面可交互元素（链接/按钮/输入框…）并分配 ref 编号，供 edge_input_click / edge_input_type 用 ref 定位。页面变化后 refs 会过期，请重新获取。",
    schema: schema({ tabId: S.int, max: S.int }),
  },
  {
    tool: "edge_screenshot", cmd: "page.screenshot", kind: "read",
    desc: "对标签页截图并返回图像。fullPage=true 截整页滚动高度；format 可选 png（默认）/jpeg。",
    schema: schema({ tabId: S.int, fullPage: S.bool, format: { type: "string", enum: ["png", "jpeg"] }, quality: S.int }),
  },
  {
    tool: "edge_wait_for", cmd: "wait.for", kind: "read",
    desc: "等待页面出现指定 CSS selector 或文本（轮询，默认 10s 超时）。导航后等元素渲染常用；frameId 可指定在某个跨域 iframe 内等待。",
    schema: schema({ tabId: S.int, selector: S.str, text: S.str, timeoutMs: S.int, frameId: S.int }),
  },
  {
    tool: "edge_input_click", cmd: "input.click", kind: "write",
    desc: "点击元素。定位优先级：ref（page.refs 编号）> CSS selector > 可见文本模糊匹配。native=true 时走 CDP 可信鼠标事件（更接近真实用户）。",
    schema: schema({ tabId: S.int, ref: S.str, selector: S.str, text: S.str, native: S.bool }),
  },
  {
    tool: "edge_input_type", cmd: "input.type", kind: "write",
    desc: "向输入框输入文本（ref/selector 定位；默认清空原值，clear=false 追加；submit=true 输入后提交表单；native=true 走 CDP insertText 可信输入，中文友好）。ref/selector 都省略时输入到当前焦点元素。",
    schema: schema({ tabId: S.int, ref: S.str, selector: S.str, text: S.str, clear: S.bool, submit: S.bool, native: S.bool }, ["text"]),
  },
  {
    tool: "edge_input_key", cmd: "input.key", kind: "write",
    desc: "向当前焦点元素发送按键（Enter/Tab/Escape/ArrowDown/Home…）。",
    schema: schema({ tabId: S.int, key: S.str, native: S.bool }, ["key"]),
  },
  {
    tool: "edge_input_scroll", cmd: "input.scroll", kind: "write",
    desc: "滚动页面：dx/dy 像素增量；或 ref/selector 定位元素并滚动到其可见。",
    schema: schema({ tabId: S.int, dx: S.int, dy: S.int, ref: S.str, selector: S.str }),
  },
  {
    tool: "edge_form_fill", cmd: "form.fill", kind: "write",
    desc: "批量填写表单：fields=[{ref|selector, value, clear}]，一次注入完成全部赋值。",
    schema: schema({ tabId: S.int, fields: { type: "array", items: { type: "object", properties: { ref: S.str, selector: S.str, value: S.str, clear: S.bool }, required: ["value"] } } }, ["fields"]),
  },
  {
    tool: "edge_eval_js", cmd: "page.eval", kind: "write",
    desc: "在页面执行任意 JS 表达式并返回 JSON 安全化结果。world=MAIN 可访问页面自身 JS 全局（SPA 状态等）；ISOLATED（默认）仅 DOM。走 chrome.debugger（CDP Runtime.evaluate），awaitPromise 原生支持。受写确认约束。",
    schema: schema({ tabId: S.int, expression: S.str, world: { type: "string", enum: ["ISOLATED", "MAIN"] }, awaitPromise: S.bool, maxBytes: S.int }, ["expression"]),
  },
  {
    tool: "edge_input_upload", cmd: "input.upload", kind: "write",
    desc: "向 <input type=file> 注入本地文件。files 为本机绝对路径数组（网关与 Edge 同机，路径必须真实存在，网关侧校验）。selector/ref 定位文件输入框；设值后需自行提交表单。",
    schema: schema({ tabId: S.int, selector: S.str, ref: S.str, files: { type: "array", items: S.str } }, ["files"]),
  },
  {
    tool: "edge_net_start", cmd: "net.start", kind: "write",
    desc: "开始捕获该标签页的网络请求/响应（CDP Network 域；记录 URL/方法/状态/响应体摘要）。收集存于扩展 SW 内存（SW 被杀丢失，上限默认 300 条）。之后用 edge_net_dump 读取、edge_net_stop 停止。",
    schema: schema({ tabId: S.int, max: S.int }),
  },
  {
    tool: "edge_net_dump", cmd: "net.dump", kind: "read",
    desc: "读取网络捕获：events（最近 tail 条，含 url/method/status/mimeType）+ bodies（最近若干条响应体摘要，≤8KB/条）。withBodies=false 跳过响应体读取。",
    schema: schema({ tabId: S.int, tail: S.int, withBodies: S.bool }),
  },
  {
    tool: "edge_net_stop", cmd: "net.stop", kind: "write",
    desc: "停止网络捕获并释放 debugger 连接。",
    schema: schema({ tabId: S.int }),
  },
  {
    tool: "edge_cdp_control", cmd: "cdp.control", kind: "write",
    desc: "CDP 通道总开关（网关本地执行，高危需确认）。action=enable：按需拉起带远程调试的 Edge 并建立 CDP 会话（此后强控制类命令自动走 CDP，其余仍走扩展）；action=disable：关闭 CDP 会话回到纯扩展通路；action=status：查看通道状态。CDP 未启用时所有命令自动降级扩展通路，不会报错。",
    schema: schema({ action: { type: "string", enum: ["enable", "disable", "status"] }, cdpPort: S.int }, ["action"]),
  },
];

// ---------------- 通道别名工具（v1.4：工具名即通道） ----------------
// 每个 alias 固定绑定通道（channelPref: "ext" | "cdp" | null=自动路由），
// 网关路由时 __preferChannel 优先于自动矩阵；绑定通道不可用时自动降级到对侧（不崩溃）。
// requiresCdp: true 的工具在 CDP 未启用时于 tools/list 描述中标注降级说明。
export const ALIAS_TOOLS = [
  // ---- 扩展通道（普通读写，保留审批闸门） ----
  { tool: "list_tabs", cmd: "tabs.list", channelPref: "ext", requiresCdp: false, kind: "read",
    desc: "【扩展通道】列出 Edge 当前所有标签页（id/title/url/active）。",
    schema: schema({}) },
  { tool: "get_page_text", cmd: "page.content", channelPref: "ext", requiresCdp: false, kind: "read",
    paramsOverride: { format: "text" },
    desc: "【扩展通道】读取页面文本（可 selector 限定区域）。CDP 未启用时等价。",
    schema: schema({ tabId: S.int, selector: S.str, maxBytes: S.int }) },
  { tool: "simple_click", cmd: "input.click", channelPref: "ext", requiresCdp: false, kind: "write",
    paramsOverride: { native: false },
    desc: "【扩展通道】点击元素（ref > selector > 文本匹配；注入式点击，无需 CDP）。",
    schema: schema({ tabId: S.int, ref: S.str, selector: S.str, text: S.str }) },
  { tool: "simple_type", cmd: "input.type", channelPref: "ext", requiresCdp: false, kind: "write",
    paramsOverride: { native: false },
    desc: "【扩展通道】向输入框输入文本（React/Vue 兼容；默认清空，clear=false 追加，submit=true 提交）。",
    schema: schema({ tabId: S.int, ref: S.str, selector: S.str, text: S.str, clear: S.bool, submit: S.bool }, ["text"]) },
  { tool: "basic_screenshot", cmd: "page.screenshot", channelPref: "ext", requiresCdp: false, kind: "read",
    paramsOverride: { fullPage: false },
    desc: "【扩展通道】对当前视口截图（返回图像；整页请用 full_screenshot）。",
    schema: schema({ tabId: S.int, format: { type: "string", enum: ["png", "jpeg"] }, quality: S.int }) },
  // ---- CDP 通道（强控制；未启用时自动降级扩展通路） ----
  { tool: "native_click", cmd: "input.click", channelPref: "cdp", requiresCdp: true, kind: "write",
    paramsOverride: { native: true },
    desc: "【CDP 通道】以浏览器级可信鼠标事件点击（isTrusted=true，绕过合成点击限制）。CDP 未启用时自动降级为扩展注入式点击。",
    schema: schema({ tabId: S.int, ref: S.str, selector: S.str, text: S.str }) },
  { tool: "network_intercept", compose: "network_intercept", channelPref: "cdp", requiresCdp: true, kind: "write",
    desc: "【CDP 通道】网络请求捕获会话：start 开始监控 / dump 读取（含响应体摘要） / stop 停止。CDP 未启用时自动降级为扩展通路的网络捕获。",
    schema: schema({ tabId: S.int, action: { type: "string", enum: ["start", "dump", "stop"] }, tail: S.int, withBodies: S.bool, max: S.int }, ["action"]) },
  { tool: "full_screenshot", cmd: "page.screenshot", channelPref: "cdp", requiresCdp: true, kind: "read",
    paramsOverride: { fullPage: true },
    desc: "【CDP 通道】整页滚动高度截图（captureBeyondViewport）。CDP 未启用时自动降级为扩展通路实现。",
    schema: schema({ tabId: S.int, format: { type: "string", enum: ["png", "jpeg"] }, quality: S.int }) },
  { tool: "evaluate_js_context", cmd: "page.eval", channelPref: "cdp", requiresCdp: true, kind: "write",
    desc: "【CDP 通道】在页面 JS 主世界强制上下文执行表达式（可访问页面全局/SPA 状态；awaitPromise 原生支持）。CDP 未启用时自动降级为扩展通路（走 chrome.debugger 等价实现）。",
    schema: schema({ tabId: S.int, expression: S.str, world: { type: "string", enum: ["ISOLATED", "MAIN"] }, awaitPromise: S.bool, maxBytes: S.int }, ["expression"]) },
  { tool: "page_capture", compose: "page_capture", channelPref: "cdp", requiresCdp: true, kind: "read",
    desc: "【CDP 通道】页面完整快照：整页截图 + 文本内容 + title/url 一次返回。CDP 未启用时自动降级为扩展通路组合实现。",
    schema: schema({ tabId: S.int, textMaxBytes: S.int }) },
];
