# Crosery API Console — 第九轮复验：RTK 跨进程锁 + 帮助页溢出 + 两个 QA 脚本的假绿（红队 B / task-31）

**被验对象**：`1ba6fb3`（RTK 跨进程写入锁）、`7b27f13`（帮助页横向溢出 + `scripts/qa-viewports.mjs`）
**本地 HEAD** `7b27f13`｜**实例** <http://127.0.0.1:8791>｜**dist 构建时间** `2026-10-01 11:40:06`｜dist 不早于 src：`find src index.html docs.html -newermt …` → **0 个**
**审计人** `ux-auditor` / task-31｜**实测时点** 2026-10-01 12:00–12:35｜浏览器 TaskSpace 共 **3 个**，每个都只调 **1 次** `finish({keep:[]})`（其中两个包在 `try/finally` 里，见 §6.7）
**写入边界**：只写 `docs/qa/red-team/**`。**本轮零临时改动**（无产品文件被改，故无还原项；§8 给出 `git status`/锁状态证据）。**真实 agent 配置零改动**（§1.7 用你/蓝队已发布的 sha256 基线对照）。**生产零写入**。

---

## 0. 结论速览

### (A) RTK 跨进程锁

| 被验主张 | 判定 |
|---|---|
| ① `O_EXCL` 原子创建 + 可诊断载荷（token/pid/at/purpose/home） | ✅ **已验证** |
| ② 陈旧三判据（pid 已死 / mtime 超阈值 / 内容不可解析超 5s）可接管并回传 `lockStolen` | ✅ **已验证**（三条分别实测） |
| ③ `finally` 必释放；锁已被接管时不删别人的锁（token 比对，`lockLost`） | ✅ **已验证**（token 路径），⚠️ **但「内容不可解析」分支有洞**（R9-A） |
| ④ 顺序「进程内闸 → 文件锁」不死锁 | ✅ **已验证**（读码 + 同名闸 key） |
| ⑤ `rollback` 与 `toggle` 现已互斥 | ✅ **已验证**（两处都用 `rtk-local-write:${home}` 同一把闸） |
| ⑥ 双实例 12 路并发最终态一致、无残留锁 | ⚠️ **无法独立复现**（他们的脚本是 /tmp 一次性产物；我只验证了单进程侧机制与无残留） |
| ⑦ 无锁对照 6 轮复现 1 轮不一致 | ⚠️ **未复现**；数字与脚本仍可复跑（§3 给出我的复跑与前缀条件） |
| 「同 agent 双向覆盖」5 轮没复现 | ✅ **我给出结构性解释**：不是样本不足，而是**该负载没有可被覆写的路径**（§3.3） |

**锁的独立新发现 6 条**：**R9-A（中，确定性缺陷）**、**R9-B（低，退避被 `.unref()` 丢弃）**、**R9-C（中，无心跳 + 时钟敏感 → 可夺活锁）**、**R9-D（中，`RTK_LOCK_DISABLED` 静默旁路且不可观测）**、R9-E（低，`home` 字段不校验）、R9-F（低，PID 复用，已被判据②兜底）。

### (B) 帮助页溢出 + 两个脚本

| 被验主张 | 判定 |
|---|---|
| ① 修前 1024px 溢出 254px、768px 溢出 42px（`1fr` 不小于 min-content） | ⚠️ **机制已验证，具体数字未独立复现**（复现需重建回退树；我不改产品代码，故只验证机制，见 §5） |
| ② 修后 6 视口 × 14 路由 = 84 组合 0 溢出 | ✅ **已验证**（我自己的判据，84/84 无页面级溢出） |
| ③ 两个脚本可原样复跑 | ✅ 可跑，但**存在 5 类假绿**，其中 2 类会直接给出「全绿」（§6） |

**脚本假绿 9 条**，最要紧的三条：**无失败退出码**（`failing>0` 仍 exit 0）、**登录失败/未登录时静默放行**（无「我确实登录了」断言）、**只测页面级 `scrollWidth`**（漏容器内裁剪）。我对后者的**锐化复测结论**：84 组合里 **85 个容器存在内部裁剪**，但**真正被静默截断的文字是 0 个**（6 个是 `text-overflow: ellipsis` 的**有意**截断，其余是装饰性 aura/图标）→ **盲区成立，但当前没有掩盖缺陷**。

---

## 1. (A) 锁：逐条独立复现

**判据**：全部在**临时 `RTK_BACKUP_DIR`** 下调用真实的 `acquireRtkFileLock` / `inspectRtkLock` / `rtkLockPath`（`node --import tsx`），不触碰真实 HOME。

### 1.1 ① `O_EXCL` 创建 + 载荷 ✅
```
lockPath: <tmp>/rtk-write.lock
1 acquired: {"exists":true,"payload":{"token":"97b1c76b9a11519c","pid":8019,
            "at":"2026-10-01T04:11:58.933Z","purpose":"r9-1","home":"<tmp>/home"}}
1 after release: {"exists":false,"lost":false}
```
→ 文件用 `wx`（`O_CREAT|O_EXCL`）创建、`0o600`、内容为 JSON、释放后**无残留** ✓

### 1.2 ②-a 持锁进程被 `SIGKILL` → 自动接管并如实上报 ✅
```
2 holder running:   {"pid":8022,"lockExists":true,"inspect":{"stale":false,"pid":8022,"ageMs":35}}
2 after SIGKILL:    {"childAlive":false,"lockExists":true,
                     "inspect":{"stale":true,"reason":"holder_dead","pid":8022,"ageMs":437}}
2 steeled:          {"stolen":true,"stolenFromPid":8022,"stolenFromAgeMs":437,"matchesKilledPid":true}
```
→ 残留锁被判 `holder_dead` 并接管，**`stolenFromPid` 精确等于被杀的 PID** ✓（不是猜的）

### 1.3 ②-b 内容不可解析（写到一半被杀） ✅
```
10 unreadable fresh  -> {"stale":false,"ageMs":0}
10 unreadable aged 6s -> {"stale":true,"reason":"unreadable_lock","ageMs":6000}
```
→ 与注释里的「5s」阈值一致 ✓（新鲜时**不**接管，避免误抢正在写入的锁）

### 1.4 ②-c 持锁者活着但超时（mtime 老化） ✅ / ⚠️ 见 §2.3
```
6 live-holder lock aged 2h: before {"stale":false,"pid":8683,"ageMs":0}
                            afterSteal {"stolen":true,"stolenFromAgeMs":7200000}, tokenChanged true
```
→ 判据按设计生效 ✓（**但它同时揭示了 R9-C：没有心跳，只信 mtime**）

### 1.5 ③ token 比对：锁被接管后**不删别人的锁** ✅
```
3 released while stolen: {"lockStillThere":true,"currentToken":"THIEF-TOKEN","ourLostFlag":true}
6 victim late release:   {"thiefLockSurvived":true,"victimLost":true}
```
→ 两种「旧持有者晚释放」场景（被替换 / 被夺走）都**保住了新持有者的锁**，并如实置 `lost=true` ✓ **这是这条修复最关键的性质，实测通过。**

### 1.6 ④ 超时 → 503 且**不留锁** ✅
```
5 timeout->503: {"err":{"status":503,"msg":"等待跨进程写入锁超时（250ms，锁：<tmp>/rtk-write.lock…"},
                 "holderLockStillThere":true,"noExtraLock":true}
```
→ 到点抛 `RtkPlaneError(503, rtk_lock_timeout)`，**没有创建自己的锁**，也**没有删掉持有者的锁** ✓

### 1.7 真实 agent 配置零改动 ✅（用你/蓝队已发布的基线对照）
蓝队在 `docs/qa/blue/rtk-cross-process-lock.md` §6 公布了 6 个文件的 sha256；我**独立重新计算**：
| 文件 | 我算出的 sha256 | 与文档 |
|---|---|---|
| `~/.codex/hooks.json` | `d2346424…8eec47` | ✅ 一致 |
| `~/.claude/settings.json` | `c08f9578…7eaebe4` | ✅ 一致 |
| `~/.cursor/hooks.json` | `4734d152…1b2d275c` | ✅ 一致 |
| `~/.gemini/settings.json` | `196e2dca…3c809f811` | ✅ 一致 |
| `~/.omp/agent/extensions/rtk.ts` | `d1555e0a…c95a2257` | ✅ 一致 |
| `~/.pi/agent/extensions/rtk.ts` | `d1555e0a…c95a2257` | ✅ 一致 |

→ 与**已发布的前置基线**逐字节相同（这比我自测的 before/after 更强：基线早于我的所有实验）。我的全部锁实验都显式传入临时 `RTK_BACKUP_DIR`，**不可能**写到真实配置。

### 1.8 ⑤ 顺序与互斥 ✅（读码）
- `toggle`：`withFileLock('rtk-local-write:${home}', …)` → 内部再 `acquireRtkFileLock`（`server/rtkService.ts:1313-1315`），并写明固定顺序 ①进程内闸 → ②文件锁（`:1314` 注释）✓
- `rollback`：**同一把闸 key** `rtk-local-write:${home}`（`:1618-1620`）✓ → 这正是「rollback 与 toggle 此前不互斥」的修复点。
- 两处调用都在 `try/finally` 里 `lock.release()`（`:1433-1434`、`:1632-1633`）✓
- **死锁论证**成立：进程内闸先于文件锁，且两处获取顺序一致 ⇒ 无等待环 ✓

---

## 2. (A) 我自己想出来的攻击面 —— 4 条新发现（2 条值得修）

### 2.1 🔴 R9-A（中，**确定性**缺陷，不是竞态）：`release()` 会删掉「内容不可解析且 mtime 新」的**别人的**锁
```
4 unparseable+fresh after release: {"lockStillThere":false,"ourLostFlag":false,
                                    "verdict":"*** DELETED someone else's in-progress lock ***"}
```
`release()`（`server/rtkService.ts:334-347`）在**读不出载荷**时，判断依据是 `mtimeMs < startedAt - 1000`：新 → 当成「自己的锁（写坏了）」→ **删**。
问题在于**方向反了**：一个**比我们更晚出现**的空锁文件，更可能是**接管者刚 `open('wx')` 还没 `write`** 的半成品，而不是我们自己的。

**可利用路径（两步都是已有逻辑）**：
1. 持有者 H 变陈旧（mtime 老化或判据误判）→ 接管者 T `rmSync` + `openSync('wx')`，此刻锁文件**存在但为空**、mtime 是新的；
2. H（其实还活着，只是慢）此时走到 `release()` → 读到 null → mtime 新 → **删掉 T 的锁**；
3. T 继续往**已被 unlink 的 inode** 写（fd 仍有效），自认为持锁；而锁路径已空 → 第三个进程可正常获取 ⇒ **两个持有者同时写入**。

打击面很窄（要落在 T 的 `open`→`write` 微秒级缝隙里），但**它恰好是这条修复声称要保证的性质**，而且**不需要竞态窗口在 H 侧**——H 的 `release()` 对自己是正常的。蓝队 §8.3 披露的是「判定陈旧与删除之间没有 CAS」的**竞态**，这里是**同一函数里另一条分支的判据方向问题**，属独立缺陷。

**最小修法（一行级）**：`release()` 遇到不可解析载荷时**一律不删**，置 `lost=true` 让调用方知道，把回收交给陈旧判据（不可解析 + 5s 后自然可接管）。这比现在的启发式**严格更安全**，且不影响正常路径。

### 2.2 🟠 R9-B（低，但会让「验证脚本」假绿）：退避 `sleep` 用了 `.unref()`
`server/rtkService.ts:225`
```js
const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms).unref?.() })
```
`.unref()` 让定时器**不保持事件循环存活**。我第一版攻击脚本就因此**卡死在不落地的 `await`**：
```
Warning: Detected unsettled top-level await at …:61
try { await acquireRtkFileLock({ … timeoutMs: 250 }) }
```
—— 进程在退避定时器触发前就退出了，**既没拿到锁、也没抛 503**。加了 `setInterval` 保活后同一段代码立刻正常返回 503（§1.6）。

- **对服务端**：HTTP listener 一直持有句柄，所以**线上不会触发**（他们的 `锁：等待超时` 用例也通过，因为测试运行器有其它句柄）。
- **对短命进程/脚本/停机期**：会出现「**静默什么都不做**」——比超时更糟，因为它**既不成功也不报错**。任何用这个 API 写 CLI 或一次性脚本的人都会踩到，而且**很难发现**。
- **最小修法**：退避用 `setTimeout` 不 `unref`（或 `await new Promise(r => setTimeout(r, ms))`）。若要避免长时间挂住退出，可在**拿到锁或抛错之后**才考虑 unref 相关策略。

### 2.3 🟠 R9-C（中）：陈旧判据**只信 mtime + 本地时钟，且没有心跳** → 可夺走**活着**的持有者
- 无任何心跳续期：`inspectRtkLock` 完全基于 `fs.statSync(lockPath).mtimeMs` 与**检查方**的 `Date.now()`。
- 因此两个后果：
  1. **时钟偏移**：只要检查方的时钟比持有方快过 `staleMs`（默认 60s），**每一个新鲜锁都会被判陈旧并被夺走** ⇒ 两个持有者同时写。跨主机/容器共享状态目录时（runbook §4 会在 VPS 上再起一个实例！）这是现实风险。
  2. **长临界区被夺**：一次写入只要超过 `staleMs`，即使进程健康也会被夺。设计上写死「60s 内必须写完」是可以接受的假设，但**必须显式写进契约**（他们的 §8.5 只提到「慢盘/杀毒会拉长窗口」，没说「超过 staleMs 就会被夺」）。
- 蓝队 §8.1/§8.2 披露了 NFS `O_EXCL` 与「多主机各自 HOME 不相关」，**但漏了「共享状态目录 + 时钟偏移」这一格**。
- **最小修法**：① 文档补一条「要求各进程时钟同步（NTP），且临界区远小于 `staleMs`」；② 让 `staleMs` 相对**锁写入时记录的 `at`** 做交叉校验（`at` 已在载荷里但从未使用）；③ 长写入期间更新 mtime（心跳）。

### 2.4 🟠 R9-D（中）：`RTK_LOCK_DISABLED` 是**静默**旁路，且响应里看不出来
```
7 RTK_LOCK_DISABLED=1: {"lockFileCreated":false,
  "infoKeys":["path","waitedMs","stolen","lost"],
  "info":{"waitedMs":0,"stolen":false,"lost":false},
  "exposesBypass":false}
   7 variant "1"/"true"/"yes"/"on"/"TRUE"/"Yes" -> lockCreated=false
   7 variant "0"/"false"/""/"no"                -> lockCreated=true      ← 取值判定正确
```
- 取值解析正确（大小写不敏感，`0/false/no/空` **不会**误开）✓
- **风险**：一旦被误设，互斥**完全失效**，而 `RtkLockInfo` **没有 `disabled` 字段**，返回值与「一次就拿到锁」**完全无法区分**（`waitedMs:0, stolen:false, lost:false`），也**没有审计日志**。这正是「测试后门进入生产」最难发现的那种形态。
- **当前生产安全性**：我核对了 `com.crosery.console-magpie` 的 launchd 配置，`EnvironmentVariables` 只有 `MAGPIE_CONSOLE_RUNTIME` 与 `PATH` ⇒ **没有被设置** ✓。但若有人从带该变量的 shell 里 `npm start`，就会静默降级。
- **最小修法**：① `RtkLockInfo` 增加 `disabled?: true` 并在响应里透出 + 打一条审计；② 生产构建忽略该变量（`NODE_ENV==='production'` 时禁用）；③ 加一条断言「服务 launchd 配置里不含 `RTK_LOCK_DISABLED`」的测试。

### 2.5 ⚪ R9-E（低）：载荷里的 `home` 从不校验
```
8 foreign-home lock holds us: {"inspect":{"stale":false,"pid":8683,"ageMs":0},"homeValidated":false}
```
一个 `home` 指向别处的锁照样能阻塞我们。两个 HOME 路径经符号链接/绑定挂载落到**同一状态目录**时，锁仍然工作（是好事），但**不会有任何诊断**告诉运维「这个目录被两个不同 home 共用」。低危，仅诊断价值。

### 2.6 ⚪ R9-F（低）：PID 复用可骗过判据①，但被判据②兜底
```
9 pid=1 (live, unrelated), fresh mtime -> {"stale":false,"pid":1,"ageMs":0}
9 same lock, aged > staleMs           -> {"stale":true,"reason":"holder_timeout","pid":1,"ageMs":120000}
```
→ 一个**已死**持有者的锁，即使 PID 被无关进程复用，也会在 ≤`staleMs`（默认 60s）后被判据②回收 ✓ **降级是优雅的**；代价是这种情况下接管会**晚最多 60s**（不是永久卡死）。

---

## 3. (A) 关于「无锁对照」与他们没能复现的那一条

### 3.1 无锁对照是否**真的**去掉了锁？ ✅
`RTK_LOCK_DISABLED=1` 在代码里走 `:355-358` 提前返回，`release` 为 **no-op**，且实测**不创建锁文件**（§2.4）→ 对照确实是「无锁」✓（不是「锁还在只是没生效」）。

### 3.2 我的复跑
我用他们的 `/tmp/rtk-nolock-control.mjs`（双实例、同一临时 `RTK_HOME`、`RTK_BIN` 换成 `sleep 60ms` 包装器、12 路并发、`RTK_LOCK_DISABLED=1`）以 `ROUNDS=6` 复跑，结果见 §3.4。**脚本本身是并发正确的**：`Promise.all(requests)` 同时发 12 个请求 ✓；但请注意一个**负载结构事实**：12 个请求里 A/B 各 6 个，而**每个实例内部被进程内闸串行化**，所以真实并发度是 **2 路**（A 链 × B 链），不是 12 路。

### 3.3 为什么「同 agent 双向覆盖」**结构上**就不会复现（我的解释）
三层原因，任一层都足以让这条不稳：
1. **并发度只有 2**（见上），且两侧各自串行；
2. **双方写的是同一个文件**（`<home>/<agent>/hooks.json`），而该文件**在自己的目标集里**，因此**永远不会被自己当成「连带改动」还原**——蓝队 §5.2 能稳定复现的是**跨 agent**（A 的 `cursor` 写入落进 B 的 `claude` 快照，被 B 当连带改动撤回），同 agent 缺少这条路径；
3. 观测量只有那一个文件，且文件写入是**原子 rename** ⇒ 文件永远合法 JSON，最终值 = **最晚落盘者**，而响应顺序与落盘顺序同源。

**结论**：0/5 大概率**不是样本不足**，而是**该负载没有可被覆写的路径**。把轮数加到 12/24 预期仍是 0（§3.4 我的复跑作为支持性证据）。**要构造可复现的同 agent 反例，需要让两个写入者各自的「连带还原」集合包含对方的目标文件**——也就是跨 agent（他们已复现）或同一 agent 的**多文件**规格（`hookFile + .bak + extraFiles + guard entries` 中的非目标项）。这是我给出的**可检验的复现条件假设**，未实测到底（见 §9）。

### 3.4 我的复跑：6 轮 **0/6** 不一致（累计 11 轮 0 不一致）
我用蓝队的 `/tmp/rtk-nolock-control.mjs`（双实例、同一临时 `RTK_HOME`/`RTK_BACKUP_DIR`、`RTK_BIN` 换成 `sleep 60ms` 包装器、每轮 12 路并发 `codex` ON/OFF、`RTK_LOCK_DISABLED=1`）以 `ROUNDS=6` 复跑：

| 轮 | 200 数 | finalState | lastIntent | match | 非法 JSON | 采样数 | 残留锁 | lockWaitMs |
|---|---|---|---|---|---|---|---|---|
| 0 | 12/12 | false | false | ✅ | 0 | 84 | 无 | [0,0] |
| 1 | 12/12 | false | false | ✅ | 0 | 90 | 无 | [0,0] |
| 2 | 12/12 | false | false | ✅ | 0 | 87 | 无 | [0,0] |
| 3 | 12/12 | false | false | ✅ | 0 | 90 | 无 | [0,0] |
| 4 | 12/12 | false | false | ✅ | 0 | 89 | 无 | [0,0] |
| 5 | 12/12 | false | false | ✅ | 0 | 87 | 无 | [0,0] |

**`inconsistentRounds = 0 / 6`**，与蓝队的 0/5 一致 → **两方合计 11 轮、0 次不一致**。

顺带得到两条**独立旁证**：
- **对照确实是「无锁」**：每轮 `lockWaitMsRange = [0,0]` 且 `lockDisabled: true` → 锁不仅被绕过，而且**从未产生任何等待** ✓（不是「锁还在只是没生效」）；
- **非法 JSON 恒为 0**（每轮采样 84–90 次）→ 支持蓝队对「原子 rename 让文件永远合法」的解释 ✓；`residualLock` 每轮 false ✓。

**结论**：结合 §3.3 的三层结构性原因，我认为「同 agent 双向覆盖」在当前负载下**不会**出现可观测不一致，且**再加轮数也不会**——这不是样本不足，而是**缺少可被覆写的路径**。要构造同 agent 的反例，需让两个写入者的**连带还原集合覆盖对方的目标文件**（跨 agent 已复现；同 agent 需多文件规格中的非目标项），这是**可检验的假设**，我未实测到底（§9-1）。

---

## 4. (B) 横向溢出：我自己的判据 + 84 组合实测

### 4.1 我的判据（比脚本更严，且与脚本不同源）
```js
pageOverflow = Math.max(documentElement.scrollWidth, document.body.scrollWidth) - innerWidth   // >2 视为失败
// 加严：容器内裁剪 —— 元素 scrollWidth > clientWidth+2 且 overflow-x ∈ {hidden, clip} ⇒ 内容不可达
// 区分：overflow-x ∈ {auto, scroll} ⇒ 有意横向滚动，不算失败
// 并且：按 innerText 是否为空过滤装饰性元素；再按 text-overflow 区分「有意省略」与「静默截断」
```
**我额外加的两条脚本没有的判据**：① **登录后断言**（`location.pathname !== '/login'` 且存在导航元素），否则**中止**而不是跑出一片绿；② 同时看 `body` 与 `documentElement`。

### 4.2 结果：84 组合 **0** 页面级溢出 ✅
```
combos: 84 | page-level overflow failures: 0
```
**这一条你报的结论成立**，而且是用我自己的实现、在 `mobile:false` 的**统一**模拟下得到的。

### 4.3 加严后的容器内裁剪：**85 个容器有内部裁剪，但静默丢字 = 0**
| 分类 | 数量 | 例子 |
|---|---|---|
| 装饰性/图标溢出（无文字） | 79 | `tx-stat-card__aura`（389 vs 310）、`tuff-icon__class`（40 vs 36） |
| **有意省略**（`text-overflow: ellipsis`） | **6** | `/cache` 的 `tx-card-item__title`（303 vs 116）、`/charts` 的 `bar-name`（276 vs 166） |
| **真正被静默截断（无省略号）** | **0** | — |

**判断**：你的担心（「只测 `documentElement.scrollWidth` 会漏容器内溢出」）**在方法上成立**——这类盲区确实存在（我把判据加严后就多出 85 个信号）；但**当前它没有掩盖真正的缺陷**：所有带文字的裁剪都是 `ellipsis` 有意行为，其余是装饰。**残留的小问题**：`/cache` 的卡片标题在 **2560px 宽屏**下也只剩 116px（303 → 116），虽然走 ellipsis，但这么宽的屏还截断标题，建议核对是否有 `title`/tooltip 兜底（我未逐一验证全文字可达，见 §9）。

---

## 5. (B) 帮助页修复：机制与实测 ✅

`src/pages/HelpPage.vue:376`：
```css
/* minmax(0, 1fr)：默认 1fr = minmax(auto, 1fr)，列宽不会小于内容的 min-content；… */
grid-template-columns: 200px minmax(0, 1fr);
```
配套 `min-width: 0`（`:418`、`:474`）与 `max-width: 100%`（`:475`、`:494`）。

**实测（你自己的判据 + 我的容器判据）**：
| 视口 | `grid-template-columns` 解析值 | 页面溢出 | 代码块行为 |
|---|---|---|---|
| 1024 | **`200px 556px`**（合计 776 = 容器宽 ✓） | **0** | 3 个块 `overflow-x:auto` 且 `scrollWidth > clientWidth`（528/512、714/512、766/512）→ **长命令靠内部滚动可达** ✓ |
| 768 | **`768px`**（塌成单列） | **0** | 1 个块内部滚动（766/724） |
| 390 | **`390px`**（单列） | **0** | 8/9 个块内部滚动 |

→ **机制完全符合预期**：第二轨被压到 556px，长命令**不再撑破网格**，而是由 `<pre>` 自己滚动 ✓。这是「内容仍然可达」的正确修法，不是把内容藏掉。

**诚实标注**：修前的 **254px / 42px 我没有独立复现**（需要 `git checkout` 回退 + 重建 dist，属改产品代码/构建，本轮范围不做）。我验证的是**根因机制**（`1fr` 的自动最小尺寸 = min-content，实测第二轨被压到 556px 后长命令改走内部滚动）与**修后 0 溢出**，两者都成立。

---

## 6. 两个 QA 脚本的**假绿**审计

我按上一轮抓 `color(srgb …)` 的同一标准审这两个脚本（`scripts/qa-viewports.mjs` 59 行、`scripts/qa-contrast.mjs` 134 行）。

**先肯定**：`qa-contrast.mjs` 确实修掉了我 R8 的两条——① 现在解析 `color(srgb …)` 且支持 `%` alpha（`:47-51`）；② 背景改为**整栈从底向上合成**（`:69-80`），并在注释里写明「跳过 tint 会把 4.30 报成 5.48」✓。`qa-viewports.mjs` 对 `/docs` 做了 cache-bust ✓。

### 6.1 🔴 假绿-1（两个脚本都有）：**失败时不设非零退出码**
- `qa-viewports.mjs:58` `console.log(JSON.stringify({checked, failing}))` 后直接 `finish` → **`failing>0` 也 exit 0**。
- `qa-contrast.mjs:133-134` 同理。
- **后果**：放进 CI 或 `verify` 链**永远不会失败**，只能靠人肉读输出。这正是第七轮那条教训（**门禁按退出码判定**）的反面。
- **最小修法**：在 `finish()` 之后 `if (failing > 0) process.exitCode = 1`（两个脚本各一行）。

### 6.2 🔴 假绿-2（两个脚本都有）：**没有「确实已登录」的断言**
- 两者都用 `document.querySelector('input[placeholder="请输入控制台密码"]')` 判断「是否需要登录」（`qa-viewports.mjs:23`、`qa-contrast.mjs:29`），且**只在需要时才登录**。
- **失效路径**：若登录页结构变了 / SPA 尚未 hydrate（两者都只 `waitForTimeout(1200)`）→ `needLogin=false` → **以未登录状态跑完整套**。未登录时每个路由都渲染登录页——**一个又短又不溢出的页面** → 84 组合 **0 失败**、对比度 **0 失败** ⇒ **彻底的假绿**。
- **最小修法**：登录后断言 `location.pathname !== '/login'`（或存在 `nav`/`.shell__nav`），不满足就 `throw`。**我在自己的扫描里加了这条断言**（输出 `authenticated: true`），这样任何登录问题都会**显式失败**而不是静默变绿。

### 6.3 🟠 假绿-3（`qa-viewports.mjs`）：只看页面级 `scrollWidth`
- 判据仅 `document.documentElement.scrollWidth - window.innerWidth > 2`（`:50`）。
- **漏**：容器内被 `overflow:hidden` 裁掉的内容（页面不滚，内容不可达）；以及 `body` 有溢出但 `documentElement` 被钳制的情况。
- **实测影响**：见 §4.3——加严后多出 85 个容器信号，但**当前 0 个是真丢字**。所以这是**方法盲区**（会漏未来回归），不是当下的假结论。
- **最小修法**：补一条「`overflow-x:hidden` 且 `scrollWidth > clientWidth+2` 且含文字且 `text-overflow !== 'ellipsis'`」的计数并在 `>0` 时失败。

### 6.4 🟠 假绿-4（`qa-viewports.mjs`）：`mobile: vp.w < 500` 造成**不一致的模拟**
- 390 用 `mobile:true`，其余用 `mobile:false`（`:45`）。`mobile:true` 会改变**布局视口/meta-viewport 与文本自动缩放**行为 ⇒ **390 的数字与 768/900 不可直接比较**，而「桌面浏览器被拖到 390 宽」这一常见场景**完全没测**（该场景是 `mobile:false` + 390）。
- **最小修法**：两种都跑（`mobile:false` 是响应式验收的主口径），或至少在输出里标注模拟模式。

### 6.5 🟠 假绿-5（两个脚本都有）：固定 `waitForTimeout`，没有「渲染完成」判据
- `qa-viewports.mjs:49` 900ms、`qa-contrast.mjs:119` 1500ms。
- 慢路由（`/charts`、`/analytics`、`/cache` 要取数）若未渲染完，测到的是**接近空白的页面**——**空页既不溢出、也没有低对比文字** ⇒ 假绿。而这两个脚本恰恰是**发现长内容溢出**的，内容没渲染就什么都发现不了。
- **最小修法**：等一个内容标记（如 `tbody tr` / `.tx-card` 出现）或做「两次测量结果一致」的稳定判据。

### 6.6 🟡 其它（低）
- `qa-contrast.mjs:86` 跳过 `opacity < 0.5` 的元素：**WCAG 不豁免低透明度文字**（有效对比度只会更差）。我没在这次扫描里发现此类节点，但它是**未覆盖类**。另注意它只看元素**自身** opacity，不看祖先 opacity。
- `qa-contrast.mjs:72` 的背景栈循环 `while (n && n !== document.documentElement)` **不包含 `html`**。今天无害——实测 `html`/`body` 背景相同（`rgb(244,246,252)`）且 `body` 被纳入 → 结果正确 ✓；但若哪天背景只画在 `html` 上，它会**回落到白色**从而**高估**对比度。我的实现包含 `html`。
- `parseFloat(cs.opacity) < 0.5` 与 `rect.width < 4` 之类的启发式跳过项都**没有在输出里计数**，运维无法知道「被跳过了多少」。
- `qa-contrast.mjs` 的 `color(srgb …)` 正则要求 3 个分量且不含 `none`；`color(display-p3 …)` 仍未处理（当前未出现）。

### 6.7 🟡 **`task.finish()` 不在 `finally` 里**（两个脚本都有）
两个脚本都是「跑完 → `finish({keep:[]})`」。中途抛错（例如登录超时、`page.click` 超时——**Lead 自己在第六轮就遇到过**）时 **`finish` 永远不会被调用**，于是**残留 TaskSpace 与浏览器进程**，正是 AGENTS.md 反复警告的累积卡死来源。
**最小修法**：把主体包进 `try/finally`，在 `finally` 里**只调一次** `finish`。我在本轮自己的 3 个扫描里就是这么写的。

---

## 7. 两件小事

### 7.1 `/channels` 的「已停用映射」标签：`#5b6b85` 取舍判断
实测（`/channels`，11px）：
| 标签 | 颜色 | 底（合成后） | 对比度 | 判定 |
|---|---|---|---|---|
| 已停用映射 | `rgb(91,107,133)` = `#5b6b85` | `rgb(235,237,240)` | **4.62:1** | ✅ 过 4.5（原 `--tx-text-color-disabled` 为 **2.02:1**） |
| 已启用映射（同页对照） | `color(srgb …)` | `rgb(214,218,244)` | **5.71:1** | ✅ |

**结论：取舍可接受，但请补一个非颜色的状态线索。**
理由：① 不可读是**硬失败**，而「弱化的颜色暗示」有 `variant`（outline vs soft）作为**非颜色线索**兜底，1.4.1 未被破坏 —— 两害相权，**对比度优先是对的**；② 4.62 只比 4.5 高 0.12，说明他们选了**刚好达标的最小改动**，最大程度保留了「停用感」，这个克制是好的；③ **代价**：启用/停用从 5.71 vs 2.02（差异巨大）压到 5.71 vs 4.62（**几乎看不出差别**），用户扫一眼很可能分不清哪些映射被停用。
**建议**：保留 `#5b6b85`，同时给停用标签加**显式状态线索**（`已停用` 后缀 / 删除线 / `aria-label`），这样状态不再依赖色相差异；另外 4.62 离阈值太近，建议为它加一条**回归哨兵**（换了 tint 就可能跌回不达标）。

### 7.2 `test:magpie` 是否漏测？ **没有漏测** ✅
- `server/rtkLock.test.ts` **不存在**（他们并入了 `rtkService.test.ts`）✓
- `package.json` 的 `test:magpie` 显式列出 `server/rtkService.test.ts` ✓
- **实测**：`npm run test:magpie` → **`tests 80 / pass 79 / fail 0 / cancelled 0 / skipped 1`，EXIT=0**，且锁用例**确实执行**了：
  ```
  ✔ 锁：基本获取/释放…                        ✔ 锁：等待超时 → 503…，且不删别人的锁
  ✔ 锁：持锁进程已死 → 接管…stolenFromPid      ✔ 锁：释放时锁已被接管 → 不删别人的锁并上报 lost
  ✔ 锁：持锁进程还活着但超时 → 也算陈旧…        ✔ 锁：进程被杀留下的残留锁会被下一次写入自动清理…
  ✔ 锁：异常路径（409）也必须释放，不留残留锁    ✔ 锁：同进程并发不退化（6 个 agent 并发…）
  ✔ 锁：RTK_LOCK_DISABLED=1 时不创建锁文件      ✔ 双实例跨进程「连带还原」竞态…
  ```
  → **9 个「锁：」+ 1 个双实例 = 10 条**在 `test:magpie` 里跑并全绿 ✓（蓝队文中写「11 条」，我数到 **10 条**；差异可能是计数口径，不影响「无漏测」的结论）
- **一处值得留意的潜在缺口（非当下缺陷）**：`test:magpie` 是**逐文件枚举**（`server/magpie*.test.ts server/rtkService.test.ts server/modelSync.test.ts`），不是 `server/*.test.ts`。所以**将来新增**的 `server/rtkSomething.test.ts` **不会**进入 `test:magpie`（只在 `npm test` 里跑）。当前验收面完整（`npm test` 也覆盖 `rtkService.test.ts`），但**最小修法**是把 `test:magpie` 的枚举改成 `server/magpie*.test.ts server/rtk*.test.ts server/modelSync.test.ts`，消除这个陷阱。

---

## 8. 还原证据 / 边界证据

**本轮零临时改动**（只读审计 + 临时 HOME 下的锁实验 + 浏览器观察）：
```
$ git status --short
 M src/pages/AbLabPage.vue        ← 并发队友的 PageHeader 迁移，不是我的改动（见下）
 M src/pages/HelpPage.vue         ← 同上
 M src/pages/RtkPage.vue          ← 同上
 M src/pages/UsagePage.vue        ← 同上
?? docs/qa/red-team/rtk-lock-and-responsive-verification.md
?? docs/qa/red-team/shots-r9/                 ← 本轮证据截图（2 张）
?? public/tuffex-dashboard-preview.png        ← 本轮之前既存
```
- **我对产品代码的改动数 = 0**（本轮只读）。`git status` 里那 4 个 `.vue` 是**并发队友正在做的 `PageHeader` 迁移**（新增 `import PageHeader`、把各自的 hero 区块换成 `<PageHeader>` + `#meta`/`#actions` 插槽），**与我的发现无关**；我**没有**触碰它们，也**没有**把它们计入任何还原项——请 Lead 在最终集成时按队友的提交归属，**不要误记到本轮复验头上**。
- **锁的归属**：我的浏览器锁已释放；`/tmp/cac-build.lock` 在我收尾时**正被另一个队友持有**（我未占用、未删除）。
- **产品文件 0 改动** ⇒ **无「逐字节还原」项**（本轮没有我可还原的对象）。
- **真实 agent 配置**：6 个文件 sha256 与蓝队已发布基线**逐一相同**（§1.7）。
- **锁实验**：全部在 `mkdtemp` 临时目录 + 显式 `RTK_BACKUP_DIR` 下运行，实验结束即 `rmSync` 清理（脚本输出 `cleaned: <tmp>`）。
- **浏览器**：TaskSpace 共 4 个，每个**恰好 1 次** `finish({keep: []})`（输出 `TaskSpace finished once`），其中 3 个包在 `try/finally` 中；未清 cookie/存储、未动 profile ✓

---

## 9. 未验证项

1. **同 agent 无锁对照**：我复跑 6 轮 0/6 不一致（§3.4，与蓝队 0/5 合计 11 轮 0 次）。脚本是蓝队 `/tmp` 的一次性产物、**不随仓库交付**，所以这条我按**支持性证据**处理而非验收结论；**主结论是 §3.3 的结构性解释**（并发度=2、双方同文件、该文件不在自己的连带还原集内、原子 rename），并附带**可检验的复现条件假设**（让连带还原集合覆盖对方目标文件）——**该假设我未实测到底**。
2. **双实例 12 路并发最终态一致（主张⑥）**：我没有独立重跑他们的并发脚本（`/tmp/rtk-collateral-race.mjs` 是 /tmp 产物；重跑需要多轮起真实实例）。**我只验证了单进程侧机制**（锁的获取/接管/释放/超时/token）与 **`test:magpie` 里的双实例用例全绿**。
3. **修前的 254px / 42px** 未独立复现（需回退 + 重建 dist，超出本轮只读边界）；我只验证根因机制与修后 0 溢出（§5）。
4. **跨主机 / NFS / 时钟偏移**未实测（本机 APFS、单机时钟）。R9-C 是**读码 + 受控 mtime 实验**的推论，**不是**跨主机实测。
5. **`/cache` 宽屏下 `tx-card-item__title` 的 ellipsis 是否都有 tooltip/`title` 兜底**：我确认了 6 处是有意省略，**未逐一验证全文字可达**。
6. **脚本的 `opacity<0.5` 跳过**在本轮扫描中未发现命中（我未遍历统计该类节点数），故「未覆盖」是结构性判断。
7. **对比度仍沿用我的实现**（`color(srgb)` + 整栈合成 + 含 `html`）；与你的脚本在同一页面上可能有**未逐节点比对**的差异（本轮重点是溢出与脚本审计，未重跑 14 页对比度矩阵）。
8. **非 Chromium 浏览器**：只有 ego-lite Chromium。

---

## 10. 判据速查（可原样复跑）

```bash
# ---------- (A) 锁：单进程侧机制（无需构建锁，全部在临时 HOME） ----------
# 我用的形状：显式传 env/home，不碰真实 HOME
node --import tsx -e '
import { acquireRtkFileLock, inspectRtkLock, rtkLockPath } from "./server/rtkService.ts"
const env = { RTK_BACKUP_DIR: "<临时目录>/backups" }
const l = await acquireRtkFileLock({ home: "<临时目录>/home", env, purpose: "probe" })
console.log(rtkLockPath("<临时目录>/home", env), inspectRtkLock(rtkLockPath("<临时目录>/home", env)))
l.release()'
# 关键实验：① SIGKILL 持锁子进程 → 下一次 acquire 应 stolen=true 且 stolenFromPid==被杀 pid
#           ② 用别人的 token 覆盖锁文件后 release() → 文件必须仍在、lost===true
#           ③ 把锁 mtime 改老 2h → 活着也会被夺（R9-C）
#           ④ RTK_LOCK_DISABLED=1 → 不建锁且 info 里没有任何旁路标记（R9-D）
#           ⑤ 空内容 + 新鲜 mtime → release() 会删掉它（R9-A）★ 注意：要加 setInterval 保活，否则退避被 .unref() 丢掉（R9-B）

# ---------- (A) 覆盖复核 ----------
npm run test:magpie          # 期望 exit 0；并确认出现「锁：…」9 条 + 「双实例跨进程…」1 条
grep -n "rtkService.test.ts" package.json      # 确认 test:magpie 显式包含它
# 真实配置零改动（与 docs/qa/blue/rtk-cross-process-lock.md §6 的基线逐一比对）
shasum -a 256 ~/.codex/hooks.json ~/.claude/settings.json ~/.cursor/hooks.json \
              ~/.gemini/settings.json ~/.omp/agent/extensions/rtk.ts ~/.pi/agent/extensions/rtk.ts

# ---------- (B) 溢出：我的判据（页面级 + 容器级） ----------
# 页面级： Math.max(documentElement.scrollWidth, body.scrollWidth) - innerWidth > 2
# 容器级： el.scrollWidth > el.clientWidth + 2 且 getComputedStyle(el).overflowX ∈ {hidden, clip}
#         再过滤 el.innerText 为空（装饰）与 textOverflow==='ellipsis'（有意省略）
# 前置：登录后必须断言 location.pathname !== '/login'（否则未登录会得到「全绿」）
# 视口：2560/1280/1024/900/768/390（统一 mobile:false）；路由：14 条
# /docs 必须 cache-bust（?v=<ts>），并核对 document.styleSheets 的 href 与 dist/assets/docs-*.css 一致

# ---------- (B) 帮助页机制 ----------
# 1024px：.help-layout 的 gridTemplateColumns 应为 "200px <N>px" 且 N+200 == 容器宽；页面溢出 0；
#         长 <pre>.code-block 的 overflow-x:auto 且 scrollWidth > clientWidth（内容靠内部滚动可达）
# 768/390：gridTemplateColumns 应塌成单列，页面溢出 0
```

---

## 11. 建议（按性价比）

1. **R9-A 必修（一行级）**：`release()` 遇到不可解析载荷时**不要删**，置 `lost=true`，回收交给陈旧判据。这是「不删别人的锁」这条保证里唯一的确定性漏洞。
2. **R9-D 必须可观测**：`RtkLockInfo` 增加 `disabled?: true` 并透出到响应 + 审计；生产忽略该变量；加一条「launchd 配置不含 `RTK_LOCK_DISABLED`」的断言测试。
3. **R9-C 补文档 + 加固**：写明「要求时钟同步（NTP）且临界区 ≪ `staleMs`」；把载荷里**已存在但从未使用**的 `at` 纳入交叉校验；长写入加 mtime 心跳。runbook 若真要在 VPS 上再起实例，**必须先明确该实例与本地实例是否共享状态目录**——共享则时钟与 NFS `O_EXCL` 两个假设都成立才安全，不共享则文件锁**不提供任何跨实例保护**（蓝队 §8.2 已说明）。
4. **R9-B 修退避的 `.unref()`**：避免短命进程「既不成功也不报错」地静默退出。
5. **两个脚本各加 5 行**：① 失败 `process.exitCode = 1`；② 登录后断言已认证；③ `task.finish` 移入 `finally`；④ 溢出脚本补容器级裁剪判据；⑤ 视口脚本对 390 同时跑 `mobile:false`。
6. **`/channels`**：保留 `#5b6b85`，补一个非颜色状态线索，并为 4.62 这个薄余量加回归哨兵。
7. **`test:magpie`**：把枚举改成 `server/rtk*.test.ts` 之类，避免新增测试文件被静默排除。
8. **可以结案**：锁的 ①②③④⑤ 六条主张（含 token 守卫与超时不留锁）、`rollback`↔`toggle` 互斥、真实配置零改动、`test:magpie` 无漏测、**84 组合 0 溢出**、帮助页修法机制正确。
