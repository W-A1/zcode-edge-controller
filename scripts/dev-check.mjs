// 环境自检：Node 版本 / 依赖 / 文件完整性 / 端口 / Edge 路径
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, 1500);
  });
}

// 1) Node 版本
const [maj, min] = process.versions.node.split(".").map(Number);
check("Node 版本 ≥ 18.17", maj > 18 || (maj === 18 && min >= 17), `当前 ${process.versions.node}`);

// 2) ws 依赖
try {
  const ws = await import("ws");
  check("ws 依赖已安装", !!ws.WebSocketServer, "import ws ✓");
} catch {
  check("ws 依赖已安装", false, "请执行: npm install");
}

// 3) 文件完整性
const required = [
  "extension/manifest.json",
  "extension/background/service-worker.js",
  "extension/lib/protocol.js",
  "extension/lib/security.js",
  "extension/lib/cdp.js",
  "extension/lib/dom.js",
  "extension/lib/commands/inject.js",
  "extension/lib/commands/read.js",
  "extension/lib/commands/write.js",
  "extension/lib/commands/net.js",
  "extension/popup/popup.html",
  "extension/popup/popup.js",
  "extension/popup/popup.css",
  "extension/test/sandbox.html",
  "server/cli.mjs",
  "server/gateway.mjs",
  "server/mcp.mjs",
  "server/cdp-backend.mjs",
  "server/protocol.mjs",
  "server/security.mjs",
  "server/logger.mjs",
  "scripts/dev.mjs",
  "scripts/serve-sandbox.mjs",
  "scripts/smoke-test.mjs",
  "scripts/launch-edge.mjs",
  "scripts/pack.mjs",
  "tests/unit.mjs",
  "tests/e2e-mcp.mjs",
  "tests/e2e-gateway.mjs",
  "README.md",
  "docs/INSTALL.md",
  "docs/ARCHITECTURE.md",
  "docs/TROUBLESHOOTING.md",
  "docs/ZCODE-INTEGRATION.md",
];
const missing = required.filter((f) => !fs.existsSync(path.join(ROOT, f)));
check("项目文件完整性", missing.length === 0, missing.length ? `缺失: ${missing.join(", ")}` : `${required.length} 个文件齐全`);

// 4) 端口状态（提示性质，占用不一定是错误）
const g = await portOpen(9223);
check("端口 9223（网关）", true, g ? "已有服务在监听（网关可能已在运行）" : "空闲");
const c = await portOpen(9222);
check("端口 9222（CDP）", true, c ? "已有服务在监听（可能存在带调试端口的 Edge 实例）" : "空闲");

// 5) Edge 可执行文件
const candidates = [
  process.env.EDGE_EXE,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const edge = candidates.find((p) => fs.existsSync(p));
check("Edge 浏览器路径", !!edge, edge || "未找到，可用 EDGE_EXE 环境变量指定");

// 6) token 文件
const tok = path.join(ROOT, "server", ".token");
check("配对 token", fs.existsSync(tok), fs.existsSync(tok) ? "server/.token 已存在" : "尚未生成（首次启动网关时自动生成）");

// ---- 汇总 ----
console.log("\n=== ZCode Edge Controller 环境自检 ===");
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? "  —  " + r.detail : ""}`);
}
const hardFail = results.filter((r) => !r.ok).length;
console.log(`\n${hardFail ? "发现问题（见 ✗ 项）" : "全部就绪 ✓"}`);
process.exit(0);
