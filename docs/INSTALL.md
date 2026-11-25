# 安装与配置

## 0. 前置条件

- Windows + Microsoft Edge（Chromium 内核，≥116 版本以保证 service worker WebSocket 保活）
- Node.js ≥ 18.17（用到全局 fetch）
- `node scripts/dev-check.mjs` 全绿再继续

## 1. 启动本地网关

```bash
cd zcode-edge-controller
npm install
npm run gateway
```

输出关键信息：

```
[token] <48位hex> (source=generated) — 在扩展弹窗填入该 token 完成配对；token 文件: server/.token
[gateway] listening on ws://127.0.0.1:9223/bridge
GATEWAY_PORT=9223
```

- token 存于 `server/.token`，也可以 `--token xxx` 或环境变量 `ZC_EDGE_TOKEN` 指定
- 改端口：`node server/cli.mjs --gateway --port 9323`（扩展弹窗里同步改网关地址）

## 2. 加载扩展（开发者模式）

1. Edge 地址栏输入 `edge://extensions`
2. 打开左下角 **开发人员模式**
3. 点 **加载解压缩的扩展**，选择 `zcode-edge-controller/extension/` 目录
4. 工具栏点扩展图标（若被折叠，先点图钉固定）
5. 弹窗中：
   - **网关 Token**：粘贴上一步的 token → **保存并重连**
   - **安全模式**：默认 `写需确认`，可按需切换
   - 顶部圆点 **变绿** = 已连接网关

> 自定义网关地址时填写 `ws://127.0.0.1:<端口>/bridge`。

## 3. 对接 ZCode（通路 A：MCP）

在 ZCode 的 MCP 配置中添加（全局配置文件，或项目级 `.zcode/mcp.json`，以你所用 ZCode 版本的 MCP 设置入口为准）：

```json
{
  "mcpServers": {
    "edge-controller": {
      "command": "node",
      "args": ["C:\\path\\to\\zcode-edge-controller\\server\\cli.mjs", "--mcp"]
    }
  }
}
```

注意：

- `--mcp` 模式**自带网关**（内嵌同进程）。如果独立网关（`npm run gateway`）已在跑，二选一：停掉独立网关，或给 MCP 模式指定 `--port` 并在扩展弹窗同步改地址
- 每次重启电脑后：先 `npm run gateway`（或由 MCP 拉起），扩展会自动重连
- 配置完成后重启 ZCode / 重载 MCP，应能看到 `mcp__edge-controller__edge_tabs_list` 等工具

## 4. 验证

```bash
# 网关健康
curl http://127.0.0.1:9223/healthz

# REST 直调（通路 B）
curl -s -X POST http://127.0.0.1:9223/call -H "Authorization: Bearer <token>" ^
  -H "content-type: application/json" -d "{\"cmd\":\"tabs.list\"}"

# ZCode 里对 Agent 说：
#   用 edge_tabs_list 看看我开了哪些标签页
#   用 edge_navigate 打开 extension/test/sandbox.html（file:/// 路径），
#   然后 edge_page_refs 列出元素，edge_input_click 点"按钮 A"，edge_screenshot 给我看结果
```

## 5. 可选：CDP 备用通路

```bash
node scripts/launch-edge.mjs        # 启动 --remote-debugging-port=9222 的独立实例
node server/cli.mjs --gateway --cdp-port 9222
```

- CDP 实例使用独立 profile（`.edge-profile/`），**需要在其中重新加载扩展**（或仅作为无扩展降级通路）
- 命令支持子集见 `server/cdp-backend.mjs` 顶部 `SUPPORTED`
- 说明：新版 Chromium 已禁用 `--load-extension` 启动参数，扩展无法再用命令行静默注入，手动加载是唯一正规途径

## 6. 打包分发

```bash
npm run pack   # 产出 dist/zcode-edge-controller-extension-v1.0.0.zip
```

zip 可用于 Edge 加载项合作方预览提交或离线分发（正式商店发布需开发者账号与商店审核）。
