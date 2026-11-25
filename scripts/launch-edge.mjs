// 以独立 profile + 远程调试端口启动 Edge（供 CDP 备用通路 / 调试使用）
// 注意：新版 Chromium 已禁用 --load-extension 启动参数，扩展请在 edge://extensions 开发者模式手动加载。
// 用法：node scripts/launch-edge.mjs [port=9222]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.EDGE_EXE,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

const exe = candidates.find((p) => fs.existsSync(p));
if (!exe) {
  console.error("未找到 msedge.exe，可用 EDGE_EXE 环境变量指定路径");
  process.exit(1);
}

const port = Number(process.argv[2] || 9222);
const profile = path.join(ROOT, ".edge-profile");
fs.mkdirSync(profile, { recursive: true });

const child = spawn(
  exe,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore", detached: true }
);
child.unref();

console.log(`Edge 已启动 (pid=${child.pid})`);
console.log(`CDP 端点: http://127.0.0.1:${port}/json/version`);
console.log(`独立 profile: ${profile}`);
console.log(`下一步: node server/cli.mjs --cdp-port ${port}   # 启用 CDP 备用通路`);
console.log(`提示: 独立 profile 中需要重新加载扩展（edge://extensions → 开发人员模式 → 加载解压缩的扩展 → 选择 extension 目录）`);
