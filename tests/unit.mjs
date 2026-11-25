// 单元测试：两侧命令表同步、参数校验、MCP 工具覆盖、token 生成
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMANDS as EXT_CMDS, validateCmd as extValidate, classify as extClassify } from "../extension/lib/protocol.js";
import { COMMANDS as SRV_CMDS, classify as srvClassify, TOOLS } from "../server/protocol.mjs";
import { loadOrCreateToken, checkCmd } from "../server/security.mjs";

// 1. 扩展侧与网关侧命令集合一致（防止两份白名单漂移）
assert.deepEqual(
  Object.keys(EXT_CMDS).sort(),
  Object.keys(SRV_CMDS).sort(),
  "extension 与 server 命令表不同步"
);
console.log(`✓ 命令表同步（${Object.keys(EXT_CMDS).length} 条）`);

// 2. 读写分类一致
for (const k of Object.keys(EXT_CMDS)) {
  assert.equal(extClassify(k), srvClassify(k), `读写分类不一致: ${k}`);
}
console.log("✓ 读写分类一致");

// 3. 参数校验
assert.equal(extValidate("tabs.list", {}), null);
assert.match(String(extValidate("tabs.create", {})), /missing required param: url/);
assert.match(String(extValidate("page.eval", { expression: 123 })), /invalid/);
assert.equal(extValidate("input.type", { text: "hi" }), null);
assert.equal(extValidate("page.content", { format: "markdown" }), null);
assert.match(String(extValidate("page.content", { format: "yaml" })), /invalid/);
assert.equal(extValidate("tabs.close", { tabId: 7 }), null);
assert.match(String(extValidate("nope.cmd", {})), /unknown command/);
assert.match(String(extValidate("form.fill", { fields: "x" })), /invalid/);
assert.equal(extValidate("form.fill", { fields: [{ selector: "#a", value: "v" }] }), null);
console.log("✓ 参数校验（必填/类型/枚举/未知命令）");

// 4. 服务端白名单校验
assert.equal(checkCmd("tabs.list"), null);
assert.match(String(checkCmd("process.exec")), /unknown command/);
console.log("✓ 服务端白名单");

// 4b. 通道路由分级标注完整性（chan/risk/strong/nativeStrong）
const CRITICAL_EXPECT = new Set(["tabs.close", "page.eval", "input.upload", "net.start", "net.stop", "cdp.control"]);
for (const [k, d] of Object.entries(SRV_CMDS)) {
  assert.equal(d.chan, "both", `${k} 缺少 chan 标注`);
  assert.ok(["normal", "critical"].includes(d.risk), `${k} risk 非法`);
  if (d.strong) assert.equal(d.kind === "write" || k === "net.dump", true, `${k} strong 只应出现在写命令/net.dump`);
}
assert.deepEqual(
  Object.keys(SRV_CMDS).filter((k) => SRV_CMDS[k].risk === "critical").sort(),
  [...CRITICAL_EXPECT].sort(),
  "critical 高危命令集合不符"
);
for (const k of ["input.click", "input.type", "input.key", "input.scroll"]) {
  assert.equal(SRV_CMDS[k].nativeStrong, true, `${k} 缺 nativeStrong`);
}
for (const k of ["page.eval", "input.upload", "net.start", "net.dump", "net.stop"]) {
  assert.equal(SRV_CMDS[k].strong, true, `${k} 缺 strong`);
}
console.log(`✓ 通道路由分级（critical=${CRITICAL_EXPECT.size}，strong=5，nativeStrong=4）`);

// 5. MCP 工具定义完整覆盖命令表
const toolCmds = TOOLS.filter((t) => t.cmd).map((t) => t.cmd).sort();
assert.deepEqual(toolCmds, Object.keys(SRV_CMDS).sort(), "TOOLS 未覆盖全部命令");
const names = TOOLS.map((t) => t.tool);
assert.equal(new Set(names).size, names.length, "工具名重复");
for (const t of TOOLS) {
  assert.equal(t.schema.type, "object", `${t.tool}.inputSchema 必须是 object`);
  assert.ok(t.desc && t.desc.length > 5, `${t.tool} 缺少描述`);
}
console.log(`✓ MCP 工具定义（${TOOLS.length} 个，含 1 个内建 status）`);

// 5b. 通道别名工具（v1.4：工具名即通道）
const ALIAS = (await import("../server/protocol.mjs")).ALIAS_TOOLS;
const EXPECT_ALIAS = new Set([
  "list_tabs", "get_page_text", "simple_click", "simple_type", "basic_screenshot",
  "native_click", "network_intercept", "full_screenshot", "evaluate_js_context", "page_capture",
]);
assert.equal(ALIAS.length, 10, "别名工具应为 10 个");
assert.deepEqual(ALIAS.map((t) => t.tool).sort(), [...EXPECT_ALIAS].sort(), "别名工具集合不符");
const extAlias = ALIAS.filter((t) => t.channelPref === "ext").map((t) => t.tool).sort();
const cdpAlias = ALIAS.filter((t) => t.channelPref === "cdp").map((t) => t.tool).sort();
assert.deepEqual(extAlias, ["basic_screenshot", "get_page_text", "list_tabs", "simple_click", "simple_type"], "扩展通道别名不符");
assert.deepEqual(cdpAlias, ["evaluate_js_context", "full_screenshot", "native_click", "network_intercept", "page_capture"], "CDP 通道别名不符");
for (const t of ALIAS) {
  assert.equal(t.schema.type, "object", `${t.tool}.schema 必须是 object`);
  assert.ok(t.desc.includes("通道"), `${t.tool} 描述应标注通道`);
  if (t.compose) assert.ok(["page_capture", "network_intercept"].includes(t.compose), `${t.tool} compose 非法`);
  else assert.ok(SRV_CMDS[t.cmd], `${t.tool} 映射的命令不存在: ${t.cmd}`);
  if (t.paramsOverride && (t.tool === "simple_click" || t.tool === "simple_type")) {
    assert.equal(t.paramsOverride.native, false, "simple_* 应强制非 native");
  }
  if (t.tool === "native_click") assert.equal(t.paramsOverride.native, true, "native_click 应强制 native");
  if (t.tool === "full_screenshot") assert.equal(t.paramsOverride.fullPage, true, "full_screenshot 应强制整页");
}
console.log("✓ 通道别名工具（扩展 5 个 + CDP 5 个，参数映射/降级标注完整）");

// 6. token 生成与格式
const tmpFile = path.join(os.tmpdir(), `zc-token-test-${Date.now()}.token`);
const { token, source } = loadOrCreateToken({ file: tmpFile });
assert.match(token, /^[0-9a-f]{48}$/, "token 应为 48 位 hex");
assert.equal(source, "generated");
const again = loadOrCreateToken({ file: tmpFile });
assert.equal(again.token, token, "重复加载应复用文件中的 token");
assert.equal(again.source, "file");
fs.rmSync(tmpFile, { force: true });
console.log("✓ token 生成/持久化/加载");

console.log("\n✅ unit tests passed");
