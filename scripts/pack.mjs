// 打包扩展目录为 zip（PowerShell Compress-Archive），输出到 dist/
// 产物可直接在 Edge 商店上传页 / edge://extensions 离线安装使用
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
const outDir = path.join(ROOT, "dist");
fs.mkdirSync(outDir, { recursive: true });
const zip = path.join(outDir, `zcode-edge-controller-extension-v${manifest.version}.zip`);

if (fs.existsSync(zip)) fs.rmSync(zip);
const extDir = path.join(ROOT, "extension").replace(/'/g, "''");
const zipEsc = zip.replace(/'/g, "''");

execFileSync(
  "powershell",
  ["-NoProfile", "-Command", `Compress-Archive -Path (Join-Path '${extDir}' '*') -DestinationPath '${zipEsc}' -Force`],
  { stdio: "inherit" }
);

const size = (fs.statSync(zip).size / 1024).toFixed(1);
console.log(`打包完成: ${zip} (${size} KB)`);
console.log(`版本: ${manifest.version}  权限: ${manifest.permissions.join(", ")}`);
