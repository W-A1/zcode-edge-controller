#!/usr/bin/env node
// 统一入口：
//   node server/cli.mjs            → Gateway 模式（WS 桥 + REST），前台运行，Ctrl+C 退出
//   node server/cli.mjs --mcp     → MCP 模式（stdio；内嵌同进程网关；stdout 只输出协议消息）
// 通用参数：--port 9223 | --cdp-port 9222 | --prefer extension|cdp | --token <xxx>
import path from "node:path";
import url from "node:url";
import { createGateway } from "./gateway.mjs";
import { createMcpStdio } from "./mcp.mjs";
import { loadOrCreateToken } from "./security.mjs";
import { createLogger } from "./logger.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { out[k] = next; i++; }
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mcpMode = !!args.mcp;
  const logFile = path.join(ROOT, "logs", mcpMode ? "mcp.log" : "gateway.log");
  // MCP 模式日志走 stderr：stdout 是协议通道
  const log = createLogger({ file: logFile, to: mcpMode ? "stderr" : "stdout" });

  const { token, source } = loadOrCreateToken({
    tokenArg: typeof args.token === "string" ? args.token : undefined,
    env: process.env.ZC_EDGE_TOKEN,
    file: path.join(ROOT, "server", ".token"),
  });

  let gateway;
  try {
    gateway = await createGateway({
      port: args.port === true || args.port === undefined ? 9223 : Number(args.port) || 0,
      token,
      prefer: args.prefer === "cdp" ? "cdp" : "extension",
      cdpPort: args["cdp-port"] ? Number(args["cdp-port"]) : 0, // 显式 --cdp-port 才启动即启用；默认关闭
      prefer: ["auto", "extension", "cdp"].includes(args.prefer) ? args.prefer : "auto", // v1.3 默认命令级路由矩阵
      confirmCdpWrites: !!args["confirm-cdp-writes"],
      log,
    });
  } catch (e) {
    if (String(e.message).includes("EADDRINUSE")) {
      // 端口已被占：探测是否为同 token 的既有网关，是则降级为 REST 转发模式（MCP 复用网关）
      const reuse = Number(args.port) || 9223;
      try {
        const h = await fetch(`http://127.0.0.1:${reuse}/healthz`, { signal: AbortSignal.timeout(2000) });
        const hj = await h.json();
        if (hj?.ok) {
          log(`[mcp] 端口 ${reuse} 已有网关运行，本进程降级为 REST 转发模式（复用网关）`);
          const restCall = async (cmd, params) => {
            const r = await fetch(`http://127.0.0.1:${reuse}/call`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ cmd, params }),
              signal: AbortSignal.timeout(120000),
            });
            const j = await r.json().catch(() => ({ ok: false, error: `bad response http ${r.status}` }));
            if (!j.ok) throw new Error(j.error || `gateway http ${r.status}`);
            return j.data;
          };
          const restStatus = async () => {
            try {
              const hj2 = await (await fetch(`http://127.0.0.1:${reuse}/healthz`, { signal: AbortSignal.timeout(2000) })).json();
              return { extensionOnline: !!hj2.extensionOnline, cdp: hj2.cdp ?? null, prefer: hj2.prefer, uptimeS: hj2.uptimeS, commands: hj2.commands ?? [], mode: "rest-relay" };
            } catch { return { extensionOnline: false, cdp: null, error: "gateway unreachable", mode: "rest-relay" }; }
          };
          createMcpStdio({ call: restCall, status: restStatus, log });
          log(`[ready] MCP(stdio) → REST 转发 → 已有网关 :${reuse}，等待 MCP host 对话…`);
          return; // 保持 stdin 打开由 mcp.mjs 管理
        }
      } catch { /* 不是我们的网关 */ }
      log(`[fatal] 端口 ${reuse} 被其他程序占用且不是本网关。请停掉占用进程，或给本进程指定 --port 并在扩展弹窗同步修改网关地址。`);
      process.exit(1);
    }
    throw e;
  }

  // 安全：不在日志中输出完整 token（日志文件可能被同步/上传/误提交）
  const masked = token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "****";
  log(`[token] ${masked} (source=${source}) — 完整 token 见 server/.token 文件（勿外泄），粘贴到扩展弹窗完成配对`);
  log(`[use]   MCP: ZCode 配置 command=node args=[server/cli.mjs, --mcp]`);
  log(`[use]   REST: POST http://127.0.0.1:${gateway.port}/call  body={"cmd":"tabs.list"}`);

  if (mcpMode) {
    createMcpStdio({ call: gateway.call, status: gateway.status, log });
  } else {
    const bye = async () => { await gateway.close().catch(() => {}); process.exit(0); };
    process.on("SIGINT", bye);
    process.on("SIGTERM", bye);
    log(`[ready] 网关运行中，等待扩展连接…（Ctrl+C 退出）`);
  }
}

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
