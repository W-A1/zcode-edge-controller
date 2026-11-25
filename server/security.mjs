// 服务端安全层：token 加载/生成、鉴权、命令白名单校验
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { COMMANDS, classify } from "./protocol.mjs";

/**
 * token 来源优先级：--token 参数 > 环境变量 ZC_EDGE_TOKEN > server/.token 文件（无则生成）
 */
export function loadOrCreateToken({ tokenArg, env, file }) {
  if (tokenArg) return { token: tokenArg, source: "arg" };
  if (env) return { token: env, source: "env" };
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return { token: t, source: "file" };
  } catch { /* 文件不存在 */ }
  const t = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  return { token: t, source: "generated" };
}

/** 网关侧命令白名单二次校验（扩展侧还有一份同名白名单）
 *  安全：用 own-property 校验，防止 cmd="__proto__"/"constructor"/"toString" 等
 *  原型链属性被当作合法命令（会取到 Object.prototype 上的值而非命令定义）。 */
export function checkCmd(cmd) {
  if (typeof cmd !== "string") return "cmd must be a string";
  if (!Object.hasOwn(COMMANDS, cmd)) return `unknown command: ${cmd}（白名单见 edge_status）`;
  return null;
}

/** 鉴权：恒定时间比较，避免 token 逐字符比较的时序侧信道 */
export function bearerOk(req, token) {
  const given = Buffer.from(String(req.headers["authorization"] || ""), "utf8");
  const want = Buffer.from(`Bearer ${token}`, "utf8");
  if (given.length !== want.length) return false;
  try { return crypto.timingSafeEqual(given, want); } catch { return false; }
}

/** WebSocket upgrade 阶段的来源检查：仅放行无 Origin（Node ws 客户端/curl）与扩展/DevTools 来源。
 *  注意不放行 origin="null"（file:// 沙箱页面可伪造），浏览器发起的 ws 恒带 Origin。 */
export function originOk(origin) {
  if (!origin) return true; // Node ws 客户端、curl 不带 Origin
  return (
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("devtools://")
  );
}

/** HTTP 请求来源检查（REST 面）：与 WS 同规则，浏览器跨站请求直接拒绝 */
export function httpOriginOk(origin) {
  if (!origin) return true; // 本地脚本/curl 不带 Origin
  return origin.startsWith("chrome-extension://") || origin.startsWith("devtools://");
}
