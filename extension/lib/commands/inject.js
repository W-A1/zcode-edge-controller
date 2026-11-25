// 注入公共层：活动标签页解析 + executeScript 封装（支持多 frame / 睡眠唤醒）+ 结果体积限制
import { actionFn } from "../dom.js";

/** 解析目标 tab：tabId 省略时取最后聚焦窗口的激活标签页 */
export async function resolveTab(tabId) {
  if (tabId != null) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { throw new Error(`tab not found: ${tabId}`); }
    return tab;
  }
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("no active tab");
  return tab;
}

const INJECT_TIMEOUT_MS = 12000;
const WAKE_WAIT_MS = 15000; // 深度休眠标签恢复加载的等待上限
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 确保标签页清醒：Edge"睡眠标签"（休眠后渲染进程被释放）激活时会重新加载页面，
 * 需要等 status 回到 complete 才能可靠注入。返回是否确认 complete。
 * 注意：status 字段在休眠时可能保留 "complete"（进程没了但状态字段不更新），
 * 所以本函数只能处理 loading 态；深度休眠统一由注入超时后的唤醒重试兜底。
 */
export async function ensureTabAwake(tabId, maxWaitMs = WAKE_WAIT_MS) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return true;
  } catch { return false; }
  try { await chrome.tabs.update(tabId, { active: true }); } catch { return false; }
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    await sleep(300);
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") return true;
    } catch { return false; }
  }
  return false;
}

/**
 * 向目标 tab 注入 actionFn 执行一个 job。
 * extra:
 *  - frameId:      指定 frame 注入（跨域 iframe 支持；省略 = 主 frame）
 *  - allFrames:    对所有 frame 注入（返回数组按 frameId 组装）
 *  - wakeOnTimeout: 注入超时（Edge 睡眠标签）时自动唤醒并重试一次（默认 true）
 * 兼容性说明（Edge 157 实测）：
 *  - executeScript 的 injection 校验拒绝 awaitPromise 属性 → 不传；等待逻辑（wait.for）由调用方轮询注入
 *  - target 只接受单数 tabId（tabIds 复数属于 tabs.remove 等批量 API）
 *  - Edge"睡眠标签"会让 executeScript 无限等待文档恢复 → 外层 Promise.race 超时保护 + 唤醒重试
 *    （深度休眠：切前台后页面重新加载，需轮询等 complete，固定延时不够——真机 11 小时休眠实测）
 * actionFn 内部已做 try/catch（业务错误以 {error} 返回）。
 */
export async function injectJob(tabId, job, extra = {}) {
  const target = extra.allFrames
    ? { tabId, allFrames: true }
    : extra.frameId
      ? { tabId, frameIds: [extra.frameId] }
      : { tabId };

  let inj;
  try {
    inj = await Promise.race([
      chrome.scripting.executeScript({ target, func: actionFn, args: [job] }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`注入超时 ${INJECT_TIMEOUT_MS}ms — 标签页可能处于 Edge"睡眠"状态或加载中`)), INJECT_TIMEOUT_MS)
      ),
    ]);
  } catch (e) {
    // 睡眠标签自动唤醒：切前台 → 轮询等页面重新加载完成（≤15s）→ 余量 500ms → 重试一次（不递归）
    if (extra.wakeOnTimeout !== false && /注入超时/.test(e.message)) {
      try { await chrome.tabs.update(tabId, { active: true }); } catch { /* tab 已关闭 */ }
      const t0 = Date.now();
      while (Date.now() - t0 < WAKE_WAIT_MS) {
        await sleep(400);
        try {
          const t = await chrome.tabs.get(tabId);
          if (t.status === "complete") break;
        } catch { break; }
      }
      await sleep(500);
      return injectJob(tabId, job, { ...extra, wakeOnTimeout: false });
    }
    throw new Error(`注入执行失败: ${e.message}`);
  }
  return inj;
}

/** 单 frame / 主 frame 注入并取回单个结果（executeScript 成功返回数组，这里取 [0]） */
export async function injectOne(tabId, job, extra = {}) {
  const injections = await injectJob(tabId, job, extra);
  if (extra.allFrames) return injections; // allFrames 交调用方组装
  const r = injections?.[0]?.result;
  if (r && r.error) throw new Error(r.error);
  if (r == null) throw new Error("注入无返回值（页面可能不支持脚本执行）");
  return r;
}

/** JSON 体积限制：超限返回截断预览，避免大结果撑爆网关/MCP。
 *  maxBytes 由调用方传入（可能来自不可信输入），此处强制上限 4MB 防 DoS。 */
const HARD_MAX_BYTES = 4 * 1024 * 1024;

export function limitBytes(value, maxBytes = 400000) {
  if (maxBytes == null) return value;
  const cap = Math.min(Number(maxBytes) || 400000, HARD_MAX_BYTES);
  let s;
  try { s = JSON.stringify(value); } catch { s = String(value); }
  if (s == null || s.length <= cap) return value;
  return { __truncated: true, note: `结果超过 ${cap} 字节已截断，可调大 maxBytes（上限 ${HARD_MAX_BYTES}）或缩小范围`, preview: s.slice(0, cap) };
}
