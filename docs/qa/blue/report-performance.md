# 报表性能：cache-trend 预聚合与 p95 复查（task-59 / blue-ui）

日期：2026-10-01 · 依据：`docs/qa/red-team/data-scale-rehearsal.md` 附录 A
服务端改动 ⇒ **已重启 `com.crosery.console-magpie` 并在生产实例上量了 HTTP 时延**（§5）。

**一句话**：`cache-trend` 的慢有两个成因——读线程把这条查询**偷偷路由到 rollup**（红队以为它走 events，因此误判了归因），以及 events 路径按「小时 × 分钟」预聚合（168h 窗口 **91,549 行 vs 展示桶 1,190 行**，77× 浪费）。改成按展示桶预聚合后，events 路径 **168h 178.9→63.8ms、720h 683.3→294ms**（达标：≤150/≤300ms），rollup 路径输出**逐字节不变**。顺带用对拍抓出并修掉一个**既有金额双计 bug**（§3，会改变 `costUsd`/`wastedUsd` 数值，需你确认）。p95 那条 **复查后决定不改**（§4，附交叉点实测）。端到端部分：CPA stub 与压测脚本已交付，但临时实例的报表数据为空（§5.2 给出确切卡点），**临时实例的 HTTP/TTI 数字没做出来**；改用**生产实例真实路径**的 HTTP 数字替代。

---

## 1. 复现环境（可重跑）

```bash
DATA_DIR=/tmp/perf-base node --import tsx scripts/perf-seed.mjs     # 造数（约 25s）
DATA_DIR=/tmp/perf-base SAMPLES=3 ROUTE=cache-trend NOW_MS=<ms> node --import tsx scripts/perf-probe.mjs
```

造数与生产**逐数字一致**（`docs/qa/deploy/prod-db-profile.md`）：`usage_events` 957,736 / 近 7 天 147,082 / 近 30 天 448,021，跨度 66 天，`api_keys` 50、`channel_states` 30。
`usage_hourly_rollup` 按**生产粒度**生成：**34,848 行 vs 生产 34,316（+1.6%）** —— 红队上一轮的 628,812 行是生产的 18×，会让走 rollup 的 loader 偏悲观（我第一版也造出 485,015 行 = 14×，已修正为「每小时 ~20 个 (key,provider,model,endpoint,client) 组合」的真实流量形状）。

`scripts/perf-probe.mjs` 用**代理 reader** 记下每条 SQL 的调用次数与耗时；`NOW_MS` 把窗口起点钉死，before/after 才可比（否则窗口边界的事件进出会污染对比）。

## 2. ① 根因：两件事叠加

### 2.1 读线程把 cache-trend 静默路由到了 rollup（红队的归因错了）

`server/sqliteReadWorker.mjs` 里有个**按 SQL 文本匹配**的改写：

```js
if (hasRollup && sql.includes('INDEXED BY idx_usage_cache_rollup')) { /* 改写成查 usage_hourly_rollup */ }
```

**铁证**：同一条 SQL 文本，直接 `DatabaseSync` 执行得到 **14,910 行**，经读线程池执行只有 **558 行**（= 168h × ~3.3 行/小时，正是「按小时分组的 rollup 行数」）。所以：

- 红队「cache-trend 走 usage_events，rollup 帮不上」的前提**不成立**：在有 rollup 的库里它走的是 rollup；他们那轮 rollup 被造到 18×（628k 行），于是量出了 2.9–3.4s —— **那是被放大的 rollup 路径**，不是 events 路径。
- 真正的 events 路径（我另建了一个 `DROP TABLE usage_hourly_rollup` 的副本，使路由不生效）才是需要优化的那条：**720h 683ms**。

> 这个改写还有个脆弱点，建议单独排一轮（**不在我的写范围**：`server/sqliteReadWorker.mjs` 不是我这次能改的文件）：判定靠字符串、参数靠**位置**（`params[0]`=cutoff、`params[2]`=provider、`params[3]`=key）。我第一次修复时多绑了一个占位符，查询静默返回**空结果**（0.4ms「飞快」），是 before/after 指纹比对抓出来的。建议补一条「events 路径与 rollup 路径结果一致」的契约测试。

### 2.2 events 路径按「小时 × 分钟」预聚合（77× 无效行）

原 SQL：`GROUP BY CAST(timestamp_ms/3600000), CAST(timestamp_ms/60000), model, provider, clientType` —— 分钟级分组，再由 JS 合并成展示桶。实测（`EXPLAIN`/计数，168h 窗口）：

| 分组粒度 | 行数 | SQL 耗时 |
| --- | --- | --- |
| 小时 × 分钟（原） | **91,549**（打散分钟基数后 122,441） | 124ms（+ TEMP B-TREE FOR GROUP BY） |
| 展示桶 6h（改后） | **1,190** | 62ms |
| 720h 窗口：分钟级 → 天桶 | 325,795 → **14,400** | 428ms → 184ms |

这 9 万行还要跨线程 structured-clone 到 JS、再 `JSON.stringify([bucket, model, provider])` 逐行 Map 合并。

**改法**（`server/usageReports.ts`）：`GROUP BY CAST(timestamp_ms / <bucketMs>) * <bucketMs/60000>`，即**分组粒度 = 展示粒度**；`bucketMs` 由 `bucketSecondsFor(hours)` 决定，**内联成常量**（不新增占位符，保持读线程路由的位置契约）。JS 侧的桶边界公式一行未改，因此桶划分逐项相同。

### 2.3 优化前后（窗口钉死 `NOW_MS=1790840316000`，单位 ms）

| loader | 路径 | 改前 p50 | 改后 p50 | 目标 | 结论 |
| --- | --- | --- | --- | --- | --- |
| cache-trend 168h | events | 178.9 | **63.8** | ≤150 | ✅ |
| cache-trend 24h | events | 27.7 | **14.6** | — | ✅ |
| cache-trend 720h | events | 683.3 | **294** | ≤300 | ✅（余量小） |
| cache-trend 168h | rollup | 77.3 | 74.0 | — | 不变 |
| cache-trend 24h | rollup | 68.9 | 67.1 | — | 不变 |
| cache-trend 720h | rollup | 100.8 | 96.3 | — | 不变 |

**数值一致性**：rollup 路径指纹**逐字节相同**（3 个窗口全等）；events 路径除金额外全部字段逐项相同（金额差异见 §3）。另外用**与实现无关的朴素参考实现**（读原始行、按 bucketMs 分桶、逐列求和）对拍 loader 输出，两种库（有/无 rollup）都逐项相等 —— `server/reportPerformance.test.ts`。

## 3. ⚠️ 顺手修掉的既有 bug：金额被计了两次（会改数值，请确认）

改成按桶分组后，指纹比对立刻报出 `costUsd` 变成约 **2×**。根因在 JS（`usageReports.ts`，本次改动前就存在）：

```js
const aggregate = rowsByBucket.get(key) ?? { …, costUsd: typeof row.costUsd === 'number' ? Number(row.costUsd) : null, … }
…
if (typeof aggregate.costUsd === 'number' …) aggregate.costUsd += Number(row.costUsd)   // ← 第一行算了两次
```

分钟级分组时每组行数多、误差被稀释（**每个展示桶只偏高 0.5% 左右**，一直没人发现）；按展示桶分组后每组 1–2 行，误差直接接近 2×。

**修法与自证**：改成「`costSum` + `costComplete`，逐行只累加一次，桶内任一行缺金额则整体 null」，与分组粒度无关。独立对拍（最近 30 天、天桶、独立 SQL `SUM(cost_usd)`）：

| 版本 | 与独立 `SUM(cost_usd)` 相等的桶 | 最大偏差 |
| --- | --- | --- |
| 修前 | **0 / 31** | 0.306 USD（≈0.5%） |
| 修后 | **31 / 31** | 0（1e-6 内） |

**影响面**：`/api/cache-trend` 的 `costUsd` 与 `wastedUsd`（由前者推导）会**略微下降**（历史值偏高 0.5% 左右；如果某桶只有 1–2 行，偏高接近 2×）。其他字段（requests/tokens/cache 命中/桶边界）逐项不变。**这不是为了快而改语义，而是修一个把同一行算两遍的错误**；如果你要求「宁可保留错值也不动历史数字」，把 `costSum`/`costComplete` 那三处改回原样即可（我不会自行回退）。

## 4. ② p95 子查询：复查后**决定不改**（附交叉点实测）

红队认为 `LIMIT 1 OFFSET (COUNT(*)×0.95)`（30 天 186ms）是 analytics p95 的主因。我实现了窗口函数版本（`ROW_NUMBER() OVER (ORDER BY latency_ms)`，一次扫描、无大 OFFSET），**在生产规模数据上实测反而更慢**：

| 窗口 | 单模型行数 | 索引 ORDER BY + OFFSET（现用） | 窗口函数版 |
| --- | --- | --- | --- |
| 1 天 | 2,482 | 12.5ms | 4.8ms |
| 7 天 | 15,533 | 16.3ms | 11.4ms |
| 30 天 | 47,282 | **18.8ms** | 25.6ms |
| 66 天 | 101,082 | **22.9ms** | 51.1ms |

原因：`idx_usage_latency_rollup` 的前缀就是「规范化模型 + success + latency_ms」，OFFSET 是**索引内顺序跳过**（行数 40× 增长而耗时只从 12.5→22.9ms）；窗口函数却必须物化+排序全部匹配行。交叉点在 ~2–3 万行，而生产 30 天窗口单模型约 4.7 万行 ⇒ **现用算法更快**。

因此：**保留原算法**（`server/usageReports.ts` 里写明了这段复测数据，避免下一个人再去「优化」），改用测试钉住分位语义：`server/reportPerformance.test.ts` 对 8 组边界数据（空窗口/单行/两行/全部相同值/并列值/100 行/101 行/含并列 20 行）断言 SQL 结果 == 朴素分位数 `sorted[floor((n-1)*0.95)]`，**逐值相同**。

**如果 186ms 仍能复现**：那大概是 `latencySummarySql`（不带模型过滤、扫全窗口做 AVG+GROUP BY）而不是 p95 子查询。把红队计时用的那条 SQL 原文给我，我可以继续定位（这属于新的取证，不在本轮改动范围）。

## 5. ③ 端到端

### 5.1 交付的脚本

| 脚本 | 用途 |
| --- | --- |
| `scripts/perf-seed.mjs` | 生产规模造数（events 三个数字精确 + rollup 生产粒度），只允许写临时目录 |
| `scripts/perf-probe.mjs` | loader 级计时 + 每条 SQL 计数/耗时 + 聚合指纹（`NOW_MS` 钉窗口、`FINGERPRINTS_OUT` 落盘比对） |
| `scripts/perf-cpa-stub.mjs` | 最小 CPA stub（`node scripts/perf-cpa-stub.mjs 8399`） |
| `scripts/perf-report-http.mjs` | 报表路由 HTTP p50/p95（只允许打 `127.0.0.1` 临时实例） |

### 5.2 ❌ 临时实例的 HTTP/TTI 没做出来 —— 卡点（如实说明）

**做到了**：stub 起来后临时实例正常启动、登录 200、`/api/usage-overview`、`/api/cache-trend`、`/api/analytics`、`/api/dashboard` 全部 200（不再 500）——「最小 CPA stub 让报表接口不再 500」这一条成立。

**卡在哪**：报表负载**全空**（`cache-trend` 响应仅 135B、`points: []`；`usage-overview` 的 `providers/models` 长度为 0），因此 HTTP 时延（0.4–2.7ms）量的是空路径，**没有意义**，浏览器 TTI 同理。根因已定位到具体位置：

1. 报表的渠道策略来自 `listGroupsForReporting()`：网关快照成功时走 `buildGroups(channels…)`，失败时才回落到持久化的 `app_settings['reporting.groups.lastKnown.v1']`。
2. 我试了两条路：①「stub 成功但返回空渠道」→ 控制台把**空策略写回**持久化存储；②「stub 对渠道/凭据端点返回 500（fail-closed）」→ 我预置的 6 个分组策略**仍被启动路径覆盖成空**（实测该行只剩 66 字节 = `groups: []`），于是 `activeProviderPredicate` 得到 `0 = 1`，查询不匹配任何行。
3. 要让它出真数据，stub 必须按 `getCompatChannels()`/`getProviderChannels()`（`server/channels.ts:52`）期望的**渠道 JSON 形状**作答（`name`/`disabled`/`models`… 以及 creds 形状），这是一次独立的控制面逆向，本轮时间不够，我没有硬凑。

**替代证据（生产真实路径）**：改为在**生产实例**（渠道齐全、rollup 已填充、`usage_events` 957,736 行）上量 HTTP。为避免 `reportSnapshots` 新鲜度缓存，每次换一个合法参数：

```
cache-trend  hours=168 → 200  2534B  0.081s（首次） / 0.013–0.016s（后续）
usage-overview days=30 → 200 12793B  0.016–0.019s
analytics    days=30   → 200 57355B  0.026–0.061s
```

生产 `cache-trend` 168h 冷启动 81ms、热 13–16ms（走 rollup 路径，与 §2.3 的 74ms 同量级）⇒ **生产不存在 2.9s 的 cache-trend**；红队那个数字来自 18× 的合成 rollup。

## 6. 命令与退出码

```
$ npx tsc -b    → 0
$ npm run lint  → 0（4 条既存 warning）
$ npm run build → 0
$ npm test      → 0 · ℹ tests 648 · pass 647 · fail 0 · cancelled 0 · skipped 1
```
重启与抽验：`launchctl kickstart -k …` → session 200、login 200、三个报表路由 200（§5.2 数字）。全程未改生产数据。

## 7. 遗留（供你决定）

1. **金额双计修复会改变 `/api/cache-trend` 的 `costUsd`/`wastedUsd`**（§3）——需要你确认接受；不接受就回退那三行。
2. **`server/sqliteReadWorker.mjs` 的字符串路由 + 位置参数**建议单独排一轮（加契约测试、改成显式标记或结构化路由），我没动它。
3. **720h（30 天）events 路径 294ms 贴着 300ms 目标**，余量小；若生产 rollup 某段时间缺失（路由失效回落到 events），30 天窗口会顶到目标线。要更稳的话可以考虑给 `usage_events` 加一条覆盖 `(success, provider, timestamp_ms, model, client_type, tokens…)` 的索引（`server/db.ts`，不在我写范围）。
4. **临时实例出真数据**需要把 CPA stub 做到符合 `getCompatChannels`/`getProviderChannels` 的渠道 JSON 形状；做完才能量纯本地的 HTTP p50/p95 与浏览器 TTI。

---

# 附：task-62 —— 读线程路由契约测试 + 覆盖索引评估

## A. ② 读线程「字符串路由 + 位置参数」的契约

**改动**（`server/sqliteReadWorker.mjs`，新增 `countPlaceholders` / `assertParamCount`）：在执行前比对**占位符个数与参数个数**，不匹配就**显式抛错**。

为什么必须这么做（实测 `node:sqlite` 的真实行为）：

| 情形 | SQLite 原生行为 | 危险度 |
| --- | --- | --- |
| 参数**少于**占位符 | 缺的参数被当 **NULL** → **静默返回空结果**，不报错 | 🔴 表现为「查询突然变快」（我踩到的是 0.4ms），靠指纹比对才发现 |
| 参数**多于**占位符 | `column index out of range` | 🟠 至少会报错 |

计数规则（与绑定语义对齐，且已自测）：先剥掉字符串字面量与注释里的 `?`，匿名 `?` 逐个计数，`?NNN` 取最大编号，出现命名参数（`:x`/`@x`/`$x`）时返回 `null` 表示跳过校验（本仓库不用命名参数）。

**契约测试**（新增 `server/sqliteReadWorkerContract.test.ts`，7 条，全绿）：

| 测试 | 钉住的契约 |
| --- | --- |
| SQL 文本带 `INDEXED BY idx_usage_cache_rollup` | 路由的**判定依据就是这串 hint**；同时钉住参数位置（`params[0]`=cutoff、`params[2]`=provider） |
| 不命中路由：直连 vs 经池**逐行相等** | 真实报表 SQL（latency 明细）逐行比对。⚠️ 注意：直连行是 **null 原型对象**，跨线程回来的是 structured-clone 的普通对象，比较前需归一化 |
| 命中路由：经池结果 == **独立写的 rollup 查询**（逐行、含全部聚合列） | 改写忠实性；并用「`minuteBucket` 全是 60 的整数倍」作为**路由确实发生**的可判定证据 |
| 去掉 hint 后不再被路由 | 字符串契约**可红**：hint 一旦被删/改，结果形状从「小时对齐」变回「15 分钟对齐」，测试立刻红 |
| 参数少于/多于占位符 → 显式报错 | 负向验证：先证明直连是**静默 0 行**，再证明经池是显式错误；同时验证正确个数仍可用 |
| 字面量/注释里的 `?` 不计入 | 计数正确性 |
| 跨路径一致性 | 见下 |

**跨路径一致性（顺手量出来的两个既有差异，均已写进测试）**：把同一条 cache-trend 查询分别跑在「有 rollup」与「无 rollup」的库上（同窗口、同参数）：

1. **首个不完整小时**：窗口起点落在小时中间时，rollup 路径按 `hour_ms >= cutoff` **整点丢弃**那个小时，events 路径按 `timestamp_ms >= cutoff` 保留 → 只有首个桶请求数偏小（生产 168h 实测：1,179 vs 1,284，占该桶 9%、占全窗口 0.075%）。测试断言「只允许首个桶有差异」。
2. **浮点求和顺序**：rollup 是「小时合计再相加」，events 是「逐行相加」，非结合性带来 ~1e-17 噪声（`0.362` vs `0.36200000000000004`）→ 比较前量化到 6 位小数。
3. **hours ≤ 72 时路由会变粗**：rollup 行是**小时**粒度，而该窗口请求的是 15 分钟/5 分钟/1 分钟桶 → 有 rollup 时拿到的小时点（实测 24h：24 点 vs events 97 点）。**这是既有行为**，不影响 6h/24h 桶的合计，但同一控制台在「rollup 填充 / 未填充」两种部署下曲线精细度不同 —— 值得单独排一轮决定要不要在 rollup 路径按分钟回补。

**位置契约的第二个坑（测试里也钉住了）**：路由路径按位置读 `params[0]/[2]`，所以调用方的参数表必须恰好是 `[cutoff, cutoff, provider(, keyId)]`。参数**个数**对但**位置**错（例如两个 cutoff 写反）不会被计数校验拦住，只能靠「独立 rollup 查询逐行比对」这条测试拦 —— 这就是为什么测试比对的是**行内容**而不只是行数。

## B. ③ `usage_events` 覆盖索引评估：结论**不值得加**

实验环境：`/tmp/perf-norollup`（生产规模 957,736 行、无 rollup ⇒ 强制走 events 路径），720h 窗口、单渠道、`EXPLAIN QUERY PLAN` + 三次取最小值。

| 项 | 结果 |
| --- | --- |
| 现状访问路径 | `SEARCH usage_events USING INDEX idx_usage_cache_rollup (success=? AND <expr>=? AND <expr>>?)` + `USE TEMP B-TREE FOR GROUP BY` |
| 720h events 查询（SQL 层） | **73.6ms**（loader 294ms = 6 渠道并行查询 + JS 聚合） |
| 加候选覆盖索引（`success, lower(trim(provider)), 规范化model, client_type, timestamp_ms, input_tokens, cached_tokens, cache_write_tokens, output_tokens, cost_usd`） | **plan 完全不变**（planner 仍选原索引），耗时 **76.7ms**（无改善） |
| 候选索引代价 | 建索引 **1.2s**、占 **61.6MB**（库 917MB 的 6.7%）、20k 行插入 **1438ms → 1741ms（写入 +21%）** |
| 额外发现 | rollup 由触发器增量维护（`trg_usage_hourly_rollup_insert` / `_update_key` / `_update_cost`）⇒ 每条 event 写入**已经**多一次 rollup 写；再加索引会直接叠在这条热路径上 |

**判据（为什么不加）**：
1. **planner 不用它**：现有 `idx_usage_cache_rollup` 的前缀顺序已匹配谓词；而分组键里的「展示桶」表达式**随窗口宽度变化**（1 分钟～1 天），任何单一索引都无法覆盖，`TEMP B-TREE FOR GROUP BY` 消不掉 —— 这 73.6ms 是「扫 44.8 万行 + 分组」的固有成本，加索引不改变它。
2. **events 路径只在 rollup 缺失/损坏时才走**：生产 rollup 已填充（34,316 行），实测走 rollup 路径 **94ms**（生产 HTTP 热 13–16ms）。
3. 代价明确且落在写热路径（+62MB、+21% 写入），收益为 0。

**触发条件（什么时候必须处理，以及先做什么）**：
- 若 **rollup 表缺失/损坏或触发器被移除**，且 30 天 events 路径 P95 超过 300ms ⇒ **先修复/重建 rollup**（一次性重建 34k 行，秒级），**不要加索引**（不解决问题）。
- 若 `usage_events` 长到 **~250 万行（当前 2.6×）**，events 720h 线性外推到 ~800ms ⇒ 同样优先保证 rollup 完整；届时应评估把 cache-trend 的预聚合**落到 rollup 的分钟维度**（`hour_ms` 之外再存一个 bucket 维度），而不是加索引。
- 判据口径：`scripts/perf-probe.mjs` + `/tmp/perf-norollup` 式「强制 events 路径」的库，`ROUTE=cache-trend NOW_MS=<固定>` 复测。
