// 命令注册表 —— 扩展侧（本文件无浏览器 API，可被 Node 测试直接 import）
// 注意：server/protocol.mjs 持有同一份命令表（网关侧二次校验 + MCP 工具定义）。
// 两侧必须保持同步：tests/unit.mjs 会自动比对命令集合与读写分类的一致性。

export const PROTOCOL_VERSION = 1;
export const GATEWAY_DEFAULT_URL = "ws://127.0.0.1:9223/bridge";
export const MODES = ["readonly", "confirm-writes", "auto"];

/**
 * kind:  "read" = 无副作用；"write" = 有副作用（受三档模式与确认开关约束）
 * risk:  "normal" = 普通操作；"critical" = 高危（强制用户确认，auto 模式也不例外）
 * chan:  "both" = 扩展/CDP 双实现
 * strong: true = CDP 启用时强制走 CDP（深度 JS / 文件注入 / 网络拦截等强控制能力）
 * nativeStrong: true = params.native=true 时走 CDP 可信事件通道
 * required: 必填参数名
 * props:    参数类型速查（"int?" / "str" / "bool?" / "array" / 枚举 "a|b|c"）
 */
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
  // ---------------- 网关本地内建（不经扩展桥/CDP，网关特判处理） ----------------
  "cdp.control":   { kind: "write", required: ["action"], props: { action: "enable|disable|status", cdpPort: "int?" }, chan: "both", risk: "critical" },
};

/** 读/写分类；未知命令返回 null（own-property 校验，防原型链属性被误认） */
export function classify(cmd) {
  return Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd].kind : null;
}

/** 轻量参数校验：必填 + 类型速查 + 范围约束。通过返回 null，否则返回错误描述字符串。 */
export function validateCmd(cmd, params) {
  if (typeof cmd !== "string" || !Object.hasOwn(COMMANDS, cmd)) return `unknown command: ${cmd}`;
  const def = COMMANDS[cmd];
  if (params == null) params = {};
  if (typeof params !== "object" || Array.isArray(params)) return "params must be an object";
  for (const k of def.required) {
    const v = params[k];
    if (v === undefined || v === null || v === "") return `missing required param: ${k}`;
  }
  for (const [k, spec] of Object.entries(def.props || {})) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    let ok;
    if (spec.includes("|")) {
      ok = spec.split("|").map((s) => s.trim()).includes(String(v));
    } else {
      const base = spec.endsWith("?") ? spec.slice(0, -1) : spec;
      ok =
        base === "int" ? Number.isInteger(v) :
        base === "str" ? typeof v === "string" :
        base === "bool" ? typeof v === "boolean" :
        base === "array" ? Array.isArray(v) : true;
    }
    if (!ok) return `param "${k}" invalid: expected ${spec}`;
  }
  // 数值范围约束（防负数/超大值导致内部 500 或资源耗尽）
  const NUM_RANGES = {
    maxBytes: [1, 4 * 1024 * 1024],
    max: [1, 5000],
    tail: [1, 2000],
    quality: [1, 100],
    timeoutMs: [1, 60000],
    tabId: [0, Number.MAX_SAFE_INTEGER],
    frameId: [0, Number.MAX_SAFE_INTEGER],
    dx: [-100000, 100000],
    dy: [-100000, 100000],
    cdpPort: [1, 65535],
  };
  for (const [k, [lo, hi]] of Object.entries(NUM_RANGES)) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return `param "${k}" must be a finite number`;
    if (v < lo || v > hi) return `param "${k}" out of range [${lo}, ${hi}]（收到 ${v}）`;
  }
  return null;
}
