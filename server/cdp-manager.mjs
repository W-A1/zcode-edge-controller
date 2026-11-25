// CDP 通道运行时管理（默认关闭，按需启用）：
//   enable : 若调试端点不可用则自动拉起带 --remote-debugging-port 的独立 Edge 实例，
//            轮询就绪后创建 CDP 后端（会话管理交给 cdp-backend）
//   disable: 关闭 CDP 会话（backend.close），Edge 实例保留（可反复 enable 复用）
//   status : {enabled, browser, port, pages, edgeSpawnedByUs}
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createCdpBackend } from "./cdp-backend.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const EDGE_CANDIDATES = [
  process.env.EDGE_EXE,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

export function createCdpManager({ log = () => {} } = {}) {
  let backend = null;
  let cdpPort = 0;
  let edgeSpawnedByUs = false;
  let starting = null; // 并发 enable 去重

  async function probeEndpoint(port, timeoutMs = 1500) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  function spawnEdge(port) {
    const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
    if (!exe) throw new Error("未找到 msedge.exe（可用 EDGE_EXE 环境变量指定）");
    const profile = path.join(ROOT, ".edge-profile");
    fs.mkdirSync(profile, { recursive: true });
    const child = spawn(exe, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ], { stdio: "ignore", detached: true });
    child.unref();
    edgeSpawnedByUs = true;
    log(`[cdp] 已拉起独立 Edge 实例 pid=${child.pid}（--remote-debugging-port=${port}，独立 profile ${profile}）`);
    return child;
  }

  async function enable(cdpPortArg) {
    if (backend) return { ok: true, alreadyEnabled: true, ...status() };
    if (starting) return starting; // 并发 enable 复用同一次启动

    starting = (async () => {
      const port = Number(cdpPortArg) || 9222;
      cdpPort = port;
      // 端点上已有调试实例则直接复用；否则自动拉起
      let version = await probeEndpoint(port);
      if (!version) {
        log(`[cdp] 127.0.0.1:${port} 无调试端点，自动拉起独立 Edge 实例…`);
        spawnEdge(port);
        // 轮询就绪（最多 15s）
        const t0 = Date.now();
        while (Date.now() - t0 < 15000) {
          await new Promise((r) => setTimeout(r, 600));
          version = await probeEndpoint(port, 1000);
          if (version) break;
        }
        if (!version) throw new Error(`Edge 调试端点未就绪（127.0.0.1:${port}，15s 超时）——检查 Edge 是否被安全软件拦截`);
      }
      backend = createCdpBackend({ port, log });
      const probe = await backend.probe().catch((e) => { throw new Error(`CDP 会话建立失败: ${e.message}`); });
      log(`[cdp] 通道已启用 @ 127.0.0.1:${port}（${typeof probe === "string" ? probe : "ready"}）`);
      return { ok: true, ...status() };
    })();

    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  async function disable() {
    if (!backend) return { ok: true, alreadyDisabled: true, ...status() };
    await backend.close().catch(() => {});
    backend = null;
    log("[cdp] 通道已停用（Edge 实例保留，可随时再次启用）");
    return { ok: true, ...status() };
  }

  function status() {
    return {
      enabled: !!backend,
      cdpPort,
      edgeSpawnedByUs,
      ...(backend ? { backend: backend.state() } : {}),
    };
  }

  // 启动参数 --cdp-port 语义 = "启动时即启用"（向后兼容 v1.2 及 e2e 测试）
  async function initIfConfigured(port) {
    if (port) return enable(port);
    return status();
  }

  async function close() {
    await disable();
  }

  return { enable, disable, status, initIfConfigured, close, get backend() { return backend; } };
}
