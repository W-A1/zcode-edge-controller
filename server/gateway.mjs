// 本地网关（v1.3 命令级通道路由）：
// - WS Server  ws://127.0.0.1:<port>/bridge   扩展桥（token 配对；多连接并存）
// - REST       POST /call                     标准化命令接口（Bearer token）
// - REST       GET  /healthz                  健康检查（含通道路由摘要）
// - REST       POST /cdp/enable|disable  GET /cdp/status   CDP 通道运行时开关（用户手动操作豁免审批）
// - REST       GET  /pending  POST /confirm|reject           CDP 写命令审批（--confirm-cdp-writes）
//
// 能力路由规则（pickChannel）：
//   ① CDP 未启用 → 全部扩展桥（离线则明确报错引导，不崩溃）
//   ② CDP 启用：
//      a. strong 命令（page.eval/input.upload/net.*）→ CDP（深度 JS/文件注入/网络拦截）
//      b. nativeStrong 命令且 params.native=true → CDP 可信事件
//      c. 其余普通读写 → 扩展桥（保留扩展侧审批闸门）
//      d. 扩展离线 → 全部降级 CDP（若支持）
//      e. 双边不支持 → 503
//   每条命令结果附 __via: "ext" | "cdp" | "gateway"（可观测/可断言）。
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { COMMANDS, classify } from "./protocol.mjs";
import { checkCmd, bearerOk, originOk } from "./security.mjs";
import { createCdpManager } from "./cdp-manager.mjs";
import { createDirectEval } from "./direct-eval.mjs";

export async function createGateway(opts = {}) {
  const {
    port = 9223,
    host = "127.0.0.1",
    token,
    prefer = "auto",        // auto（路由矩阵）| extension（强制扩展）| cdp（强制 CDP，兼容旧值）
    cdpPort = 0,            // >0 表示启动时即启用 CDP（向后兼容 v1.2）；0 = 默认关闭，运行时经 /cdp/enable 或 edge_cdp_control 开启
    confirmCdpWrites = false,
    log = () => {},
  } = opts;

  if (!token) throw new Error("gateway requires a token");
  const startedAt = Date.now();
  const extConns = new Map(); // clientId -> {ws, client, v, build, commands:Set|null, since}
  let lastConnId = null;
  let seq = 0;
  const pending = new Map();
  const pendingCdp = new Map();
  const PENDING_TTL_MS = 5 * 60 * 1000;
  const MAX_PENDING = 50; // 挂起队列上限，防止无限灌入导致内存增长
  const cdpMgr = createCdpManager({ log });
  // 直连 CDP 执行器：page.eval 走独立进程连接，避免页面 JS 死循环阻塞扩展 SW（实测确认的架构缺陷）
  const directEval = cdpPort ? createDirectEval({ port: cdpPort, log }) : null;

  function sweepPendingCdp() {
    const now = Date.now();
    for (const [id, p] of pendingCdp) {
      if (now - p.ts > PENDING_TTL_MS) {
        pendingCdp.delete(id);
        log(`[confirm] 挂起审批过期移除 id=${id} cmd=${p.cmd}`);
      }
    }
  }

  /** 入队（带容量上限：满则淘汰最旧的，防 DoS 撑爆内存） */
  function enqueuePending(confirmId, entry) {
    sweepPendingCdp();
    if (pendingCdp.size >= MAX_PENDING) {
      const oldest = [...pendingCdp.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) pendingCdp.delete(oldest[0]);
    }
    pendingCdp.set(confirmId, entry);
  }

  const connList = () => [...extConns.entries()].map(([id, c]) => ({ id, client: c.client, v: c.v, build: c.build, since: c.since, commands: c.commands ? c.commands.size : null }));

  function pickConn() {
    if (extConns.size === 0) return null;
    let conn = extConns.get(lastConnId);
    if (!conn) {
      const first = extConns.entries().next();
      if (!first.value) return null;
      lastConnId = first.value[0];
      conn = first.value[1];
    }
    if (extConns.size > 1) {
      log(`[bridge] 多实例在线（${extConns.size}），路由到最近活跃 ${lastConnId}（tabId 不参与路由，跨实例请隔离网关）`);
    }
    return { ...conn, id: lastConnId };
  }

  // ---------------- 命令级路由引擎 ----------------
  function pickChannel(cmd, params) {
    const def = COMMANDS[cmd];
    const backend = cdpMgr.backend;
    const cdpOn = !!backend;
    const conn = pickConn();
    const extOk = !!conn && (!conn.commands || conn.commands.has(cmd)); // 旧扩展无 commands 清单 → 视为支持

    // 工具级通道绑定（MCP 别名工具注入 __preferChannel）：绑定通道不可用时自动降级对侧，不崩溃
    const chanPref = params?.__preferChannel;
    if (chanPref === "ext") return conn ? { via: "ext", conn } : (backend?.supports(cmd) ? { via: "cdp" } : null);
    if (chanPref === "cdp") return backend?.supports(cmd) ? { via: "cdp" } : (conn ? { via: "ext", conn } : null);

    // 显式 prefer（兼容 v1.2 的强制语义）
    if (prefer === "cdp") return backend?.supports(cmd) ? { via: "cdp" } : (conn ? { via: "ext", conn } : null);
    if (prefer === "extension") return conn ? { via: "ext", conn } : (backend?.supports(cmd) ? { via: "cdp" } : null);

    // 路由矩阵
    if (!cdpOn) return conn ? { via: "ext", conn } : null;                       // ① CDP 关 → 全扩展
    if (def.strong && backend.supports(cmd)) return { via: "cdp" };              // ②a 强控制 → CDP
    if (def.nativeStrong && params?.native === true && backend.supports(cmd)) return { via: "cdp" }; // ②b 可信事件
    if (extOk) return { via: "ext", conn };                                      // ②c 普通读写 → 扩展
    if (backend.supports(cmd)) return { via: "cdp" };                            // ②d 扩展离线/不支持 → CDP 降级
    return conn ? { via: "ext", conn } : null;                                   // ②e 双不支持 → 交给扩展报明确错误
  }

  // ---------------- CDP 内建命令（网关本地执行，不路由） ----------------
  // 统一返回结构：所有 action 都返回 { action, enabled, cdpPort, edgeSpawnedByUs, ... }
  // （曾因 status 返回嵌套 routing.cdp 而 enable 返回顶层字段，导致 popup 状态显示不正确）
  async function cdpControl(params) {
    const action = params?.action;
    if (action === "enable") {
      const r = await cdpMgr.enable(params?.cdpPort);
      return { action: "enable", ...r };
    }
    if (action === "disable") {
      const r = await cdpMgr.disable();
      return { action: "disable", ...r };
    }
    const st = cdpMgr.status();
    return {
      action: "status",
      ...st,
      routing: {
        prefer,
        cdp: st,
        extensionOnline: extConns.size > 0,
        connections: connList(),
        strongCommands: Object.entries(COMMANDS).filter(([, d]) => d.strong).map(([k]) => k),
      },
    };
  }

  // ---------------- HTTP ----------------
  const server = http.createServer((req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, "http://x");
    // 安全：路径严格白名单（不做宽松归一化，避免 /./call 之类变体被路由）。
    // URL 解析已把 /a/../b 归一化；此处再用 path.posix.normalize 处理 /./ 与重复斜杠，
    // 归一化后若非白名单路径则 404，杜绝变体绕过。
    let pathname = url.pathname;
    try { pathname = decodeURIComponent(pathname); } catch { /* 保持原样 */ }
    // WHATWG URL 不消除 "/./"，path.posix.normalize 也保留前导 "./"；
    // 这里显式折叠：多重斜杠 → 单斜杠，去掉 "/./" 段，再 normalize 处理 ".."
    pathname = pathname.replace(/\/{2,}/g, "/").split("/").filter((seg) => seg !== "." && seg !== "").join("/");
    pathname = path.posix.normalize("/" + pathname);
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    // 严格白名单：归一化后不在表内一律 404（杜绝变体绕过）
    const ALLOWED_PATHS = new Set(["/healthz", "/status", "/call", "/pending", "/confirm", "/reject", "/cdp/enable", "/cdp/disable", "/cdp/status"]);
    if (!ALLOWED_PATHS.has(pathname)) {
      return json(404, { ok: false, error: `not found: ${pathname}` });
    }

    // 跨站请求防护：浏览器跨站请求必带 Origin；非扩展/DevTools 来源一律拒绝（防恶意网页借道本地服务）
    const origin = req.headers.origin;
    if (origin && !/^(chrome-extension|devtools):\/\//.test(origin)) {
      return json(403, { ok: false, error: "forbidden origin（仅允许本地工具与扩展访问）" });
    }

    if (req.method === "GET" && pathname === "/healthz") {
      // 未鉴权端点：只暴露最小健康信息（不泄露扩展 ID / CDP 会话 / 命令表）
      return json(200, { ok: true, uptimeS: Math.round((Date.now() - startedAt) / 1000), extensionOnline: extConns.size > 0 });
    }
    // 已鉴权的完整状态（供 dev-check / 弹窗 / Agent 自检）
    if (req.method === "GET" && pathname === "/status") {
      if (!bearerOk(req, token)) return json(401, { ok: false, error: "unauthorized" });
      return json(200, { ok: true, ...status() });
    }
    // CDP 运行时开关（用户手动操作——弹窗按钮/脚本自检，视为已确认，豁免审批闸门）
    if (req.method === "POST" && /^\/cdp\/(enable|disable|status)$/.test(pathname)) {
      if (!bearerOk(req, token)) return json(401, { ok: false, error: "unauthorized" });
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on("end", async () => {
        const action = pathname.split("/")[2];
        let cdpPortArg;
        try { cdpPortArg = JSON.parse(body || "{}").cdpPort; } catch { /* 忽略 */ }
        try {
          const r = await cdpControl({ action, cdpPort: cdpPortArg });
          return json(200, { ok: true, ...r });
        } catch (e) {
          return json(e.httpCode || 500, { ok: false, error: e.message });
        }
      });
      return;
    }
    if (req.method === "GET" && pathname === "/cdp/status") {
      if (!bearerOk(req, token)) return json(401, { ok: false, error: "unauthorized" });
      return cdpControl({ action: "status" }).then((r) => json(200, { ok: true, ...r }));
    }
    if (req.method === "POST" && pathname === "/call") {
      if (!bearerOk(req, token)) return json(401, { ok: false, error: "unauthorized（需要 Authorization: Bearer <token>）" });
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 5e6) req.destroy(); });
      req.on("end", async () => {
        let j;
        try { j = JSON.parse(body || "{}"); } catch { return json(400, { ok: false, error: "bad json body" }); }
        try {
          const data = await call(j.cmd, j.params, Math.min(Number(j.timeoutMs) || 0, 120000));
          return json(200, { ok: true, data });
        } catch (e) {
          const payload = { ok: false, error: e.message };
          if (e.confirmId) payload.confirmId = e.confirmId;
          return json(e.httpCode || 500, payload);
        }
      });
      return;
    }
    // CDP 写命令审批
    if (!bearerOk(req, token)) return json(401, { ok: false, error: "unauthorized" });
    if (req.method === "GET" && pathname === "/pending") {
      sweepPendingCdp();
      return json(200, { ok: true, pending: [...pendingCdp.entries()].map(([id, p]) => ({ id, cmd: p.cmd, params: p.params, ts: p.ts, ageS: Math.round((Date.now() - p.ts) / 1000) })) });
    }
    if (req.method === "POST" && (pathname === "/confirm" || pathname === "/reject")) {
      sweepPendingCdp();
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on("end", async () => {
        let j;
        try { j = JSON.parse(body || "{}"); } catch { return json(400, { ok: false, error: "bad json body" }); }
        const p = pendingCdp.get(j.id);
        if (!p) return json(404, { ok: false, error: `pending not found: ${j.id}` });
        pendingCdp.delete(j.id);
        if (pathname === "/reject") return json(200, { ok: true, rejected: j.id, cmd: p.cmd });
        try {
          const data = await dispatch(p.cmd, p.params);
          return json(200, { ok: true, confirmed: j.id, cmd: p.cmd, data });
        } catch (e) {
          return json(e.httpCode || 500, { ok: false, error: e.message });
        }
      });
      return;
    }
    json(404, { ok: false, error: "not found" });
  });

  // ---------------- WS 扩展桥 ----------------
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname !== "/bridge" || !originOk(req.headers.origin)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, onExtConnection);
  });

  function onExtConnection(ws) {
    let paired = false;
    let myId = null;
    ws.on("message", (buf) => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.type === "hello") {
        if (m.token !== token) {
          log("[bridge] token 校验失败，拒绝连接");
          ws.close(4001, "bad token");
          return;
        }
        paired = true;
        myId = String(m.runtimeId || m.client || `ext-${++seq}`);
        const old = extConns.get(myId);
        if (old && old.ws !== ws) { try { old.ws.close(4000, "replaced"); } catch { /* 忽略 */ } }
        extConns.set(myId, {
          ws,
          client: m.client || "?",
          v: m.v,
          build: m.build || "?",
          commands: Array.isArray(m.commands) ? new Set(m.commands) : null, // 能力集（路由用）
          since: Date.now(),
        });
        lastConnId = myId;
        log(`[bridge] 扩展已连接 id=${myId} build=${m.build || "?"} 命令集=${m.commands ? m.commands.length + " 条" : "未声明（旧版本）"}（在线 ${extConns.size} 个）`);
        return;
      }
      if (!paired) { ws.close(4001, "hello first"); return; }
      if (m.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
      if (m.type === "pong") return;
      if (m.type === "result") {
        const p = pending.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(m.id);
          if (m.ok) p.resolve(m.data);
          else {
            const err = new Error(m.error || "extension error");
            err.code = m.code;
            if (m.code === "BAD_PARAMS") err.httpCode = 400;
            p.reject(err);
          }
        }
        return;
      }
    });
    ws.on("close", () => {
      if (myId && extConns.get(myId)?.ws === ws) {
        extConns.delete(myId);
        log(`[bridge] 扩展连接断开 id=${myId}（剩余 ${extConns.size} 个）`);
        if (lastConnId === myId) lastConnId = extConns.keys().next().value || null;
      }
    });
    ws.on("error", () => {});
  }

  // ---------------- 命令入口（MCP / REST 共用） ----------------
  // 审批放行标记使用服务端私有 Symbol（不在 params 中传递）：
  // 旧实现用 params.__confirm 判定"已审批"，但 REST/MCP 调用方可自行在 params 里塞 __confirm=true
  // 从而跳过 428 闸门直接执行写命令（已实测复现）。Symbol 无法经 JSON 反序列化伪造。
  const CONFIRMED = Symbol("gateway.confirmed");

  // 网关侧结果体积限制（eval 返回值可能很大）
  function limitBytes0(value, maxBytes) {
    const cap = Math.min(Number(maxBytes) || 400000, 4 * 1024 * 1024);
    let s;
    try { s = JSON.stringify(value); } catch { s = String(value); }
    if (s == null || s.length <= cap) return value;
    return { __truncated: true, note: `结果超过 ${cap} 字节已截断`, preview: s.slice(0, cap) };
  }

  // 敏感文件规则：命中即拒绝上传（防网关 token / SSH 私钥 / 云凭据被上传到网页外泄）
  const SENSITIVE_FILE_PATTERNS = [
    /(^|[\\/])\.token$/i,
    /(^|[\\/])\.env(\..*)?$/i,
    /(^|[\\/])\.git[\\/]config$/i,
    /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
    /\.(pem|pfx|p12|key|keystore|jks)$/i,
    /(^|[\\/])\.aws[\\/]/i,
    /(^|[\\/])\.ssh[\\/]/i,
    /(^|[\\/])(credentials|secrets?|passwords?)\.(json|ya?ml|txt|ini)$/i,
  ];

  async function call(cmd, params, timeoutMs, trust = {}) {
    if (!cmd) { const e = new Error("missing cmd"); e.httpCode = 400; throw e; }
    const errW = checkCmd(cmd);
    if (errW) { const e = new Error(errW); e.httpCode = 400; throw e; }
    params = { ...(params || {}) };
    // 外部传入的 __confirm / __preferChannel 属于不可信输入：__confirm 一律剥离丢弃（防伪造），
    // __preferChannel 白名单化后保留（仅影响通道路由，不构成提权）。
    delete params.__confirm;
    if (!["ext", "cdp"].includes(params.__preferChannel)) delete params.__preferChannel;
    const isConfirmed = trust.confirmed === true; // 仅由服务端 /confirm 流程置位

    // 网关本地内建：CDP 通道总开关（不路由到扩展/CDP 后端）
    if (cmd === "cdp.control") {
      if (confirmCdpWrites && params.action !== "status" && !isConfirmed) {
        sweepPendingCdp();
        const confirmId = crypto.randomBytes(8).toString("hex");
        enqueuePending(confirmId, { cmd, params, ts: Date.now() });
        const e = new Error(`CONFIRM_REQUIRED ${confirmId}：cdp.${params.action} 已挂起待审批。POST /confirm {"id":"${confirmId}"} 执行；POST /reject 拒绝`);
        e.httpCode = 428;
        e.confirmId = confirmId;
        throw e;
      }
      const data = await cdpControl(params);
      return { __via: "gateway", ...data };
    }

    // file.upload：网关与 Edge 同机，文件存在性在网关侧校验（扩展 SW 无 fs）
    // 安全：拦截敏感文件上传，防止把本机凭据（网关 token、私钥、env）外泄到网页
    if (cmd === "input.upload") {
      const files = Array.isArray(params.files) ? params.files : [];
      if (!files.length) { const e = new Error("input.upload.files 必须为非空路径数组"); e.httpCode = 400; throw e; }
      if (files.length > 20) { const e = new Error("input.upload.files 单次最多 20 个文件"); e.httpCode = 400; throw e; }
      for (const f of files) {
        if (typeof f !== "string" || !path.isAbsolute(f) || !fs.existsSync(f)) {
          const e = new Error(`input.upload 文件不存在或非绝对路径: ${f}`);
          e.httpCode = 400;
          throw e;
        }
        // 只允许普通文件：目录/设备文件（NUL、CON）会导致扩展侧挂起或未定义行为
        let st;
        try { st = fs.statSync(f); } catch { const e = new Error(`input.upload 无法读取文件信息: ${f}`); e.httpCode = 400; throw e; }
        if (!st.isFile()) {
          const e = new Error(`input.upload 仅支持普通文件（拒绝目录/设备/链接）: ${f}`);
          e.httpCode = 400;
          throw e;
        }
        const hit = SENSITIVE_FILE_PATTERNS.find((re) => re.test(f));
        if (hit) {
          const e = new Error(`input.upload 拒绝上传敏感文件（疑似凭据/私钥/配置）: ${f}。命中规则 ${hit}；如确需上传请先复制到非敏感路径。`);
          e.httpCode = 403;
          throw e;
        }
      }
    }

    const kind = classify(cmd);
    // 超时：page.eval 含死循环风险，给较短上限（扩展侧默认 8s + 熔断，此处留余量）
    const tmo = timeoutMs || (
      cmd === "page.eval" ? 30000
        : kind === "write" || cmd === "page.screenshot" ? 90000
          : 45000
    );

    // page.eval 特殊路径：优先走 CDP 直连（独立进程），避免页面 JS 死循环阻塞扩展 SW。
    // 实测：扩展 SW 执行 Runtime.evaluate 时，页面 while(true){} 会阻塞 SW 事件循环，
    //       导致超时定时器不触发、熔断失效、并连带影响其他标签页。
    if (cmd === "page.eval" && directEval && kind === "write" && params.__preferChannel !== "ext") {
      const isConfirmedEval = trust.confirmed === true;
      if (confirmCdpWrites && !isConfirmedEval) {
        // 与 CDP 写命令同策略：闸门开启时需审批
        sweepPendingCdp();
        const confirmId = crypto.randomBytes(8).toString("hex");
        enqueuePending(confirmId, { cmd, params, ts: Date.now() });
        const e = new Error(`CONFIRM_REQUIRED ${confirmId}：page.eval 已挂起待审批。POST /confirm {"id":"${confirmId}"} 执行`);
        e.httpCode = 428;
        e.confirmId = confirmId;
        throw e;
      }
      const expr = String(params.expression ?? "");
      const tmoEval = Math.min(Math.max(Number(params.timeoutMs) || 8000, 1000), 30000);
      try {
        const r = await directEval.evaluate({
          targetId: params.cdpTargetId || null,
          expression: expr,
          awaitPromise: !!params.awaitPromise,
          timeoutMs: tmoEval,
        });
        return { __via: "cdp-direct", result: limitBytes0(r.result, params.maxBytes), targetId: r.targetId, url: r.url };
      } catch (e) {
        // 直连失败（如未启用 CDP 实例）时回退扩展通路，但明确标注
        if (/ECONNREFUSED|CDP \/json\/list|无可用 page target|未找到 target/i.test(e.message)) {
          log(`[eval] CDP 直连不可用（${e.message.slice(0, 60)}），回退扩展通路`);
        } else {
          throw e;
        }
      }
    }

    // page.screenshot 特殊路径：优先直连（避免 SW 阻塞）；直连失败则回退扩展通路
    if (cmd === "page.screenshot" && directEval && params.__preferChannel !== "ext") {
      try {
        const r = await directEval.screenshot({
          targetId: params.cdpTargetId || null,
          fullPage: !!params.fullPage,
          format: params.format === "jpeg" ? "jpeg" : "png",
          quality: params.quality,
          timeoutMs: 15000,
        });
        return { __via: "cdp-direct", base64: r.base64, format: r.format, url: r.url, title: r.title, tabId: r.targetId };
      } catch (e) {
        if (/ECONNREFUSED|CDP \/json\/list|无可用 page target|未找到 target/i.test(e.message)) {
          log(`[screenshot] CDP 直连不可用，回退扩展通路`);
        } else {
          throw e;
        }
      }
    }

    // 路由决策（命令级矩阵；__preferChannel 已在入口白名单化，路由后剥离不下发底层）
    const route = pickChannel(cmd, params);
    delete params.__preferChannel;
    if (!route) {
      const cdpOn = !!cdpMgr.backend;
      const e = new Error(
        cdpOn
          ? `命令 ${cmd} 双通道均不支持（扩展离线/能力缺失，CDP 后端不含该命令）`
          : "扩展桥未连接且 CDP 未启用：请启动网关并在 Edge 扩展弹窗完成 token 配对；或在弹窗/edge_cdp_control 启用 CDP 通道"
      );
      e.httpCode = 503;
      throw e;
    }

    // CDP 通路写命令审批闸门（--confirm-cdp-writes）
    if (route.via === "cdp" && confirmCdpWrites && kind === "write" && !isConfirmed) {
      sweepPendingCdp();
      const confirmId = crypto.randomBytes(8).toString("hex");
      enqueuePending(confirmId, { cmd, params, ts: Date.now() });
      const e = new Error(
        `CONFIRM_REQUIRED ${confirmId}：CDP 通路写命令已挂起待审批。POST /confirm {"id":"${confirmId}"} 执行；POST /reject {"id":"${confirmId}"} 拒绝；GET /pending 查看`
      );
      e.httpCode = 428;
      e.confirmId = confirmId;
      throw e;
    }

    let data;
    if (route.via === "ext") {
      data = await callExt(route.conn, cmd, params, tmo);
    } else {
      data = await cdpMgr.backend.call(cmd, params, tmo);
    }
    // 通道回显：Agent/测试可断言实际通路
    return typeof data === "object" && data !== null ? { __via: route.via, ...data } : { __via: route.via, result: data };
  }

  function dispatch(cmd, params) {
    // 服务端内部放行：confirmed 只经此参数（代码调用）传递，不来自任何反序列化输入
    return call(cmd, params || {}, undefined, { confirmed: true });
  }

  function callExt(conn, cmd, params, tmo) {
    return new Promise((resolve, reject) => {
      const id = `c${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`extension timeout after ${tmo}ms for ${cmd}（页面未响应或扩展 SW 被挂起，可重试）`));
      }, tmo);
      pending.set(id, {
        resolve,
        reject: (err) => {
          // 扩展侧参数校验错误（BAD_PARAMS）应映射为 400，而非 500
          if (err.code === "BAD_PARAMS") err.httpCode = 400;
          reject(err);
        },
        timer,
      });
      conn.ws.send(JSON.stringify({ type: "call", id, cmd, params }), (err) => {
        if (err) {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        }
      });
    });
  }

  function status() {
    return {
      extensionOnline: extConns.size > 0,
      connections: connList(),
      cdp: cdpMgr.status(),
      prefer,
      confirmCdpWrites,
      pendingCdp: pendingCdp.size,
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      commands: Object.keys(COMMANDS),
    };
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const realPort = server.address().port;
  log(`[gateway] listening on ws://${host}:${realPort}/bridge`);
  log(`[gateway] REST  POST http://${host}:${realPort}/call   GET http://${host}:${realPort}/healthz   POST /cdp/enable|disable`);
  if (confirmCdpWrites) log(`[gateway] CDP 写命令审批已启用：GET /pending → POST /confirm|reject`);
  log(`GATEWAY_PORT=${realPort}`);
  // 启动参数语义：cdpPort>0 = 启动时即启用 CDP 通道（向后兼容）；0 = 默认关闭
  await cdpMgr.initIfConfigured(cdpPort);

  return {
    server, wss, call, status, port: realPort,
    close: async () => {
      for (const [, c] of extConns) { try { c.ws.close(); } catch { /* 忽略 */ } }
      extConns.clear();
      wss.close();
      await new Promise((r) => server.close(r));
      await cdpMgr.close();
    },
  };
}
