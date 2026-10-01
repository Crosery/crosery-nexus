# 崩溃恢复演练：写入中途 kill -9 会留下什么、能不能自愈（红队 A / 第二十七轮 / task-71）

审计者：rtk-auditor · 时点 2026-10-01T09:32–09:45Z（本地 17:32–17:45）
环境：**只在 `/tmp/cac-r27-*` 的临时 HOME/DATA_DIR + 备用端口 8880/8881/8888 上做**；生产零写入、未重启/未停任何服务（真实 8791/8790 全程只做只读探活，`pid` 未变）
真实 6 个 agent 配置 sha256 自证（**全程未变**）：
`~/.codex/hooks.json d234642427dd4c2e` · `~/.claude/settings.json c08f957851d68845` · `~/.claude/RTK.md dc37dc6afdf51320` · `~/.claude/CLAUDE.md 5afc2f75a1f96a72` · `~/.cursor/hooks.json 4734d152efa28ffb` · `~/.gemini/settings.json 196e2dca8dacab1b`

---

## 0. 结论（一句话）

**中转站上控制台被 OOM/重启，数据不会坏、基本不需要人工介入**：SQLite 的事务性 + rollup 触发器与 INSERT 同事务保证了事件表与汇总表一致（崩溃实测 0 漂移），agent 配置的写入有"备份 + 跨进程锁 + fencing"，锁能被正确判 stale 并接管（三种 reason 全部实测）、旧持有者接管后无法提交（fencing 实测拦下一次真实的丢更新），崩溃循环 3 次不积累垃圾、约 **0.25 秒**即可重新服务（生产 launchd `KeepAlive=1` + `ThrottleInterval=10` ⇒ 约 **10 秒**恢复）。**唯一天然需要人工的情形**是"配置写了一半 + 重试的 CLI 没能重写该文件"：此时文件会停在半写状态，控制台**会检测到并拒绝**（409 `hook_file_unparsable`，提示可用 rollback 恢复），人工用**崩溃那次操作的 backupId** 能**逐字节**还原（已实测）。**没有任何一项需要"先修代码再发布"。**

---

## 1. 阶段演练：写入中途 kill -9（3 个阶段）

操作对象：`POST /api/rtk/toggle`（agent=codex，本地平面，会多步写：取锁 → 备份 → 跑 CLI → 校验 → 收尾）。用受控的假 RTK CLI 在指定阶段停住，然后在窗口内 `kill -9` 控制台进程。

| 阶段 | 崩溃瞬间 | 留下了什么 | 下次写入（不清理任何东西） |
| --- | --- | --- | --- |
| **S1 拿到锁、CLI 还没写** | `kill -9` 控制台（CLI 在 `sleep`） | 锁文件 134B `{"token":"c80808cc…","pid":51001,"at":"2026-10-01T09:33:59.932Z","purpose":"toggle codex on","home":"/tmp/cac-r27-…/home"}` **inode=332424642** mode 0600；备份目录 `2026-10-01T09-33-59-933Z-43aac3`（manifest + `.codex__hooks.json` 副本 + `.codex__hooks.json.bak` 副本）；**目标文件未动**（150B，hash 68a22a3866cf67bc 与崩溃前一致） | **200 OK**，`lock: {stolen: true, stolenFromPid: 51001, stolenFromAgeMs: 18877, waitedMs: 0}`；写入成功落盘；锁被释放（文件消失）；`.bak` 未被我方改动（cacb01d3cf01） |
| **S2 写完一半**（CLI 把目标截断成 40B 后停住） | `kill -9` | 锁文件（新 token，**inode=332424702**，pid 53505 已死）；备份目录 +1；**目标文件变成 40 字节、非法 JSON**（hash 78bf79d142d5dd9a） | **409** `{"error":"codex 的 .codex/hooks.json 在操作后不是合法 JSON（invalid_json），已拒绝并回填操作前原文；可用 /api/rtk/rollback 恢复","reason":"hook_file_unparsable"}`；旧锁被接管（stolen，来自死 pid）；**半写状态未被自动修好**（回填的是"本次操作前"的原文=那份半写文件）→ 见 §2 的还原验证 |
| **S3 写完、未收尾**（CLI 写入合法内容后停住） | `kill -9` | 锁文件（inode 变、pid 已死）+ 备份目录；**目标文件有效**（86B，hash e057ebb5b790cbe8） | **200 OK**，`stolen: true, stolenFromPid: 60593, stolenFromAgeMs: 10876, waitedMs: 1`；操作成功（幂等重做） |

**三个阶段的共同点**：留下的锁文件始终是完整 JSON（token/pid/at/purpose/home 齐全，mode 0600），备份目录完整（manifest + 文件逐字节副本），**没有留下临时文件、没有半截 manifest**；下一次写入**不需要任何人工清理**即可继续（`waitedMs` 0–1ms，无等待）。

---

## 2. 自愈判据（逐条）

### 2.1 stale 检测：三种 reason 全部实测到位

用同一把锁文件的构造集直接调 `inspectRtkLock()`（脚本 `evidence/r27/probe-lock-reasons.mts`，只读，不碰真实配置）：

```
dead.json          → {"stale":true,"reason":"holder_dead","pid":999999,"ageMs":60001}
alive-timeout.json → {"stale":true,"reason":"holder_timeout","pid":69693,"ageMs":60001}
garbage-old.json   → {"stale":true,"reason":"unreadable_lock","ageMs":60001}
garbage-fresh.json → {"stale":false,"ageMs":1001}                       ← 刚写一半的锁不抢（正确）
foreign-timeout.json → {"stale":false,"foreignHome":true,"note":"锁属于另一个 home…不基于超时接管"}  ← 共用备份目录时不误抢（正确）
```

端到端两条：
- `holder_dead`：S1/S3 崩溃后重发 → `stolen: true, stolenFromPid: 51001/60593`（死者 pid），立即接管。
- `holder_timeout`：见 2.3 的 fencing 演练（活着的持有者被 SIGSTOP → 锁龄 4799ms > stale 3000ms → 被接管）。
- `unreadable_lock`：手工放一个 16 字节垃圾锁文件（mtime 设到 2000 年）→ 重发直接接管成功（200）。

### 2.2 半写文件：**自动重试不修，人工 rollback 能逐字节还原**

- 崩溃后第一次重发：控制台**检测到**非法 JSON 并拒绝（409 + `hook_file_unparsable`）——**不会**静默继续写，也不会把坏文件当成合法输入。
- 但"回填操作前原文"回填的是**这次操作开始时**的原文，也就是那份半写文件 → **文件仍是 40 字节非法 JSON**。
- **用崩溃那次操作的 backupId 做 rollback**：`POST /api/rtk/rollback {"backup":"2026-10-01T09-34-29-424Z-da4d46","confirm":true}` → 目标文件恢复为 **hash 255356853a71dd82 / 90 字节 / 合法 JSON**，与崩溃前**逐字节一致** ✓（备份目录里确实有 `.codex__hooks.json` 副本；第一版我用 `ls` 没看到隐藏文件，复核后确认副本存在）。
- 口径说明：真实 RTK CLI 会重写钩子文件，所以生产里"重试即修好"；我用的是受控假 CLI（故意不重写），因此**这一条要读成"控制台侧不会自动修，但提供了可逐字节还原的备份 + 明确指引"**。
- **是否需要人工**：这一种情形**需要人工选 backupId**（错误文案里已直接给出 `可用 /api/rtk/rollback 恢复`）。级别：**低**（有指引、有备份、逐字节可还原）；若同时 CLI 也失败且无人值守，最坏结果是该 agent 的钩子配置停在半写状态、RTK 对它是"未启用"，**不影响控制台与其他 agent**。

### 2.3 fencing：**实测拦住一次真实丢更新**

构造：A 实例（8880）持锁跑慢 CLI → 对 A `SIGSTOP`（进程活着但心跳停）→ 4.5s 后锁龄超过 `RTK_LOCK_STALE_MS=3000` → B 实例（8881，同一 HOME/备份根）发起同一操作。

```
A 持锁: {"token":"f19a539333c430d2","pid":60593,…}
B 的结果: 200 {"ok":true,"lock":{"stolen":true,"stolenFromPid":60593,"stolenFromAgeMs":4799,"waitedMs":0}}
B 写后: hash=f192464267b0615d 357 字节
A 醒来（SIGCONT）后: 409 {"error":"写入锁在操作期间被接管（token_mismatch）：已放弃本次提交…（可用 /api/rtk/rollback 恢复…）",
                          "reason":"lock_lost_during_write","lockLost":true,"lockLostReason":"token_mismatch"}
最终文件: hash=f192464267b0615d 357 字节（= B 写的内容，A 没有覆盖）
```

→ **fencing 生效**：旧持有者（token `f19a5393…`）在新持有者接管后**不能提交**，返回结构化 409 且**没有发生丢更新**；`lockLostReason: token_mismatch` 可直接被客户端/排障读取。

### 2.4 需要人工介入的清单

| 情形 | 需要人工？ | 级别 |
| --- | --- | --- |
| 进程被杀（任意阶段），锁残留 | **不需要**（自动判 stale 并接管） | — |
| 事件写入中途崩溃（rollup/events） | **不需要**（见 §3，0 漂移） | — |
| 配置写到一半，且重试成功 | **不需要**（重试即修好） | — |
| 配置写到一半，且重试的 CLI 没能重写该文件 | **需要**：用崩溃那次操作的 backupId 做 rollback（错误文案已给出指引） | **低** |
| 连续崩溃 | **不需要**（§4：零垃圾、秒级恢复） | — |

---

## 3. kill -9 与 rollup 一致性

**代码依据（触发器与 INSERT 是否同一事务）**：`server/usageRollup.ts:40-41` 建的是 `CREATE TRIGGER IF NOT EXISTS trg_usage_hourly_rollup_insert AFTER INSERT ON usage_events`（另有 `…_update_key` :98、`…_update_cost` :188，分别处理 key 变更与成本回填）。SQLite 的 `AFTER INSERT` 触发器**在触发它的那条语句所属事务内执行**——所以"事件行提交"与"rollup 累加"要么一起可见、要么一起不可见；进程在语句之间被 `kill -9` 不可能造成两者不一致。反过来，schema 里**没有 `AFTER DELETE` 触发器**，所以 rollup 只增不减：任何"重复写入/删事件"的路径会让 rollup 偏大——这正是自检要抓的（events 侧 `request_id UNIQUE` + `INSERT OR IGNORE` 是可信参照）。

**实测（临时库，注入 600 行基线数据后）**：

| 场景 | 崩溃方式 | 崩溃后一致性（`scripts/rollup-rebuild.mjs check --db <副本> --hours 24`） |
| --- | --- | --- |
| A 自动提交循环 | 写到约 1000/6000 行时 `kill -9` 写入进程 | `requests 1610/1610`、`totalTokens 1,610,000/1,610,000`、`cost 16.1/16.1`、**`rowDrift.driftingRows = 0`、severity ok** |
| B 显式事务（300 行未提交） | 提交前 `kill -9` | 未提交的 300 行**整体消失**（原子回滚），基线 600 行完好：`600/600`，五维度 0 漂移，`rowDrift 0` |

自检命令现在覆盖**五维度**（请求数/token/缓存 token/延迟合计/金额）+ **逐行漂移**（`rowDrift.driftingRows / sumAbsRequests / maxAbsTokens / sumAbsCost`），崩溃后两侧都是 0。

**结论**：**崩溃不会让 rollup 与 events 不一致**，无需人工重建；重建脚本只在"历史上被重复写入过"这类场景才需要（并在副本上验证过幂等）。

---

## 4. 崩溃循环（启动 → 杀 → 启动 ×3）

| 指标 | 第 1 次 | 第 2 次 | 第 3 次 | 结论 |
| --- | --- | --- | --- | --- |
| 锁文件残留 | 0 | 0 | 0 | 不积累 |
| 备份目录数 | 10 | 10 | 10 | **封顶**（`RTK_BACKUP_KEEP` 默认 10 + 120s grace），不无限增长 |
| 临时文件（`*.tmp`/`.rtk-*`） | 0 | 0 | 0 | 不积累 |
| 半写残留（`*.part`） | 0 | 0 | 0 | 不积累 |
| `.bak` | 1（我的种子文件，未变） | 1 | 1 | 不积累 |

**恢复时间**（在全新 DATA_DIR 的干净实例上测，避免沙箱内"上一实例仍在启动"的干扰）：
- 冷启动 → `GET /api/session` 返回 200：**0.25 秒**（另一次热态 0.15 秒）；
- 因此应用自身的"kill → 可用"≈**0.3 秒**；
- **生产**（只读 `plutil -p` 取证）：`KeepAlive = 1`、`RunAtLoad = 1`、`ThrottleInterval = 10` ⇒ OOM/崩溃后 launchd 自动重启，**实际恢复 ≈ 10 秒**（节流）+ 启动时间，**不需要人工**。

---

## 5. 附带发现（与崩溃恢复相关）

| # | 现象 | 级别 | 说明与修法 |
| --- | --- | --- | --- |
| N1 | **空窗口下 `rollup-rebuild.mjs check` 报 `alert`，同一状态的 HTTP 接口报 `ok`**（实测：`rollup:null, events:null, severity:"alert"` vs `/api/usage/rollup-health` 的 `0/0, ratio 1, ok`） | **低**（值班误报，不是数据问题） | 夜间无流量/新装机器都会触发"alert"→ 若接告警会误报。修法：CLI 的查询用 `COALESCE(SUM(...),0)`，并把 `rollup=0 && events=0` 判为 ok（与 HTTP 口径一致） |
| N2 | 两个控制台实例共用同一 `DATA_DIR` 同时启动 → 启动期 `SQLite: database is locked (errcode 261)` | 信息级 | 单实例设计；重启时要先确认旧进程已退出（我在演练里踩到一次）。建议写进运行手册 |
| N3 | 逐行金额漂移用浮点直接相减，观测到 `sumAbsCost = 8.3e-14` 噪声 | 信息级 | 不影响 severity；建议加 epsilon 或改用整数分单位比较 |
| N4 | 备份目录里的文件副本以 `.` 开头（`.codex__hooks.json`），普通 `ls` 看不见 | 信息级 | 运维排障时用 `ls -a`；建议文档里点明（我自己第一版就看漏了，复核后确认副本存在） |

---

## 6. 发布判断

**可以发布。** 崩溃（OOM/重启/`kill -9`）不会破坏数据：agent 配置写入有"备份 + 跨进程锁 + fencing"三重保护，锁的三种陈旧态都能自动接管且实测拦下一次丢更新；事件与 rollup 因"触发器同事务"在崩溃后零漂移；崩溃循环零垃圾、约 10 秒自动恢复（launchd KeepAlive）。**唯一的人工步骤**是"配置写到一半且重试未修好"时用错误提示里给出的 rollback + backupId 手动还原（低级别、有指引、可逐字节还原），**不构成发布阻塞**；建议顺手修 N1（一行 `COALESCE`）以免值班被空窗口告警打扰。

---

## 7. 未验证 / 边界

1. **真实 RTK CLI 参与**：我用受控假 CLI 精确控制阶段；真实 CLI 会重写钩子文件，因此"重试即修好"这一路径在生产更乐观——但**我没有在真实 CLI 上复现崩溃窗口**（需要真实 agent 配置，超出本轮约束）。
2. **`kill -9` 命中时刻的精确性**：阶段 S1/S2/S3 用 CLI 的显式停住点保证窗口，未做"随机时刻连打 N 次"的统计式演练。
3. **生产实测**：全程未在生产写入/重启，恢复时间由*临时实例实测*＋*launchd 配置取证*推导，不是生产停机实测（后者按约束不做）。
4. **fencing 的 TOCTOU 窗口**：代码注释已声明"校验与写入之间存在 ≤1 个系统调用的窗口，无原生 CAS 无法消除"；本轮没有尝试命中该窗口（需要精确的调度注入），沿用代码声明。
5. **多机/跨主机场景**：锁依赖本机时钟与 mtime，契约明确"不支持跨主机/时钟偏移"；未验证。

---

## 8. 证据索引

| 文件 | 内容 |
| --- | --- |
| `evidence/r27/probe-lock-reasons.mts` | 三种 stale reason 的直接取证脚本（含 fresh/foreign 反例） |
| `evidence/r27/crash-writer.mjs` | 崩溃与 rollup 演练的写入器（auto/txn 两种模式） |
| 本文 §1–§4 | 阶段现场（锁内容/inode/备份/目标 hash）、fencing 409、崩溃循环计数与恢复时间 |

### 本轮对生产发出的请求（全部只读）

`GET /`（8791 探活）、`GET /health`（8790 探活）、`plutil -p` 读 plist。**没有**向生产写任何数据、**没有**重启或停止任何服务（服务 `pid` 与 `state=running` 全程未变）。临时实例已在收尾时全部 kill，临时目录 `/tmp/cac-r27-*` 已删除。
