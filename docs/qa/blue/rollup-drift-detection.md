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
