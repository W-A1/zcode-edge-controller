// 端到端（MCP 通路）：spawn cli.mjs --mcp，走 stdio JSON-RPC 完整对话
// 验证 initialize / tools/list / tools/call(edge_status) / 无扩展时的报错结构
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(ROOT, "server", "cli.mjs"), "--mcp", "--port", "0"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const waiters = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const w = waiters.shift();
    try { w?.(JSON.parse(line)); } catch (e) { console.error("[test] bad json:", line.slice(0, 200)); }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[mcp] " + d.toString()));

let seq = 100;
function rpc(method, params) {
  const id = ++seq;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res, rej) => {
    waiters.push(res);
    setTimeout(() => rej(new Error(`rpc timeout: ${method}`)), 20000);
  });
}
function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

try {
  // 1) initialize 握手
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "zcode-e2e-test", version: "0" },
  });
  assert.equal(init.result.serverInfo.name, "zcode-edge-controller");
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.ok(init.result.capabilities.tools);
  notify("notifications/initialized");
  console.log("✓ initialize 握手");

  // 2) tools/list
  const tools = await rpc("tools/list", {});
  const names = tools.result.tools.map((t) => t.name);
  assert.ok(names.length >= 20, `工具数量应 ≥20，实际 ${names.length}`);
  for (const must of ["edge_tabs_list", "edge_screenshot", "edge_navigate", "edge_eval_js", "edge_status"]) {
    assert.ok(names.includes(must), `缺少工具 ${must}`);
  }
  const sch = tools.result.tools.find((t) => t.name === "edge_input_type").inputSchema;
  assert.deepEqual(sch.required, ["text"]);
  console.log(`✓ tools/list（${names.length} 个工具，schema 完整）`);

  // 3) tools/call edge_status（网关本地应答，不依赖扩展）
  const st = await rpc("tools/call", { name: "edge_status", arguments: {} });
  assert.equal(st.result.isError, false);
  assert.match(st.result.content[0].text, /extensionOnline/);
  assert.match(st.result.content[0].text, /tabs\.list/);
  console.log("✓ tools/call edge_status");

  // 4) tools/call 未知工具 → isError 结构
  const bad = await rpc("tools/call", { name: "edge_not_exist", arguments: {} });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /unknown tool/);
  console.log("✓ 未知工具报错结构");

  // 5) 无扩展在线时 tabs.list → 业务错误以 isError:true 返回（不挂死）
  const tl = await rpc("tools/call", { name: "edge_tabs_list", arguments: {} });
  assert.equal(tl.result.isError, true);
  assert.match(tl.result.content[0].text, /扩展桥未连接|无可用后端/);
  console.log("✓ 无扩展在线的业务错误通路");

  // 6) 白名单外命令（经由假工具名到达命令层不适用，改测 REST 层已在 gateway e2e 覆盖）

  console.log("\n✅ e2e-mcp passed");
} finally {
  child.kill();
  setTimeout(() => process.exit(0), 200);
}
