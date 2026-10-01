# rollup 漂移：自检与重建（task-64 / blue-ui）

日期：2026-10-01 · 结论：**生产健康（实测 ratio 1.000）**；问题在「错了没人知道」——本页给出**只读自检**（HTTP 接口 + 脚本，成本 7.5ms / 50ms）与**幂等重建**（演练通过，先备份、跑两遍结果一致）。

---

## 1. 为什么会漂移（机制，代码事实）

`usage_hourly_rollup` 不是查询时现算的，而是由 `server/usageRollup.ts` 里 **3 个 `AFTER INSERT`/`AFTER UPDATE` 触发器**在写入 `usage_events` 时**增量累加**出来的：

```sql
-- trg_usage_hourly_rollup_insert（节选）
ON CONFLICT (hour_ms, key_hash, …) DO UPDATE SET
  request_count = usage_hourly_rollup.request_count + 1,
  total_tokens  = usage_hourly_rollup.total_tokens + excluded.total_tokens, …
```

而 schema 里**只有** `trg_usage_hourly_rollup_insert` / `_update_key` / `_update_cost`，**没有 `AFTER DELETE`**（`sqlite_master` 实测）。于是任何「同一条逻辑事件被写两次」的路径都会**永久**放大 rollup，而**没有任何机制会发现**：

- 回填/重建脚本跑两遍；
- 重建中断后重跑；
- 手工重放、`INSERT OR REPLACE` 语义（REPLACE 先删后插，但只触发 INSERT 侧）；
- 更早的残留数据（下面那个开发库就是）。

对照之下 `usage_events` 侧是可信的：`request_id UNIQUE` + `INSERT OR IGNORE`（`server/sync.ts:25`）保证重复写入被忽略 ⇒ **`COUNT(*) FROM usage_events` 可以作为参照**。

**影响面**：所有走 rollup 的 loader（dashboard / analytics / usage-overview / key-summaries / breakdown）+ 长窗口（>168h）的 cache-trend，都会**安静地**显示错数。

## 2. 怎么发现（只读、便宜）

### 2.1 判据

同一**整点对齐**窗口内：

```
ratio = SUM(usage_hourly_rollup.request_count) / COUNT(*) FROM usage_events
```

窗口必须对齐到整点：不对齐时 rollup 路径会整点丢弃/多算首个不完整小时，产生 1–3% 的**假漂移**（生产 3h 窗口实测 1.023 就是这么来的）。

分级：**< 1% ok ｜ 1–5% warn ｜ > 5% alert**（`driftPct` 取绝对值，rollup 偏大或偏小都算）。

### 2.2 HTTP 接口（一眼可见）

```
GET /api/usage/rollup-health?hours=24        # 走既有 /api 鉴权；无 cookie → 401
{ "windowHours":24, "cutoffMs":1790755200000, "rollupRequests":12568, "eventRequests":12568,
  "ratio":1, "driftPct":0, "severity":"ok", "checkedAt":"2026-10-01T…" }
```

实现：`server/usageRollup.ts` 的 `rollupHealthOperations()` + `summarizeRollupHealth()`，路由在 `server/index.ts`（**只新增只读诊断接口**，不动业务路由/鉴权/审计/静态层），查询跑在**读线程池**上，不占主线程。

### 2.3 脚本（巡检 / CI 可用）

```bash
node scripts/rollup-rebuild.mjs check --db <path> [--hours 24]     # 退出码：alert → 1，其余 → 0
```

### 2.4 成本（实测）

| 环境 | 窗口 | rollup 侧 | events 侧 | 合计 |
| --- | --- | --- | --- | --- |
| 生产库（3.7GB / 958k 事件 / rollup 3.4 万行，SSH 只读） | 24h | 2.3ms | 5.2ms | **7.5ms** |
| 同上 | 168h | 0.9ms | 49ms | **50ms** |

⇒ 便宜到**可以随时跑**，建议：每次发版后跑一次 24h + 168h；要定期轮询的话 15–30 分钟一次也毫无压力（<0.1% 的读线程占用）。**不需要**全表扫描。

### 2.5 生产实测（`ssh cpa-vps` 只读打开，服务器未写任何文件）

```
{"hours":24, "rollup":12568, "events":12568, "ratio":1,     "driftPct":0, "severity":"ok"}
{"hours":168,"rollup":147210,"events":147210,"ratio":1,     "driftPct":0, "severity":"ok"}
```

**生产是健康的**（与 Lead 只读实测一致）。本机实例（`/api/usage/rollup-health`）则报 **alert**：24h `ratio 2.00 / drift 99.8%`、168h `ratio 6.32 / drift 532%` —— 因为该实例的 `DATA_DIR` 指向仓库里那个被 gitignore 的开发库（见 §5）。**自检能抓到真实漂移，这就是它的价值。**

## 3. 怎么重建（幂等、先备份、可验证）

```bash
cp <drifted.db> /tmp/drill/console.db                    # 永远在副本上演练
node scripts/rollup-rebuild.mjs rebuild --db /tmp/drill/console.db --hours 24 --backup-dir /tmp/drill/backups
```

流程与安全设计：

1. **护栏**：`--db` 必填；解析成绝对路径后**先**判断是否生产路径 `/opt/crosery-api-console/`，命中即**拒绝**（除非 `--allow-production`，运行手册规定生产上只跑 `check`）。
2. **先备份**：`VACUUM INTO`（在线、只读源库、写出独立文件）。演练实测：107.5MB 库 **169ms**。
3. **重建**：`DELETE FROM usage_hourly_rollup` + **按 events 全量重算**（`INSERT … SELECT … GROUP BY`），表达式与触发器逐项一致（`client_type` 归一、`uncached_input_tokens`、`cost_usd_count`、`hour_text/day_text`），全程一个 `BEGIN IMMEDIATE` 事务。
4. **自证幂等**：重建**两次**并比较 rollup 指纹（行数 / `SUM(request_count)` / `SUM(total_tokens)` / `SUM(cached_tokens)` / `SUM(cost_usd_sum)`），要求一致。
5. **自证结果**：重建后再跑一次自检，要求 `severity = ok`（drift < 1%），否则退出码 1。

**演练实测**（副本，即上面那个漂移的开发库）：

```
before      ratio 1.9976  drift 99.762%  severity alert
backup      107.5MB / 169ms
rebuild#1   57ms → ratio 1  drift 0%  severity ok
rebuild#2   49ms → ratio 1  drift 0%  severity ok
idempotent  true   fingerprint {"rows":804,"requests":26004,"totalTokens":5077650927,"cached":4736142364,"cost":925.898795}
verdict     rebuilt-and-verified          （整轮 0.315s）
```

## 4. 触发条件：看到什么就该重建

| 现象 | 判定 | 动作 |
| --- | --- | --- |
| `/api/usage/rollup-health?hours=24` `severity=ok`（drift < 1%） | 正常 | 无需动作（发版后跑一次留档） |
| `severity=warn`（1–5%） | 先排除**窗口边界假漂移**：把 `hours` 换成整点对齐的 24/48/168 再看；仍 warn 则可能有少量重复写入 | 记录 + 观察趋势；连续两次 warn 就重建 |
| `severity=alert`（> 5%） | 确认漂移 | **在副本上重建 → 自检回到 1.000 → 停服、备份、替换 rollup 表**（或直接对库跑 rebuild，前提是已备份且已确认 stop-the-world） |
| `ratio ≈ 2.00`（整数倍） | 典型「同批事件被写了两遍」 | 重建；并回查是哪条路径写了两遍（回填脚本/补偿同步） |
| `ratio < 1`（rollup 偏小） | 触发器漏跑（如 events 由别的进程直写、或迁移期间写入） | 重建 |

**重建后的必查项**：① 自检 `ok`；② 抽 3 个小时用独立查询把 rollup 与 events 现算结果逐项比对（requests / total_tokens / errors）；③ 抽查一个走 rollup 的页面（如 analytics 30 天）数值是否随之回到合理区间。

## 5. ⚠️ 不要用仓库里那个开发库当「生产形状」

- 仓库 `data/console.db`（**被 gitignore**）已漂移：整表 `SUM(request_count)` 975,490 vs `COUNT(*)` 26,004 = **37.5×**；最近 24h **2.00×**、168h **6.32×**。
- 本机运行实例的 `DATA_DIR` 默认指向 `root/data`，也就是这个库 —— 所以本机 `/api/usage/rollup-health` 报 alert 属于**预期**。
- **判据只能是生产库**（`/opt/crosery-api-console/data/console.db`，只读实测 ratio 1.000）。
- 性能回归请用 `scripts/perf-seed.mjs` 造的生产规模合成库（957,736 事件 / rollup 34,848 = 生产粒度），不要用这个开发库。**建议**：把它删掉或按 `perf-seed` 重新生成（`rm data/console.db` 后由服务重新初始化），避免下一个人再被它的数字误导。

## 6. 交付物与验证

| 产物 | 说明 |
| --- | --- |
| `server/usageRollup.ts` | `alignedCutoffMs` / `summarizeRollupHealth` / `rollupHealthOperations` / `checkRollupHealth` |
| `server/index.ts` | **只新增** `GET /api/usage/rollup-health`（只读、走既有鉴权、读线程池执行） |
| `scripts/rollup-rebuild.mjs` | `check` / `rebuild`（护栏 + VACUUM INTO 备份 + 幂等自证） |
| `server/usageRollupDrift.test.ts` | 6 条：分级判据、整点对齐、脚本 check/rebuild 端到端、幂等、护栏、同步库自检 |

验证：`tsc -b` **0** · `lint` **0**（4 条既存 warning）· `build` **0** · `npm test` **0**（`663 / 662 / 0 / 1 skipped`）。已重启 `com.crosery.console-magpie`：`/api/usage/rollup-health` 认证后 200（24h 67ms、168h 40ms 首次调用含预热）、无 cookie **401**。生产库只读自检 **ratio 1.000 / ok**（24h、168h）。**全程未在生产执行任何重建、未写入任何文件。**

---

# 附：task-67 —— 补上红队实证的两个盲区（多维度 + 抵消型）

红队第十八轮在副本上实证：旧自检（只比 `request_count` 总量）**看不见**两类真实漂移——
① **抵消型**：一行 `+1`、另一行 `−1`，总量完全相等，逐行已错；② **只改 token/cost**（+234 万 tokens、+$9.99），
一个维度都不比。金额错恰恰最贵。本节的改动**保留原有总量判据**（`requests` 的 ratio/driftPct/severity 字段语义不变），
在其之上补维度与行级差异。

## 1. 新载荷

`GET /api/usage/rollup-health?hours=N`（只读、走既有鉴权、读线程池执行）：

```json
{ "windowHours": 24, "cutoffMs": …, "rollupRequests": 12206, "eventRequests": 12206,
  "ratio": 1, "driftPct": 0, "severity": "ok", "checkedAt": "…",      // ← 与 task-64 完全一致，客户端无需改
  "metrics": [ { "id": "requests|totalTokens|cachedTokens|latencySumMs|costUsdSum",
                 "label": "…", "rollup": …, "events": …, "ratio": …, "driftPct": …, "severity": "ok|warn|alert" } ],
  "rowDrift": { "driftingRows": 0, "sumAbsRequests": 0, "maxAbsRequests": 0,
                "sumAbsTokens": 0, "maxAbsTokens": 0, "sumAbsCost": 0, "maxAbsCost": 0, "severity": "ok" } }
```

- **多维度**：`requests` / `totalTokens` / `cachedTokens` / `latencySumMs` / `costUsdSum` 各自给 ratio + driftPct + severity（同一套 <1% ok / 1–5% warn / >5% alert 判据）。
- **行级差异**：把 rollup 与「按 rollup 主键重新聚合的 events」两边 `UNION ALL` 后按主键分组，得到
  `driftingRows`（有多少行不一致）、`sumAbs*`（`SUM(ABS(diff))`）、`maxAbs*`（最大绝对差）。
  **抵消型漂移在这里必然暴露**（逐行 delta 不全为 0）。整体 `severity` = 所有维度与行级差异里最差的那个。
- 金额用 `1e-6` 绝对阈值判等：浮点求和顺序不同会带来 1e-12 级噪声（生产实测 `sumAbsCost` = 4.5e-14），**不会**被误判成漂移。

## 2. 两个盲区的必红用例（已进测试，`server/usageRollupDriftV2.test.ts`）

| 用例 | 构造 | 旧判据（只看 requests 总量） | 新判据 |
| --- | --- | --- | --- |
| **① 抵消型** | 5 小时前那行 `request_count +1`，3 小时前那行 `−1` | ratio **1**、driftPct **0**、severity **ok**（盲区确认） | `driftingRows ≥ 2`、`sumAbsRequests ≥ 2`、severity 被拉起来（2/4 行 = 50% → **alert**） |
| **② 金额/token** | 只 `total_tokens +2,345,678`、`cost_usd_sum +9.99` | requests 维度 **ok**（盲区确认） | `totalTokens` **alert**、`costUsdSum` **alert**、`driftingRows ≥ 1`、整体 **alert** |
| ③ 合法数据 | 忠实聚合（与触发器同语义） | ok | 五维度全 ok、`driftingRows 0`（**不误报**） |
| ④ 边界 | events 为空、rollup 有 7 条 | — | 该维度 `ratio = null`、`driftPct = 100`、**alert** |

**负向验证**：用例 ② 里显式断言「如果只保留 requests 维度（= 旧行为），这条用例就会通过」——
证明抓到它的是**新维度**本身，而不是别的巧合；用例 ① 同理（`ratio`/`driftPct` 仍为 1/0，只有 `rowDrift` 报）。

## 3. 成本（诚实数字：比只比 requests 贵，但仍是一次分组扫描）

设计上**只用一条 SQL**：两边 `UNION ALL` 后按主键分组，同一次扫描同时得出「两边总量」与「逐行差异」，
所以没有把两个昂贵查询叠加起来（分开做的实测是 245ms + 176ms，合并后 210ms）。

| 环境 | 窗口 | 旧自检（仅 requests） | 新自检（五维度 + 行级） |
| --- | --- | --- | --- |
| 生产规模合成库（95.7 万 events / 3.4 万 rollup，本机） | 24h | 7.5ms | **31.2ms** |
| 同上 | 168h | 50ms | **210.2ms** |
| 本机实例（`/api/usage/rollup-health`，含 HTTP + 读线程） | 24h / 168h | — | 76ms / 81ms |
| **生产库**（3.7GB / 958k events，SSH 只读） | 24h | 7.5ms（基线） | **62.3ms** |
| 同上 | 168h | 50ms（基线） | **1,891ms** |

结论与建议：
- **24h 窗口 62ms** —— 适合作为常规巡检窗口（发版后、每日一次都没问题）；
- **168h 窗口 ~1.9s**（生产机器上逐行分组 14.7 万行）—— 属于「深挖」用途，**不要高频轮询**；
  若要高频，请用 24h，或另开一个只比 requests 的快速模式（本次未加，避免把载荷再分叉）。
- 全部只读、跑在独立读线程上，不阻塞登录/导航/SSE/静态文件。

## 4. 边界（红队点名要求写清）

1. `events = 0 且 rollup > 0` ⇒ 该维度 **`ratio = null`、`driftPct = 100`、severity `alert`**（只有一侧有数据 = 必然漂移）；客户端**必须处理 `null`**（不要直接相除）。
2. 两侧都为 0 ⇒ `ratio = 1`、`driftPct = 0`、`ok`（没有数据不等于漂移）。
3. **窗口外的历史漂移看不见** —— 这是有意的取舍（对比全表意味着每次都要扫 95 万行）。要看全表用
   `node scripts/rollup-rebuild.mjs check --db <path> --all`（`--all` = 不做窗口过滤，把历史漂移一起算出来）。
   实测成本：生产规模合成库（95.7 万 events）全表自检 **3.67s**（含 node 启动）——所以默认仍是窗口模式。
   顺带用它复验了两件事：① `--all` 在 Lead 修过的开发库上现在也是 **ok / ratio 1 / driftingRows 0**（此前的 37.5× 已消失）；
   ② 用 `rollup-rebuild` 重建过的副本在更强的多维检查下仍是 **ok / 0 行漂移**（重建路径经得起新判据）。
4. 行级比较按 rollup 主键（hour × key_hash × provider × model × model_group × endpoint × client_type × success × status_code × error_category）；**同一主键内部**的抵消（例如同一行 `request_count +1` 且 `total_tokens` 相应减少）会被多维度判据抓到，但**跨主键的字段级抵消**（A 行 tokens 多、B 行 tokens 少且行数也对调）属于行级 diff 的粒度上限，已在载荷里通过 `driftingRows` + `sumAbs*` 显式暴露。

## 5. 生产只读抽验（本轮，未重启/未停任何服务、未写入任何文件）

```
24h : ms 62.3   rollup requests 12,206 = events 12,206 | tokens 2,946,974,516 = 2,946,974,516
                | cached 2,863,447,148 = 2,863,447,148 | latency 147,183,779 = 147,183,779 | cost 218.933511 = 218.933511
      severity: requests ok / totalTokens ok / cachedTokens ok / latencySumMs ok / costUsdSum ok
      rowDrift: driftingRows 0, sumAbsRequests 0, sumAbsCost 4.5e-14（浮点噪声，正确未判为漂移）→ ok
168h: ms 1891.2 rollup requests 147,237 = events 147,237 | tokens 28,581,576,500 = 28,581,576,500
                | cached 27,180,256,459 = … | latency 1,580,754,620 = … | cost 8044.324216 = 8044.324216
      rowDrift: driftingRows 0, sumAbsCost 6.3e-12 → ok
```

**生产仍是 1.000 ok**（与 Lead 的只读复验一致）。本机实例（`DATA_DIR` = 仓库 `data/`，Lead 已修复）也是 `ok / ratio 1 / driftingRows 0`；
无 cookie 访问 `/api/usage/rollup-health` → **401**。

## 6. 验证

- 测试：`server/usageRollupDriftV2.test.ts` 5 条（两个盲区必红用例 + 不误报 + 边界 + 判据负向）+ 原 `server/usageRollupDrift.test.ts` 6 条，**11/11 通过**。
- `tsc -b` **0** · `lint` **0**（4 条既存 warning）· `build` **0** · `npm test` **0**（`677 / 676 / 0 / 1 skipped`）。
- 已重启本机服务（`launchctl kickstart -k`，**未用 bootout**）并抽验接口；**生产仅只读 SSH 查询**。

---

# 附：task-74 —— 空窗口误报 alert（告警可信度）与「三种 0」

红队崩溃恢复演练的附带发现 **N1（低）**：空窗口下 `scripts/rollup-rebuild.mjs check` 报 `alert`，
而 `GET /api/usage/rollup-health` 报 `ok`。**为什么要修**：一个在"夜间无流量"必然误报的检查，
会训练巡检员忽略告警——那比没有告警更糟。

## 1. 根因：两条路径各自实现了一遍判定，其中一份把 NULL 当成"非 0"

脚本里的本地规则写的是 `rollup === 0`（**严格相等**），而 SQL 的 `SUM(...)` 在**没有任何分组行**时返回
**NULL** ⇒ `NULL !== 0` ⇒ 走进"只有 rollup 有数"分支 ⇒ `driftPct = 100` ⇒ **alert**。
服务端那份（`compareMetric`）用的是 `Number(x) || 0`，所以同一状态报 `ok`。复现证据（同库同窗口）：

```
修复前：{"脚本 check": {"severity": "alert", "ratio": null, "events": null, "rollup": null, "driftPct": null}}
        接口路径： {"severity": "ok", "ratio": 1, "metrics": 五个全 ok, "driftingRows": 0}
```

## 2. 修法：**只留一份判定**（结构性对齐，而不是把两条规则都改对）

1. `server/usageRollup.ts` 的 `rollupDriftSql`：外层聚合**全部 COALESCE 成 0**
   （`SUM/MAX` 在空集上是 NULL），空窗口从此是真·0 而不是 null。
2. `scripts/rollup-rebuild.mjs` 的 `checkHealth`：删掉本地那套 severity 计算，
   **直接调用服务端的 `summarizeRollupHealthV2`** ⇒ 两条路径不可能再判得不一样。
   （教训：同一条判定写两遍，早晚会漂移——这次漂的就是 NULL 语义。）

**修复后 · 同库同窗口并列输出**（本机空库 `/tmp/empty-db/console.db`，24h 窗口）：

```json
{ "脚本 check":                        { "severity": "ok", "ratio": 1, "rollup": 0, "events": 0, "driftingRows": 0,
                                         "metrics": { "requests": "ok", "totalTokens": "ok", "cachedTokens": "ok",
                                                      "latencySumMs": "ok", "costUsdSum": "ok" } },
  "接口路径 (checkRollupHealthV2)":     { "severity": "ok", "ratio": 1, "rollup": 0, "events": 0, "driftingRows": 0,
                                         "metrics": { …五个 ok } },
  "同判": true }
```

脚本退出码 **0**；本机实例接口（只读，未重启）`{"severity":"ok","ratio":1,"rollup":2910,"events":2910}`；
生产只读（`ssh cpa-vps`，本轮同一会话内实测）24h `12,206 = 12,206`、168h `147,237 = 147,237`，
五维度全 ok、`driftingRows 0`（生产不是空窗口，所以三个「0」的用例在临时空库上验证）。

## 3. 三种「0」的判定（每条一个用例）

| 场景 | 含义 | 判定 | 证据 |
| --- | --- | --- | --- |
| ① events=0 且 rollup=0 | **真空窗口**（夜间无流量） | **ok**（ratio 记 1，driftPct 0，五维度全 ok，`driftingRows 0`） | 空库用例 + 脚本/接口并列输出 |
| ② events=0 但 rollup>0 | **真漂移**（多余数据/重复累加） | **alert**（`ratio: null`、`driftPct: 100`、`driftingRows > 0`） | 用例「三种 0 ②」 |
| ③ events>0 但 rollup=0 | **触发器漏跑**（events 由别的路径写入） | **alert**（`driftPct: 100`、`driftingRows > 0`） | 用例「三种 0 ③」 |

**负向验证**：用例里显式实现了一个"错误规则" `anyZeroIsOk = (rollup, events) => rollup === 0 || events === 0 ? 'ok' : 'alert'`，
并断言它会把 ② 和 ③ 判成 `ok`；同时断言正确实现（`compareMetric`）对 ②③ 都是 `alert`、只有 0/0 是 `ok`。
⇒ 若后人把规则改成"任何 0 都 ok"，这两条用例必红。

## 4. 空窗口语义对 `metrics[]` 与 `rowDrift` 的影响（顺手核对）

空窗口下：五个维度**全部 ok**（0/0）、`rowDrift.driftingRows = 0`、`rowDrift.severity = ok`、
顶层 `ratio = 1`（不是 null）、`driftPct = 0`。**只有 ② 那种"单边为 0"才会出现 `ratio: null` + `driftPct: 100`** ——
客户端只需处理这一种 null 情况（`events=0 且 rollup>0`），这一点已写进 `server/usageRollup.ts` 的注释与文档。

## 5. 验证

- 新增/更新测试：`server/usageRollupDriftV2.test.ts` 追加 5 条（三种 0 + 错误规则负向 + **脚本与接口同判**的端到端），
  该文件 **10/10 通过**；`server/usageRollupDrift.test.ts` 6/6 通过。
- `tsc -b` **0** · `lint` **0** · `npm test` **0**（`685 / 684 / 0 / 1 skipped`）。
- **未重启/未停服务**：服务端改动是 SQL 侧 `COALESCE` + 复用同一判定函数，对运行实例的行为是**幂等**的
  （接口此前就判 ok，实测也仍 ok）；脚本路径的修复立刻生效（脚本每次都由 node 重新加载）。
