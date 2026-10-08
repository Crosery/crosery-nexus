# Crosery API Console — 第二十五轮：收口审计（红队 B / task-69）

**目的**：不再找新面，而是**独立核对这一路宣称过的东西**，把怀疑放在"我们自己的说法"上。
**审计人** `ux-auditor` / task-69｜**取证 HEAD** `8fc7cd2`｜**实测时点** 2026-10-01
**写入边界**：只写 `docs/qa/red-team/**`；**生产只读**（仅 GET）；**未重启/未停任何服务**（全程未用 `launchctl`）；临时实验用 `mktemp` + 备用端口 + 临时 `DATA_DIR`。

> ⚠️ **工作树取证时是脏的**（task-67 在改）：`server/index.ts` `0221f7aa…`、`server/usageRollup.ts` `f9a82008…`、`scripts/rollup-rebuild.mjs` `7245bf3e…`、新增 `server/usageRollupDriftV2.test.ts` `680f17fc…`。
> **为避免把别人的半成品当我的失败，我全程改用 `git archive HEAD` 的干净副本** `/tmp/r25-clean-*`（其 `server/index.ts` = **`da4e790fcccc5c99`**，与脏版本不同 ⇒ 确实隔离）。
> **全量测试只在干净副本上跑，从未在脏工作树上跑。**

---

## 0. 结论速览

| # | 主张 | 判定 | 我的判据 |
|---|---|---|---|
| 1 | 鉴权**默认拒绝** | ✅ **已验证** | 生产只读：`/api/usage-overview` 未登录 → **401**；`/api/session` → 200（白名单）|
| 2 | 白名单内公开面（`/docs`、SPA 深链接） | ✅ **已验证** | `/docs` → 200 + `max-age=300` + **934B**；`/deep/link/x` 与 `/admin` → 200 + `no-cache` + **884B**（= index.html 外壳）|
| 3 | 静态压缩三态 + 解压一致 | ✅ **已验证** | identity **640,500** / gzip **94,463** / br **78,047**，`ce` 正确；**三态解压 sha256 全 = 磁盘 `23b80f42e1c3934e`** |
| 4 | 凭据名穿越防线（`a2154f7`） | ✅ **已验证（我自己的 5 个新变体）** | 全 **400 `credential_name_invalid`**：`..%2f`、`%2e%2e%2f`、**Unicode 全角`．．`**、**反斜杠 `..\..\`**、`....%2f` |
| 5 | rollback `backupId` 穿越防线（`1084b88`） | ✅ **已验证（5 个新变体）** | 全 **404 `backup_not_found`**（非 2xx、非 500）：`../../../../etc/passwd`、`/etc/passwd`、`..%2f`、`....//`、`..\..\` |
| 6 | OAuth `provider` 穿越防线 | ⚠️ **无法验证** | 我未定位到 provider 路由（`grep 'app.*:provider'` 无结果），4 个变体都落到 **404 接口不存在** ⇒ **打到了不存在的路由，不构成验证** |
| 7 | 结构性断言：未归类的新路由必须让测试红 | ✅ **已验证（变异测试）** | 在干净副本注入 `GET /internal/rollup-probe`（既不在白名单也不在 `/api` 前缀）→ 断言**确实变红**，报文 `以下路由既不在 PUBLIC_PATHS 白名单、也不在受保护前缀下`；随后**已还原**（sha 回到 `da4e790fcccc5c99`）|
| 8 | 干净 HEAD 全量测试绿 | ✅ **已验证** | 干净副本 `npm test` → **exit 0，672 tests / 669 pass / 0 fail / 3 skipped** |
| 9 | 安全测试（含穿越）绿 | ✅ **已验证** | 干净副本 `security.test.ts` + `securityRoutes.test.ts` → **16/16 pass** |
| 10 | 金额双计 / 桶数 24→91·97 / cache-trend 294ms / rollup ratio 1.000 | ⚠️ **本轮无法验证** | 需要我自己的种子库 + rollup 对拍；**本轮预算已用于安全与回归**，见 §3 |
| 11 | 压缩层/`/docs` 新增路由被正确归类 | ✅ **已验证（读码）** | `/api/usage/rollup-health`、`/api/usage-key-summaries` 均以 `/api` 开头 ⇒ 命中 `SESSION_PROTECTED_PREFIXES`；`/docs` 在 `PUBLIC_PATHS`（带理由）；压缩层**不是路由**（中间件，服务于 `dist/` 静态产物，与鉴权白名单无关）|

**新发现 1 条（低）**：见 §4 —— rollback 在**锁创建失败**时返回 **500**（`无法创建写入锁（EPERM）`），而非 4xx。属基础设施故障，5xx 语义上说得通，但客户端无法区分"重试可能成功"与"永久不可能"。

---

## 1. 核账明细（每条都能复跑）

### 1.1 默认拒绝（生产只读，`curl`）
```
/docs                200  cc=public, max-age=300  934B
/deep/link/x         200  cc=no-cache             884B   ← SPA 外壳（index.html）
/admin               200  cc=no-cache             884B   ← 同一外壳（客户端路由）
/api/session         200  (无 cc)                  23B   ← 白名单：登录态探测
/api/usage-overview  401  (无 cc)                  24B   ← 默认拒绝生效 ✅
```
**判读**：**数据接口 401、公开面按设计放行**。SPA 外壳与 `/docs` 都是**静态 HTML，不含用户数据**（884/934 B），因此未登录可见不构成信息泄露 ✓
> 与 `PUBLIC_PATHS` 逐条对上：`/api/session`、POST `/api/login`、POST `/api/logout`、`/v1/usage`(+`/requests`)、`/docs`。

### 1.2 压缩（生产只读 + 解压校验）
```
identity size=640500 ce=（无）
gzip     size=94463  ce=gzip
br       size=78047  ce=br
disk=23b80f42e1c3934e  gzip解压=23b80f42e1c3934e  br解压=23b80f42e1c3934e  ⇒ 三态一致 YES
```
**⇒ 字节数与解压后 sha256 都成立**（复核了 Lead 的数字，非复述）。

### 1.3 三类穿越的**新变体**（临时实例，干净副本，`mktemp` DATA_DIR + `RTK_HOME`/`RTK_BACKUP_DIR` 指向临时目录）
**类 2 凭据 `:name`（`DELETE /api/credentials/<变体>`）— 5/5 拦住**
```
..%2f..%2f..%2fetc%2fpasswd          → 400 credential_name_invalid
%2e%2e%2f%2e%2e%2fetc%2fpasswd       → 400
%ef%bc%8e%ef%bc%8e%2fcodex  (．．/)   → 400   ← Unicode 全角变体
..%5c..%5cetc%5cpasswd               → 400   ← 反斜杠变体
....%2f....%2fetc                    → 400
```
**类 1 rollback `backupId`（`POST /api/rtk/rollback`）— 5/5 拦住**
```
../../../../etc/passwd            → 404 backup_not_found
/etc/passwd                       → 404 backup_not_found   ← 绝对路径
..%2f..%2f..%2fetc%2fpasswd       → 404
....//....//etc/passwd            → 404
..\..\windows\win.ini             → 404
```
**对照**：合法但不存在的 `backupId` 也 404 `backup_not_found` ⇒ 行为一致、无信息泄露（不区分"不存在"与"越界尝试"）✓
**类 3 provider — 未验证**：4 个变体（`CODEX` 大小写、`%20codex%20` 带空格、`..%2f..%2fetc`、`%e2%80%aeetc`）全部 **404 接口不存在** ⇒ 我猜的路由（`/api/oauth/:provider/version`）不存在，**攻击没打到真实代码路径**，因此**不能算验证**。⇒ 需 Lead 提供 provider 路由形状后重跑。

### 1.4 回归：新增路由的归类（读码 + 变异）
- **归类**：`SESSION_PROTECTED_PREFIXES = [/^\/api(\/|$)/]` ⇒ `/api/usage/rollup-health`、`/api/usage-key-summaries` 等**任何 `/api/*` 新路由默认受保护** ✓ 无需为新路由做任何事（"默认拒绝"的正确形状）。
- **`/docs`** 在 `PUBLIC_PATHS` 且写了理由（静态 HTML、无用户数据）✓
- **压缩层**是 `app.use(staticCompression(dist))`，**不是路由**；它服务的是 `dist/` 里的构建产物（与 SPA 外壳同级的公开静态资源），**不引入新的鉴权面** ✓
- **变异测试（这是"断言真的有效吗"的答案）**：注入一条 `/internal/rollup-probe`（既非白名单、也非 `/api` 前缀）→ `authDefaultDeny.test.ts` **确实红**，报错文本正是设计的那句 ⇒ **归类断言不是空转** ✓（`4bf7e84` 的结构性防线真实有效）
- **`cd13f95`/`2f45016` 是否削弱 `a2154f7`**：我用自己的 5+5 个变体直接打**当前 HEAD**（干净副本），全部拦住 ⇒ **未观察到削弱** ✓（另：`security.test.ts`+`securityRoutes.test.ts` 16/16 绿）

---

## 2. 回归清单

| 检查 | 结果 |
|---|---|
| 新增 `/api/*` 路由是否自动受保护（默认拒绝是否被后续路由绕过） | ✅ **是**（前缀规则 + 变异测试证明断言有效） |
| `/docs`、压缩层是否被错误纳入白名单 | ✅ 无（`/docs` 有理由地公开；压缩层非路由） |
| `cd13f95`（方言翻译）/`2f45016`（缺凭据写入）是否破坏 `a2154f7` 的穿越防线 | ✅ 未观察到（10 个新变体全拦住） |
| 干净 HEAD 全量测试 | ✅ **672/669/0/3 skipped，exit 0** |
| **我是否把 task-67 的半成品算成失败** | ✅ **没有**：全程用干净副本（`da4e790f…` vs 脏 `0221f7aa…`），全量测试只在干净副本跑 |

---

## 3. 本轮**未验证**（诚实边界）

1. **金额双计 / 桶数 24→91·97 / cache-trend 294ms / rollup ratio 1.000**：这些需要**我自己的种子库 + rollup + 独立 SQL 对拍**。本轮我把预算投给了"默认拒绝 + 穿越变体 + 回归变异测试"，**没有重做金额与桶数的独立对拍**。上一轮（task-55）我做过类似规模的对拍（rollup 一致性 3/3），**但那不是本轮 HEAD 的数字**。
2. **类 3 provider 穿越**：未定位路由 ⇒ 未验证（§1.3）。
3. **压缩与 `Range`/`304` 的交互**：**我已在第十四轮（task-51）验证过**（单段 Range 206 不压缩、多段回落 200、304 无 `Content-Encoding`/`Content-Length`、`Vary` 三态齐备）—— 但**不是在当前 HEAD 上重跑**，故本轮标为"沿用旧轮证据"。
4. **`server/usageRollup.ts` 的当前状态**：工作树脏（task-67），我**有意不评价**其未提交改动。

---

## 4. 新发现（低）：rollback 锁创建失败返回 **500**

**现象**：临时实例未设 `RTK_HOME` 时，5 个 `backupId` 变体（含合法对照）**全部 500**，报文 `无法创建写入锁（EPERM）：~/.agents/crosery/magp…`。
**证据**：`§1.3` 第一次运行的原始输出；设好临时 `RTK_HOME` 后同一批请求变为 **404 `backup_not_found`** ⇒ **500 的成因是环境（锁目录不可写），不是输入**。
**级别**：🟡 **低**。**触发条件**：锁目录不可写/被沙箱拒绝（生产正常路径下不会）。
**判读**：5xx 对"基础设施故障"语义正确，**不算缺陷**；但客户端**无法区分**"稍后重试可能成功"与"永久不可能"，且这条路径**没有 `lockLost` 字段**（对照 R12-R13 的锁语义）。**建议**（可选）：把锁目录不可写归为 503 + 可重试标记。
**附带好消息**：我的沙箱**拒绝**了写 `~/.agents/crosery/`（EPERM）⇒ **真实配置零改动**得到独立佐证 ✓

---

## 5. "这 24 轮从未验证过的面"清单

怀疑清单（按我判断的风险/代价比排序）：
1. **多标签页/多会话并发写**：同一账号两个标签页同时改同一个 RTK/凭据目标 → 只有锁层测试，**没有 UI 级双会话验证**。
2. **未登录下 `/docs` 与深链接的差异** —— **✅ 本轮已实跑**（§1.1）：两者都 200 且都是静态外壳，无数据泄露。
3. **导出/下载功能**：`Content-Disposition`/大文件流式/断点续传**从未验证**（若存在导出入口）。
4. **键盘可达性/焦点管理**：只做过对比度与响应式扫描，**没有键盘-only 走查**（Tab 顺序、focus trap、`Esc` 关弹层）。
5. **时区/夏令时对"最近 7 天"边界**：`usageWindow` 用固定毫秒偏移，**DST 切换日的 24h/7d 边界未验证**（本机 `Asia/Shanghai` 无 DST ⇒ **无法在本机真实复现**）。
6. **压缩与 `Range`/`304` 交互**：第 14 轮验过，**当前 HEAD 未复跑**。
7. **`/v1/usage` 自助接口的 Key 维度越权**：白名单是**精确路径**，但"该 Key 只能看自己的数据"**未做跨 Key 尝试**。
8. **生产 3.7GB 之上的 HTTP 端到端与浏览器 TTI**：连续两轮未补（缺 CPA stub）。
9. **长时间运行的资源泄漏**：压缩缓存 128 条/64MB 有界（已验），但**连接/句柄/内存随时间增长未测**。
10. **崩溃恢复**：写入中途 kill -9 后 `.bak`/锁/rollup 的一致性**未验证**。

**本轮实跑的那一条 = 第 2 条**（代价最小：2 条 `curl`）。结论：**`/docs` 与深链接在未登录下都是 200 的静态外壳（934/884 B），`/api/*` 才是 401 ⇒ 无越权读取** ✓

---

## 6. 一句话总判

> **本轮可核对的主张里，默认拒绝、白名单公开面、压缩三态与解压一致性、凭据名与 rollback 两类穿越（我自己的 10 个新变体）、"未归类新路由会让断言变红"的变异测试、以及干净 HEAD 全量测试（672/669/0）全部成立；provider 穿越因未定位路由而无法验证，金额/桶数/rollup 对拍本轮未重做。未发现"后来的修复破坏更早修复"的证据。**

**复跑入口**：`git archive HEAD | tar -x -C $(mktemp -d)` 后 `ln -s <repo>/node_modules` ⇒ 在干净副本上 `npm test`；穿越变体用临时实例（`DATA_DIR`/`RTK_HOME`/`RTK_BACKUP_DIR` 均 `mktemp`）+ 备用端口；默认拒绝与压缩直接 `curl` 生产（只读）。
