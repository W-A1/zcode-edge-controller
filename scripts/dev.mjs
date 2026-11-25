// 一键开发环境：并行启动 网关 + 沙箱静态服务器，统一日志前缀，Ctrl+C 全停。
//   npm run dev            → gateway(9223) + sandbox(8090)
//   npm run dev -- --cdp   → 额外以 9222 启动独立 Edge 实例并启用 CDP 备用通路（网关 9323）
import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const wantCdp = process.argv.includes("--cdp");
const wantConfirm = process.argv.includes("--confirm-cdp-writes");

const procs = [];
function run(name, args, color) {
  const p = spawn(NODE, args, { cwd: ROOT, env: process.env });
  const tag = `[${name}] `;
  p.stdout.on("data", (d) => process.stdout.write(d.toString().split("\n").filter(Boolean).map((l) => tag + l).join("\n") + "\n"));
  p.stderr.on("data", (d) => process.stderr.write(d.toString().split("\n").filter(Boolean).map((l) => tag + l).join("\n") + "\n"));
  p.on("exit", (code) => {
    console.log(tag + `退出 code=${code}`);
    if (code !== 0 && code !== null) bye();
  });
  procs.push(p);
  return p;
}

function bye() {
  for (const p of procs) { try { p.kill(); } catch { /* 忽略 */ } }
  process.exit(0);
}
process.on("SIGINT", bye);
process.on("SIGTERM", bye);

console.log("=== ZCode Edge Controller 开发环境（Ctrl+C 全部停止）===");
run("gateway", ["server/cli.mjs", "--gateway"], "");
run("sandbox", ["scripts/serve-sandbox.mjs"], "");
if (wantCdp) {
  // 独立 Edge 实例 + CDP 网关（网关 9323，避免与主网关 9223 冲突）
  run("cdp-edge", ["scripts/launch-edge.mjs", "9222"], "");
  setTimeout(() => run("cdp-gw", ["server/cli.mjs", "--gateway", "--port", "9323", "--cdp-port", "9222", ...(wantConfirm ? ["--confirm-cdp-writes"] : [])], ""), 2000);
}
console.log(`\n配对 token: server/.token（首次由网关生成）`);
console.log(`弹窗配对 → 绿点后可跑: npm run smoke\n`);
