// CDP 直连执行器：绕过扩展 SW，直接通过调试端口执行 JS
// 背景：扩展 SW 里 chrome.debugger.sendCommand 在页面主线程死循环时会阻塞 SW 事件循环，
//      导致 Promise.race 定时器都不触发、熔断失效、连带其他标签页受影响（实测确认）。
// 方案：page.eval 同时支持"扩展通路(带熔断)"与"CDP 直连通路"，后者在独立进程执行，
//      死循环只阻塞该页面的渲染进程，网关与 SW 均不受影响。
import { WebSocket } from "ws";

const PAGES_CACHE_MS = 500;

export function createDirectEval({ port = 9222, log = () => {} } = {}) {
  let targets = { at: 0, list: [] };
  const pageConns = new Map(); // targetId -> {ws, seq, pend, alive}

  async function listPages() {
    if (Date.now() - targets.at < PAGES_CACHE_MS) return targets.list;
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`CDP /json/list ${res.status}`);
    const all = await res.json();
    targets = { at: Date.now(), list: (all || []).filter((t) => t.type === "page") };
    return targets.list;
  }

  async function pageConn(targetId) {
    const cur = targetId && pageConns.get(targetId);
    if (cur && cur.ws.readyState === 1) return cur;
    const pages = await listPages();
    if (!pages.length) throw new Error("CDP 无可用 page target");
    // 显式 targetId 优先；未指定时选「最后创建的页面」（用户最近打开的，而非可能已卡死的旧页）
    const t = targetId
      ? pages.find((p) => p.id === targetId || p.id.startsWith(targetId))
      : pages[pages.length - 1];
    if (!t?.webSocketDebuggerUrl) throw new Error(`CDP 未找到 target: ${targetId || "(默认)"}`);
    const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
      setTimeout(() => rej(new Error("CDP page WS 连接超时")), 5000);
    });
    const conn = { ws, seq: 0, pend: new Map(), targetId: t.id, url: t.url };
    ws.on("message", (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.id !== undefined) {
        const p = conn.pend.get(m.id);
        if (p) { conn.pend.delete(m.id); clearTimeout(p.timer); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
      }
    });
    ws.on("close", () => pageConns.delete(t.id));
    ws.on("error", () => {});
    pageConns.set(t.id, conn);
    return conn;
  }

  function send(conn, method, params, timeoutMs = 10000) {
    return new Promise((res, rej) => {
      const id = ++conn.seq;
      const timer = setTimeout(() => {
        conn.pend.delete(id);
        rej(new Error(`CDP ${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      conn.pend.set(id, { res, rej, timer });
      try { conn.ws.send(JSON.stringify({ id, method, params: params || {} })); }
      catch (e) { clearTimeout(timer); conn.pend.delete(id); rej(e); }
    });
  }

  /**
   * 在 CDP 调试实例页面执行 JS。
   * 关键：执行超时后立即关闭该页面的 CDP 连接（ws.close 是进程级操作，不受页面阻塞影响），
   * 从而释放网关侧资源；页面本身仍需刷新恢复，但不再拖累任何其他组件。
   */
  async function evaluate({ targetId, expression, awaitPromise = false, timeoutMs = 8000 }) {
    const conn = await pageConn(targetId);
    const evalP = send(conn, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true,
    }, timeoutMs);
    let timedOut = false;
    const watchdog = new Promise((_, rej) =>
      setTimeout(() => {
        timedOut = true;
        // 强制断开该页 CDP 连接：ws 是网关进程内的 socket，关闭不受页面 JS 阻塞影响
        try { conn.ws.close(); } catch { /* 忽略 */ }
        pageConns.delete(conn.targetId);
        rej(new Error(
          `eval 执行超时 ${timeoutMs}ms：该页 JS 主线程被阻塞（如 while(true){}）。` +
          `已断开该页 CDP 连接，网关与其他标签页不受影响。` +
          `恢复方法：调用 nav.reload 刷新该标签页（tabId=${conn.targetId}）。`
        ));
      }, timeoutMs + 1500)
    );
    try {
      const r = await Promise.race([evalP, watchdog]);
      if (r?.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error("eval error: " + (d.exception?.description || d.exception?.value || d.text));
      }
      return { result: r?.result?.value, targetId: conn.targetId, url: conn.url, ...(timedOut ? { timedOut } : {}) };
    } catch (e) {
      // 内层 send 超时或页面阻塞：统一包装为带恢复指引的错误
      if (!timedOut && /超时/.test(e.message)) {
        try { conn.ws.close(); } catch { /* 忽略 */ }
        pageConns.delete(conn.targetId);
        targets = { at: 0, list: [] }; // 失效 targets 缓存，下次重新发现
        throw new Error(
          `eval 执行超时 ${timeoutMs}ms：该页 JS 主线程被阻塞（如 while(true){}）。` +
          `已断开该页 CDP 连接，网关与其他标签页不受影响。` +
          `恢复方法：调用 nav.reload 刷新该标签页（或对该页以外的标签页继续操作）。`
        );
      }
      // 连接类错误：清理缓存后让调用方重试
      if (/WebSocket|closed|ECONNRESET|not opened/i.test(e.message)) {
        try { conn.ws.close(); } catch { /* 忽略 */ }
        pageConns.delete(conn.targetId);
        targets = { at: 0, list: [] };
      }
      throw e;
    }
  }

  /**
   * 在 CDP 调试实例页面截图（同样走直连，避免 SW 阻塞）。
   * 页面死循环时截图也会超时，但超时只断开该页连接，不影响网关。
   */
  async function screenshot({ targetId, fullPage = false, format = "png", quality, timeoutMs = 15000 }) {
    const conn = await pageConn(targetId);
    const params = { format, captureBeyondViewport: !!fullPage };
    if (format === "jpeg") params.quality = Math.min(100, Math.max(10, quality ?? 80));
    try {
      const r = await send(conn, "Page.captureScreenshot", params, timeoutMs);
      const info = await send(conn, "Runtime.evaluate", { expression: "({url: location.href, title: document.title})", returnByValue: true }, 5000).catch(() => null);
      return { base64: r.data, format, targetId: conn.targetId, url: info?.result?.value?.url, title: info?.result?.value?.title };
    } catch (e) {
      if (/超时/.test(e.message)) {
        try { conn.ws.close(); } catch { /* 忽略 */ }
        pageConns.delete(conn.targetId);
        targets = { at: 0, list: [] };
        throw new Error(`截图超时 ${timeoutMs}ms：该页可能被 JS 阻塞。已断开该页 CDP 连接（不影响其他页面）；恢复请刷新该页。`);
      }
      throw e;
    }
  }

  async function close() {
    for (const [, c] of pageConns) { try { c.ws.close(); } catch { /* 忽略 */ } }
    pageConns.clear();
  }

  return { listPages, evaluate, screenshot, close, state: () => ({ port, pages: pageConns.size }) };
}
