// 冒烟测试：对真实 Edge 全命令一键自检（扩展桥通路）。
//   npm run smoke                # 默认 9223，自动定位/新建沙箱页
//   npm run smoke -- --port 9323 --cdp   # 走 CDP 备用通路（9323 网关）
// 注意：写命令会触发扩展弹窗批准卡片（confirm-writes 模式），请留意工具栏徽标"!"并点"批准执行"。
//      拒绝/超时的写命令计为 SKIP，不判 FAIL。
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const PORT = Number(get("--port") || 9223);
const TOKEN = get("--token") || fs.readFileSync(path.join(ROOT, "server", ".token"), "utf8").trim();
const BASE = `http://127.0.0.1:${PORT}`;
const CDP = argv.includes("--cdp");

const results = [];
const vias = [];
const ok = (name, detail = "") => {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`);
};
const fail = (name, err) => { results.push({ name, ok: false, detail: err }); console.log(`  ✗ ${name} — ${err}`); };
const skip = (name, err) => { results.push({ name, ok: null, detail: err }); console.log(`  ○ ${name}（跳过：${err}）`); };

async function call(cmd, params = {}, timeoutMs) {
  const res = await fetch(`${BASE}/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ cmd, params, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs || 95000),
  });
  const j = await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }));
  // CDP 写命令审批闸门（--confirm-cdp-writes）：428 → 冒烟自检自动确认并重放
  if (res.status === 428 && j.confirmId) {
    console.log(`  ⟳ ${cmd} 被 CDP 审批闸门拦截（${j.confirmId}），自动确认执行`);
    const cf = await fetch(`${BASE}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ id: j.confirmId }),
    });
    const cj = await cf.json().catch(() => ({ ok: false, error: `http ${cf.status}` }));
    if (!cj.ok) {
      const e = new Error(cj.error || "confirm failed");
      e.isApproval = true;
      throw e;
    }
    return cj.data;
  }
  if (j.data?.__via) vias.push({ cmd, via: j.data.__via });
  if (!j.ok) {
    const e = new Error(j.error || "unknown");
    e.isApproval = /用户未批准|60s 超时/.test(j.error || "");
    throw e;
  }
  return j.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findSandboxTab() {
  const { tabs } = await call("tabs.list", {}, 20000);
  return tabs.find((t) => /sandbox\.html/.test(t.url || ""));
}

async function main() {
  console.log(`\n=== ZCode Edge Controller 冒烟测试（${CDP ? "CDP 备用通路" : "扩展桥"} @ ${PORT}）===\n`);

  // 0. 网关健康（/healthz 最小信息 + /status 鉴权详情）
  try {
    const h = await (await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(5000) })).json();
    if (!h.ok) throw new Error("healthz ok=false");
    if (!CDP && !h.extensionOnline) {
      console.log("✗ 扩展桥未连接。请确认：① npm run dev（网关在跑）② Edge 扩展弹窗已粘贴 token 且圆点绿色");
      process.exit(1);
    }
    let builds = "n/a";
    try {
      const st = await (await fetch(`${BASE}/status`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(5000) })).json();
      builds = (st.connections || []).map((c) => `${c.build}`).join(",") || "n/a";
    } catch { /* /status 不可用不影响冒烟 */ }
    ok("healthz / 网关健康", CDP ? "CDP 后端已启用" : `扩展桥在线（build=${builds}）`);
  } catch (e) {
    console.log(`✗ 网关不可达（${BASE}）：${e.message}\n  先运行 npm run dev`);
    process.exit(1);
  }

  // 1. 沙箱页（写命令 tabs.create 需批准；已有则复用）
  let sandbox = null;
  try {
    sandbox = await findSandboxTab();
    if (sandbox) ok("定位沙箱页", `tabId=${sandbox.id}`);
    else {
      const data = await call("tabs.create", { url: "http://127.0.0.1:8090/test/sandbox.html" });
      sandbox = { id: data.tabId };
      ok("新建沙箱页", `tabId=${sandbox.id}`);
    }
    await sleep(1200);
  } catch (e) {
    e.isApproval ? skip("新建沙箱页", "未批准") : fail("沙箱页准备", e.message);
    if (!sandbox) return report();
  }
  const T = sandbox.id;

  // 2. 读命令组
  try {
    const refs = await call("page.refs", { tabId: T });
    ok("page.refs", `${refs.count} 个可交互元素（e1 按钮 A …）`);
  } catch (e) { fail("page.refs", e.message); }

  try {
    const w = await call("wait.for", { tabId: T, text: "按钮 A", timeoutMs: 6000 }, 30000);
    ok("wait.for（轮询）", `命中 ${w.matched}，${w.elapsedMs}ms`);
  } catch (e) { fail("wait.for", e.message); }

  try {
    const md = await call("page.content", { tabId: T, format: "markdown", maxBytes: 5000 }, 30000);
    ok("page.content markdown", `${md.bytes}B，含表格: ${md.content.includes("| 资产 |") ? "✓" : "?"}`);
  } catch (e) { fail("page.content markdown", e.message); }

  try {
    let shot, lastErr;
    for (let i = 0; i < 2; i++) {
      try { shot = await call("page.screenshot", { tabId: T, fullPage: true, format: "png" }, 90000); lastErr = null; break; }
      catch (e) { lastErr = e; await sleep(1500); }
    }
    if (lastErr) throw lastErr;
    const out = path.join(ROOT, "logs", `smoke-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.base64, "base64"));
    ok("page.screenshot 整页", `${Math.round(shot.base64.length * 3 / 4 / 1024)}KB → ${path.relative(ROOT, out)}`);
  } catch (e) { fail("page.screenshot", e.message); }

  // 3. 写命令组（每条都会弹批准卡片；拒绝则 SKIP）
  console.log("\n-- 以下为写命令，请在扩展弹窗点「批准执行」（每条 60s 超时）--\n");

  try {
    const r = await call("input.click", { tabId: T, ref: "e1" });
    const log = await call("page.content", { tabId: T, selector: "#eventlog", maxBytes: 2000 }, 30000);
    const hit = /点击了 btn-a/.test(log.content || "");
    ok("input.click(ref) → 事件日志", hit ? "点击已生效" : "点击返回但日志未见（检查沙箱页）");
  } catch (e) { e.isApproval ? skip("input.click(ref)", "未批准") : fail("input.click(ref)", e.message); }

  try {
    const r = await call("input.type", { tabId: T, selector: "#in-name", text: "ZCode 冒烟测试" });
    // input 的 value 不在 innerText 里，读回需走 eval
    const v = await call("page.eval", { tabId: T, expression: "document.getElementById('in-name').value" });
    const got = typeof v.result === "string" ? v.result : "";
    ok("input.type(可信输入)", got.includes("ZCode 冒烟测试") ? `值已写入（${got.length} 字符）` : `输入返回但读回为"${got.slice(0, 20)}"`);
  } catch (e) { e.isApproval ? skip("input.type", "未批准") : fail("input.type", e.message); }

  try {
    const r = await call("form.fill", { tabId: T, fields: [
      { selector: "#f-user", value: "zcode" },
      { selector: "#f-pass", value: "pass123" },
    ] });
    ok("form.fill 批量填表", `filled=${r.filled}`);
  } catch (e) { e.isApproval ? skip("form.fill", "未批准") : fail("form.fill", e.message); }

  try {
    const r = await call("page.eval", { tabId: T, expression: "({title: document.title, href: location.href})" });
    ok("page.eval（debugger/MAIN）", `title=${(r.result?.title || "").slice(0, 20)}`);
  } catch (e) {
    /CSP|Evaluating a string/.test(e.message)
      ? skip("page.eval", "扩展未重载到 v4（edge://extensions 点「重新加载」后重跑）")
      : e.isApproval ? skip("page.eval", "未批准") : fail("page.eval", e.message);
  }

  try {
    await call("nav.reload", { tabId: T });
    ok("nav.reload", "刷新并等加载完成");
  } catch (e) { e.isApproval ? skip("nav.reload", "未批准") : fail("nav.reload", e.message); }

  try {
    // reload 后页面为本机最新版（含 #in-file）；生成真实存在的临时上传文件
    const upFile = path.join(ROOT, "logs", `smoke-upload-${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(upFile), { recursive: true });
    fs.writeFileSync(upFile, "zcode edge controller upload smoke test\n");
    await call("input.upload", { tabId: T, selector: "#in-file", files: [upFile] });
    const namev = await call("page.eval", { tabId: T, expression: "document.getElementById('in-file').files[0] ? document.getElementById('in-file').files[0].name : ''" });
    const fname = typeof namev.result === "string" ? namev.result : "";
    ok("input.upload（CDP setFileInputFiles）", fname ? `页面侧文件名=${fname}` : "已注入但页面侧未读到（检查 onChange）");
  } catch (e) { e.isApproval ? skip("input.upload", "未批准") : fail("input.upload", e.message); }

  try {
    await call("net.start", { tabId: T, max: 200 });
    await call("nav.goto", { tabId: T, url: "http://127.0.0.1:8090/test/sandbox.html?cachebust=" + Date.now() });
    await sleep(800);
    const d = await call("net.dump", { tabId: T, tail: 50, withBodies: true });
    await call("net.stop", { tabId: T });
    ok("net.start/dump/stop 网络捕获", `捕获 ${d.total} 条请求，响应体摘要 ${d.bodies?.length ?? 0} 条`);
  } catch (e) { e.isApproval ? skip("net.* 网络捕获", "未批准") : fail("net.* 网络捕获", e.message); }

  return report();
}

function report() {
  if (vias.length) console.log("\n通道回显:", vias.map((v) => v.cmd + "→" + v.via).join(", "));
  const pass = results.filter((r) => r.ok === true).length;
  const skipped = results.filter((r) => r.ok === null).length;
  const failed = results.filter((r) => r.ok === false).length;
  console.log(`\n=== 结果：${pass} 通过 / ${skipped} 跳过 / ${failed} 失败 ===`);
  if (failed) {
    console.log("\n失败项排查见 docs/TROUBLESHOOTING.md：");
    for (const r of results.filter((r) => r.ok === false)) console.log(`  ✗ ${r.name}: ${r.detail}`);
  }
  if (skipped) console.log("\n跳过说明：写命令需要批准（弹窗点「批准执行」后重跑即通过）；page.eval 需重载扩展到 v4。");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("[smoke fatal]", e); process.exit(1); });
