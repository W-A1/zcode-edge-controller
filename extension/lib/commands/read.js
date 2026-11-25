// 读命令：标签列表 / 页面内容（多 frame）/ 可交互元素 refs（多 frame）/ 截图 / 等待
import { cdpSend, withDebugger } from "../cdp.js";
import { resolveTab, injectOne, injectJob, ensureTabAwake } from "./inject.js";

export async function tabsList(params) {
  const tabs = await chrome.tabs.query(params?.query || {});
  return {
    count: tabs.length,
    tabs: tabs.map((t) => ({
      id: t.id, windowId: t.windowId, title: t.title, url: t.url,
      active: t.active, pinned: t.pinned,
      audible: t.audible || undefined, incognito: t.incognito || undefined,
    })),
  };
}

export async function tabGet(params) {
  const t = await resolveTab(params?.tabId);
  return {
    id: t.id, windowId: t.windowId, title: t.title, url: t.url,
    active: t.active, status: t.status,
    favIconUrl: t.favIconUrl || undefined, incognito: t.incognito || undefined,
  };
}

/** page.content：主 frame 在前，子 frame 内容带来源标注依次拼接（跨域 iframe 支持） */
export async function pageContent(params) {
  const tab = await resolveTab(params?.tabId);
  const maxBytes = params?.maxBytes || 400000;
  const injections = await injectOne(tab.id, {
    action: "extract",
    format: params?.format,
    selector: params?.selector,
    maxBytes, // 每 frame 先各自按上限截断，最后整体再截
  }, { allFrames: true });

  const frames = injections
    .filter((i) => i.result && !i.result.error)
    .map((i) => ({ frameId: i.frameId, ...i.result }));
  if (!frames.length) throw new Error("所有 frame 均无可提取内容（页面可能是内部页或未加载完成）");

  const mainIdx = frames.findIndex((f) => f.frameId === 0);
  const main = frames[mainIdx >= 0 ? mainIdx : 0];
  const children = frames.filter((f) => f !== main && f.content);

  let content = main.content || "";
  const frameNotes = [];
  for (const f of children) {
    frameNotes.push({ frameId: f.frameId, url: f.url, bytes: f.bytes });
    content += `\n\n--- iframe #${f.frameId} ${f.url} ---\n` + f.content;
  }

  const bytes = new Blob([content]).size;
  let truncated = false;
  if (bytes > maxBytes) { content = content.slice(0, maxBytes); truncated = true; }
  return { tabId: tab.id, url: main.url, title: main.title, format: main.format, frames: frames.length, frameNotes, bytes, truncated, content };
}

/** page.refs：所有 frame 的可交互元素合并编号（ref 在各自 frame 的隔离世界，点击时按 frameId 定位注入） */
export async function pageRefs(params) {
  const tab = await resolveTab(params?.tabId);
  const injections = await injectOne(tab.id, { action: "refs", max: params?.max }, { allFrames: true });
  const frames = injections.filter((i) => i.result && !i.result.error);
  if (!frames.length) throw new Error("所有 frame 均无法收集 refs（页面可能是内部页或未加载完成）");

  const refs = [];
  let url, title;
  for (const f of frames) {
    const r = f.result;
    if (f.frameId === 0 || !url) { url = r.url; title = r.title; }
    for (const item of r.refs || []) refs.push({ ...item, frameId: f.frameId === 0 ? undefined : f.frameId, frameUrl: f.frameId === 0 ? undefined : r.url });
  }
  return { tabId: tab.id, count: refs.length, url, title, frames: frames.length, refs };
}

export async function waitFor(params) {
  if (!params?.selector && !params?.text) throw new Error("wait.for 需要 selector 或 text 至少一个");
  const tab = await resolveTab(params?.tabId);
  const frameId = Number.isInteger(params?.frameId) && params.frameId !== 0 ? params.frameId : undefined;
  // 本 Edge 版本 executeScript 不支持 awaitPromise → 在 SW 侧轮询注入同步探测（150ms 间隔）
  const timeoutMs = Math.min(params?.timeoutMs ?? 10000, 60000);
  const t0 = Date.now();
  while (Date.now() - t0 <= timeoutMs) {
    const r = await injectOne(tab.id, { action: "wait", selector: params?.selector, text: params?.text }, { frameId });
    if (r?.hit) return { tabId: tab.id, ok: true, matched: r.matched, elapsedMs: Date.now() - t0, ...(frameId ? { frameId } : {}) };
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error(`wait timeout after ${Date.now() - t0}ms: ${params?.selector || params?.text}`);
}

/** 截图走 chrome.debugger（CDP Page.captureScreenshot），支持整页 captureBeyondViewport。
 *  睡眠标签：attach 超时/失败时自动唤醒（切前台+等加载完成）后重试一次。 */
export async function pageScreenshot(params) {
  const tab = await resolveTab(params?.tabId);
  const format = params?.format === "jpeg" ? "jpeg" : "png";
  const opts = { format, captureBeyondViewport: !!params?.fullPage };
  if (format === "jpeg") opts.quality = Math.min(100, Math.max(10, params?.quality ?? 80));
  const shoot = () => withDebugger(tab.id, async () => {
    const res = await cdpSend(tab.id, "Page.captureScreenshot", opts);
    return { tabId: tab.id, url: tab.url, title: tab.title, format, base64: res.data };
  });
  try {
    return await shoot();
  } catch (e) {
    if (/attach 超时|睡眠/.test(e.message)) {
      const awake = await ensureTabAwake(tab.id, 15000);
      if (!awake) throw new Error(`标签页无法唤醒（可能已关闭或页面无法加载）: ${e.message}`);
      return shoot();
    }
    throw e;
  }
}
