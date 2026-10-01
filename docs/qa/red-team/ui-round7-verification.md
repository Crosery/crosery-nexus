# Crosery API Console — 第七轮 UI 对抗复验（红队 B / task-27）

**被验对象**：`9e7b0db`（R6-A/C/E/F：并发区间收口、汇总派生、死代码清理、导航差集守卫）、`1ff0809`（R6-B 服务端一半 + OAuthPage 迁移）
**本地 HEAD** `1ff0809`｜**实例** <http://127.0.0.1:8791>｜**dist 构建时间** `2026-10-01 11:15:18`｜dist 不早于 src：`find src index.html docs.html -newermt "$(stat -f '%Sm' dist/index.html)"` → **0 个**
**审计人** `ux-auditor` / task-27｜**实测时点** 2026-10-01 11:16–11:40｜浏览器 TaskSpace `40`（已 `finish({keep:[]})`）；浏览器锁与构建锁均已释放
**写入边界**：只写 `docs/qa/red-team/**`（新目录 `shots-r7/`，7 张截图）。临时改动 **4 次**（3 个文件），**全部逐字节还原并附证据**（§8）。

---

## 0. 结论速览

| # | 被验主张 | 判定 |
|---|---|---|
| 1 | **R6-C 已修**：客户端 1–500 与服务端一致；契约测试用服务端权威函数实测区间 | ✅ **已验证**（改 `max=1000` → **红**，报错精确；浏览器 501/1000 报错、500 通过；服务端边界实测 0/1/2/499/500 接受、501/600/1000/2000 拒绝） |
| 2 | **R6-B 客户端一半已修**（并发必填） | ✅ **已验证**（留空在客户端被拦下，`allowEmpty:false`） |
| 2 | **R6-B 服务端一半已修**（PATCH 空串 400、绝不落 0） | 🔴 **被推翻：修复已提交但未生效** —— 真实实例对 `{"totalConcurrency":""}` 返回 **200**（旧行为），见 §6 |
| 2 | `server/totalConcurrencyRoutes.test.ts` 真读库 | ✅ **已验证**（`DatabaseSync` + `SELECT total_concurrency`，`server/totalConcurrencyRoutes.test.ts:112,124-127`） |
| 3 | **R6-A 已修**（汇总从字段派生） | ✅ **已验证**（2 错→2、修 1→1、全修好→消失；**反向**：改坏一个立即出现，无需提交；提交定位首错仍正常） |
| 4 | **R6-E**：死代码与其测试已删，其余 3 条仍覆盖 | ✅ **已验证** |
| 4 | **R6-F**：`navRoutes.test.ts` 差集断言有牙齿 | ✅ **已验证（双向）**（加路由不加导航 → 红；加导航不加路由 → 红；文案精确） |
| 5 | **OAuthPage 迁移**：5 原语 + URL 筛选 + 失败可重试 + 空态 + D24 未改坏 + 390 无溢出 | ✅ **已验证**（逐项见 §4） |
| 5 | 两类 `.vue` 静默坑无残留 | ✅ **已验证**（`initial` 仅 1 处且用法正确并带注释；5 处 `TxFilterChips` **全部** `:items`；`:options` 只出现在 `TxSelect` 上） |

**本轮独立发现 4 条**：
- **🔴 R7-A（高）**：R6-B 的服务端修复**已提交但未在运行实例上生效**（服务未重启）—— 用户仍可让「空并发」静默变成 **0 = 不限速**。
- **🟠 R7-B（低，潜在）**：并发规则文案 `TOTAL_CONCURRENCY_RULE` 与 `policy.ts` **是两份重复字面量**，非「同源」，且无测试锁住两者一致。
- **🟠 R7-C（低-中）**：**同一类静默改写**在额度接口仍在（`server/index.ts:347-349`）：`""`/`"abc"` → **0 = 不限额**，`"-3"` → 负值照收。
- **⚪ R7-D（低）**：`req.query.days` 非数字时被算成 **NaN** 并进入报表查询（只读面）。

---

## 1. R6-C：并发区间与服务端契约 ✅ **已验证**

### 1.1 故意把 `CONCURRENCY_LIMITS.max` 改成 1000 → **红** ✅
**判据**：`src/lib/validation.ts:18` `{ min: 1, max: 500 }` → `{ min: 1, max: 1000 }`（**未手改任何文案**——文案是从常量派生的模板字符串）。
```
✖ 客户端区间上界 == 服务端接受上界
   AssertionError: 客户端声称 1–1000，服务端实际只接受到 500：两侧漂移，用户会填进必然被 400 拒的值
✖ 客户端规则与服务端在边界上逐点一致
   AssertionError: 并发 501：客户端=接受，服务端=拒绝
ℹ tests 5  ℹ pass 3  ℹ fail 2
```
→ **契约测试确实能防住 R6-C 再犯**：它不看文案、不比字符串常量，而是**用服务端 `validatePolicy()` 线性扫描 1..2000 实测出上界**再与客户端常量对齐，任一侧漂移都会红。

### 1.2 服务端实际接受边界（直接调用纯函数，零写入）
| 值 | 结果 |
|---|---|
| 0 / 1 / 2 / 499 / 500 | **ACCEPTED** |
| 501 / 600 / 1000 / 2000 | **REJECTED**「总并发必须是 0 到 500 的整数，0 表示不限速」 |

与第六轮实测**完全一致** → 说明这轮是**客户端向服务端收口**，服务端语义未被改动（无行为回归）✓

### 1.3 蓝队自曝的「凭空 1000」——我独立核对
```
$ git log -S "integerInRange(1, 1000" --oneline -- src/pages/KeysPage.vue
9e7b0db  (移除)
805ca80  (引入)
```
→ **那个 1000 确实是在 `805ca80`（第五轮字段校验）引入、`9e7b0db` 移除**，与蓝队自曝一致。第五轮我在报告里已把该值判为「无服务端依据」，现在的契约测试正是针对它。

### 1.4 浏览器实测
| 输入 | 结果 |
|---|---|
| `501` | 字段错误「请填写最大总并发数（**1–500** 的整数，与服务端一致）；不想限速请打开「不限速」开关」+ 汇总「还有 1 处需要修改」 |
| `1000` | 同上（字段错误） |
| `500` | **无字段错误、无汇总**（通过） |

**注意文案里的区间也随常量走**（`KeysPage.vue` 用模板字符串引用 `CONCURRENCY_LIMITS`），所以不会出现「常量改了文案没改」。

证据：`shots-r7/keys-并发-501-字段错误-桌面.png`

---

## 2. R6-A：汇总改为派生 computed ✅ **已验证**

**判据**：`/keys` 创建弹窗，逐步制造/修复字段错误，读弹窗内 `[role="alert"]`：

| 步骤 | 字段错误数 | 汇总文案 |
|---|---|---|
| 名称留空 + 并发 `0` | 2 | 「还有 **2** 处需要修改，已定位到第一个字段。」 |
| 填回名称 | 1 | 「还有 **1** 处需要修改，已定位到第一个字段。」 |
| 并发改 `8` | 0 | **汇总消失**（`summary: []`，`alerts: []`） |
| **反向**：全对后再把并发改成 `0`（**不提交**） | 1 | 汇总**立即出现**「还有 1 处需要修改…」 |

→ 第六轮那个「字段修好了汇总还挂着」的假陈述**已消除**，且**双向**都跟着字段走（不再是提交时写一次）。额度弹窗同样改为派生（`quotaSummary`）。
**回归检查**：提交按钮仍把焦点送到首个出错字段（`activeElement` = `[aria-label="最大总并发数"]` / `data-field="totalConcurrency"`）✓，且 `window.__w === []`（校验拦住了提交，**零写请求**）✓

证据：`shots-r7/keys-汇总-两错-桌面.png`、`keys-汇总-全修好-桌面.png`、`keys-汇总-反向立即出现-桌面.png`

---

## 3. R6-E / R6-F ✅ **均已验证**

### 3.1 R6-E：死代码已清净
- `grep -rn "emptyKeyListCopy" src server` → **0 命中**（函数与其测试断言都已删除）✓
- `server/gatewayStatus.test.ts` 现在只导入并覆盖**剩下的 3 个导出**：`gatewayStatusCopy`（2 条）、`analyticsScopeKey` + `dataForScope`（1 条）✓ 没有留下「测已删函数」的空壳。

### 3.2 R6-F：`navRoutes.test.ts` **双向**都有牙齿 ✅
| 突变 | 结果 |
|---|---|
| 在 `router.ts` 加子路由 `ghost-r7`、**不加**导航项 | ✖ 「这些子路由没有对应的侧栏导航项：**ghost-r7**。要么在 `ConsoleNav.vue` 的 navEntries 里补一项，要么把路由从 `router.ts` 移除。」 |
| 在 `ConsoleNav.vue` 加导航项 `/ghost-r7`、**不加**路由 | ✖ 「这些导航项指向不存在的路由：**ghost-r7**」 |
| 还原两处 | ✔ 2/2 绿 |

- 它的第 2 条测试（「解析守卫有牙齿」）用**合成样本**做差集自检，**不读生产文件** → 符合我在 R5-B 立的标准 ✓
- 文档注释里也写清了「为什么不用访问 `/nope` 验收」（catch-all 重定向会掩盖），与我在第六轮的结论一致 ✓

---

## 4. OAuthPage 迁移（`1ff0809`）✅ **已验证**

### 4.1 五个原语 + URL 状态
| 项 | 实测 |
|---|---|
| `PageHeader` | `h1` = 「OAuth 授权登录」，页头组件渲染 ✓ |
| `useResource` | `pool = useResource(() => api.channels())`（`:34`），页面 8 张提供商卡由 `pool.data.credentials` 驱动 ✓ |
| `ErrorPanel` | 见 4.3 ✓ |
| `LoadingBlock` | `v-else-if="pool.initial.value"`（`:359`）✓ |
| `EmptyState` | 「还没有上游账号 / 选下面的提供商开始一次授权；授权成功后账号会自动进入上游账号池，并在渠道页可单独启停。/ **去选择提供商**」→ **有下一步动作** ✓ |
| `useQueryState` | 点「OpenAI / Codex」→ URL **`/oauth?provider=codex`**，chip `aria-pressed="true"`；`reload()` 后 **URL 与选中态都保持** ✓ |

### 4.2 失败态可重试
屏蔽 `*/api/channels*` → 页面出现 **`ErrorPanel`**「上游账号池读取失败 / 请检查网络或服务是否在运行，然后重试。/ **重试**」；解除屏蔽后点「重试」→ **8 张卡恢复** ✓

### 4.3 D24 三条逻辑**未被改坏** ✅（代码逐条核对）
| 行为 | 位置 | 判定 |
|---|---|---|
| **5 分钟上限** | `:230-236` 超时即 `clearPoll` + 置 error + 给「重新发起」/「手动提交」两条出路 | ✅ |
| **连续 3 次失败即停** | `:252-258` 计数、达 3 停止并说明；**`:239` 每次成功把计数清零**（是「连续」而非「累计」） | ✅ |
| **卸载清定时器** | `:316-318` `onUnmounted` 遍历 `pollTimers` 全部 `clearPoll` | ✅ |

### 4.4 窄屏 390
`innerWidth = 390`、`documentElement.scrollWidth = 390`（**无横向溢出**）、筛选 chips 右边界 378 ≤ 390、提供商网格退化为单列（`360px`）、8 张卡与 `h1` 均正常 ✓

证据：`shots-r7/oauth-URL筛选-桌面.png`、`oauth-首次失败-桌面.png`、`oauth-390-桌面.png`

---

## 5. 两类 `.vue` 静默坑的**全站独立扫描** ✅ 均无残留

### 5.1 `useResource.initial` 当「加载中」用
全仓 `.initial` 的用法**只有 3 处**（排除 legacy）：
- `VersionWidget.vue:23` — `props.initialVersions`，同名但无关 ✓
- `OAuthPage.vue:359` `v-else-if="pool.initial.value"` — **唯一真实用法**
- `OAuthPage.vue:349` — 注释，解释「`initial` 语义 = 从未成功加载过」

**用法是否正确**：OAuthPage 的分支顺序是
```
ErrorPanel  v-if="pool.error.value && accounts.length === 0"   ← 首次失败：阻断式（先判错）
LoadingBlock v-else-if="pool.initial.value"                    ← 只有「从未成功过」才显示骨架
（内容 + ErrorPanel v-if="pool.error.value" 非阻断横幅）        ← 有旧数据时保留内容 + 提示
```
→ **首次失败会走 ErrorPanel，不会永久停在骨架**；有旧数据时是 inline 横幅 ✓ **这正是坑的反面，用法正确**，且蓝队把「为什么顺序重要」写进了注释。

### 5.2 `TxFilterChips` 传 `:options`（真实 prop 是 `:items`）
5 处 `TxFilterChips` **全部**使用 `:items`：
`KeysPage.vue:507`、`ModelsPage.vue:481`、`OAuthPage.vue:405`、`OAuthPage.vue:411`、`ChannelsPage.vue:318` ✓
全仓 `:options` 只出现在 **`TxSelect`** 上（`ModelsPage.vue:489,495`、`DashboardPage.vue:111,118`）——那是 `TxSelect` 的**正确 prop**，非残留 ✓
运行期交叉验证：`/oauth` 的 14 个 chips 全部有文案、`aria-pressed` 正确（不是空芯片）✓

**结论：两类坑在全站**（含 Lead 改的 4 个文件）**均无残留**，与 Lead 的初查一致。

---

## 6. 🔴 R7-A（高）：R6-B 的服务端修复**已提交但未生效**（服务未重启）

### 6.1 现象
在**真实实例**上用登录后的 cookie 对**已存在的 Key**（`龚翰林`）发 PATCH：

| 请求体 | 观察到的状态码 | 响应中的并发值 |
|---|---|---|
| `{"totalConcurrency": ""}` | **200**（期望 400） | 0 |
| `{"totalConcurrency": "   "}` | **200**（期望 400） | 0 |
| `{"totalConcurrency": 501}` | 400「总并发必须是 0 到 500 的整数，0 表示不限速」 | — |

### 6.2 为什么这**不是**我的测试问题（三重排除）
1. **请求体确实到达了 handler**：同一次会话里我先发 `{"note":"r7-diag-<ts>"}` → **200**，且响应回显的 `item.note` **等于我送的 marker**，读回也一致 → body 解析正常，随后我已还原该 note。
2. **没有中间件会改写 `req.body`**：`grep "app.use(" server/index.ts` → 只有 `express.json({limit:'1mb'})`、`cookieParser()`、`requireAuth`、静态与 404；`grep "req.body\s*=" server/*.ts` → **无赋值**；`normalize*` 都是无关领域的函数。所以 `raw` 就是字面的 `""`。
3. **已提交的源码对该输入必然抛错 → 400**：`server/index.ts:468-479`
   ```js
   function parseTotalConcurrency(raw, fallback) {
     if (raw === undefined || raw === null) { if (fallback !== undefined) return fallback; throw ... }
     if (typeof raw === 'string' && raw.trim() === '') throw new Error(`总并发数不能为空：${TOTAL_CONCURRENCY_RULE}`)
     ...
   }
   ```
   PATCH 用 `parseTotalConcurrency(req.body?.totalConcurrency, Number(row.total_concurrency))`（`:512`）→ `""` 命中第二个分支 → 抛错 → `catch` → **400**。**观察到 200 ⇒ 运行的不是这份代码。**

### 6.3 与**修复前**的行为逐字吻合（决定性佐证）
`1ff0809` 的改动说明与 diff 都写明：PATCH 旧表达式是 **`Number(v ?? row.total_concurrency)`**。
`"" ?? x` → `""`（`??` 不拦空串）→ `Number("")` = **0** → 200，并把 `total_concurrency` 静默写成 **0（= 不限速）**。
**我观察到的正是：200 + 值 0**。目标 Key 本来就是 0，所以数值上看不出变化——**但状态码 200（而非 400）本身就证明了旧代码在跑**。

### 6.4 根因：服务是长驻进程，改源码必须重启
- `com.crosery.console-magpie` 的 launchd 参数是 `node --import tsx scripts/magpie-console.mjs run`；
- `scripts/magpie-console.mjs:103` `spawn(process.execPath, ['--import','tsx','server/index.ts'], …)` → **直接跑 TypeScript 源码**，进程常驻；
- 因此 `1ff0809`（11:14:45）改了 `server/index.ts` 后，**必须重启服务**才生效（COORDINATION.md 明确写了这条）。`dist` 在 11:15:18 重建过（**前端已生效**，OAuthPage 的迁移我实测到了），但**服务端没有重启**。
- 佐证（弱）：`service.log` 的 mtime 停在 **10:57**，此后没有新的已刷盘输出——与「没重启过」一致。但 Node 写文件是块缓冲的，**这条只作旁证，不作依据**。

### 6.5 为什么测试全绿却线上是旧的（这是值得记下的结构性缺口）
`server/totalConcurrencyRoutes.test.ts:79-83` **自己 spawn 一个 `server/index.ts` 子进程**（临时 `DATA_DIR` + 本地 CPA stub）——所以它验的是**修复后的源码**，永远绿；而**线上长驻进程仍是旧代码**。「进程内测试」无法发现「进程没重启」。这不是测试写错了（隔离是对的），而是**部署/重启这一步没有验证**。
**建议**：把 `1ff0809` 的验收补一步「重启后对真实实例做一次 PATCH 空串 → 期望 400」，或把「服务端文件变更 ⇒ 必须重启」写进交付清单并在验收里留痕。

### 6.6 诚实披露：那次「应当被拒」的 PATCH **没有被拒**，产生了副作用
任务授权我发一次**应当被拒绝**的 PATCH。它**实际被接受（200）**，因此走了成功路径：`UPDATE api_keys SET … updated_at=?`（`server/index.ts:522-523`，`:520` 取 `now`）→ 目标 Key 的 **`updated_at` 被推进**到 `2026-10-01T03:17:42.270Z`（= 11:17:42 +0800），并追加了一条 `update_key` 审计（`server/index.ts:525`）。
**其余字段均无变化**：该 Key 的并发本来就是 0（旧表达式算出的也是 0），我额外用 `note` 探针改动的值**已在同一次会话里还原为空串**，最终读回整表与开测前**逐字段一致**。**这是我本轮唯一未能「零写入」的地方，如实记录。**

---

## 7. 其它独立发现

### 7.1 R7-B（低，潜在）：并发规则文案**不是同源**，是两份重复字面量
- 声明「文案与 `server/policy.ts` 同源」，但实际是：
  - `server/policy.ts:10`：`throw new Error('总并发必须是 0 到 500 的整数，0 表示不限速')` — **内联字面量**
  - `server/index.ts:466`：`const TOTAL_CONCURRENCY_RULE = '总并发必须是 0 到 500 的整数，0 表示不限速'` — **另一份字面量**
  - `index.ts` 只从 policy 导入 `validatePolicy`（`:14`），**没有**导入这个常量；
  - `grep -rn "TOTAL_CONCURRENCY_RULE" server/*.test.ts` → **无测试断言两者一致**。
- **当前状态**：三处（policy 文案、index 文案、`CONCURRENCY_LIMITS`）**都写着 500，是一致的**，所以**这不是线上缺陷**，而是**潜在漂移**：将来只改 `policy.ts` 的边界（比如放到 1000），`index.ts` 的 400 文案仍会说「0 到 500」。
- **已有保护**：**数值区间**被 `concurrencyContract.test.ts` 锁住（它实测 `validatePolicy` 的上界并断言 `serverMax === 500`）——所以边界改动**会**红。**没被保护的是文案**。
- **最小修法**：把 `TOTAL_CONCURRENCY_RULE`（以及边界 500）从 `policy.ts` 导出、`index.ts` 导入；`CONCURRENCY_LIMITS` 保持由契约测试对齐即可。

### 7.2 R7-C（低-中）：**同一类静默改写**在额度接口仍在
`server/index.ts:347-349`（`PATCH /api/keys/:id/quota`）：
```js
totalUsd:  Number(req.body?.totalUsd  ?? row.quota_total_usd)  || 0,
dailyUsd:  Number(req.body?.dailyUsd  ?? row.quota_daily_usd)  || 0,
weeklyUsd: Number(req.body?.weeklyUsd ?? row.quota_weekly_usd) || 0,
```
我用同一表达式实测：
| 输入 | 结果 |
|---|---|
| `""` | **0**（= 不限额） |
| `"abc"` | **0**（= 不限额，`\|\| 0` 把 NaN 也吞了） |
| `"0"` | 0 |
| `"5"` | 5 |
| `null` | 保持原值（`??` 生效） |
| `"-3"` | **-3**（负值照收，本行没有范围校验） |
→ 与 R6-B **同一反模式、同一危险方向**（静默变成「不限额」）。**但从 UI 不可达**：`KeysPage.vue:401` 发的是 `Number(quotaValues.total) || 0`，空框 → 0，而额度字段的语义**本来就是**「留空表示不限制」，所以 UI 行为是自洽的。
**风险面**：非 UI 调用方（脚本 / 其它客户端）传 `""` 或垃圾字符串会**静默变成不限额**；传负数会被存下。**严重度：低-中**（不阻塞，但建议照 `parseTotalConcurrency` 的形状收口，并对负数给 400）。
**这是我在本轮唯一「与已修缺陷同类但未修」的发现**，值得排期。

### 7.3 R7-D（低）：`req.query.days` 非数字 → **NaN** 进入报表查询
`server/index.ts:544,554,564,574,613,623,633,863` 同一形状：
```js
const days = Math.max(1, Math.min(config.usageRetentionDays, Number(req.query.days || 30)))
```
实测：`"7"→7`、`""→7`、`"0"→1`、`"-5"→1`，但 **`"abc" → NaN**（`Math.min(90, NaN)` = NaN，`Math.max(1, NaN)` = NaN）。
→ 非数字 `days` 会把 `NaN` 当窗口传给报表/查询（只读面）。UI 永远发有效值，所以**可从 UI 触达性为 0**；风险是 API 直调时的报错信息可读性/意外空结果。**严重度：低**。最小修法：`Number.isFinite` 兜底成默认值。

---

## 8. 还原证据（4 次临时改动 / 3 个文件，全部逐字节还原）

| 文件 | 用途 | 基线 sha256（= 还原后） | `git diff` |
|---|---|---|---|
| `src/lib/validation.ts` | 把 `CONCURRENCY_LIMITS.max` 改成 1000（验证契约测试有牙齿） | `d7f0e64ed0cc516201f63da5de8bc3af1a4f4eb99c4c0cea39fc75c78b6fcd6d` | 空 |
| `src/router.ts` | 加一条不入导航的子路由 `ghost-r7`（验证 navRoutes 正向） | `cf6df21d1353b61985b33c0c64886c460012cfa653ccb848ca0e3b3c7676d8de` | 空 |
| `src/components/ConsoleNav.vue` | 加一条没有路由的导航项 `/ghost-r7`（验证 navRoutes 反向） | `1c0b6bb4bd75c5cf4c4fb28869831d3cd9f11e1d40f809753378dcbce0d860a2` | 空 |

**还原后全量套件**：
```
$ npm test
exit=0
ℹ tests 585  ℹ pass 584  ℹ fail 0  ℹ cancelled 0  ℹ skipped 1
$ git diff --stat -- src/lib/validation.ts src/router.ts src/components/ConsoleNav.vue   →  (空)
$ git status --short
?? docs/qa/red-team/shots-r7/          ← 我的本轮交付
?? public/tuffex-dashboard-preview.png ← 本轮之前既存
$ ls -d /tmp/cac-*.lock → 不存在（两把锁均已释放）
```
临时备份已删除。**除 §6.6 记录的 `updated_at` 推进外，产品代码与数据零残留改动。**

---

## 9. 未验证项

1. **R7-A 的「重启后是否真生效」未验证**：我**故意没有重启服务**——重启会抹掉「运行实例是旧代码」的证据，而且重启属 Lead 的收口动作。**修法验证需要在重启后复测 PATCH 空串 → 400**（建议写进验收）。
2. **OAuthPage 的「有旧数据 + 刷新失败 = inline 非阻断横幅」未实测**：页面确实有「刷新」按钮（实测存在），我没有构造该组合（需先加载成功再屏蔽接口再点刷新）。**只验证了首次失败的阻断式分支**（§4.2）与代码里的 inline 分支存在。
3. **D24 的 5 分钟上限与「连续 3 次失败」未做运行时触发**：只做**代码逐条核对**（`:230-236`/`:252-258`/`:316-318`）；真跑需等 5 分钟或伪造时钟。
4. **R7-B 的文案漂移未做「改 policy 边界」的实证**：我核对了两份字面量当前一致、且无数值以外的断言；没有真的改边界看文案是否漂移（那会破坏幂等的证据链）。属读码结论。
5. **R7-C / R7-D 未做端到端**：均为**同一表达式的纯函数复算**（未对真实接口发这些请求，以免产生额度/查询副作用）。
6. **对比度**：未量化，本报告**不含对比度结论**（沿用前六轮口径）。
7. **非 Chromium 浏览器**：只测 ego-lite Chromium。

---

## 10. 判据速查（可原样复跑）

```bash
# 0) 基线
git log --oneline -1                       # 1ff0809
find src index.html docs.html -type f \( -name '*.vue' -o -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.html' \) \
     -newermt "$(stat -f '%Sm' dist/index.html)"        # 期望：空

# 1) R6-C 契约测试有牙齿（构建锁内）
for i in $(seq 1 36); do mkdir /tmp/cac-build.lock 2>/dev/null && break || sleep 5; done
shasum -a 256 src/lib/validation.ts
sed -i '' 's/max: 500 } as const/max: 1000 } as const/' src/lib/validation.ts
node --test --import tsx server/concurrencyContract.test.ts     # 期望 2 fail
cp <备份> src/lib/validation.ts && shasum -a 256 src/lib/validation.ts && git diff --stat -- src/lib/validation.ts
# 服务端边界（零写入，纯函数）
node --import tsx -e 'import{validatePolicy}from"./server/policy.ts";
for(const n of [0,1,2,499,500,501,600,1000,2000]){try{validatePolicy({enabled:true,groups:["g"],totalConcurrency:n,groupConcurrency:n===0?{}:{g:1}});console.log(n,"ACCEPTED")}catch(e){console.log(n,"REJECTED")}}'
rmdir /tmp/cac-build.lock

# 2) navRoutes 双向有牙齿（构建锁内）
#   正向：在 router.ts 的 children 里加 { path:'ghost-r7', name:'ghost-r7', component: … }（不加导航）
node --test --import tsx server/navRoutes.test.ts               # 期望 fail「没有对应的侧栏导航项：ghost-r7」
#   反向：在 ConsoleNav.vue 的 navEntries 里加 to:'/ghost-r7'（不加路由）
node --test --import tsx server/navRoutes.test.ts               # 期望 fail「指向不存在的路由：ghost-r7」
#   两处都还原后 → 2/2 绿

# 3) R7-A：真实实例对空并发的行为（**这条会写 updated_at，慎跑**）
#   浏览器内（带 cookie）：PATCH /api/keys/<id>  body {"totalConcurrency":""}
#   修复前的运行实例 → 200；修复并重启后 → 400「总并发数不能为空：总并发必须是 0 到 500 的整数」
```

浏览器关键判据（`spaceId=40`，均已实测）：

| 项 | 操作 | 期望 |
|---|---|---|
| R6-C 边界 | `[data-field="totalConcurrency"] input` 填 `501`/`1000` | 字段错误「1–500 的整数，与服务端一致」 |
| R6-C 通过 | 填 `500` | 无字段错误、无汇总 |
| R6-A 计数 | 制造 2 错 → 修 1 → 全修 | 汇总 `2 → 1 → 消失`；**反向**改坏一个立即出现 |
| 提交定位 | 名称合法 + 并发 `0` → 提交 | `activeElement` 的 `[data-field]` = `totalConcurrency` |
| OAuth 筛选 | 点 `OpenAI / Codex` | URL `/oauth?provider=codex`；reload 后保持 |
| OAuth 失败 | 屏蔽 `*/api/channels*` | ErrorPanel +「重试」；解除后点重试 → 8 卡恢复 |
| OAuth 窄屏 | 390×844 | `scrollWidth == 390`，无横向溢出 |

---

## 11. 给 Lead 的建议（按性价比）

1. **🔴 立刻重启服务并复测 R7-A**：`launchctl kickstart -k gui/$(id -u)/com.crosery.console-magpie`，然后对**已存在 Key** 发一次 `PATCH {"totalConcurrency":""}`，**期望 400**。当前线上仍可让「空并发」静默变成 **0 = 不限速**（那是比第六轮 POST 的「变 4」更危险的方向）。我未代为重启，以免抹掉证据。
2. **把「服务端文件变更 ⇒ 必须重启 + 重启后抽验一条真实请求」写进交付清单**：这轮的所有测试都绿，但线上是旧代码——**进程内测试无法发现「进程没重启」**（§6.5）。
3. **R7-C 排期（低-中）**：照 `parseTotalConcurrency` 的形状收口额度三值：空串/非数字 → 400，负数 → 400；并把 UI 的「留空 = 不限额」这条语义显式写进接口契约（它现在是隐式的）。
4. **R7-B（低）**：把 `TOTAL_CONCURRENCY_RULE` 与边界从 `policy.ts` 导出、`index.ts` 导入，消掉重复字面量。
5. **R7-D（低）**：`days` 用 `Number.isFinite` 兜底默认值。
6. **可以结案**：R6-A ✅、R6-C ✅、R6-E ✅、R6-F ✅（双向）、OAuthPage 迁移 ✅、两类 `.vue` 静默坑 ✅ 无残留。
