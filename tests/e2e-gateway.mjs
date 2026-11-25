// 端到端（网关通路）：spawn gateway → mock 扩展（ws 客户端）→ REST /call 全链路
// 验证 token 配对、命令路由、白名单、鉴权、断线处理
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-token-123";

const child = spawn(
  process.execPath,
  [path.join(ROOT, "server", "cli.mjs"), "--gateway", "--port", "0", "--token", TOKEN],
  { stdio: ["ignore", "pipe", "pipe"] }
);

// 解析 GATEWAY_PORT 行
let out = "";
let port = null;
const portReady = new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error("等待 GATEWAY_PORT 超时")), 15000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    out += d;
    const m = /GATEWAY_PORT=(\d+)/.exec(out);
    if (m && port === null) {
      port = Number(m[1]);
      clearTimeout(timer);
      res(port);
    }
  });
});
child.stderr.on("data", (d) => process.stderr.write("[gw] " + d.toString()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  port = await portReady;
  console.log(`✓ 网关启动 @ ${port}`);

  const base = `http://127.0.0.1:${port}`;

  // 1) healthz
  const h = await fetch(`${base}/healthz`);
  const hj = await h.json();
  assert.equal(hj.ok, true);
  assert.equal(hj.extensionOnline, false);
  console.log("✓ /healthz");

  // 2) 未认证 401
  const r401 = await fetch(`${base}/call`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "tabs.list" }),
  });
  assert.equal(r401.status, 401);
  console.log("✓ 无 token 401");

  // 3) 错误 token 的扩展连接应被拒（close code 4001）
  const badCode = await new Promise((res, rej) => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    bad.on("close", (code) => res(code));
    bad.on("error", rej);
    bad.on("open", () => bad.send(JSON.stringify({ type: "hello", token: "WRONG", client: "mock" })));
    setTimeout(() => rej(new Error("bad-token 断开超时")), 5000);
  });
  assert.equal(badCode, 4001);
  console.log("✓ 错误 token 扩展连接被拒（4001）");

  // 4) 正确 token 的 mock 扩展连接并应答命令
  const mock = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  const seen = [];
  await new Promise((res, rej) => { mock.on("open", res); mock.on("error", rej); });
  mock.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "ping") return mock.send(JSON.stringify({ type: "pong" }));
    if (m.type === "call") {
      seen.push(m.cmd);
      mock.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: { mock: true, cmd: m.cmd, echo: m.params ?? {} } }));
    }
  });
  mock.on("open", () => mock.send(JSON.stringify({ type: "hello", token: TOKEN, client: "mock-extension", v: 1 })));
  mock.send(JSON.stringify({ type: "hello", token: TOKEN, client: "mock-extension", v: 1 }));
  await sleep(400);

  const h2 = await (await fetch(`${base}/healthz`)).json();
  assert.equal(h2.extensionOnline, true);
  console.log("✓ mock 扩展配对（extensionOnline=true）");

  // 5) REST 全链路：命令转发 → mock 应答 → 返回数据
  const r1 = await fetch(`${base}/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ cmd: "tabs.list", params: {} }),
  });
  const j1 = await r1.json();
  if (!j1.ok) console.log("[debug] tabs.list 响应:", JSON.stringify(j1).slice(0, 300));
  assert.equal(j1.ok, true);
  assert.equal(j1.data.mock, true);
  assert.equal(j1.data.cmd, "tabs.list");
  console.log("✓ REST /call 全链路（网关→扩展→回传）");

  // 6) 带参数透传
  const r2 = await fetch(`${base}/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ cmd: "nav.goto", params: { url: "https://example.com" } }),
  });
  const j2 = await r2.json();
  assert.equal(j2.ok, true);
  assert.equal(j2.data.echo.url, "https://example.com");
  console.log("✓ 参数透传");

  // 7) 白名单外命令 400
  const r3 = await fetch(`${base}/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ cmd: "process.exec" }),
  });
  assert.equal(r3.status, 400);
  assert.match((await r3.json()).error, /unknown command/);
  console.log("✓ 白名单外命令 400");

  // 7b) 安全回归：敏感文件上传必须被拦截（防凭据外泄）
  const rSen = await fetch(`${base}/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ cmd: "input.upload", params: { selector: "#f", files: [path.join(ROOT, "server", ".token")] } }),
  });
  assert.equal(rSen.status, 403, "★ 安全回归失败：敏感文件（.token）未被拦截");
  console.log("✓ 安全回归：敏感文件上传拦截（403）");

  // 8) 扩展断开 → 503
  mock.close();
  await sleep(300);
  const r4 = await fetch(`${base}/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ cmd: "tabs.list" }),
  });
  assert.equal(r4.status, 503);
  assert.match((await r4.json()).error, /扩展桥未连接/);
  console.log("✓ 扩展断开后 503 + 引导信息");

  // 9) 通道路由矩阵 + CDP 审批闸门（--cdp-port 启动即启用；需要 9222 的 Edge 实例，不在则跳过）
  let cdpEdge = false;
  try {
    const v = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1500) });
    cdpEdge = v.ok;
  } catch { cdpEdge = false; }
  if (!cdpEdge) {
    console.log("○ CDP 路由/审批用例跳过（127.0.0.1:9222 无 Edge 实例；可先 npm run dev -- --cdp）");
  } else {
    const gw2 = spawn(process.execPath, [
      path.join(ROOT, "server", "cli.mjs"), "--gateway", "--port", "0",
      "--cdp-port", "9222", "--confirm-cdp-writes", "--token", TOKEN,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out2 = "";
    const port2 = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("第二个网关启动超时")), 15000);
      gw2.stdout.setEncoding("utf8");
      gw2.stdout.on("data", (d) => {
        out2 += d;
        const m = /GATEWAY_PORT=(\d+)/.exec(out2);
        if (m) { clearTimeout(t); res(Number(m[1])); }
      });
    });
    try {
      const b2 = `http://127.0.0.1:${port2}`;
      const post = (body) => fetch(`${b2}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // mock2 连接 CDP 网关（模拟"扩展桥在线 + CDP 启用"的路由场景）
      const mock2 = new WebSocket(`ws://127.0.0.1:${port2}/bridge`);
      await new Promise((res, rej) => { mock2.on("open", res); mock2.on("error", rej); });
      mock2.on("message", (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === "ping") return mock2.send(JSON.stringify({ type: "pong" }));
        if (m.type === "call") mock2.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: { mock: true, cmd: m.cmd } }));
      });
      mock2.send(JSON.stringify({
        type: "hello", token: TOKEN, client: "mock-extension-2", v: 1,
        commands: ["tabs.list", "page.content", "input.click", "form.fill"], // 能力集声明：不含 page.eval/net.*
      }));
      await sleep(300);

      // 9a. 路由矩阵（CDP 启用 + 扩展在线 + 扩展声明了能力集）
      const rTabs = await post({ cmd: "tabs.list" });
      const jTabs = await rTabs.json();
      if (!jTabs.ok) console.log("[debug] tabs.list:", JSON.stringify(jTabs).slice(0, 300));
      assert.equal(jTabs.data?.__via, "ext", "能力集内的普通命令应路由扩展桥");
      // helper：CDP 通路写命令遇 428 自动确认（验证闸门放行闭环）
      const confirmPending = async (id) => {
        const cf = await fetch(`${b2}/confirm`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
        return cf.json();
      };
      const rEval = await post({ cmd: "page.eval", params: { expression: "1+1" } });
      let jEval = await rEval.json();
      if (rEval.status === 428 && jEval.confirmId) {
        console.log("  ⟳ page.eval 被 CDP 审批闸门拦截，自动确认（验证闸门闭环）");
        jEval = await confirmPending(jEval.confirmId);
      }
      assert.equal(jEval.ok, true, "page.eval 执行失败: " + JSON.stringify(jEval).slice(0, 200));
      // v1.5.0 起 page.eval 走 CDP 直连（避免页面死循环阻塞扩展 SW），__via 为 "cdp-direct"
      assert.ok(["cdp", "cdp-direct"].includes(jEval.data.__via), `strong 命令应走 CDP 通道，实际 ${jEval.data.__via}`);
      assert.equal(jEval.data.result, 2, "CDP Runtime.evaluate 1+1=2");
      // 准备 CDP 实例页面（write → 428 → confirm）
      const rNav = await post({ cmd: "nav.goto", params: { url: "http://127.0.0.1:8090/test/sandbox.html" } });
      let jNav = await rNav.json();
      if (rNav.status === 428 && jNav.confirmId) {
        console.log("  ⟳ nav.goto 被审批闸门拦截，自动确认");
        jNav = await confirmPending(jNav.confirmId);
      }
      assert.equal(jNav.ok, true, "CDP 通路 nav.goto 失败: " + JSON.stringify(jNav).slice(0, 200));
      const rClick = await post({ cmd: "input.click", params: { text: "按钮 A", native: true } });
      let jClick = await rClick.json();
      if (rClick.status === 428 && jClick.confirmId) {
        console.log("  ⟳ input.click(native) 被审批闸门拦截，自动确认");
        jClick = await confirmPending(jClick.confirmId);
      }
      assert.equal(jClick.ok, true, "native 点击失败: " + JSON.stringify(jClick).slice(0, 200));
      assert.equal(jClick.data.__via, "cdp", "native=true 可信事件应路由 CDP");

      // 9a-2. 工具级通道绑定（__preferChannel）：绑定优先于自动矩阵，不可用时自动降级对侧
      // tabs.list 是扩展能力 → 偏好 cdp 强制走 CDP（mock2 不在 CDP，由 CDP 后端应答）
      const rPrefCdp = await post({ cmd: "tabs.list", params: { __preferChannel: "cdp" } });
      const jPrefCdp = await rPrefCdp.json();
      assert.equal(jPrefCdp.data?.__via, "cdp", "__preferChannel=cdp 应强制走 CDP");
      // page.eval 是 strong（默认走 CDP）→ 偏好 ext 强制走扩展桥（mock2 能力集外仍应答）
      const rPrefExt = await post({ cmd: "page.eval", params: { expression: "2+3", __preferChannel: "ext" } });
      let jPrefExt = await rPrefExt.json();
      if (rPrefExt.status === 428 && jPrefExt.confirmId) jPrefExt = await confirmPending(jPrefExt.confirmId);
      assert.equal(jPrefExt.ok, true, "__preferChannel=ext 降级/放行失败: " + JSON.stringify(jPrefExt).slice(0, 200));
      assert.equal(jPrefExt.data.__via, "ext", "__preferChannel=ext 应强制走扩展桥");
      console.log("✓ 工具级通道绑定（__preferChannel）优先于自动矩阵，不可用自动降级");
      const rSt = await post({ cmd: "cdp.control", params: { action: "status" } });
      const jSt = await rSt.json();
      assert.equal(jSt.data.__via, "gateway");
      assert.equal(jSt.data.routing.cdp.enabled, true);
      console.log("✓ 路由矩阵：能力集内→扩展，strong/native→CDP，cdp.control→网关本地");

      // 9b. CDP 写命令审批闸门（tabs.create 不在 mock 能力集 → 走 CDP → critical 闸门 428）
      const rC = await post({ cmd: "tabs.create", params: { url: "about:blank" } });
      assert.equal(rC.status, 428, "CDP 通路写命令应 428 待审批");
      const jC = await rC.json();
      assert.ok(jC.confirmId, "428 应返回 confirmId");
      const p = await (await fetch(`${b2}/pending`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
      assert.ok(p.pending.some((x) => x.id === jC.confirmId));
      const cf = await fetch(`${b2}/confirm`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ id: jC.confirmId }),
      });
      const jf = await cf.json();
      assert.equal(jf.ok, true, "confirm 应放行执行: " + JSON.stringify(jf).slice(0, 200));
      const rR = await post({ cmd: "net.stop", params: {} });
      assert.equal(rR.status, 428);
      const jR2 = await rR.json();
      const rr = await fetch(`${b2}/reject`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ id: jR2.confirmId }),
      });
      assert.equal((await rr.json()).ok, true);
      console.log("✓ CDP 写命令审批闸门（428 → /pending → /confirm 执行 → /reject 拒绝）");

      // 9b-2. 安全回归：params 注入 __confirm 不得绕过审批闸门（历史高危漏洞）
      // 注：本节在独立网关内执行；敏感文件校验不依赖 CDP，可在主网关稳定验证
      const inj = await post({ cmd: "tabs.create", params: { url: "about:blank", __confirm: true } });
      assert.equal(inj.status, 428, "★ 安全回归失败：params.__confirm 可绕过审批闸门");
      console.log("✓ 安全回归：__confirm 注入无法绕过审批闸门");

      // 9c. 降级：扩展断开 + CDP 启用 → 全部走 CDP 不崩溃
      mock2.close();
      await sleep(300);
      const rD = await post({ cmd: "tabs.list" });
      const jD = await rD.json();
      assert.equal(jD.ok, true, "扩展断开后 CDP 启用状态应降级成功");
      assert.equal(jD.data.__via, "cdp", "降级后走 CDP");
      console.log("✓ 降级验证：扩展离线 + CDP 启用 → 自动走 CDP 不崩溃");
    } finally {
      gw2.kill();
    }
  }

  console.log("\n✅ e2e-gateway passed");
} finally {
  child.kill();
  setTimeout(() => process.exit(0), 200);
}
