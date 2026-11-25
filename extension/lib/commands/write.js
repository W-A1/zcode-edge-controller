// 写命令：标签增删切换 / 导航 / 点击 / 输入 / 按键 / 滚动 / 表单批量填写 / 文件上传 / 执行 JS
// native=true 时走 chrome.debugger 的 CDP 可信输入事件（更接近真实用户操作）
// 跨域 iframe：ref/page.refs 返回 frameId 的元素按对应 frame 注入（native 坐标点击除外，见下）
import { cdpSend, withDebugger, clearQuarantine } from "../cdp.js";
import { resolveTab, injectOne, limitBytes } from "./inject.js";

// ---------------- 标签页 ----------------
export async function tabsCreate(params) {
  const tab = await chrome.tabs.create({ url: params.url, active: params?.active !== false });
  return { tabId: tab.id, url: tab.url ?? params.url, title: tab.title };
}

export async function tabsClose(params) {
  await chrome.tabs.remove(params.tabId);
  return { closed: params.tabId };
}

export async function tabsActivate(params) {
  const tab = await chrome.tabs.update(params.tabId, { active: true });
  if (tab.windowId != null) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* 窗口已关闭则忽略 */ }
  }
  return { tabId: params.tabId, url: tab.url, title: tab.title, active: tab.active };
}

// ---------------- 导航 ----------------
// 安全：协议白名单。默认禁止 file:/data:/view-source:（防本地文件读取与脚本注入），
// 需要 file:// 时在扩展设置里显式开启 allowFileScheme（默认关闭）。
// 渗透测试实测：file:///C:/Windows/win.ini 与 data:text/html,<script> 曾被接受。
const SAFE_SCHEMES = /^(https?|about|edge|chrome|devtools):/i;
const FILE_SCHEMES = /^(file|view-source):/i;
const DATA_SCHEME = /^data:/i;

async function allowFileScheme() {
  try {
    const { allowFileScheme } = await chrome.storage.local.get({ allowFileScheme: false });
    return allowFileScheme === true;
  } catch { return false; }
}

function normalizeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) throw new Error("url 不能为空");
  // 明确拒绝可执行/可注入协议
  if (DATA_SCHEME.test(raw)) {
    throw new Error("拒绝导航到 data: URL（可执行脚本注入，安全策略禁止）");
  }
  if (SAFE_SCHEMES.test(raw)) return raw;
  if (FILE_SCHEMES.test(raw)) {
    // 由调用方 await allowFileScheme() 判定，这里抛专用错误由上层处理
    const e = new Error("FILE_SCHEME_REQUIRES_OPT_IN");
    e.needsFileOptIn = true;
    throw e;
  }
  // 裸域名补 https
  if (/^[\w.-]+\.[a-z]{2,}([/?#:].*)?$/i.test(raw)) return "https://" + raw;
  // 相对/无协议来源（如 localhost:8090/x）尝试补 https 前先拒绝可疑协议
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    throw new Error(`拒绝导航到不安全/不支持的协议: ${raw.split(":")[0]}:`);
  }
  return "https://" + raw;
}

/** 统一入口：处理 file:// 需显式开启的场景 */
async function resolveNavUrl(url) {
  try {
    return normalizeUrl(url);
  } catch (e) {
    if (e.needsFileOptIn) {
      if (await allowFileScheme()) return String(url).trim();
      throw new Error(
        "拒绝导航到 file: / view-source: 协议（默认禁止，防本地文件读取）。" +
        "如确需访问本地文件，请在扩展弹窗设置中开启「允许 file:// 访问」（allowFileScheme）。"
      );
    }
    throw e;
  }
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    function finish(reason) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { chrome.tabs.onUpdated.removeListener(listener); } catch { /* 忽略 */ }
      resolve(reason);
    }
    function listener(id, info) { if (id === tabId && info.status === "complete") finish("complete"); }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") finish("complete"); }).catch(() => finish("gone"));
  });
}

export async function navGoto(params) {
  const url = await resolveNavUrl(params.url);
  const tab = await resolveTab(params?.tabId);
  await chrome.tabs.update(tab.id, { url });
  if (params?.waitForLoad !== false) await waitTabComplete(tab.id, 30000);
  const t = await chrome.tabs.get(tab.id);
  return { tabId: t.id, url: t.url, title: t.title, status: t.status, loadEvent: params?.waitForLoad !== false ? "complete/timeout" : "skipped" };
}

export async function navBack(params) {
  const tab = await resolveTab(params?.tabId);
  try {
    await chrome.tabs.goBack(tab.id);
    const t = await chrome.tabs.get(tab.id);
    return { tabId: tab.id, url: t.url, moved: true };
  } catch (e) {
    return { tabId: tab.id, moved: false, reason: e.message };
  }
}

export async function navForward(params) {
  const tab = await resolveTab(params?.tabId);
  try {
    await chrome.tabs.goForward(tab.id);
    const t = await chrome.tabs.get(tab.id);
    return { tabId: tab.id, url: t.url, moved: true };
  } catch (e) {
    return { tabId: tab.id, moved: false, reason: e.message };
  }
}

export async function navReload(params) {
  const tab = await resolveTab(params?.tabId);
  await chrome.tabs.reload(tab.id, { bypassCache: false });
  await waitTabComplete(tab.id, 30000);
  // 刷新即视为页面主线程已恢复：解除 CDP 隔离态
  try { clearQuarantine(tab.id); } catch { /* 忽略 */ }
  return { tabId: tab.id, quarantineCleared: true };
}

// ---------------- 交互输入 ----------------
// ref 可能带 frameId（来自多 frame 的 page.refs），定位注入到对应 frame
function frameOf(params) {
  return Number.isInteger(params?.frameId) && params.frameId !== 0 ? params.frameId : undefined;
}

const KEY_VK = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32 };

/** 跨 frame 可信点击的坐标合成：目标元素在子 frame 内的坐标 + 该 iframe 在父 viewport 的偏移。
 *  v1.2 支持一层 iframe（父为主文档）；更深的嵌套仍要求注入式点击。 */
async function frameOffsetInMain(tabId, frameId) {
  const tree = await cdpSend(tabId, "Page.getFrameTree");
  let frameUrl = null;
  let parentIsMain = false;
  (function walk(node) {
    for (const c of node.childFrames || []) {
      if (c.frame.id === frameId) { frameUrl = c.frame.url; parentIsMain = node.frame.id === 0; }
      walk(c);
    }
  })(tree.frameTree);
  if (!frameUrl) throw new Error(`frame 树中未找到 frameId=${frameId}`);
  if (!parentIsMain) throw new Error("native 点击 v1.2 仅支持一层 iframe（父为主文档），更深嵌套请用注入式点击");
  const off = await injectOne(tabId, { action: "iframeRect", url: frameUrl });
  return off; // {x, y}：iframe 在主 viewport 的偏移（已将 iframe 滚至视口中央）
}

export async function inputClick(params) {
  if (!params?.ref && !params?.selector && !params?.text) throw new Error("input.click 需要 ref / selector / text 至少一个");
  const tab = await resolveTab(params?.tabId);
  const frameId = frameOf(params);
  if (params?.native) {
    // 顺序：先让 iframe 在主文档滚到可见（叠加偏移），再在子 frame 内 scrollIntoView + 取元素中心
    let rect = await injectOne(tab.id, { action: "rectOf", ref: params.ref, selector: params.selector, text: params.text });
    if (frameId) {
      const off = await frameOffsetInMain(tab.id, frameId);
      rect = { ...rect, x: rect.x + off.x, y: rect.y + off.y };
    }
    await withDebugger(tab.id, async () => {
      await cdpSend(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", buttons: 1, clickCount: 1 });
      await cdpSend(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", buttons: 0, clickCount: 1 });
    });
    return { tabId: tab.id, clicked: rect, native: true, ...(frameId ? { frameId } : {}) };
  }
  const r = await injectOne(tab.id, { action: "click", ref: params.ref, selector: params.selector, text: params.text }, { frameId });
  return { tabId: tab.id, clicked: r, ...(frameId ? { frameId } : {}) };
}

export async function inputType(params) {
  const tab = await resolveTab(params?.tabId);
  const frameId = frameOf(params);
  if (params?.native) {
    // Input.insertText 输入到"当前焦点元素"，无坐标问题 → 跨 frame 直接支持：
    // 子 frame 内 focus，主 frame 收尾（insertText 是浏览器级可信输入，与 frame 无关）
    const f = await injectOne(tab.id, { action: "focusOf", ref: params?.ref, selector: params?.selector, clear: params?.clear !== false }, { frameId });
    await withDebugger(tab.id, async () => {
      await cdpSend(tab.id, "Input.insertText", { text: String(params.text) });
    });
    if (params?.submit && (params?.ref || params?.selector)) {
      await injectOne(tab.id, { action: "submitFrom", ref: params?.ref, selector: params?.selector }, { frameId });
    }
    return { tabId: tab.id, typed: String(params.text).length, native: true, target: f, ...(frameId ? { frameId } : {}) };
  }
  const r = await injectOne(tab.id, {
    action: "type",
    ref: params?.ref, selector: params?.selector,
    text: params.text, clear: params?.clear, submit: params?.submit,
  }, { frameId });
  return { tabId: tab.id, typed: r, ...(frameId ? { frameId } : {}) };
}

export async function inputKey(params) {
  const tab = await resolveTab(params?.tabId);
  if (params?.native) {
    return withDebugger(tab.id, async () => {
      const key = params.key;
      const vk = KEY_VK[key] ?? 0;
      await cdpSend(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await cdpSend(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      return { tabId: tab.id, key, native: true };
    });
  }
  const r = await injectOne(tab.id, { action: "key", key: params.key }, { frameId: frameOf(params) });
  return { tabId: tab.id, ...r };
}

export async function inputScroll(params) {
  const tab = await resolveTab(params?.tabId);
  const frameId = frameOf(params);
  if (params?.native) {
    const vp = await injectOne(tab.id, { action: "viewport" }, { frameId });
    let cx = Math.round(vp.w / 2), cy = Math.round(vp.h / 2);
    if (frameId) {
      const off = await frameOffsetInMain(tab.id, frameId);
      cx += off.x; cy += off.y;
    }
    return withDebugger(tab.id, async () => {
      await cdpSend(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x: cx, y: cy,
        deltaX: params?.dx || 0, deltaY: params?.dy || 0,
      });
      return { tabId: tab.id, native: true, dx: params?.dx || 0, dy: params?.dy || 0, ...(frameId ? { frameId } : {}) };
    });
  }
  const r = await injectOne(tab.id, { action: "scroll", dx: params?.dx, dy: params?.dy, ref: params?.ref, selector: params?.selector }, { frameId });
  return { tabId: tab.id, ...r };
}

export async function formFill(params) {
  const tab = await resolveTab(params?.tabId);
  const frameId = frameOf(params);
  const r = await injectOne(tab.id, { action: "fill", fields: params.fields }, { frameId });
  return { tabId: tab.id, ...r };
}

// ---------------- 文件上传（CDP DOM.setFileInputFiles，路径由网关侧校验存在性） ----------------
export async function inputUpload(params) {
  if (!params?.selector && !params?.ref) throw new Error("input.upload 需要 selector 或 ref 定位 <input type=file>");
  if (!Array.isArray(params?.files) || !params.files.length) throw new Error("input.upload.files 必须为非空路径数组");
  const tab = await resolveTab(params?.tabId);
  // 统一定位：ref/selector → 注入层打一次性标记属性 → 生成 CDP 可用的选择器（主 frame 元素）
  const marked = await injectOne(tab.id, { action: "markForUpload", ref: params?.ref, selector: params?.selector });
  return withDebugger(tab.id, async () => {
    await cdpSend(tab.id, "DOM.enable");
    const doc = await cdpSend(tab.id, "DOM.getDocument", { depth: 1 });
    const q = await cdpSend(tab.id, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: marked.selector });
    if (!q?.nodeId) throw new Error("CDP 未找到文件输入节点: " + marked.selector);
    await cdpSend(tab.id, "DOM.setFileInputFiles", { files: params.files, nodeId: q.nodeId });
    // 清理一次性标记属性，不污染页面 DOM
    try {
      await injectOne(tab.id, { action: "cleanupMark", selector: marked.selector, attributeName: marked.attributeName }, { frameId: frameOf(params) });
    } catch { /* 清理失败不影响上传结果 */ }
    return {
      tabId: tab.id, uploaded: params.files.length, files: params.files, target: marked,
      note: "文件已注入该 file input，随后用 input.click 点击提交按钮或 input.type submit=true 提交表单",
    };
  });
}

// ---------------- 执行 JS ----------------
// MV3 实测约束：扩展 CSP 禁止字符串 eval（ISOLATED world 也受扩展 CSP 管辖），
// 且 executeScript 的 injection 校验拒绝 awaitPromise 属性（Edge 157）。
// 因此 page.eval 统一走 chrome.debugger 的 CDP Runtime.evaluate：
//   · 不受扩展 CSP 限制          · MAIN world 原生支持（页面 JS 全局可访问）
//   · ISOLATED world 经 Page.createIsolatedWorld 实现
//   · awaitPromise / returnByValue 原生支持
//   · allowUnsafeEvalBlockedByCSP：Chromium 105+ 起 Runtime.evaluate 默认受 CSP 拦截，需显式放行
export async function pageEval(params) {
  const tab = await resolveTab(params?.tabId);
  const world = params?.world === "MAIN" ? "MAIN" : "ISOLATED";
  return withDebugger(tab.id, async () => {
    const evalParams = {
      expression: params.expression,
      returnByValue: true,
      awaitPromise: !!params?.awaitPromise,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true,
    };
    if (world === "ISOLATED") {
      // Page.createIsolatedWorld 的 frameId 是必填参数（缺省报 -32602 Invalid parameters）
      await cdpSend(tab.id, "Page.enable");
      const tree = await cdpSend(tab.id, "Page.getFrameTree");
      const w = await cdpSend(tab.id, "Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id,
        worldName: "zcode-eval-" + Date.now(),
        grantUniveralAccess: false,
      });
      evalParams.contextId = w.executionContextId;
    }

    // 执行看门狗：超时后尝试强杀页面脚本，并【主动 detach】释放调试通道。
    // 现实约束（渗透实测）：while(true){} 会锁死页面主线程，此时
    //   · Runtime.terminateExecution 可能无法送达（同一条 CDP 通道被阻塞）
    //   · 后续 eval / screenshot 都会一起挂起
    // 因此策略是「快速失败 + 释通道 + 告知恢复方式」，而不是假装能杀掉死循环。
    const EXEC_TIMEOUT_MS = Math.min(Math.max(Number(params?.timeoutMs) || 8000, 1000), 30000);
    let timedOut = false;
    const raceEval = cdpSend(tab.id, "Runtime.evaluate", evalParams);
    const watchdog = new Promise((_, rej) =>
      setTimeout(() => {
        timedOut = true;
        // 尽力强杀（不 await，避免看门狗自身被拖死）
        Promise.resolve()
          .then(() => cdpSend(tab.id, "Runtime.enable", {}))
          .then(() => cdpSend(tab.id, "Runtime.terminateExecution", {}))
          .catch(() => { /* 通道可能已阻塞 */ });
        rej(new Error(
          `eval 执行超时 ${EXEC_TIMEOUT_MS}ms：页面 JS 主线程已被阻塞（如 while(true)）。` +
          `已请求终止并释放调试通道。恢复方法：调用 nav.reload 刷新该标签页（或手动刷新）。`
        ));
      }, EXEC_TIMEOUT_MS)
    );
    let r;
    try {
      r = await Promise.race([raceEval, watchdog]);
    } catch (e) {
      // 超时/阻塞后立即释放 debugger，避免该 tab 的调试通道长期不可用
      if (timedOut) {
        Promise.resolve().then(() => chrome.debugger.detach({ tabId: tab.id })).catch(() => {});
      }
      throw e;
    }
    if (r?.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("page eval error: " + (d.exception?.description || d.exception?.value || d.text));
    }
    return { tabId: tab.id, world, result: limitBytes(r?.result?.value, params?.maxBytes), ...(timedOut ? { timedOut } : {}) };
  });
}
