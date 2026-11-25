// 日志：控制台 + 可选落盘。MCP 模式必须写 stderr（stdout 是协议通道，不能污染）。
import fs from "node:fs";
import path from "node:path";

export function createLogger({ file, to = "stdout" } = {}) {
  const out = to === "stderr" ? (...a) => console.error(...a) : (...a) => console.log(...a);
  let stream = null;
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: "a" });
  }
  return (...parts) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${parts.join(" ")}`;
    out(line);
    stream?.write(line + "\n");
  };
}
