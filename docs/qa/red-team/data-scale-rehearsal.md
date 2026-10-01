# Crosery API Console — 第十六轮：生产规模数据容量预演（红队 B / task-54）

**目的**：所有既往验证都跑在**几乎空的小库**上；生产 `console.db` 是 **3.7 GB**（`docs/qa/deploy/release-plan.md` §7.1）。本轮用**临时实例 + 临时 DATA_DIR + 合成生产规模数据**做容量预演。
**审计人** `ux-auditor` / task-54｜**实测时点** 2026-10-01 14:54–15:05｜**仓库源码 0 改动**
**写入边界**：只写 `docs/qa/red-team/**`；**只用临时 DATA_DIR**（`mktemp -d`）；**生产 8791 未灌数据、未压测**（仅 8791 之外的自建临时端口）；真实配置零改动。

### ⚠️ 最重要的一条前提（先读）
我测的 **100k 行 = 132 MB**（≈1.32 KB/行）。生产 **3.7 GB ÷ 1.32 KB ≈ 2.8M 行 ≈ 我最大数据集的 28 倍**。
**因此本轮的价值不在绝对毫秒数，而在「增长是否有界」**：我测出了**线性增长**的斜率，据此外推 28×。**「28×」这个外推是本节所有风险判断的基础，也是最需要被挑战的假设**（见 §6 未验证项）。

---

## 1. 造数（合成，非真实数据）

用临时 `DATA_DIR` + `server/db.ts` 自身迁移建 schema，再以 `node:sqlite` 在一个事务里灌数据：

| 数据集 | 用量行 | Key | 渠道 | 时间跨度 | 错误率 | DB 大小 |
|---|---|---|---|---|---|---|
| `d10k` | 10,000 | 50 | 30 | 30 天 | 4.8% | 13.7 MB |
| `d50k` | 50,000 | 50 | 30 | 30 天 | 5.1% | 67.1 MB |
| `d100k` | **100,000** | 50 | 30 | 30 天 | **4.9%** | **132.0 MB** |

- **长尾**：token 用指数分布（`exp(rand*8)`），另加 **0.5% 超大行**（input 20 万–100 万、output 6 万–26 万）⇒ 贴近真实长尾
- 另有 **30 条 `channel_states` + 240 条 `channel_model_states`**、8 个模型、6 个分组、8 类客户端、5 类错误
- **优先走接口**的意图未能实现：控制台没有「写入用量行」的公开接口（用量来自网关），故按任务允许的**回退方案**直写临时库 ✓

---

## 2. 🔴 无法用 HTTP 端到端测：7 个页面接口在隔离实例上**全部 500**

我按计划起了临时实例并登录，但 `/api/dashboard`、`/api/analytics`、`/api/usage-overview`、`/api/usage-page`、`/api/charts`、`/api/cache-analytics` **在三个数据规模下全部返回 500**（错误体 1267 B），`/api/model-index` 返回 502。**根因不是数据量**：
```
Error: CPA_MANAGEMENT_KEY 未配置
    at cpaRequest (server/cpa.ts:60)
    at getCompatChannels (server/cpa.ts:166)
    at fetchChannels (server/channels.ts:53)
    at loadGatewaySnapshot (server/channels.ts:415)
```
⇒ 这些报表接口会先取**网关渠道快照**，而隔离实例没有 CPA 管理密钥/网关。**这是环境缺失，不是缺陷**（同一代码在生产有网关时正常）。
**我随即改用「直接测报表层」**：`new SQLiteReadPool(临时库)` + 直接调用 `server/usageReports.ts` 的 8 个 loader（这才是容量问题真正所在，且排除了网关噪声）。**代价：浏览器首屏 TTI 与 HTTP 端到端数字本轮拿不到**（见 §6）。

---

## 3. 增长曲线（核心数据）

**方法**：每个规模 3 次采样取中位数；先 warm 一次（排除首次 prepare/parse）；同一进程内顺序执行，无并发干扰。**时间控制**：3 规模 × 8 loader × 3 次 ≈ 10 秒，秒级完成，未触及「几分钟」上限。

| loader（对应页面） | d10k | d50k | **d100k** | **×100k/10k** | 线性？ |
|---|---|---|---|---|---|
| `loadDashboardReport`（/dashboard） | 5.3ms | 24.0ms | **43.5ms** | **×8.2** | ✅ 近似线性 |
| `loadAnalyticsReport`（/analytics） | 14.5ms | 66.6ms | **131.0ms** | **×9.0** | ✅ 近似线性 |
| **`loadUsageOverviewReport`（/usage 顶部汇总）** | 33.3ms | 162.5ms | **318.3ms** | **×9.6** | 🔴 **线性** |
| `loadUsagePageReport`（/usage 页） | 30.7ms | 96.9ms | **133.3ms** | ×4.3 | ⚠️ 次线性 |
| `loadChartsReport`（/charts） | 15.6ms | 45.9ms | **60.0ms** | ×3.8 | ⚠️ 次线性 |
| **`loadCacheTrendReport`（/cache）** | 34.7ms | 158.5ms | **282.2ms** | **×8.1** | 🔴 **线性** |
| `loadUsageKeySummariesReport`（/keys 汇总） | 28.5ms | 80.7ms | **123.1ms** | ×4.3 | ⚠️ 次线性 |
| **`loadUsageBreakdownReport`（/analytics 明细聚合）** | 19.1ms | 88.3ms | **167.4ms** | **×8.8** | 🔴 **线性** |

**读法**：行数 ×10，耗时 ×8.1–9.6 就是**线性**（无缓存、无预聚合兜底）；×3.8–4.3 说明有部分固定成本或走了更好的索引。

### 外推到生产（×28）
| loader | d100k 实测 | **×28 外推（≈2.8M 行）** | 级别 |
|---|---|---|---|
| **usage-overview** | 318ms | **≈ 8.9 s** | 🔴 高 |
| **cache-trend** | 282ms | **≈ 7.9 s** | 🔴 高 |
| usage-breakdown | 167ms | ≈ 4.7 s | 🟠 中 |
| analytics | 131ms | ≈ 3.7 s | 🟠 中 |
| usage-page | 133ms | ≈ 3.7 s | 🟠 中 |
| key-summaries | 123ms | ≈ 3.4 s | 🟠 中 |
| dashboard | 43.5ms | ≈ 1.2 s | 🟡 低 |
| charts | 60ms | ≈ 1.7 s | 🟡 低 |

**注意**：外推是**上界**（真实生产窗口内行数取决于 `USAGE_RETENTION_DAYS` 保留策略；3.7GB 里可能大部分是**额度账本与过期明细**，而不是 30 天窗口内的行）。**见 §6-1，这是决定发布判断的关键未知量。**

---

## 4. 深分页 / 排序 / 无界 LIMIT

**结论：经典「`offset=90000` 深分页」风险不存在** —— 报表层**没有任何用户可控的大 OFFSET**，所有列表都是**硬上限**：
| 位置 | SQL 形态 | 上限 |
|---|---|---|
| `usageReports.ts:334` | 请求明细：`ORDER BY u.timestamp_ms DESC LIMIT 200` | **硬编码 200** |
| `:230` | Top 模型：`GROUP BY … LIMIT 8` | 8 |
| `:235` | 错误状态码：`LIMIT 6` | 6 |
| `:240` | 错误分类：`LIMIT 8` | 8 |
| `:53` | 另一处 Top-N：`LIMIT 8` | 8 |
⇒ **没有 `page`/`offset`/`limit` 查询参数**（我核对了 `/api/usage-page` 只吃 `days`/`keyId`），因此**不存在漏行/重复行的分页正确性风险**（无分页可言）。

**但发现一处「隐蔽的深 OFFSET」—— p95 百分位实现（`usageReports.ts:60-72`）**：
```sql
COALESCE(( SELECT latency_ms FROM usage_events INDEXED BY idx_usage_latency_rollup
           WHERE ${selected} ORDER BY latency_ms
           LIMIT 1 OFFSET ( SELECT CAST((COUNT(*) - 1) * 0.95 AS INTEGER)
                            FROM usage_events INDEXED BY idx_usage_latency_rollup WHERE ${selected} ) ),0) p95
```
- **现象**：用「先数出总数、再 `OFFSET` 到 95% 位置」算 p95 ⇒ SQLite 必须**逐个跳过 ~95% 的索引项**才能取到那一行。
- **证据**：这是 `/analytics` 与 `/charts-latency` 共用的形状；实测 `analytics` 的线性增长（×9.0）与之一致；`EXPLAIN` 显示该子查询走 `idx_usage_latency_rollup` 索引（不读表），但**跳过 2.66M 项仍是 O(n)**。
- **级别**：🟠 **中**（随行数线性增长，且**每次调用都要走两遍**：一遍 COUNT、一遍 OFFSET 跳过）
- **触发条件**：窗口内行数越大越慢；生产 2.8M 行时该子查询本身就可能**秒级**
- **建议**：改用 `ORDER BY latency_ms LIMIT 1 OFFSET` 的正统替代 —— SQLite 3.25+ 支持**窗口函数**（`PERCENTILE_CONT` 无，但 `ROW_NUMBER()/NTILE` 可用），或用直方图/rollup 表预聚合 p95

---

## 5. 索引与 N+1（`EXPLAIN QUERY PLAN`，d100k + 30 天窗口）

| 查询形态 | 计划 | 判定 |
|---|---|---|
| `GROUP BY provider`（窗口聚合） | `SEARCH usage_events USING INDEX idx_usage_timestamp_ms (timestamp_ms>?)` + TEMP B-TREE FOR GROUP BY | ✅ **走索引**，无全表扫描 |
| `GROUP BY key_hash`（key 汇总） | **`SCAN usage_events USING COVERING INDEX idx_usage_key_rollup`** + TEMP B-TREE FOR ORDER BY | ⚠️ **索引全扫**（但是 **covering**，不读主表）—— 这是 `key-summaries` 仍增长的原因 |
| `GROUP BY 小时` | `SEARCH … idx_usage_timestamp_ms` + TEMP B-TREE | ✅ |
| `GROUP BY model, success` | `SEARCH … idx_usage_timestamp_ms` + TEMP B-TREE | ✅ |
| 明细页（`LIMIT 200` + `LEFT JOIN api_keys`） | `SEARCH u USING INDEX idx_usage_timestamp_ms` → `SEARCH a USING INDEX sqlite_autoindex_api_keys_1 (key_hash=?) LEFT-JOIN` | ✅ **连接走索引 ⇒ 无 N+1** |

**结论**：**没有全表扫描（除一个 covering-index 扫描）**，**没有 N+1**（join 用索引 + 明细硬上限 200），**没有无界 LIMIT**。**慢的原因不是缺索引，而是「必须聚合整个窗口」这一语义本身** —— 属于**数据量与预聚合**问题，不是索引问题。

---

## 6. 聚合正确性（与我自己写的 SQL 比对，d100k）

直接调 `loadUsageOverviewReport(d100k, days=30)` 与 `node:sqlite` 全表 SQL 对比：

| 指标 | loader 返回 | 我的 SQL（全部 10 万行） | 差异 | 判定 |
|---|---|---|---|---|
| requests | **99,992** | 100,000 | 8 | ✅ 窗口边界外 8 行 |
| outputTokens | **81,808,521** | 81,808,738 | 217 | ✅ 同一 8 行 |
| cacheTokens | **59,634,004** | 59,634,111 | 107 | ✅ |
| totalTokens | 405,936,732 | 405,940,144（in+out 相加） | 3,412 | ✅ |
| errors | —（loader 未直接暴露） | 4,938（**4.94%**） | — | ✅ 与我造的 5% 一致 |
| cacheShare | **0.1421** | 59,634,111 / (324,131,406+…) | 量级一致 | ✅ |

⇒ **聚合数值正确**（差异全部由「30 天窗口边界」解释，且方向一致）✓ 未发现重复计数或漏计。

---

## 7. 对发布决策的判断（一句话 + 数字）

> **不阻塞发布，但 `/usage`、`/cache`、`/analytics` 在满规模生产库上会明显变慢（外推 4–9 秒），属于「能用但难受」；真正的未知量是 3.7 GB 里落在当前保留窗口内的行数——发布前应先 `SELECT COUNT(*) FROM usage_events WHERE timestamp_ms >= <窗口起点>` 量一次：≤30 万行则全部接口 <1 秒、无风险；≈280 万行则 usage-overview/cache-trend 会到 8–9 秒，建议先做 p95 子查询与 usage-overview 的预聚合/rollup 优化再发布。**

**支撑数字**：① 我用 10k/50k/100k 三点量出 **5 个 loader 呈线性（×8.1–9.6 / 10× 行）**；② 100k 行时最慢的 `usage-overview` = **318ms**，×28 ⇒ **≈8.9s**；③ 索引与 N+1 都不是瓶颈（EXPLAIN 证明走索引、join 用索引、明细硬上限 200）⇒ 优化方向是**预聚合/rollup 与 p95 算法**，不是加索引；④ 聚合数值与独立 SQL 一致，**没有正确性风险**。
**为什么说「不阻塞」**：这些是**只读报表接口**，没有硬超时；前端有加载态；即使 9 秒也只是「慢」，不会写坏数据或崩服务。**但它会直接变成用户抱怨的「转圈」**，所以建议**发布前先量那一个 COUNT**，用数字决定是否需要先优化。

---

## 8. 未验证项（诚实列出）

1. **生产 3.7 GB 里「窗口内行数」未知** —— 我的 ×28 外推**可能大幅高估**（若大部分是过期明细/额度账本）。**这是本轮最大的不确定性，也是发布判断的关键输入。**
2. **HTTP 端到端 7 个接口 + 浏览器首屏 TTI 未测**：隔离实例缺 `CPA_MANAGEMENT_KEY`/网关 ⇒ 全部 500（§2）。我用报告层直测替代。**要补的话需要 CPA stub（工作量不小）或在中转站灰度实例上量。**
3. **并发/多用户未测**：全部为单请求顺序采样；没有测 10 个用户同时打开 `/usage` 的叠加效应（`SQLiteReadPool` 有 2 个 worker，读并发行为未验）。
4. **真实 `USAGE_RETENTION_DAYS` 与 rollup 表状态未纳入**：`usage_hourly_rollup` 等预聚合表在我灌数时是空的；生产若已填充，实际耗时可能**低于**我的线性外推（这是对我结论的**反向**不确定性）。
5. **深分页「正确性」只做了存在性核查**（无用户可控 OFFSET），**未做集合比对的漏行/重复行实验**（因为无分页可测）。
6. **未测 500/超时是否真的出现**：报告层没有硬超时；未构造「行数 × 并发」到超时的场景。
7. **未验证 `usage_hourly_rollup` 是否被查询路径优先使用**（若用了，线性外推不成立）。

---

## 9. 复跑判据

```bash
BASE=$(mktemp -d /tmp/r16-XXXX)
# 1) 建 schema（用服务自身的迁移，DATA_DIR 隔离）
DATA_DIR=$BASE/d100k node --import tsx -e 'await import("./server/db.ts")'
# 2) 灌数据：直写临时 console.db（node:sqlite，单事务）
#    usage_events: request_id/timestamp/timestamp_ms/key_hash/provider/model/model_group/endpoint/success/status_code/
#                  latency_ms/ttft_ms/input_tokens/output_tokens/reasoning_tokens/cached_tokens/cache_write_tokens/total_tokens/…/cost_usd
#    api_keys 50 行；channel_states 30 行；时间跨度 30 天；5% success=0；0.5% 超大 token 行
# 3) 直接测报表层（绕开网关依赖）
node --import tsx -e '
const {SQLiteReadPool}=await import("./server/sqliteReadWorker.ts")
const R=await import("./server/usageReports.ts")
const GROUPS=["openrouter","anthropic","openai","google","moonshot","xai"].map(id=>({id,name:id,color:"#000",kind:"compat",models:[]}))
const r=new SQLiteReadPool("<dir>/console.db",2)
console.time("usage-overview"); await R.loadUsageOverviewReport(r,GROUPS,30,""); console.timeEnd("usage-overview")'
# 4) 正确性：与 SQL 对比（差异应可由窗口边界解释）
# 5) EXPLAIN QUERY PLAN 看索引/全扫；grep -n "OFFSET\|LIMIT" server/usageReports.ts 看分页与上限
```
**时间控制**：灌数单事务（10 万行 ≈ 数秒）；报表测量 3 规模 × 8 loader × 3 次 ≈ 10 秒；EXPLAIN 瞬时 ⇒ **单条压测远低于「几分钟」上限**，且**全程未触碰生产 8791**。


---

# 附录 A：按生产实测行数复跑（task-55，纠正上一轮的 ×28 外推）

**触发**：Lead 用只读 SSH 在生产库上量出真实规模（证据 `docs/qa/deploy/prod-db-profile.md`），**推翻了我上一轮的核心假设**。
| 项 | 我上轮假设 | **生产实测** | 我的复跑造数 |
|---|---|---|---|
| 全量 `usage_events` | ≈2.8M（由 3.7GB÷1.32KB 外推） | **957,736** | **957,736** ✅ |
| 最近 7 天 | — | **147,082** | **147,082** ✅ |
| 最近 30 天 | — | **448,021** | **448,021** ✅ |
| `usage_hourly_rollup` | **空**（我灌数时未填） | **34,316（已填充）** | **628,812** ⚠️ 见 §A.3 |
| 跨库时间范围 | — | 66 天 | 66 天 ✅ |

**⇒ 我上一轮的 ×28 外推高估了约 2.9×**（2.8M vs 957,736）。而且**生产已填充 rollup**，我上轮合成库缺它 ⇒ 对 rollup 支撑的那部分**偏悲观**。

## A.1 rollup 与 events 的一致性（要求 1）
按 PK（hour_ms × key_hash × provider × model × model_group × endpoint × client_type × success × status_code × error_category）由 events 聚合出 rollup，**再用另一条独立查询**随机抽 3 个小时与 events 现算结果比对：
```
{"hour":"2026-07-30T02","events":{"req":599,"tok":4738389,"errs":24},"rollup":{"req":599,"tok":4738389,"errs":24},"match":true}
{"hour":"2026-09-09T22","events":{"req":583,"tok":1582164,"errs":27},"rollup":{"req":583,"tok":1582164,"errs":27},"match":true}
{"hour":"2026-08-19T12","events":{"req":607,"tok":2999177,"errs":27},"rollup":{"req":607,"tok":2999177,"errs":27},"match":true}
```
✅ **3/3 完全一致**（requests / total_tokens / errors 三项全等）⇒ 我的 rollup 与 events 自洽。
（造数时 PK 首次报 UNIQUE 冲突，改用 `INSERT OR REPLACE` 后通过；一致性检查正是为了确保 REPLACE 没有掩盖重复计数 —— 3 个小时的逐项比对证明没有。）

## A.2 per-loader 耗时（7 天 / 30 天窗口，5 次采样 p50/p95，单位 ms）
| loader | **数据来源** | **7 天 p50/p95** | **30 天 p50/p95** |
|---|---|---|---|
| dashboard | **rollup** | 38.7 / 86.6 | 188.6 / 193.8 |
| analytics | **混合**（3×rollup + 1×events=p95） | 428.1 / 433.2 | 647.2 / **1240.7** |
| usage-overview | **rollup** | 525.3 / 959.6 | 1229.1 / 1235.0 |
| usage-page | 混合 | 85.2 / 99.2 | 313.7 / 356.7 |
| charts | **events** | 65.3 / 77.7 | 173.5 / 175.4 |
| key-summaries | **rollup** | 702.9 / 708.3 | 700.3 / 707.1 |
| breakdown | **rollup** | 149.1 / 156.8 | 616.8 / 630.1 |
| **cache-trend（168h）** | **events** | — | **2910.8 / 3435.2** 🔴 |
| charts-latency（30d） | events（含 p95） | — | 143.5 / 147.0 |
| **p95 子查询（单独计时）** | **events** | **99.0 / 100.7** | **186.2 / 189.7** |

**来源判定方法**：读码统计每个 `export async function` 块内 `usage_hourly_rollup` / `FROM usage_events` 的出现次数（rollup 为主 / events / 混合），再与实测对照。

## A.3 ⚠️ 我这个合成库的 rollup **比生产大 18.3 倍**（628,812 vs 34,316）
原因：我的合成数据每小时基数远高于生产（生产 66 天 34,316 行 ⇒ **~21.7 行/小时**；我 ~397 行/小时）。
**后果**：**所有 rollup 支撑的 loader 在我的数据上被显著高估** —— `usage-overview` 1229ms、`key-summaries` 700ms 都是**上界**；生产 34k 行的 rollup 应快得多（粗略按行数比例，可能回到几十到一两百 ms 量级，但**这是估算、未实测**）。
**而 events 支撑的 loader 是代表性的**（我的 events 总数与 7/30 天分布与生产**逐数字相同**）。

## A.4 p95 子查询：**上轮的发现完全成立，且这是唯一不受 rollup 帮助的路径**（要求 2 的重点）
```
P95 SUBQUERY 30d: {"windowRows":447988,"p50":186.2,"p95":189.7}
P95 SUBQUERY  7d: {"windowRows":147004,"p50":99.0,"p95":100.7}
```
- 它 `INDEXED BY idx_usage_latency_rollup ... LIMIT 1 OFFSET (COUNT(*)×0.95)` ⇒ 在 44.8 万行窗口下要**跳过约 42.6 万个索引项**，且**一次调用走两遍**（COUNT + OFFSET）。
- **单它就占 30 天窗口 186ms**，而 `analytics` 的 **p95 从 433ms 涨到 1241ms（×2.9）** —— 与 `analytics` 是「3×rollup + 1×events(p95)」的混合结构吻合：**窗口一变大，p95 这条事件路径就成了主导项**。
- ✅ **级别：中（仍建议修）**；修法同前（窗口函数/直方图/预聚合 p95）。
- **行数增长含义**：日均 ~1.45 万行（96 万 / 66 天）⇒ **30 天窗口每月约 +45 万行** ⇒ 一年后 30 天窗口约 **45 万 → 千万级**？不，是**每月 +45 万存量**：30 天窗口 ≈ 43.5 万行/月 × 月数… 准确说：**30 天窗口的行数 ≈ 45 万（现在）**，而**全量每月 +45 万**；若保留策略不放宽，30 天窗口会**稳定在 ~45 万行左右**（因为旧数据被清理）⇒ **p95 的 186ms 不会随时间继续恶化**，这是好消息。**但前提是 `USAGE_RETENTION_DAYS` 保持现状**。

## A.5 上一轮结论的修正（要求 3）
| 上轮结论 | 复跑后 |
|---|---|
| ×28 外推（usage-overview ≈8.9s 等） | 🔴 **被推翻**：真实 957,736 行（不是 2.8M），且生产有 rollup ⇒ **外推高估约 2.9× 且方向偏悲观** |
| 「所有聚合都退回扫 events」 | 🔴 **被推翻**：生产 rollup 已填充，5 个 loader 走 rollup（dashboard / usage-overview / key-summaries / breakdown / usage-page 部分） |
| **p95 子查询是隐患** | ✅ **完全成立**，且在 44.8 万行窗口实测 **186ms**，是 analytics 30 天 p95 从 433→1241ms 的主因 |
| 深分页风险不存在（无用户可控 OFFSET、列表硬上限） | ✅ **成立**（读码结论未变） |
| 无全表扫描 / 无 N+1（EXPLAIN） | ✅ **成立**（本轮未重跑 EXPLAIN，但 schema 与查询未变） |
| 聚合数值正确 | ✅ **成立**（本轮 rollup 一致性 3/3） |
| **新发现：`cache-trend`（168h）≈2.9–3.4 秒** | 🔴 **本轮新发现且最慢**，走 **events**（rollup=0）⇒ **不受 rollup 帮助、且我的行数与生产一致 ⇒ 代表性强**。**原因未定位**（疑似按小时循环/多次扫 events），**列为最高优先复查处** |

## A.6 HTTP 端到端与浏览器 TTI（要求 4）：**仍未补上**
本轮我**没有**实现 CPA stub（时间/预算不足）。隔离实例仍因 `CPA_MANAGEMENT_KEY 未配置` 使页面接口 500，因此：
- **HTTP p50/p95 与浏览器 TTI 仍是未验证项**（与上轮相同）；
- 我改为**直接测报表层**（§A.2），这正是容量的决定因素，但**不含 HTTP/序列化/前端渲染开销**。
**诚实标注**：这是本附录最大的缺口。

## A.7 新的发布判断（要求 5）
> **按实测行数（96 万全量 / 45 万 30 天窗口 / 34k rollup），发布不阻塞；唯一值得在发布前处理的是 `cache-trend`（实测 2.9–3.4 秒，走 events，代表性强）与 p95 子查询（186ms，且是 analytics 30 天 p95 的主导项）。rollup 支撑的主路径反而比我上轮估计的好得多（我上轮的悲观来自缺 rollup + 高估 2.9×）。**

**支撑数字**：① 我的 events 与生产的 **957,736 / 147,082 / 448,021 三个数字逐一对齐**；② rollup 一致性 3/3；③ p95 子查询 30 天 **186ms**（7 天 99ms）——**唯一不受 rollup 帮助的事件路径**；④ `cache-trend` **2911ms**，走 events，**待定位**；⑤ rollup 支撑的 5 个 loader 的 1229ms/700ms 是**被我 18.3× 超标 rollup 抬高的上界**，不代表生产。
**增长含义**：日均 ~1.45 万行 ⇒ **全量每月 +45 万行**，但 **30 天窗口在保留策略不变时稳定在 ~45 万行** ⇒ **p95 与 events 路径的耗时不随时间持续恶化**（除非放宽 `USAGE_RETENTION_DAYS` 或提高流量）。**真正的长期风险是全量增长对 rollup 构建/维护与 `key-summaries`（窗口无关、恒定 ~700ms）的影响**，以及**流量翻倍时 30 天窗口同步翻倍**。
