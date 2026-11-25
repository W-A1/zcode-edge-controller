// 沙箱静态服务器：把 extension/ 目录 serve 到 http://127.0.0.1:<port>（默认 8090）
// 目的：file:// 页面受扩展"允许访问文件网址"开关限制，走 http 最稳；
//      也让 CDP 实例（独立 profile）可以直接打开沙箱页。
// 用法：node scripts/serve-sandbox.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const PORT = Number(process.argv[2] || 8090);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  let file = path.join(EXT, urlPath === "/" ? "test/sandbox.html" : urlPath.replace(/^\//, ""));
  if (!file.startsWith(EXT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("not found: " + urlPath); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[sandbox] http://127.0.0.1:${PORT}/test/sandbox.html`);
});
