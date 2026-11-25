// chrome.debugger（扩展内 CDP）封装
// - withDebugger: 按 tabId 互斥的 attach → 执行 → detach（同一扩展重复 attach 同一 tab 会报错，必须串行）
// - cdpSend:      已 attach 状态下的单条 CDP 命令
// - 复用规则：若目标 tab 已被长持有方（net.start 网络捕获）attach，withDebugger 直接复用该连接，
//   执行完不 detach，避免打断捕获（Edge 报错文案 "Another debugger already attached"）。

const locks = new Map(); // tabId -> Promise（链式互斥）
const ATTACH_TIMEOUT_MS = 15000; // 睡眠标签 attach 可能无限挂起，超时保护
const LOCK_MAX_MS = 20000;       // 单个 withDebugger 任务最长占用（eval 默认 8s + 余量）

// 熔断：某 tab 的 CDP 任务超时（页面主线程被 JS 阻塞）后标记为隔离态，
// 后续 CDP 操作直接快速失败，避免反复拖住 SW 的调试通道（渗透实测：死循环会连带阻塞其他标签页）。
const quarantined = new Map(); // tabId -> { until: number, reason: string }
const QUARANTINE_MS = 120000;

export function isQuarantined(tabId) {
  const q = quarantined.get(Number(tabId));
  if (!q) return null;
  if (Date.now() > q.until) { quarantined.delete(Number(tabId)); return null; }
  return q;
}

export function quarantine(tabId, reason) {
  quarantined.set(Number(tabId), { until: Date.now() + QUARANTINE_MS, reason: String(reason).slice(0, 200) });
}

export function clearQuarantine(tabId) {
  if (tabId == null) quarantined.clear();
  else quarantined.delete(Number(tabId));
}

export function withDebugger(tabId, fn) {
  const q = isQuarantined(tabId);
  if (q) {
    return Promise.reject(new Error(
      `标签页 ${tabId} 处于隔离态（页面 JS 主线程被阻塞，剩余 ${Math.ceil((q.until - Date.now()) / 1000)}s）。` +
      `请先调用 nav.reload 刷新该标签页以恢复，或改用其他标签页。`
    ));
  }
  const prev = locks.get(tabId) || Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    let reused = false;
    let attached = false;
    try {
      await Promise.race([
        chrome.debugger.attach({ tabId }, "1.3").then(() => { attached = true; }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`debugger attach 超时 ${ATTACH_TIMEOUT_MS}ms — 标签页可能处于睡眠状态`)), ATTACH_TIMEOUT_MS)
        ),
      ]);
    } catch (e) {
      if (/already attached/i.test(String(e.message))) {
        reused = true; // net.start 等长持有方已 attach，复用不 detach
      } else {
        if (attached) { try { await chrome.debugger.detach({ tabId }); } catch { /* 忽略 */ } }
        throw e;
      }
    }
    try {
      return await Promise.race([
        fn(),
        new Promise((_, rej) =>
          setTimeout(() => {
            // 熔断该 tab：此后所有 CDP 操作快速失败，保护 SW 与其他标签页
            quarantine(tabId, `CDP 任务超时 ${LOCK_MAX_MS}ms（页面疑似 JS 死循环）`);
            rej(new Error(
              `CDP 任务超时 ${LOCK_MAX_MS}ms：页面 JS 主线程疑似被阻塞（如 while(true){}）。` +
              `已将标签页 ${tabId} 标记为隔离态（2 分钟），期间该页 CDP 操作会立即失败。` +
              `恢复方法：调用 nav.reload 刷新该标签页。`
            ));
          }, LOCK_MAX_MS)
        ),
      ]);
    } finally {
      if (!reused) {
        try {
          await Promise.race([
            chrome.debugger.detach({ tabId }),
            new Promise((r) => setTimeout(r, 3000)),
          ]);
        } catch { /* 已分离或不可分离，忽略 */ }
      }
    }
  });
  locks.set(tabId, job.catch(() => {}));
  return job;
}

const CDP_SEND_TIMEOUT_MS = 20000; // 单条 CDP 命令超时（防调试会话挂起拖死整条命令链）

/** 带 20s 超时保护的 CDP 命令发送（attach 后的 Runtime/Page/DOM/Network 域调用均应使用） */
export function cdpSend(tabId, method, params) {
  return Promise.race([
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`CDP ${method} 超时 ${CDP_SEND_TIMEOUT_MS}ms（调试会话挂起）`)), CDP_SEND_TIMEOUT_MS)
    ),
  ]);
}
