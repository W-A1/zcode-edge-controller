# 🔒 安全审计报告 — ZCode Edge Controller Extension

> 审计日期：2026-11-25 ｜ 审计方式：代码审计 + 真机 PoC 复现 + 修复后回归验证
> 审计版本：修复前 v1.4.1 → 修复后 **v1.4.2**
> 审计范围：网关鉴权 / 审批闸门 / 文件上传 / 注入面 / 资源稳定性 / 扩展隔离

---

## 一、审计结论

| 等级 | 发现 | 已修复 | 遗留 |
|---|---|---|---|
| 🔴 高危 | 1 | 1 | 0 |
| 🟠 中危 | 2 | 2 | 0 |
| 🟡 低危 | 3 | 3 | 0 |
| 🔵 提示 | 2 | 0（设计边界，已标注） | 2 |

**结论：发现 1 个高危漏洞（可完全绕过审批闸门执行任意写操作）并已修复 + 加回归用例钉死；当前版本 v1.4.2 无已知高危/中危漏洞。**

---

## 二、🔴 高危漏洞（已修复）

### H-1 审批闸门可被 `params.__confirm` 伪造绕过

**位置**：`server/gateway.mjs` `call()` 函数（修复前）

**PoC（真机复现，修复前）**：
```
网关：--cdp-port 9222 --confirm-cdp-writes
基线：POST /call {cmd:"tabs.create"}                    → 428 CONFIRM_REQUIRED  ✓
攻击：POST /call {cmd:"tabs.create",params:{__confirm:true}} → 200 OK，标签页被创建  ★
```

**根因**：审批放行标记 `__confirm` 从**请求参数**读取，而请求参数完全由调用方控制（REST JSON / MCP arguments）。任何持有 token 的调用方（或 prompt 注入诱导 Agent）在 params 里塞 `__confirm:true` 即可跳过 428 审批闸门，直接执行 `page.eval` / `input.upload` / `tabs.close` 等高危写命令——**用户确认机制形同虚设**。

**影响**：违反需求“所有高危操作必须经过确认”，是架构级安全控制失效。

**修复**：确认态改为**服务端私有通道**（`trust.confirmed` 参数，仅 `/confirm` 流程内部代码可置位），并从所有外部入口强删 `params.__confirm`；`__preferChannel` 同步做 `["ext","cdp"]` 白名单化（仅影响路由，不构成提权）。

**验证**（修复后）：
```
带 __confirm → 428 ✓（无法绕过）
正常写命令 → 428 ✓（闸门未失效）
/confirm 放行 → 执行成功 ✓（正常流程可用）
```
**回归钉死**：`tests/e2e-gateway.mjs` 新增用例「安全回归：__confirm 注入无法绕过审批闸门」。

---

## 三、🟠 中危（已修复）

### M-1 token 明文写入日志文件

**位置**：`server/cli.mjs` 启动横幅
**问题**：启动时 `log("[token] <完整 48 位 token>")` 写入 `logs/gateway.log`（实测确认命中）。日志常被同步、打包、误提交，等同于凭据泄露；且 `server/.token` 权限依赖文件系统。
**修复**：日志改为掩码显示（`f2b6…6935`），完整值仅存 `server/.token`（0600）。
**验证**：启动日志 grep 完整 token → 不含 ✓

### M-2 任意本地文件可被上传到网页（凭据外泄通道）

**位置**：`server/gateway.mjs` `input.upload` 校验
**问题**：仅校验「路径存在」，未拦截敏感文件。Agent（或被注入诱导的 Agent）可执
`input.upload{files:["…/server/.token"]}` 把网关 token 上传到任意网页表单，完成凭据外泄；同理可外泄 SSH 私钥、云凭据。
**修复**：新增敏感文件规则集（`.token` / `.env` / `id_rsa` / `*.pem,*.pfx,*.key` / `.ssh/` / `.aws/` / `credentials*.json` / `.git/config`），命中返回 **403**；同时限制单次最多 20 个文件。
**验证**：上传 `server/.token` → 403 ✓；普通文件不被误拦 ✓
**回归钉死**：e2e 新增「安全回归：敏感文件上传拦截（403）」。

---

## 四、🟡 低危（已修复）

| # | 问题 | 位置 | 修复 |
|---|---|---|---|
| L-1 | token 用普通字符串比较（时序侧信道可逐字符猜解） | `server/security.mjs` `bearerOk` | 改 `crypto.timingSafeEqual` + 长度预检 |
| L-2 | `pendingCdp` 无容量上限（灌入可致内存增长） | `server/gateway.mjs` | 加 `MAX_PENDING=50` + 淘汰最旧 + TTL 5min |
| L-3 | 扩展侧 `pendingApproval` 单槽覆盖（并发写命令互相顶掉，早到者超时失败） | `extension/lib/security.js` | 改为待批**队列**（上限 10）+ popup 显示排队数，批准后自动推进下一条 |
| L-4 | `maxBytes` 参数无硬上限（大值可致大内存/传输） | `extension/lib/commands/inject.js` | 加 `HARD_MAX_BYTES=4MB` 强顶 |

---

## 五、🔵 提示项（设计边界，已文档化）

1. **CDP 备用通路不经用户审批**：`--cdp-port` 直连调试实例时，写命令在扩展离线场景下走 CDP 且扩展侧闸门无法覆盖。缓解：默认关闭 CDP；`--confirm-cdp-writes` 网关闸门（现已不可绕过）。**建议**：生产环境仅用扩展通路。
2. **`host_permissions: <all_urls>`**：任意页注入所需。缓解：无静态 content script（按需动态注入）、仅本地回环监听、token 配对。可降级为 `optional_host_permissions` 按站点授权（牺牲自动化顺畅度）。

---

## 六、审计通过项（无问题）

| 面 | 结论 |
|---|---|
| 网络面 | 仅监听 `127.0.0.1`；WS `originOk` 已移除 `origin=null`（防 file:// 页面连接）；错误 token 断开 4001 |
| 命令白名单 | 双侧校验（扩展 + 网关），24 命令固定表，`tests/unit.mjs` 强制同步；白名单外 400 |
| 注入面 | 无 `innerHTML` 写入页面；refs 存隔离世界全局（页面 JS 不可见）；selector 仅作 `querySelector` 参数（浏览器解析，非法即异常）；表达式经 `JSON.stringify` 传参，无命令拼接 |
| CSP 处理 | 字符串 eval 不走扩展上下文，改经 CDP `Runtime.evaluate` + `allowUnsafeEvalBlockedByCSP`（与 DevTools 等价，属受控调试通道） |
| 资源稳定性 | CDP 单命令 20s / attach 15s / 注入 12s / body 5s 超时全覆盖；睡眠标签唤醒重试；debugger 复用不误 detach；net 捕获上限 2000 条 + SW 冷启动恢复 |
| HTTP 面 | `/call` body 5MB 上限、其它端点 1MB；JSON 解析失败 400 |
| 审批语义 | `auto` 模式下 critical（6 条）仍强制确认；timeout 自动拒绝；审计落 storage.local 1000 条 |

---

## 七、修复验证与回归

**修复验证（专项 8/8 通过）**
```
FIX-1 带 __confirm 仍被闸门拦截（428）            ✓
FIX-1 正常写命令仍被拦截（428，闸门未失效）        ✓
FIX-1 /confirm 正常放行仍工作                     ✓
FIX-2 拒绝上传 server/.token（403）               ✓
FIX-2 普通文件不被误拦                            ✓
FIX-3 启动日志不含完整 token                      ✓
FIX-4 错误 token → 401 / 正确 token → 正常        ✓
```

**全量回归（无副作用）**
```
unit tests passed          （24 命令 / 分级 / 35 工具 / 别名）
e2e-gateway passed         （含 2 条新增安全回归用例）
e2e-mcp passed             （35 工具 schema）
```

**新增永久回归用例**（防止漏洞复发）
- `安全回归：__confirm 注入无法绕过审批闸门`
- `安全回归：敏感文件上传拦截（403）`

---

## 八、交付状态

- 修复版本：**v1.4.2**（`dist/zcode-edge-controller-extension-v1.4.2.zip`，33.4KB）
- 遗留高危/中危：**0**
- 建议后续（非阻塞）：iframe 深层 native 点击、net 跨会话持久化、`optional_host_permissions` 按站点授权
