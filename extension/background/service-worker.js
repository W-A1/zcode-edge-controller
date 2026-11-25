// ZCode Edge Controller — MV3 Service Worker（模块型）
// 职责：维持与本地网关的 WebSocket 长连接；接收命令 → 白名单校验 → 模式闸门/写审批 → 执行 → 回传。
//
// 保活机制（Edge ≥116 / Chromium ≥116）：
// 1) WebSocket 收发活动会重置 SW 30s 空闲计时 → 20s 心跳即可常驻；
// 2) chrome.alarms 每 30s 兜底：SW 被杀后唤醒并重连。

import { COMMANDS, PROTOCOL_VERSION, validateCmd } from "../lib/protocol.js";
import { getSettings, setSettings, checkMode, requestUserApproval, resolveApproval } from "../lib/security.js";
import * as R from "../lib/commands/read.js";
import * as W from "../lib/commands/write.js";
import { netStart, netDump, netStop, netHandler, restoreCaptures } from "../lib/commands/net.js";

const LOG_MAX = 120;
const AUDIT_MAX = 1000;
let ws = null;
let wsState = "idle"; // idle | connecting | open | retrying
let retryCount = 0;
let heartbeatTimer = null;

// ---------------- 命令处理表 ----------------
const HANDLERS = {
  "tabs.list": R.tabsList, "tab.get": R.tabGet, "page.content": R.pageContent,
  "page.refs": R.pageRefs, "page.screenshot": R.pageScreenshot, "wait.for": R.waitFor,
  "tabs.create": W.tabsCreate, "tabs.close": W.tabsClose, "tabs.activate": W.tabsActivate,
  "nav.goto": W.navGoto, "nav.back": W.navBack, "nav.forward": W.navForward, "nav.reload": W.navReload,
  "input.click": W.inputClick, "input.type": W.inputType, "input.key": W.inputKey,
  "input.scroll": W.inputScroll, "form.fill": W.formFill, "page.eval": W.pageEval,
  "input.upload": W.inputUpload,
  "net.start": netStart, "net.dump": netDump, "net.stop": netStop,
};

// ---------------- 审计（持久，storage.local，跨会话可查） ----------------
// 记录每条命令的执行与审批决策；弹窗日志只展示最近 120 条，审计是完整依据。
async function audit(entry) {
  try {
    const { zcAudit = [] } = await chrome.storage.local.get("zcAudit");
    zcAudit.push({ ts: Date.now(), ...entry });
    if (zcAudit.length > AUDIT_MAX) zcAudit.splice(0, zcAudit.length - AUDIT_MAX);
    await chrome.storage.local.set({ zcAudit });
  } catch { /* 审计失败不影响命令执行 */ }
}

// ---------------- 日志（内存环形 + storage.session，供 popup 展示） ----------------
const logs = [];
async function log(level, msg) {
  const line = { ts: new Date().toISOString().slice(11, 19), level, msg: String(msg).slice(0, 500) };
  logs.push(line);
  if (logs.length > LOG_MAX) logs.shift();
  try { await chrome.storage.session.set({ logs }); } catch { /* 会话存储不可用时忽略 */ }
  (level === "error" ? console.error : console.log)(`[ZC ${line.ts}] ${line.msg}`);
}

// ---------------- WebSocket 连接 ----------------
function isOpen() { return ws && ws.readyState === 1; }

async function connect() {
  if (isOpen() || (ws && ws.readyState === 0)) return;
  const { gatewayUrl, token } = await getSettings();
  if (!token) {
    wsState = "idle";
    await log("warn", "未配置 token，跳过连接（点扩展图标 → 弹窗填入网关 token）");
    return;
  }
  wsState = "connecting";
  try {
    ws = new WebSocket(gatewayUrl);
  } catch (e) {
    wsState = "retrying";
    scheduleRetry();
    return;
  }
  ws.onopen = () => {
    retryCount = 0;
    wsState = "open";
    startHeartbeat();
    // runtimeId = 扩展 ID（同 ID 顶替/异 ID 并存）；build = 版本（重载可观测）；
    // commands = 能力集（网关路由矩阵据此判断扩展通路是否支持该命令）
    const build = chrome.runtime.getManifest?.().version || "unknown";
    ws.send(JSON.stringify({
      type: "hello", token, client: "zcode-edge-extension", v: PROTOCOL_VERSION,
      runtimeId: chrome.runtime.id, build,
      commands: Object.keys(COMMANDS),
    }));
    log("info", `已连接网关 ${gatewayUrl}（build=${build}，命令集 ${Object.keys(COMMANDS).length} 条）`);
  };
  ws.onmessage = (ev) => handleMessage(ev.data);
  ws.onclose = () => { wsState = "retrying"; stopHeartbeat(); scheduleRetry(); };
  ws.onerror = () => { try { ws.close(); } catch { /* 忽略 */ } };
}

function scheduleRetry() {
  const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(retryCount++, 5)));
  setTimeout(() => { if (!isOpen()) connect(); }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => { if (isOpen()) ws.send(JSON.stringify({ type: "ping" })); }, 20000);
}
function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

function send(obj) { if (isOpen()) ws.send(JSON.stringify(obj)); }

// ---------------- 消息处理 ----------------
async function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === "ping") return send({ type: "pong" });
  if (msg.type === "call") return handleCall(msg);
}

async function handleCall({ id, cmd, params }) {
  const t0 = Date.now();
  let approved; // undefined = 非写命令 / 未进入审批；true/false = 审批决策（fail 闭包引用，必须函数级声明）
  const fail = (error, code) => {
    log("warn", `${cmd} ✗ ${error}`);
    audit({ cmd, kind: COMMANDS[cmd]?.kind, ok: false, error: String(error).slice(0, 300), ms: Date.now() - t0, ...(approved !== undefined ? { approved } : {}) });
    send({ type: "result", id, ok: false, error, ...(code ? { code } : {}) });
  };
  try {
    const errV = validateCmd(cmd, params);
    // 参数校验失败属调用方错误（400），不是内部错误（500）——渗透测试发现的语义问题
    if (errV) return fail(errV, "BAD_PARAMS");

    const kind = COMMANDS[cmd].kind;
    const { mode } = await getSettings();
    const errM = checkMode(kind, mode);
    if (errM) return fail(errM);

    if (kind === "write") {
      // 审批策略：
      //  confirm-writes（默认）：所有写命令弹批准卡片
      //  auto：普通写自动放行；critical（高危：tabs.close/page.eval/upload/net.*）仍强制确认
      //  readonly：已被 checkMode 拒绝
      const needsApproval = mode === "confirm-writes" || (mode === "auto" && COMMANDS[cmd].risk === "critical");
      if (needsApproval) {
        approved = await requestUserApproval(cmd, params);
        if (!approved) return fail("用户未批准该写操作（手动拒绝或 60s 超时）");
      }
    }

    if (!HANDLERS[cmd]) return fail(`命令 ${cmd} 仅网关侧支持（cdp.control）或版本不匹配——请确认扩展与网关版本一致`);
    const data = await HANDLERS[cmd](params || {});
    log("info", `${cmd} ✓`);
    audit({ cmd, kind, ok: true, ms: Date.now() - t0, ...(approved !== undefined ? { approved } : {}) });
    send({ type: "result", id, ok: true, data });
  } catch (e) {
    fail((e && e.message) || String(e));
  }
}

// ---------------- popup UI 消息 ----------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "ui.getState": {
          const s = await getSettings();
          const ss = await chrome.storage.session.get(["pendingApproval", "pendingCount"]);
          sendResponse({
            wsState, mode: s.mode, gatewayUrl: s.gatewayUrl, hasToken: !!s.token,
            logs, pending: ss.pendingApproval || null, pendingCount: ss.pendingCount || 0,
          });
          break;
        }
        case "ui.save": {
          await setSettings(msg.settings || {});
          logs.length = 0;
          if (msg.reconnect !== false) {
            try { ws?.close(); } catch { /* 忽略 */ }
            wsState = "retrying";
            retryCount = 0;
            connect();
          }
          const s = await getSettings();
          sendResponse({ ok: true, mode: s.mode, hasToken: !!s.token });
          break;
        }
        case "ui.approve":
          sendResponse({ ok: await resolveApproval(msg.id, msg.approve) });
          break;
        case "ui.reconnect":
          try { ws?.close(); } catch { /* 忽略 */ }
          connect();
          sendResponse({ ok: true });
          break;
        case "ui.clearLogs":
          logs.length = 0;
          await chrome.storage.session.set({ logs });
          sendResponse({ ok: true });
          break;
        case "ui.audit": {
          const { zcAudit = [] } = await chrome.storage.local.get("zcAudit");
          sendResponse({ ok: true, audit: zcAudit });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown ui message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  })();
  return true; // 异步 sendResponse
});

// ---------------- 生命周期 ----------------
// CDP 事件 → Network 捕获（net.start 期间长持有 attach）
chrome.debugger.onEvent.addListener(netHandler);
// SW 冷启动：恢复未完成的网络捕获（storage.session 持久化 + attach 浏览器级保持）
restoreCaptures().catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("zc-keepalive", { periodInMinutes: 0.5 });
  log("info", "扩展已安装/更新");
  connect();
});

chrome.runtime.onStartup.addListener(() => connect());

chrome.alarms.onAlarm.addListener((al) => {
  if (al.name !== "zc-keepalive") return;
  if (isOpen()) ws.send(JSON.stringify({ type: "ping" })); // 顺带喂看门狗
  else connect();
});

// SW 冷启动直接尝试连接
connect();
