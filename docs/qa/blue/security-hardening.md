# 第二十轮：控制台安全加固三条（task-57 / blue-ui）

日期：2026-10-01 · 依据：`docs/qa/red-team/security-audit.md`（红队第十五轮首次 HTTP 安全面审计）
服务端改动 ⇒ **已重启 `com.crosery.console-magpie` 并对运行实例抽验**（见 §5）。

**一句话**：三条都已修并各有**行为级**测试与**真实实例**抽验：错误响应不再泄堆栈（客户端通用文案 / 服务端日志留全栈）、登录加内存滑动窗口限流（429 + `Retry-After`，不泄漏用户名存在性）、Cookie 的 `Secure` 改为按协议推导（HTTPS 下即使 `COOKIE_SECURE=false` 也带）、登出做服务端吊销（旧 cookie 重放立即 401）。

---

## 1. ① 错误不泄堆栈（未认证即可触发的那条）

**修法**：在**所有路由之后**加兜底错误中间件（`server/index.ts` 尾部），并在 `server/security.ts` 里把响应体文案集中成 `errorResponseBody(status)`：

| 情形 | 旧行为 | 新行为 |
| --- | --- | --- |
| 畸形 JSON（`express.json` 的 `SyntaxError`，带 `status:400`） | Express 默认错误页：**完整堆栈 + 绝对路径**（红队在生产复现） | `400 {"error":"请求格式不正确"}` |
| 请求体超限（`entity.too.large` → 413） | 同上 | `413 {"error":"请求体过大"}` |
| 其它未捕获异常 | 同上 | `500 {"error":"服务器内部错误"}` |
| 服务端日志 | — | **保留完整堆栈**：`[error] POST /api/login → 400` + 全部堆栈帧 |

**不依赖 `NODE_ENV`**：生产当前没设它，新中间件对任何环境都只回通用文案（文案里也没有路径/内部标识）。

**真实实例抽验**（重启后）：

```console
$ curl -s -X POST http://127.0.0.1:8791/api/login -H 'content-type: application/json' -d '{"username": "admin", '
status=400
{"error":"请求格式不正确"}                      ← 客户端：无堆栈、无路径

$ grep -A 2 "\[error\] POST /api/login" ~/.agents/crosery/magpie-console/service-errors.log
[error] POST /api/login → 400
SyntaxError: Expected double-quoted property name in JSON at position 22 (line 1 column 23)
    at JSON.parse (<anonymous>)
    at parse (.../node_modules/body-parser/lib/types/json.js:91:21)      ← 服务端日志：堆栈完整保留
```

## 2. ② 登录限流

**实现**（`server/security.ts`，内存、无新依赖）：`createLoginRateLimiter()` 按 **来源 IP + 用户名** 分桶的**滑动窗口**；窗口内失败达到阈值即进入退避（`windowMs * 3 * 2^超出次数`，封顶 `LOGIN_MAX_BLOCK_MS`），返回 `429` + `Retry-After`；**成功登录清零**该桶；所有桶按时间过期清理 + 容量上限（10k）→ **内存有界**。

- 默认值：`LOGIN_MAX_FAILURES=5` / `LOGIN_WINDOW_MS=300000`(5min) / `LOGIN_MAX_BLOCK_MS=900000`(15min)，三个都可用环境变量覆盖（测试里用 3 次/1 分钟）。
- `app.set('trust proxy', 'loopback')`：控制台在 127.0.0.1 的 nginx 之后，只有信任回环代理才能从 `X-Forwarded-For` 拿到真实来源 IP（否则所有请求都是 127.0.0.1，限流等于全局锁）。
- **保住了红队认可的两条优点**：`401` 文案对「用户名不存在 / 密码错误」完全一致；凭据比较仍走 `validateCredentials`（`timingSafeEqual`，时序不可区分）。**限流位置在凭据校验之前**，对任何用户名一视同仁。

**测试**（`server/security.test.ts` 6 条 + `server/securityRoutes.test.ts` 端到端）覆盖：阈值触发 429、`Retry-After ≥ 1`、窗口滑过后恢复、成功清零、不同 IP / 不同用户名互不影响、不泄漏存在性（不存在的用户名打满自己的桶后得到**逐字节相同**的 429 文案；未限流时两者 401 文案也相同）、内存有界（500 个键过期后 `size()` 下降）。

**真实实例抽验（不把自己锁住）**：默认阈值 5，只打 **2 次**错误密码 + 1 次正确密码：

```console
wrong#1=401 wrong#2=401 correct_after_2_failures=200      ← 限流在生效（记录失败）且成功即清零
```

## 3. ③ 会话加固（Secure 推导 + 登出吊销）

### Secure 按协议推导（`shouldSecureCookie`）
判据（三层，都不依赖 `NODE_ENV`）：
1. 请求**经 HTTPS 到达**（`trust proxy` 后的 `req.secure`，或 `X-Forwarded-Proto: https`，多跳取第一跳）→ **一定带 `Secure`**，即使 `COOKIE_SECURE=false`；
2. 否则 `COOKIE_SECURE=true` 强制带（TLS 终止层没传 XFP 时用）；
3. 未显式设置且非 HTTPS → 不带（纯 HTTP 本地调试，否则浏览器会丢 Cookie）。

**为什么不能只改环境变量**：生产启动脚本把 `COOKIE_SECURE` 写死成 `false`（见 §6 待办），只改环境变量等于没修；按协议推导才是真正的兜底。

**真实实例抽验**（环境里 `COOKIE_SECURE=false`）：

```console
$ curl -s -D - -o /dev/null -X POST .../api/login -H 'x-forwarded-proto: https' -d '{…}'
Set-Cookie: crosery_console_session=…; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Strict   ← 带 Secure ✅

$ curl -s -D - -o /dev/null -X POST .../api/login -d '{…}'        # 纯 HTTP
Set-Cookie: crosery_console_session=…; Max-Age=43200; Path=/; HttpOnly; SameSite=Strict          ← 不带 ✅
```

### 登出做服务端吊销
`server/security.ts` 维护**有界撤销集合**：`sha256(token) → 到期时刻`（只存摘要，不在内存里再放一份可用凭据；比较用 `timingSafeEqual` 的那套思路不适用摘要比对，摘要只用于查表）。条目在 token 自己到期后清理，另有 10k 容量上限兜底。

**关键实现细节**：撤销检查中间件必须挂在**所有 `/api` 路由之前**（`cookieParser` 之后）——`/api/session` 是注册最早的路由之一，放在后面会让登出后的旧 cookie 继续被认作已认证（**这是我第一版实现被端到端测试抓出来的真实缺陷**）。现在：`/api/session` 返回 `200 {authenticated:false}`（前端靠它判登录态，不能改成 401），其余受保护接口 `401`。

**真实实例抽验**：

```console
login=200  bootstrap_before=200  logout=200  bootstrap_after=401     ← 旧 cookie 重放立即失效
$ curl -b <旧 cookie> .../api/session   →   {"authenticated":false}
```

**保持不动的两条**（红队确认过的优点）：换 `SESSION_SECRET` 重启后旧会话失效 ✓（签名不匹配）、伪造签名 401 ✓ —— `security.test.ts` 里有对「签发 Cookie 必须被 `server/auth.ts` 的 `isAuthenticated` 接受」的**契约测试**（防两处签名规则漂移），并对篡改签名断言 `false`。

## 4. 命令与退出码

```
$ npx tsc -b        → tsc_exit=0
$ npm run lint      → lint_exit=0（2 条既存 server/nativeResponses.ts no-control-regex warning）
$ npm run build     → build_exit=0 · ✓ built in 501ms
$ npm test          → test_exit=0 · ℹ tests 641 · pass 640 · fail 0 · cancelled 0 · skipped 1
```
```console
$ git diff --stat server/index.ts
 server/index.ts | 79 +++++++++++++++++++++++++++++++++++++++++++++++++++++++---
 1 file changed, 76 insertions(+), 3 deletions(-)
```
改动只落在这三件事上（兜底错误中间件、登录路由限流、会话/登出与撤销中间件）；未碰业务路由、审计逻辑、RTK 代码、静态服务/压缩层。新增 `server/security.ts`、`server/security.test.ts`（12 条）、`server/securityRoutes.test.ts`（3 条端到端）。

## 5. 重启与真实抽验（服务端改动必做）

```console
$ launchctl kickstart -k gui/$(id -u)/com.crosery.console-magpie    # kickstart_ok
$ curl -s -o /dev/null -w "%{http_code}" .../api/session            # 200
```
抽验汇总：畸形 JSON → `400 {"error":"请求格式不正确"}` 且日志有全栈；正常登录 → `200`；HTTPS 头 → Cookie 带 `Secure`，纯 HTTP → 不带；登出后旧 cookie → `401`（`/api/session` → `{"authenticated":false}`）；2 次错误密码 + 正确密码 → `401/401/200`（限流生效但未自锁）。**限流的 429 路径只在临时子进程实例里验证**（`securityRoutes.test.ts`），生产上不制造锁定。

## 6. 遗留与待办（未做，供你决定）

1. **启动脚本仍写死 `COOKIE_SECURE=false`**：现在的推导已能保证 HTTPS 下带 `Secure`（实测），但环境变量本身与部署事实矛盾，建议改成不设或 `true`（文件在部署侧，不在我写范围）。
2. **`server/auth.ts` 的 `login()` 现在没有调用方**（登录改由 `security.ts` 的 `issueSession` 签发，以便按请求协议推导 `Secure`）。`auth.ts` 的 `isAuthenticated`/`requireAuth`/`validateCredentials`/`logout` 仍在用。要不要把 `login()` 删掉或把 `issueSession` 迁进 `auth.ts`（单一会话模块），建议与 task-58 的「默认拒绝」重构一起做——**我没有动它**。
3. `/api/session` 对已撤销会话返回 `200 {authenticated:false}` 是**有意**的（前端契约），不是漏改 401。
