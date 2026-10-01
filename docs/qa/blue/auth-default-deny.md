# 鉴权改成「默认拒绝」+ 会话模块归属合并（task-58 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依据：红队安全审计 §1.3 的结构性提醒 + task-57 遗留 ②

---

## 1. 问题：安全不是设计出来的，是「恰好」

红队原话：守卫是「`/api` 前缀挂载」这一**结构性弱点** —— 将来任何非 `/api` 新路由会**默认公开**。

修复前：`app.use('/api', requireAuth)` —— 只要把路由写在 `/api` 下就受保护，写在别处就公开且**没有任何测试会拦住**。
下一个加 `app.get('/metrics')`、`app.use('/internal', …)` 或 `/v2/...` 的人会得到一条默认公开的路由。

---

## 2. 修法：全局守卫 + 显式公开白名单（默认拒绝）

`server/index.ts` 的挂载从「`/api` 前缀中间件」改成：

```ts
app.use(createSessionGuard(app))   // 挂在 cookieParser 之后、所有路由之前
```

**判定顺序**（`server/auth.ts:createSessionGuard`）：

| # | 条件 | 结果 |
| --- | --- | --- |
| 1 | 命中公开白名单 | 放行 |
| 2 | 持有**有效且未撤销**的会话 | 放行 |
| 3 | 路径在受保护前缀（`/^\/api(\/|$)/`） | **401**（保住「未知 `/api` 路径也是 401」的既有行为） |
| 4 | 会命中某条**已注册路由**（反射路由表，例如将来新增的 `/internal/...`） | **401** |
| 5 | 其余（静态资源、`/`、SPA 深链接回退） | 放行：只可能返回前端产物，不返回数据 |

已撤销的会话在第 2 步判为未认证，但**同样走 3~5 的归类**：受保护接口 401、深链接仍返回 index.html
（同时清掉 Cookie，由前端跳登录页），**不会把深链接变成 401 页面**（这条是实测发现的，见 §5 注）。

### 2.1 公开白名单（逐条写清「为什么可以公开」）

| 规则 | 方法 | 为什么可以公开 |
| --- | --- | --- |
| `/^\/api\/session\/?$/` | 任意 | 登录态探测端点：未登录/已撤销都必须 `200 {authenticated:false}`（前端据此跳登录页）。改成 401 会打乱前端状态机；blue-ui 已把这条写进文档，**属有意行为** |
| `/^\/api\/login\/?$/` | POST | 登录入口本身必须匿名可达；滥用由按「来源 IP + 用户名」的滑动窗口限流兜住（`security.ts`） |
| `/^\/api\/logout\/?$/` | POST | 登出必须匿名可达：持过期/已撤销 Cookie 的请求也要能被清理，否则用户卡在坏会话里 |
| `/^\/v1(\/|$)/` | 任意 | 自助用量接口用 `Authorization` 里的 API Key **自鉴权**（`index.ts:publicUsageKey`），只返回该 Key 自己的数据，与控制台会话无关 |
| `/^\/docs(\/|$)/` | 任意 | 产品文档页：静态 HTML（`dist/docs.html` 934B），不含任何用户数据，路由自带 `max-age=300` |

代码里每一条都带 `why` 字段，且**结构性测试会断言每条 `why` 非空**（防止有人只加 pattern 不写理由）。

### 2.2 结构性断言测试（`server/authDefaultDeny.test.ts`）

1. **归类断言**：解析 `server/index.ts` 的所有 `app.<verb>('<path>')` 与 `app.use('<prefix>')`（本仓库没有动态注册与子路由，正则足够且更直观），
   断言**每一条要么在白名单、要么在受保护前缀下**；未归类 → 测试红，并打印具体路由与处理方式。
2. **白名单收口断言**：`/api/` 下的公开路由必须**恰好**是 `GET /api/session`、`POST /api/login`、`POST /api/logout` 这三条
   （防止将来有人往白名单里多加一条业务路由）。
3. **端到端**：真起子进程实例，断言 §5 的每一格行为。

---

## 3. 会话模块归属合并（task-57 遗留 ②）

**边界决定（含理由）**：

| 模块 | 归属 | 内容 |
| --- | --- | --- |
| `server/auth.ts` | **会话域（唯一归属）** | 口令校验、会话签发/读取/校验/撤销、登出、**默认拒绝守卫与公开白名单** |
| `server/security.ts` | **传输与滥用防护工具** | Cookie 的 `Secure` 协议推导、登录失败限流、错误体文案 |

理由：会话的生命周期（签发 → 携带 → 校验 → 撤销）必须在一处闭合。合并前签发在 `security.ts`、
验证在 `auth.ts`，同一套 `<expires>.<hmac>` 规则**写了两遍**（各自的 `sign`/`timingSafeEqual`），
只能靠一条契约测试防漂移；合并后签发与校验共用同一个 `sign()` 与 `sessionTokenValid()`，
契约测试保留为「签发出来的 Cookie 必须能被 `isAuthenticated` 接受」的回归断言。
依赖方向单向：`auth.ts → security.ts`（auth 用 `shouldSecureCookie`），无环。

**删除的死代码**：`auth.ts` 的 `login()`（登录改由 `issueSession` 签发后已无调用方）、
`requireAuth()`（被全局守卫取代）；`security.ts` 里迁走的会话实现（`issueSession`/`readSessionToken`/
`revokeSession`/`isSessionRevoked`/`isSessionTokenValid`/撤销集合/`SESSION_COOKIE`）全部移出。
现状核对：`grep -c "export function login|export function requireAuth" server/auth.ts` = **0**；
`grep -c "export function issueSession|isSessionTokenValid" server/security.ts` = **0**。

**`isAuthenticated()` 现在包含撤销检查**（原来只有索引中间件检查撤销）：这样 `abLab` 等直接调用它的地方
也自动获得撤销语义，会话判定只有一个真源。

---

## 4. 负向验证：新增一条未归类路由必须让结构性测试变红

```
基线 shasum: 3ccd4877ef14283e0ee36649bcbe53fa2709920ed15aa70850393fde81d34ade  server/index.ts

临时在 index.ts 加 app.get('/internal/ping', …)：
  ① 结构性断言 → ✖ ℹ pass 0 · fail 1
     失败信息点名：GET /internal/ping（route）
  ② 运行时（真起实例）未认证访问 /internal/ping → http=401 {"error":"请先登录"}
     （即：即使忘了归类，默认拒绝也已经在运行时兜住了它）

移除后：shasum 与基线**逐字节相同** → 三条用例全部 ✔
```

---

## 5. 逐条「不破坏现有行为」实测（重启后的运行实例 8791）

| 场景 | 结果 |
| --- | --- |
| `/api/session`（未认证） | **200** `{authenticated:false}` |
| `/api/login`（未认证，错凭据） | **401** + `{error:'管理员账号或密码不正确'}`（登录入口可达，是它自己的 401） |
| `/api/logout`（未认证） | **200**（登出必须匿名可达） |
| `/api/audit`、`/api/rtk/status`（未认证） | **401** `{"error":"请先登录"}` |
| `/api/unknown-route`（未认证） | **401**（保住「未知 API 路径也是 401」，不再是 404 JSON） |
| `/v1/usage`（未认证） | **401** + `{"error":{"message":"无效或不可用的 API Key",…}}` —— **它自己的**鉴权错误，说明没被会话守卫拦下 |
| `/docs` | **200** `text/html`，934B（`docs.html` <1KB 未被压缩层接管，压缩行为也没变） |
| `/`、`/rtk`、`/cache`、`/not-a-real-page` | **200** `text/html` 884B = **index.html**（SPA 深链接没变成 401 页面） |
| 登录后 `/api/audit`、`/api/rtk/status` | **200** |
| 登出（撤销）后 `/api/audit` | **401** |
| 登出（撤销）后 `/api/session` | **200** `{authenticated:false}`（**有意行为**，未改） |
| 登出（撤销）后 SPA 深链接 `/rtk` | **200** index.html（同时清掉 Cookie） |

> 注：撤销 + 深链接这条是我在**现网抽验时发现并当场修掉的**：第一版守卫在「已撤销」分支直接返回 401，
> 会把登出后的深链接变成 401 页面。现在撤销分支并入统一归类（§2 判定顺序 3~5），
> e2e 用例也加了这条断言，防止回归。

---

## 6. 命令退出码与套件

```
npm test run#1 → ℹ tests 644 · pass 643 · fail 0 · skipped 1（9.73s）   exit 0
npm test run#2 → ℹ tests 644 · pass 643 · fail 0 · skipped 1（9.74s）   exit 0
npm run test:magpie → ℹ tests 105 · pass 104 · fail 0 · skipped 1        exit 0
npx tsc -b --pretty false → exit 0
npm run build → ✓ built in 463ms                                        exit 0
npm run lint → 仅既有 server/nativeResponses.ts:200/203 两条告警        exit 0
```

**顺带更新了一条既有测试**：`server/dataPlane.test.ts` 里 `data-plane status route remains behind the existing
administrator middleware` 原本硬编码地断言源码里存在 `app.use('/api', requireAuth)`（已被取代），
现改为断言「存在全局守卫 `createSessionGuard(app)`，且该路由注册在守卫之后」——**意图不变**、机制跟上新结构。

---

## 7. 未做 / 残余

1. **结构性断言是「源码正则」而非「运行时路由表」**：本仓库没有动态注册（`app[method]`）与子路由
   （`express.Router()`）——两者都用 grep 核对过为 0，所以正则解析是充分的。若将来引入动态注册或嵌套路由，
   解析会漏掉它们 → **必须**改成运行时反射（`app.router.stack`），否则结构性断言会失效。
   （运行时守卫本身不依赖这个解析：新路由只要不被白名单命中，一律 401——§4 的 `/internal/ping` 已验证。）
2. **「没有已注册路由 ⇒ public」这条规则的含义**：任何路径只要不匹配任何已注册路由，就会落到静态/SPA 回退，
   因此是公开的。这是**有意**的（否则深链接会 401），且它只返回前端产物、不返回数据。
   触发条件：若将来把敏感内容做成「静态文件」放进 `dist`，该文件会因此公开——**新增静态资源前先确认它可以公开**。
3. **白名单是前缀/正则匹配**：`/^\/v1(\/|$)/` 会放行 `/v1` 下的所有路径。触发条件：若 `/v1` 下新增管理类接口，
   必须把它移出白名单区域（或把规则收窄到具体路径）。
4. 登录限流是**进程内**的（多实例不共享计数），与 task-57 相同，未变。
