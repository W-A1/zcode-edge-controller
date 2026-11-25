// popup：状态展示 / 模式切换 / token 配对 / CDP 通道开关 / 写操作审批 / 日志查看
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let pendingId = null;
let gwSettings = { gatewayUrl: "", token: "" };

/** 从 ws://host:port/bridge 推导 REST 基址 http://host:port */
function restBase() {
  const m = /^ws(s?):\/\/([^/]+)/.exec(gwSettings.gatewayUrl || "");
  return m ? `http${m[1]}://` + m[2] : null;
}
function gwHeaders() {
  return { authorization: `Bearer ${gwSettings.token}`, "content-type": "application/json" };
}
async function gwFetch(path, opts = {}) {
  const base = restBase();
  if (!base) throw new Error("网关地址未配置");
  const res = await fetch(base + path, { ...opts, headers: { ...gwHeaders(), ...(opts.headers || {}) }, signal: AbortSignal.timeout(20000) });
  const j = await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }));
  if (!j.ok) throw new Error(j.error || `http ${res.status}`);
  return j;
}

async function refreshCdp() {
  try {
    const st = await gwFetch("/cdp/status");
    // 兼容两种返回结构：/cdp/enable 返回顶层 enabled，/cdp/status 返回 routing.cdp.enabled
    const s = st.routing?.cdp || st;
    const enabled = s.enabled === true;
    $("cdp-dot").className = "dot " + (enabled ? "on" : "off");
    $("cdp-state").textContent = enabled
      ? `已启用 @ 127.0.0.1:${s.cdpPort}${s.edgeSpawnedByUs ? "（本网关拉起）" : ""}`
      : "未启用——全部命令走扩展桥（降级可用）";
    $("cdp-enable").disabled = enabled;
    $("cdp-disable").disabled = !enabled;
  } catch (e) {
    $("cdp-dot").className = "dot off";
    $("cdp-state").textContent = "网关不可达：" + e.message.slice(0, 60);
    $("cdp-enable").disabled = true;
    $("cdp-disable").disabled = true;
  }
}
$("cdp-enable").addEventListener("click", async () => {
  $("cdp-state").textContent = "启用中（拉起 Edge 实例并建立 CDP 会话，最长 15s）…";
  $("cdp-enable").disabled = true;
  try {
    await gwFetch("/cdp/enable", { method: "POST", body: "{}" });
  } catch (e) {
    $("cdp-state").textContent = "启用失败：" + e.message.slice(0, 90);
  }
  refreshCdp();
});
$("cdp-disable").addEventListener("click", async () => {
  try { await gwFetch("/cdp/disable", { method: "POST", body: "{}" }); } catch (e) { /* 忽略 */ }
  refreshCdp();
});

const STATE_TEXT = {
  open: "已连接网关",
  connecting: "连接中…",
  retrying: "重连中（检查网关是否在运行）",
  idle: "未连接（未配置 token 或网关未启动）",
};

async function refresh() {
  const st = await send({ type: "ui.getState" });
  $("dot").className = "dot " + (st.wsState === "open" ? "on" : st.wsState === "idle" ? "off" : "wait");
  $("sub").textContent = STATE_TEXT[st.wsState] || st.wsState;

  const modeRadio = document.querySelector(`input[name=mode][value="${st.mode}"]`);
  if (modeRadio) modeRadio.checked = true;

  $("url").value = st.gatewayUrl;
  if (st.hasToken && !$("token").value) $("token").placeholder = "已配置（留空保持不变）";
  else if (!st.hasToken) $("token").placeholder = "粘贴 server/.token 内容";
  gwSettings = { gatewayUrl: st.gatewayUrl, token: "" };
  // token 已存于 storage.local（getSettings 默认值含 token），这里直接取配置用于 REST
  chrome.storage.local.get(["token"]).then(({ token }) => { gwSettings.token = token || ""; refreshCdp(); });

  const ap = st.pending;
  pendingId = ap?.id || null;
  $("approval").classList.toggle("hidden", !ap);
  if (ap) {
    const extra = st.pendingCount > 1 ? `（队列 ${st.pendingCount} 条，批准后自动显示下一条）` : "";
    $("ap-cmd").textContent = "命令: " + ap.cmd + extra;
    $("ap-params").textContent = "参数: " + ap.paramsPreview;
  }

  $("logbox").textContent =
    (st.logs || []).map((l) => `${l.ts} ${l.level === "error" ? "✗" : l.level === "warn" ? "!" : "·"} ${l.msg}`).join("\n") || "（暂无日志）";
  $("logbox").scrollTop = 1e9;
}

$("save").addEventListener("click", async () => {
  const settings = { mode: document.querySelector("input[name=mode]:checked").value };
  const url = $("url").value.trim();
  if (url) settings.gatewayUrl = url;
  const tok = $("token").value.trim();
  if (tok) settings.token = tok;
  await send({ type: "ui.save", settings });
  $("token").value = "";
  refresh();
});

$("reconnect").addEventListener("click", async () => { await send({ type: "ui.reconnect" }); refresh(); });
$("clearlog").addEventListener("click", async () => { await send({ type: "ui.clearLogs" }); refresh(); });
$("copyaudit").addEventListener("click", async () => {
  try {
    const r = await send({ type: "ui.audit" });
    const text = JSON.stringify(r.audit || [], null, 2);
    await navigator.clipboard.writeText(text);
    $("copyaudit").textContent = `已复制 ${r.audit?.length ?? 0} 条`;
    setTimeout(() => { $("copyaudit").textContent = "复制审计"; }, 2000);
  } catch (e) {
    $("copyaudit").textContent = "复制失败";
    setTimeout(() => { $("copyaudit").textContent = "复制审计"; }, 2000);
  }
});
$("ap-yes").addEventListener("click", async () => { if (pendingId) await send({ type: "ui.approve", id: pendingId, approve: true }); refresh(); });
$("ap-no").addEventListener("click", async () => { if (pendingId) await send({ type: "ui.approve", id: pendingId, approve: false }); refresh(); });

document.querySelectorAll("input[name=mode]").forEach((r) =>
  r.addEventListener("change", async () => {
    await send({ type: "ui.save", settings: { mode: r.value }, reconnect: false });
    refresh();
  })
);

refresh();
setInterval(refresh, 1500); // popup 打开期间轮询连接/审批状态
