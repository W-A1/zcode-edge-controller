// 极简 MCP stdio server（newline-delimited JSON-RPC 2.0，零依赖）
// 实现 initialize / tools/list / tools/call / ping，对接 ZCode 及通用 MCP host。
// 注意：stdout 只能输出协议消息，一切日志走 stderr。
//
// v1.4 工具层：
//  - TOOLS        25 个核心工具（通道由网关路由矩阵自动选择）
//  - ALIAS_TOOLS  10 个通道别名工具（工具名即通道：simple_* 走扩展、native/网络/整页走 CDP；
//                 绑定通道不可用时网关自动降级对侧，不崩溃）
//  - CDP 未启用时，依赖 CDP 的别名工具在 tools/list 描述中标注降级说明（保留可见，调用不报错）
import { TOOLS, ALIAS_TOOLS } from "./protocol.mjs";

export function createMcpStdio({ call, status, log = () => {} }) {
  const SERVER_INFO = { name: "zcode-edge-controller", version: "1.4.0" };
  let buf = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) dispatch(line);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();

  function write(obj) {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }

  function dispatch(line) {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    handle(req).catch((e) => {
      if (req?.id !== undefined) write({ id: req.id, error: { code: -32603, message: e?.message || String(e) } });
    });
  }

  async function handle(req) {
    const { id, method, params } = req;
    switch (method) {
      case "initialize": {
        // 回显客户端请求的协议版本（兼容各代 spec），缺省 2024-11-05
        return write({
          id,
          result: {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        return write({ id, result: {} });
      case "tools/list":
        return write({ id, result: { tools: listTools() } });
      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments || {};
        try {
          return write({ id, result: await invokeTool(name, args) });
        } catch (e) {
          return write({
            id,
            result: { content: [{ type: "text", text: "命令失败: " + (e?.message || String(e)) }], isError: true },
          });
        }
      }
      default:
        if (id !== undefined) write({ id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }

  function cdpEnabled() {
    try { return !!status().cdp?.enabled; } catch { return false; }
  }

  function listTools() {
    const core = TOOLS.map((t) => ({
      name: t.tool,
      description: t.desc + (t.kind === "write" ? "【写操作】" : ""),
      inputSchema: t.schema,
    }));
    const aliases = ALIAS_TOOLS.map((t) => {
      const note = t.requiresCdp && !cdpEnabled()
        ? "〔CDP 未启用：调用将自动降级到扩展通路〕"
        : t.channelPref === "ext"
          ? "〔扩展通路〕"
          : "〔CDP 通路〕";
      return {
        name: t.tool,
        description: note + " " + t.desc + (t.kind === "write" ? "【写操作】" : ""),
        inputSchema: t.schema,
      };
    });
    return [...core, ...aliases];
  }

  async function invokeTool(name, args) {
    const tool = TOOLS.find((t) => t.tool === name);
    const alias = ALIAS_TOOLS.find((t) => t.tool === name);
    if (!tool && !alias) throw new Error(`unknown tool: ${name}（可用工具见 tools/list）`);

    // 内建工具（不经扩展桥）
    if (!tool?.cmd && !alias) {
      if (name === "edge_status") {
        return { content: [{ type: "text", text: JSON.stringify(await status(), null, 2) }], isError: false };
      }
      throw new Error("builtin tool not implemented: " + name);
    }

    // ---- 别名分发（通道绑定 + 组合命令） ----
    if (alias) {
      if (alias.compose === "page_capture") return await aliasPageCapture(alias, args);
      if (alias.compose === "network_intercept") return await aliasNetworkIntercept(alias, args);
      const args2 = { ...(args || {}), ...(alias.paramsOverride || {}) };
      args2.__preferChannel = alias.channelPref; // 工具级通道绑定（网关路由优先级最高；不可用自动降级对侧）
      const data = await call(alias.cmd, args2);
      if (alias.cmd === "page.screenshot" && data?.base64) {
        const via = data.__via || alias.channelPref;
        return {
          content: [
            { type: "image", data: data.base64, mimeType: data.format === "jpeg" ? "image/jpeg" : "image/png" },
            { type: "text", text: `截图完成（通道=${via}）tab=${data.tabId} url=${data.url}` },
          ],
          isError: false,
        };
      }
      const via = data?.__via || alias.channelPref;
      return {
        content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
        isError: false,
      };
    }

    // ---- 核心工具 ----
    const data = await call(tool.cmd, args);
    if (tool.cmd === "page.screenshot" && data?.base64) {
      return {
        content: [
          { type: "image", data: data.base64, mimeType: data.format === "jpeg" ? "image/jpeg" : "image/png" },
          { type: "text", text: `截图完成 tab=${data.tabId} url=${data.url} title=${data.title ?? ""} format=${data.format}` },
        ],
        isError: false,
      };
    }
    return {
      content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
      isError: false,
    };

    // ---- 组合命令实现 ----
    async function aliasPageCapture(alias, args) {
      const tabId = args?.tabId;
      const shotArgs = { ...(tabId != null ? { tabId } : {}), fullPage: true, __preferChannel: "cdp" };
      const textArgs = { ...(tabId != null ? { tabId } : {}), format: "text", maxBytes: args?.textMaxBytes || 50000, __preferChannel: "cdp" };
      let shot, text;
      const errs = [];
      try { shot = await call("page.screenshot", shotArgs); } catch (e) { errs.push("screenshot: " + e.message); }
      try { text = await call("page.content", textArgs); } catch (e) { errs.push("content: " + e.message); }
      if (!shot && !text) throw new Error("page_capture 全部失败: " + errs.join("; "));
      const content = [];
      if (shot?.base64) content.push({ type: "image", data: shot.base64, mimeType: shot.format === "jpeg" ? "image/jpeg" : "image/png" });
      content.push({
        type: "text",
        text: JSON.stringify({
          tabId: (shot || text)?.tabId,
          url: (shot || text)?.url,
          title: (shot || text)?.title,
          text: text?.content ?? null,
          textTruncated: text?.truncated ?? false,
          degraded: errs.length ? errs : undefined, // 部分失败时说明降级情况
        }, null, 2),
      });
      return { content, isError: false };
    }

    async function aliasNetworkIntercept(alias, args) {
      const action = args?.action || "dump";
      const tabId = args?.tabId;
      if (action === "start") {
        const data = await call("net.start", { ...(tabId != null ? { tabId } : {}), max: args?.max, __preferChannel: "cdp" });
        return { content: [{ type: "text", text: JSON.stringify({ __via: data.__via, ...data }, null, 2) }], isError: false };
      }
      if (action === "dump") {
        const data = await call("net.dump", { ...(tabId != null ? { tabId } : {}), tail: args?.tail, withBodies: args?.withBodies, __preferChannel: "cdp" });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
      }
      if (action === "stop") {
        const data = await call("net.stop", { ...(tabId != null ? { tabId } : {}), __preferChannel: "cdp" });
        return { content: [{ type: "text", text: JSON.stringify({ __via: data.__via, ...data }, null, 2) }], isError: false };
      }
      throw new Error("network_intercept.action 非法: " + action);
    }
  }

  log("[mcp] stdio server ready (zcode-edge-controller)");
}
