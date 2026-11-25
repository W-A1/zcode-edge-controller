// Network 域捕获：net.start / net.dump / net.stop
// 设计：
//  - net.start 后长持有 debugger attach（区别于 withDebugger 用完即 detach），
//    chrome.debugger.onEvent 由 SW 顶层转发到 netHandler；
//    withDebugger 检测到 "already attached" 时复用连接不打断捕获（见 lib/cdp.js）。
//  - 持久化：事件以 2s 节流写入 chrome.storage.session（SW 被杀数据仍在）；
//    SW 冷启动时 restoreCaptures() 从 session 恢复并重新挂 Network.enable（debugger
//    attach 是浏览器级状态，SW 死亡不断开；恢复后捕获继续）。
import { resolveTab } from "./inject.js";

const captures = new Map(); // tabId -> { events: [], max: number }
const BODY_MAX = 8000;      // 单条响应体摘要上限
const SS_KEY = (tabId) => `zcNet-${tabId}`;
const flushTimers = new Map();

function scheduleFlush(tabId) {
  if (flushTimers.has(tabId)) return;
  flushTimers.set(tabId, setTimeout(async () => {
    flushTimers.delete(tabId);
    const cap = captures.get(tabId);
    if (!cap) return;
    try { await chrome.storage.session.set({ [SS_KEY(tabId)]: { events: cap.events, max: cap.max } }); } catch { /* 存储满则放弃本轮 */ }
  }, 2000));
}

export async function netStart(params) {
  const tab = await resolveTab(params?.tabId);
  const max = Math.min(params?.max || 300, 2000);
  if (captures.has(tab.id)) {
    const cap = captures.get(tab.id);
    return { tabId: tab.id, note: "该标签页已在捕获中（本次调用重置上限）", captured: cap.events.length, max };
  }
  await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable", { maxResourceBufferSize: 5_000_000, maxTotalBufferSize: 20_000_000 });
  captures.set(tab.id, { events: [], max });
  return { tabId: tab.id, capturing: true, max, note: "捕获已开始：操作页面后用 net.dump 读取，net.stop 停止" };
}

/** SW 顶层 chrome.debugger.onEvent 转发进来；非捕获 tab 直接忽略 */
export function netHandler(source, method, params) {
  const tabId = source?.tabId;
  const cap = tabId != null && captures.get(tabId);
  if (!cap) return;
  const keep = () => {
    if (cap.events.length > cap.max) cap.events.splice(0, cap.events.length - cap.max);
  };
  if (method === "Network.requestWillBeSent") {
    cap.events.push({
      ts: Date.now(), phase: "request", requestId: params.requestId,
      url: params.request?.url, method: params.request?.method,
      resourceType: params.type || undefined,
      postData: params.request?.postData ? String(params.request.postData).slice(0, 2000) : undefined,
    });
    keep();
    scheduleFlush(tabId);
  } else if (method === "Network.responseReceived") {
    const req = [...cap.events].reverse().find((e) => e.requestId === params.requestId && e.phase === "request");
    if (req) { Object.assign(req, { status: params.response?.status, mimeType: params.response?.mimeType }); }
    else { cap.events.push({ ts: Date.now(), phase: "response", requestId: params.requestId, status: params.response?.status, mimeType: params.response?.mimeType, url: params.response?.url }); keep(); }
    scheduleFlush(tabId);
  }
}

/** SW 冷启动恢复：从 storage.session 读回捕获上下文，并确保 attach + Network.enable 挂着 */
export async function restoreCaptures() {
  let all;
  try { all = await chrome.storage.session.get(null); } catch { return; }
  for (const [k, v] of Object.entries(all || {})) {
    if (!k.startsWith("zcNet-") || !v?.events) continue;
    const tabId = Number(k.slice(6));
    if (!Number.isInteger(tabId)) continue;
    try {
      let tabAlive = false;
      try { const t = await chrome.tabs.get(tabId); tabAlive = !!t; } catch { tabAlive = false; }
      if (!tabAlive) { await chrome.storage.session.remove(k); continue; }
      await chrome.debugger.attach({ tabId }, "1.3").catch((e) => {
        if (!/already attached/i.test(String(e.message))) throw e;
      });
      await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
      captures.set(tabId, { events: v.events, max: v.max || 300 });
      console.log(`[net] 已恢复标签页 ${tabId} 的网络捕获（${v.events.length} 条历史）`);
    } catch (e) {
      console.warn(`[net] 恢复标签页 ${tabId} 捕获失败: ${e.message}`);
      await chrome.storage.session.remove(k).catch(() => {});
    }
  }
}

export async function netDump(params) {
  const tab = await resolveTab(params?.tabId);
  const cap = captures.get(tab.id);
  if (!cap) throw new Error(`该标签页未在捕获：先调用 net.start（tabId=${tab.id}）`);
  const tail = Math.min(params?.tail || 100, cap.max);
  const events = cap.events.slice(-tail);

  let bodies;
  if (params?.withBodies !== false) {
    bodies = [];
    // 最近 20 条有响应的请求，读取响应体摘要（单条 5s 超时，防个别请求拖死 dump）
    const withResp = cap.events.filter((e) => e.phase === "response" && e.status).slice(-20);
    for (const ev of withResp) {
      try {
        const b = await Promise.race([
          chrome.debugger.sendCommand({ tabId: tab.id }, "Network.getResponseBody", { requestId: ev.requestId }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("body 读取超时")), 5000)),
        ]);
        const body = b?.base64Encoded ? `[base64 ${b.body?.length || 0}B]` : String(b?.body || "");
        bodies.push({ url: ev.url, status: ev.status, mimeType: ev.mimeType, body: body.slice(0, BODY_MAX) });
      } catch { /* 重定向/无 body 资源/超时忽略 */ }
    }
  }
  return { tabId: tab.id, capturing: true, total: cap.events.length, events, ...(bodies ? { bodies } : {}) };
}

export async function netStop(params) {
  const tab = await resolveTab(params?.tabId);
  const cap = captures.get(tab.id);
  if (!cap) return { tabId: tab.id, stopped: false, note: "该标签页未在捕获" };
  const total = cap.events.length;
  captures.delete(tab.id);
  if (flushTimers.has(tab.id)) { clearTimeout(flushTimers.get(tab.id)); flushTimers.delete(tab.id); }
  await chrome.storage.session.remove(SS_KEY(tab.id)).catch(() => {});
  try { await chrome.debugger.detach({ tabId: tab.id }); } catch { /* 已分离 */ }
  return { tabId: tab.id, stopped: true, totalCaptured: total };
}
