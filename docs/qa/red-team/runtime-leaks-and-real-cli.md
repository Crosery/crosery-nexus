# 长时运行泄漏审计（⑨）与真实 RTK CLI 端到端（红队 A / 第二十八轮 / task-75）

审计者：rtk-auditor · 时点 2026-10-01T09:44–09:58Z（本地 17:44–17:58）
环境：临时实例（`mktemp` HOME/DATA_DIR + 端口 8890/8891/8892）；真实 CLI 实验在**一次性 HOME** `/tmp/cac-r28b-xxxx/home`
真实 6 个 agent 配置 sha256 自证（**全程未变**）：
`~/.codex/hooks.json d234642427dd4c2e` · `~/.claude/settings.json c08f957851d68845` · `~/.claude/RTK.md dc37dc6afdf51320` · `~/.claude/CLAUDE.md 5afc2f75a1f96a72` · `~/.cursor/hooks.json 4734d152efa28ffb` · `~/.gemini/settings.json 196e2dca8dacab1b`
生产零写入（仅只读探活）；未重启/未停任何服务。

---

## 0. 结论

**(A) 泄漏审计**：静态上**每个长期结构都有清理路径与上界**（唯一例外：**SSE 并发客户端数没有显式上限**，标"无界可疑"）；有界 soak 里 **FD 完全平直**（10 万+ 次 SSE 连断 + 40 万+ 次 API 调用后仍为常数），heap 呈正常 GC 锯齿、RSS 无增长趋势 ⇒ **未发现快泄漏**。**慢泄漏本轮无法证明**——已交付只读采样器供真实服务长期采样（这是唯一能证慢泄漏的方式）。

**(B) 真实 CLI 端到端**：**锁/fencing/备份语义在真 CLI 下依然成立**，但**第 27 轮的一条推断被推翻**：
- 真 CLI 单次 `rtk init -g --codex` **仅 7ms**（控制台每次 toggle 调 3 次 ≈21ms），而 stale 窗口**默认是 60 秒**（`rtkService.ts:308`，不是任务书里写的 3000ms）⇒ **不存在自己踩 holder_timeout 的风险**（实测连"每次调用前 sleep 4s / 总 12s"都能 200 完成，`stolen:false`）。
- 崩溃后**死锁被正确接管**（`stolen:true, stolenFromPid`）、**fencing 生效**（A 醒来提交被拒 `409 lock_lost_during_write / token_mismatch`，B 的结果未被覆盖）；默认参数下活着的持有者**不会被抢**（竞争者 503 fail-closed）。
- **推翻**：真 CLI 遇到半写的 `hooks.json` **不修复而是直接退出 1**（`rtk: Failed to parse … as JSON`）⇒ 第 27 轮"生产里重试即修好"**不成立**，该状态需要人工 rollback（已验证逐字节还原）。
- **但可达性极低**：真 CLI 的写是**原子替换**（每次 init/uninstall 都换 inode）⇒ 真 CLI 中途被杀**不会**留下半写文件。半写状态只能来自非原子写入者、IO 错误或人工编辑。
- 人工恢复路径已验证：`POST /api/rtk/rollback` + 损坏前的 backupId → 文件恢复为 356B 有效 JSON + marker=1 ✓

---

## 1. 任务 A-①：长期结构的有界性（静态审计）

| 结构 | 谁清理 | 什么条件下清理 | 上界 | 判定 |
| --- | --- | --- | --- | --- |
| SSE 客户端集合 `clients`（`liveStream.ts:152`） | `req.on('close')` → `client.remove()`；`catch` → `remove()`；`broadcast` 对写失败的客户端也摘除 | 连接关闭 / 写失败 | **无显式上限**（仅受 OS 句柄限制） | **无界可疑**（建议加并发上限，例如 16，超出即 503） |
| SSE 缓冲 `client.buffered`（`addBufferedClient`） | `activate()` 置 null；`remove()` 丢弃 | 历史查询返回（毫秒级） | 数组本身无上限，但窗口极短 | 低（可接受；若历史查询长时间挂起才会涨） |
| 静态压缩缓存（`compression.ts:54`） | 容量淘汰 | 超 128 项或 64MB | **`MAX_CACHE_ENTRIES=128` / `MAX_CACHE_BYTES=64MB`** | ✓ 有界 |
| `claudeQuotaCache.entries` / `inFlight` | `entries.delete` / `clear`；`inFlight` 在 finally 删除 | 请求完成 / 缓存失效 | ≈ 凭据数量（个位到几十） | ✓ 有界 |
| `revokedSessions`（`auth.ts:88`） | `pruneRevoked()`（按 token 到期时间删）+ 容量淘汰 | 每次访问 / 超容量 | **`REVOCATION_CAPACITY=10000`** | ✓ 有界 |
| `inflightBackups`（`rtkService.ts:842`） | `endRtkBackupUse()` 在 **finally** 中调用 | 备份使用结束（含异常路径） | ≈ 并发写请求数 | ✓ 有界 |
| 登录限流桶（`security.ts`） | `prune()` + 容量淘汰 | 每次访问 / 超容量 | **`MAX_KEYS=10000`** | ✓ 有界 |
| SQLite 读池（`sqliteReadWorker.ts`） | 构造时一次性创建 | 不随请求增长 | **固定 2 个 worker**（`REPORT_READ_WORKERS` 1–4） | ✓ 有界 |
| 定时器（14 个） | 进程生命周期 | — | 固定数量；关键 `setInterval` 全部 `.unref()` | ✓ 有界 |

---

## 2. 任务 A-②：有界 soak（**只覆盖快泄漏**）

方法：临时实例（端口 8890，`--inspect=9333`）+ 负载生成器 `evidence/r28/soak.mjs`：随机打 10 个只读 API + SSE `/api/cache-live` 连上读一小段再 abort（模拟标签页开关）；每 15s 采样一次 **FD（`lsof -p`）** 与 **堆（inspector CDP `process.memoryUsage()`）**。

**两轮合计：API 1,004,980 次 + SSE 连断 251,245 次**（均跑完，明细见 `evidence/r28/03-soak.md`）

| 指标 | 第 1 轮（8.3 分钟） | 第 2 轮（5 分钟） | 判定 |
| --- | --- | --- | --- |
| **FD** | 34–35 → 40，**静置后回到 30** | 39–40 → **静置后 30** | **零句柄泄漏**（25 万次 SSE 连断，回到加载前基线） |
| heapTotal | 87.6–90.1 MB 稳定 | 89.6–90.3 MB 稳定 | 无容量型增长 |
| heapUsed | 锯齿 23–54 MB；**低点基线 8 分钟内 ~23 → ~35 MB**，静置后 30.9 MB | 锯齿 26–52 MB | **单轮无法与"慢泄漏"区分**（见下） |
| RSS | 159 → 208 MB 平台 | 201 → 208 MB | V8 不还页给 OS，属正常；不看单点判泄漏 |

> **必须说清的边界**：以上只证明**分钟级可见的快泄漏不存在**。**慢泄漏（跑几天才涨）本轮无法证明**——那只能靠 A-③ 的采样器在真实服务上长期跑。**本轮没有、也不能给出"无慢泄漏"的结论。**

---

## 3. 任务 A-③：只读采样器（交付物）

`docs/qa/red-team/evidence/r28/read-only-sampler.mjs`（默认只读、不写被采样目录、不做任何变更）：

```bash
# 基本用法（默认 300s 一次）
node docs/qa/red-team/evidence/r28/read-only-sampler.mjs --port 8791 --label prod --interval 300 --out ~/leak-samples.jsonl
# 若服务是用 --inspect 启的，可以同时采堆（否则只采 FD + 可用性）
node … --port 8791 --inspect 9333 --interval 300
```

判读方法（写在脚本头部，同时给运维）：
1. **先看 FD 的长期斜率**（最可信的泄漏信号）：正常围绕加载后的水平线波动；单调上升 = 句柄泄漏。
2. **heap 要看"每轮采样窗口的低点"**（GC 后基线），不要看瞬时值；基线随天数单调上升才是泄漏。
3. 脚本记录 `pid` 与 `restart` 标记：遇到重启会标出来，便于剔除。
4. 与已知的 launchd 行为对照：`KeepAlive=1 + ThrottleInterval=10` ⇒ 若采样里看到 **pid 频繁变化 + 每次重启后 FD/heap 仍快速抬高**，就是"泄漏 → OOM → 每 10 秒崩一次"的形态。

---

## 4. 任务 B：真实 RTK CLI 端到端（**本轮核心**）

环境：一次性 HOME；`RTK_BIN=~/.local/bin/rtk`（**rtk 0.50.0**）；`spec.initFlags(codex)=['--codex']` ⇒ 控制台执行 `rtk init -g --codex`（关时加 `--uninstall`）。

### 4.1 正常 toggle（真 CLI）

| 观测 | 值 |
| --- | --- |
| HTTP / 总耗时 | 200 / **0.112s** |
| `hooks.json` | 199B → **575B**，`rtk hook codex` marker=1，**两个第三方钩子都保留** |
| `.bak` | **真 CLI 自己写的** `hooks.json.bak` = 199B（= 写入前原文） |
| extraFiles | `.codex/RTK.md`、`.codex/AGENTS.md` 被创建 |
| 控制台备份目录 | `manifest.json`（`.codex/hooks.json: true`、`.codex/hooks.json.bak: false`）+ `.codex__hooks.json` 逐字节副本 |

### 4.2 真实耗时 vs 锁 stale 窗口（回答任务 B-2）

```
$ HOME=<tmp> rtk init -g --codex            → 0.0077s（再跑 0.0070s，幂等：同 hash）
$ HOME=<tmp> rtk init -g --codex --uninstall → 0.0066s（marker 清零，第三方钩子保留）
控制台一次 toggle 调用 CLI 次数：3（wrapper 计数） ⇒ 约 21ms 的 CLI 时间
```
- **`RTK_LOCK_STALE_MS` 默认 = 60,000ms**（`server/rtkService.ts:308`；任务书里的"默认 3000ms"是第 27 轮我显式覆盖的值）
- CLI 单次 7ms ÷ 60s 窗口 ≈ **1/8000**；即使把每次调用人为拖到 4 秒（500×），toggle 仍 **200 / `stolen:false`**（心跳默认 `staleMs/3=20s` 会续期）
⇒ **真 CLI 不可能自己踩到 holder_timeout**。

### 4.3 崩溃（真 CLI）

| 阶段 | 崩溃瞬间残留 | 恢复（直接重发，不清理） |
| --- | --- | --- |
| **真 CLI 还没写**（wrapper pre-sleep 中 kill） | 目标未动（86B、marker=0）；锁残留（死 pid 7355、inode 332811698） | 200；死锁被接管（`stolen:true, stolenFromPid`） |
| **真 CLI 已写完、控制台未收尾**（kill） | marker=1、有效 JSON、`.bak` 86B | 200；`stolen:true, stolenFromPid:8635, stolenFromAgeMs:7876`；最终状态一致（有效 JSON + marker） |

### 4.4 **推翻**：真 CLI 不会修复半写文件

```
制造半写：hooks.json 截断到 40B（无效 JSON、marker=0）
重试：409 {"error":"codex 的 .codex/hooks.json 在操作后不是合法 JSON（invalid_json），已拒绝并回填操作前原文；可用 /api/rtk/rollback 恢复",
          "reason":"hook_file_unparsable"}     ← 文件仍 40B / 无效 / marker=0

隔离验证（直接跑二进制，不经控制台）：
$ HOME=<tmp> rtk init -g --codex
退出码=1
stderr: rtk: Failed to parse /tmp/cac-r28b-xxxx/home/.codex/hooks.json as JSON: EOF while parsing a list at line 4 column 5
→ 真 CLI 解析失败即退出，**不做任何修复**
```
⇒ 第 27 轮"生产里重试即修好"**不成立**；恢复必须人工（或用自动化挑 backupId）。

### 4.5 但可达性极低：真 CLI 的写是**原子的**

```
uninstall：inode 332859872 → 332860018（变了）
init     ：inode 332860018 → 332860022（变了）
```
temp+rename 替换 ⇒ **真 CLI 中途被 kill 不会留下半写文件**（旧文件一直完整）。半写状态只能来自：非原子写入者（如第 27 轮的假 CLI）、IO/磁盘错误、人工编辑。**这把 4.4 的缺口从"可能发生"降级为"几乎不可达，且有人工恢复路径"**。

### 4.6 人工恢复路径（已实测）

```
backupId = 2026-10-01T09-47-47-033Z-6b9e74（损坏前的备份）
POST /api/rtk/rollback {"backup":"…","confirm":true} → 200，restored 30 个文件
恢复后 hooks.json：356B、有效 JSON、marker=1 ✓
```

### 4.7 fencing（真 CLI 在环）

| 配置 | 行为 |
| --- | --- |
| B 用**默认** stale（60s） | **不抢**，`503 等待跨进程写入锁超时（15000ms…持有者 pid=9423）` ⇒ 活着的持有者不被抢、竞争者 fail-closed（安全属性 ✓） |
| B 显式 `RTK_LOCK_STALE_MS=3000` | A（SIGSTOP）的锁 4808ms 后被接管：B `200 {stolen:true, stolenFromPid:9423}`；**A 醒来 `409 lock_lost_during_write / lockLostReason:"token_mismatch"`**，B 的结果未被覆盖 ✓ |

**边界（诚实记录）**：被 spawn 的 CLI 是独立进程，锁/fencing 保护的是**控制台自己的提交与校验**，不覆盖 CLI 自身的写入（本例中 A 的 CLI 子进程在 A 醒来后仍写了一次；两侧都是幂等的 `rtk init` 结果，最终状态一致）。真 CLI 单次 7ms，该窗口极小；若未来 CLI 做非幂等写入，这层不覆盖。

---

## 5. 结论一句话（回答 lead 的问题）

**用真 CLI 时，我们的锁/fencing/备份语义依然成立**：真 CLI 只占 stale 窗口的 1/8000（7ms vs 60s）、崩溃后死锁被正确接管、fencing 实测拦住一次真实丢更新、备份逐字节可还原；**唯一被推翻的是"重试即修好"**——真 CLI 对半写文件直接退出 1 不修复，但真 CLI 自身是原子写，所以这个状态在实践中几乎不可达，且人工 rollback 路径已验证。

---

## 6. 未验证 / 边界

1. **慢泄漏**：本轮只覆盖分钟级快泄漏；"跑几天才涨"必须靠采样器长期观测，**未验证**。
2. **soak 的负载形态**：以只读 API + SSE 连断为主，未覆盖"长时间高并发写"（写路径有锁，串行化，泄漏面不同）。
3. **SSE 并发上限**：静态上"无界可疑"，但我没有做"故意开 N 千条 SSE 连接"的压测（存在把临时实例打死或影响本机的风险，且价值低于写报告）；建议按 §1 加一个上限。
4. **真 CLI 的原子性结论**基于 inode 变化（间接证据），未用 `fs_usage`/`dtrace` 直接观测 write+rename 序列。
5. **多 agent**：真 CLI 实验只覆盖 `codex`（其余 agent 的 `initFlags` 不同，行为未逐一验证）。

---

## 7. 证据索引

| 文件 | 内容 |
| --- | --- |
| `evidence/r28/soak.mjs` | 有界 soak（FD + 堆采样 + SSE churn + API 负载） |
| `evidence/r28/read-only-sampler.mjs` | **长期只读采样器**（含判读方法） |
| `evidence/r28/01-real-cli-e2e.txt` | 真 CLI 端到端全部观测（toggle/耗时/崩溃/半写/原子性/恢复） |
| `evidence/r28/02-real-cli-fencing.txt` | fencing 两种配置的实测输出 |
| `evidence/r28/03-soak.md` | soak 两轮的采样数字 |
