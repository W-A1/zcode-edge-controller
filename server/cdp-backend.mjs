// CDP 备用通路：不依赖扩展，直连 Edge 的远程调试端口（--remote-debugging-port 启动的实例）。
// 用法：先用 scripts/launch-edge.mjs 启动 Edge，再以 --cdp-port 9222 启动网关。
// DOM 相关逻辑直接复用扩展的 actionFn（String() 序列化后在页面执行），保证两端行为一致。
import { WebSocket } from "ws";
import { actionFn } from "../extension/lib/dom.js";

const ACTION_FN_SRC = `(${actionFn.toString()})`;

// CDP 后端支持的命令子集（扩展桥为主通路，这里是降级能力）
const SUPPORTED = new Set([
  "tabs.list", "tab.get", "tabs.create", "tabs.close", "tabs.activate",
  "nav.goto", "nav.back", "nav.forward", "nav.reload",
  "page.content", "page.refs", "page.screenshot", "wait.for",
  "input.click", "input.type", "input.key", "input.scroll",
  "form.fill", "page.eval", "input.upload",
  "net.start", "net.dump", "net.stop",
]);

export function createCdpBackend({ port = 9222, host = "127.0.0.1", log = () => {} } = {}) {
  let bws = null;
  let bseq = 0;
  const bpend = new Map();
  const pages = new Map(); // targetId -> { ws, seq, pend, waiters }

  // ---------- HTTP 发现 ----------
  async function json(pathname, method = "GET") {
    const res = await fetch(`http://${host}:${port}${pathname}`, {
      method,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`CDP http ${res.status} for ${pathname}`);
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  async function probe() {
    const v = await json("/json/version");
    return v?.Browser || true;
  }

  // ---------- Browser 级 WS ----------
  async function browserWs() {
    if (bws && bws.readyState === 1) return bws;
    const v = await json("/json/version");
    if (!v?.webSocketDebuggerUrl) throw new Error("browser endpoint 不可用");
    bws = new WebSocket(v.webSocketDebuggerUrl);
    await opened(bws);
    bws.on("message", (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.id !== undefined) {
        const p = bpend.get(m.id);
        if (p) { bpend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
      }
    });
    bws.on("close", () => { bws = null; });
    return bws;
  }

  function browserSend(method, params) {
    return browserWs().then((ws) => new Promise((res, rej) => {
      const id = ++bseq;
      bpend.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    }));
  }

  // ---------- Page 级 WS ----------
  async function listTargets() {
    const ts = await json("/json/list");
    return (ts || []).filter((t) => t.type === "page");
  }

  async function pageConn(targetId) {
    let pc = pages.get(targetId);
    if (pc && pc.ws.readyState === 1) return pc;
    const t = (await listTargets()).find((x) => x.id === targetId);
    if (!t?.webSocketDebuggerUrl) throw new Error(`CDP target 不可用: ${targetId}`);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await opened(ws);
    pc = { ws, seq: 0, pend: new Map(), waiters: [], capture: null };
    ws.on("message", (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.id !== undefined) {
        const p = pc.pend.get(m.id);
        if (p) { pc.pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
        return;
      }
      if (m.method) {
        // Network 捕获（net.start 期间持久收集，与扩展侧 net.js 同一套规则）
        if (pc.capture && m.method.startsWith("Network.")) netCollect(pc.capture, m.method, m.params);
        pc.waiters = pc.waiters.filter((w) => {
          if (w.method !== m.method) return true;
          clearTimeout(w.timer);
          w.res(m.params);
          return false;
        });
      }
    });
    ws.on("close", () => pages.delete(targetId));
    ws.on("error", () => {});
    pages.set(targetId, pc);
    return pc;
  }

  function pcSend(pc, method, params) {
    return new Promise((res, rej) => {
      const id = ++pc.seq;
      pc.pend.set(id, { res, rej });
      pc.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function waitEvent(pc, method, tmo) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pc.waiters = pc.waiters.filter((w) => w.method !== method);
        rej(new Error(`等待 ${method} 超时`));
      }, tmo);
      pc.waiters.push({ method, res, timer });
    });
  }

  // ---------- 页面执行辅助 ----------
  async function evalJs(pc, expression, awaitPromise = false) {
    const r = await pcSend(pc, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
      // Chromium 105+：Runtime.evaluate 求值字符串默认受目标上下文 CSP 拦截，
      // 调试通道（DevTools/扩展 debugger）等价放行，与 allowUnsafeEvalBlockedByCSP 语义一致
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (r?.exceptionDetails) {
      throw new Error("page eval error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r?.result?.value;
  }

  async function runAction(pc, job, awaitPromise = false) {
    const r = await evalJs(pc, `${ACTION_FN_SRC}(${JSON.stringify(job)})`, awaitPromise);
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  async function targetOf(p) {
    const ts = await listTargets();
    if (p?.tabId != null) {
      // 明确校验：CDP 通路与扩展通路的页面空间是两个浏览器，tabId 不匹配时明确报错而非静默错页
      const t = ts.find((x) => x.id === p.tabId);
      if (!t) {
        throw new Error(
          `targetId ${p.tabId} 不在 CDP 实例的页面列表中——该 tabId 属于扩展桥所在的主 Edge 实例。` +
          `CDP 通路请不传 tabId（操作调试实例当前页），或用 CDP 通路自身导航后的 targetId`
        );
      }
      return t.id;
    }
    const t = ts[0];
    if (!t) throw new Error("没有可用的 page target（Edge 是否以 --remote-debugging-port 启动？）");
    return t.id;
  }

  async function waitLoad(pc, tmo) {
    await pcSend(pc, "Page.enable");
    await waitEvent(pc, "Page.loadEventFired", Math.min(tmo || 20000, 30000)).catch(() => { /* 超时不致命 */ });
  }

  // ---------- 命令实现 ----------
  async function call(cmd, p = {}, tmo = 45000) {
    switch (cmd) {
      case "tabs.list": {
        const ts = await listTargets();
        return { count: ts.length, tabs: ts.map((t) => ({ id: t.id, title: t.title, url: t.url, active: false, note: "cdp-backend 无法感知激活态" })) };
      }
      case "tab.get": {
        const ts = await listTargets();
        const t = (p.tabId && ts.find((x) => x.id === p.tabId)) || ts[0];
        if (!t) throw new Error("no page target");
        return { id: t.id, title: t.title, url: t.url, active: false };
      }
      case "tabs.create": {
        const r = await browserSend("Target.createTarget", { url: p.url });
        return { tabId: r.targetId, url: p.url };
      }
      case "tabs.close": {
        await browserSend("Target.closeTarget", { targetId: p.tabId });
        return { closed: p.tabId };
      }
      case "tabs.activate": {
        try { await json(`/json/activate/${p.tabId}`); }
        catch { await json(`/json/activate/${p.tabId}`, "PUT"); }
        return { activated: p.tabId };
      }
      case "nav.goto": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        await pcSend(pc, "Page.bringToFront").catch(() => {});
        await pcSend(pc, "Page.navigate", { url: p.url });
        if (p?.waitForLoad !== false) await waitLoad(pc, tmo);
        const info = await evalJs(pc, "({ url: location.href, title: document.title })");
        return { tabId: tid, ...info };
      }
      case "nav.reload": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        await pcSend(pc, "Page.reload");
        if (p?.waitForLoad !== false) await waitLoad(pc, tmo);
        return { tabId: tid };
      }
      case "nav.back": case "nav.forward": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        await evalJs(pc, cmd === "nav.back" ? "history.back()" : "history.forward()");
        return { tabId: tid };
      }
      case "page.content": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const r = await runAction(pc, { action: "extract", format: p.format, selector: p.selector, maxBytes: p.maxBytes });
        return { tabId: tid, ...r };
      }
      case "page.refs": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const r = await runAction(pc, { action: "refs", max: p.max });
        return { tabId: tid, ...r };
      }
      case "page.screenshot": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const format = p.format === "jpeg" ? "jpeg" : "png";
        const params = { format, captureBeyondViewport: !!p.fullPage };
        if (format === "jpeg") params.quality = Math.min(100, Math.max(10, p.quality ?? 80));
        const r = await pcSend(pc, "Page.captureScreenshot", params);
        const info = await evalJs(pc, "({ url: location.href, title: document.title })").catch(() => ({}));
        return { tabId: tid, ...info, format, base64: r.data };
      }
      case "wait.for": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const r = await runAction(pc, { action: "wait", selector: p.selector, text: p.text, timeoutMs: p.timeoutMs }, true);
        return { tabId: tid, ...r };
      }
      case "input.click": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const rect = await runAction(pc, { action: "rectOf", ref: p.ref, selector: p.selector, text: p.text });
        await pcSend(pc, "Page.bringToFront").catch(() => {});
        await pcSend(pc, "Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", buttons: 1, clickCount: 1 });
        await pcSend(pc, "Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", buttons: 0, clickCount: 1 });
        return { tabId: tid, clicked: rect };
      }
      case "input.type": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const target = await runAction(pc, { action: "focusOf", ref: p.ref, selector: p.selector, clear: p.clear !== false });
        await pcSend(pc, "Input.insertText", { text: String(p.text) });
        if (p.submit && (p.ref || p.selector)) await runAction(pc, { action: "submitFrom", ref: p.ref, selector: p.selector });
        return { tabId: tid, typed: String(p.text).length, target };
      }
      case "input.key": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const vk = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[p.key] ?? 0;
        await pcSend(pc, "Input.dispatchKeyEvent", { type: "keyDown", key: p.key, code: p.key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await pcSend(pc, "Input.dispatchKeyEvent", { type: "keyUp", key: p.key, code: p.key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        return { tabId: tid, key: p.key };
      }
      case "input.scroll": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const vp = await runAction(pc, { action: "viewport" });
        await pcSend(pc, "Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(vp.w / 2), y: Math.round(vp.h / 2), deltaX: p.dx || 0, deltaY: p.dy || 0 });
        return { tabId: tid, dx: p.dx || 0, dy: p.dy || 0 };
      }
      case "form.fill": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const r = await runAction(pc, { action: "fill", fields: p.fields || [] });
        return { tabId: tid, ...r };
      }
      case "page.eval": {
        // CDP 后端在页面主世界执行（可访问页面 JS 全局）；ISOLATED 参数在此通路忽略
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const t0 = Date.now();
        const value = await evalJs(pc, p.expression, !!p.awaitPromise);
        return { tabId: tid, world: "MAIN", result: value, elapsedMs: Date.now() - t0 };
      }
      case "input.upload": {
        if (!p.selector) throw new Error("CDP 后端 input.upload 仅支持 selector 定位（ref 属扩展隔离世界）");
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        await pcSend(pc, "DOM.enable");
        const doc = await pcSend(pc, "DOM.getDocument", { depth: 1 });
        const q = await pcSend(pc, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: p.selector });
        if (!q?.nodeId) throw new Error("CDP 未找到文件输入节点: " + p.selector);
        await pcSend(pc, "DOM.setFileInputFiles", { files: p.files, nodeId: q.nodeId });
        return { tabId: tid, uploaded: (p.files || []).length, files: p.files, note: "文件已注入，随后提交表单" };
      }
      case "net.start": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const max = Math.min(p.max || 300, 2000);
        await pcSend(pc, "Network.enable", { maxResourceBufferSize: 5_000_000, maxTotalBufferSize: 20_000_000 });
        pc.capture = { events: [], max };
        return { tabId: tid, capturing: true, max, note: "捕获已开始（page 级 WS 持续监听 Network 域）" };
      }
      case "net.dump": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        if (!pc.capture) throw new Error(`该标签页未在捕获：先 net.start`);
        const tail = Math.min(p.tail || 100, pc.capture.max);
        const events = pc.capture.events.slice(-tail);
        let bodies;
        if (p.withBodies !== false) {
          bodies = [];
          for (const ev of pc.capture.events.filter((e) => e.phase === "response" && e.status).slice(-20)) {
            try {
              const b = await pcSend(pc, "Network.getResponseBody", { requestId: ev.requestId });
              bodies.push({ url: ev.url, status: ev.status, mimeType: ev.mimeType, body: (b?.base64Encoded ? `[base64 ${b.body?.length || 0}B]` : String(b?.body || "")).slice(0, 8000) });
            } catch { /* 无 body 忽略 */ }
          }
        }
        return { tabId: tid, capturing: true, total: pc.capture.events.length, events, ...(bodies ? { bodies } : {}) };
      }
      case "net.stop": {
        const tid = await targetOf(p);
        const pc = await pageConn(tid);
        const total = pc.capture?.events.length || 0;
        try { await pcSend(pc, "Network.disable"); } catch { /* 忽略 */ }
        pc.capture = null;
        return { tabId: tid, stopped: true, totalCaptured: total };
      }
      default:
        throw new Error(`cdp backend does not support: ${cmd}`);
    }
  }

  function state() {
    return { mode: "cdp", port, pages: pages.size };
  }

  async function close() {
    for (const [, pc] of pages) { try { pc.ws.close(); } catch { /* 忽略 */ } }
    pages.clear();
    try { bws?.close(); } catch { /* 忽略 */ }
    bws = null;
  }

  return { call, supports: (cmd) => SUPPORTED.has(cmd), probe, state, close };
}

function opened(ws) {
  return new Promise((res, rej) => {
    if (ws.readyState === 1) return res();
    ws.once("open", res);
    ws.once("error", rej);
  });
}

// Network 事件收集（与扩展侧 net.js 同一套规则：request/response 合并、上限裁剪）
function netCollect(cap, method, params) {
  const keep = () => { if (cap.events.length > cap.max) cap.events.splice(0, cap.events.length - cap.max); };
  if (method === "Network.requestWillBeSent") {
    cap.events.push({
      ts: Date.now(), phase: "request", requestId: params.requestId,
      url: params.request?.url, method: params.request?.method,
      resourceType: params.type || undefined,
      postData: params.request?.postData ? String(params.request.postData).slice(0, 2000) : undefined,
    });
    keep();
  } else if (method === "Network.responseReceived") {
    const req = [...cap.events].reverse().find((e) => e.requestId === params.requestId && e.phase === "request");
    if (req) { Object.assign(req, { status: params.response?.status, mimeType: params.response?.mimeType }); }
    else { cap.events.push({ ts: Date.now(), phase: "response", requestId: params.requestId, status: params.response?.status, mimeType: params.response?.mimeType, url: params.response?.url }); keep(); }
  }
}
