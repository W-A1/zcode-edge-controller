// 安全层：设置存储、三档模式判定、写操作用户确认（popup 审批闸门）
import { MODES, GATEWAY_DEFAULT_URL } from "./protocol.js";

const DEFAULTS = {
  gatewayUrl: GATEWAY_DEFAULT_URL,
  token: "",
  mode: "confirm-writes", // readonly | confirm-writes | auto
};

export async function getSettings() {
  const cur = await chrome.storage.local.get(DEFAULTS);
  if (!MODES.includes(cur.mode)) cur.mode = DEFAULTS.mode;
  return cur;
}

export async function setSettings(patch) {
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) if (patch?.[k] !== undefined && patch[k] !== "") clean[k] = patch[k];
  await chrome.storage.local.set(clean);
  return getSettings();
}

/** 模式闸门：readonly 直接拒绝一切写命令；confirm-writes / auto 放行（确认在主流程做） */
export function checkMode(kind, mode) {
  if (kind === "write" && mode === "readonly") {
    return "当前为只读模式（readonly），写命令已被拒绝。请在扩展弹窗切换模式。";
  }
  return null;
}

// ---------------- 写操作用户确认 ----------------
// 流程：SW 将待批准命令写入 storage.session 并亮 badge → popup 读取展示 →
// 用户批准/拒绝 → popup 通过 runtime 消息回传 → SW resolve。60s 超时自动拒绝。

const APPROVAL_TIMEOUT_MS = 60000;
const pendingWaiters = new Map(); // approvalId -> resolve(bool)
const pendingQueue = [];          // 待批队列（修复单槽覆盖：并发写命令不再互相顶掉）
const MAX_QUEUE = 10;             // 队列上限，防灌爆

/** badge 显示待批数量（>1 显示数字，1 显示 "!"，0 清空） */
async function updateBadge() {
  try {
    const n = pendingWaiters.size;
    await chrome.action.setBadgeText({ text: n > 1 ? String(n) : n === 1 ? "!" : "" });
    if (n > 0) await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
  } catch { /* 无 action 上下文时忽略 */ }
}

/** 把队首同步到 storage.session（popup 每次只展示/审批一条，批准后自动推进下一条） */
async function syncHead() {
  const head = pendingQueue[0];
  if (head) await chrome.storage.session.set({ pendingApproval: head, pendingCount: pendingQueue.length });
  else await chrome.storage.session.remove("pendingApproval").catch(() => {});
  try { await chrome.storage.session.set({ pendingCount: pendingQueue.length }); } catch { /* 忽略 */ }
  await updateBadge();
}

export async function requestUserApproval(cmd, params) {
  if (pendingQueue.length >= MAX_QUEUE) {
    throw new Error(`待批操作过多（${MAX_QUEUE} 条），请先在扩展弹窗处理或稍后重试`);
  }
  const id = `ap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const summary = { id, cmd, paramsPreview: safePreview(params), ts: Date.now() };
  pendingQueue.push(summary);
  await syncHead();

  const approved = await new Promise((resolve) => {
    pendingWaiters.set(id, resolve);
    setTimeout(() => {
      if (pendingWaiters.has(id)) {
        pendingWaiters.delete(id);
        const i = pendingQueue.findIndex((q) => q.id === id);
        if (i >= 0) pendingQueue.splice(i, 1);
        resolve(false);
        syncHead();
      }
    }, APPROVAL_TIMEOUT_MS);
  });

  // 从队列移除并推进到下一项
  const idx = pendingQueue.findIndex((q) => q.id === id);
  if (idx >= 0) pendingQueue.splice(idx, 1);
  await syncHead();
  return approved;
}

export async function resolveApproval(id, approve) {
  const w = pendingWaiters.get(id);
  if (!w) return false;
  pendingWaiters.delete(id);
  const idx = pendingQueue.findIndex((q) => q.id === id);
  if (idx >= 0) pendingQueue.splice(idx, 1);
  await syncHead();
  w(Boolean(approve));
  return true;
}

function safePreview(params, cap = 400) {
  try {
    const s = JSON.stringify(params ?? {});
    return s.length > cap ? s.slice(0, cap) + ` …(共 ${s.length} 字节)` : s;
  } catch {
    return "{}";
  }
}
