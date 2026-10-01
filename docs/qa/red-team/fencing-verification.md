# Crosery API Console — 第十二轮复验：提交点 fencing（R11-C）+ R11-A（红队 B / task-41）

**被验对象**：`bab62f4`（提交点 fencing）
**取证时 HEAD** `bab62f4`｜**审计人** `ux-auditor` / task-41｜**实测时点** 2026-10-01 13:35–14:10
**写入边界**：只写 `docs/qa/red-team/**`。**仓库文件 0 改动**（全部实验在 `/tmp` + `mkdtemp` 临时 HOME）；**真实 agent 配置零改动**（§6 逐一贴 sha256 与已发布基线一致）；生产零写入。

---

## 0. 结论速览

| # | 主张 | 判定 |
|---|---|---|
| ① | 锁对象加 `isOwned()`/`assertOwned()`（token + inode，**不依赖心跳**），被接管抛 409 `lock_lost_during_write` | ✅ **已验证**（`rtkService.ts:542-554`；e2e 实测 409 `lock_lost_during_write`、退出码 4） |
| ② | **5 个落盘点**都接了 fence | ⚠️ **代码全部接上（5/5）**；**e2e 覆盖 1 个主提交点 + rollback  happy path**，其余 3 个为代码级验证（详见 §3 覆盖表，**我不把代码级说成 e2e**） |
| ③ | 跨进程时序：修后 H 报 409、接管者内容不被覆盖 | ✅ **独立重放成功**，并且我做了**带对照的强版本**：同一时序、只改一个环境变量，**fence 开 → 接管者文件字节不变**；**fence 关（= 修前语义）→ H 报 `ok:true` 且覆盖接管者**（§2） |
| ④ | 边界声明诚实（CLI 写入无法 fence）+ `TODO` 触发条件可执行 | ✅ **判定诚实**：文档明确写「CLI 已落盘的改动可能仍在、需用户用 rollback/重试收敛」，**不会被读成「接管后不会重复写」**；TODO 的触发条件是**可执行的具体条件**（§4） |
| ⑤ | R11-A：`rtkLockHeartbeatMs` 改为 `max(10, min(max(200, floor(staleMs/3)), staleMs))` | ✅ **已验证**（12 个取值全过：5→10、10→10、50→50、100→100、150→150、199→199、200→200、201→200、300→200、600→200、1000→333、60000→20000，**`interval ≤ max(staleMs,10)` 恒成立**） |

**新增发现 3 条（无高危）**：
- **🟡 R12-A（低-中，边界诚实性）**：Fence 是「**校验 → 写入**」，两者之间仍有 **≤1 个系统调用**的窗口（`assertOwned()` 在 `:1682`、写入在 `:1684`），**没有第二次校验**。因此「**本控制台自己的所有写入都不会落在接管之后**」这句**字面上过强**（与上一轮 `rename` 窗口同类）。实际不可达性见 §3.3。
- **🟡 R12-B（低）**：409 错误的载荷里 **`reason: "lock_lost_during_write"` 但没有 `lockLost: true`**（实测 `lockLost: null`）；HTTP 层是否补上 `lockLost` 取决于 `rtkFailure`，我未逐层核对 ⇒ 客户端若只读 `lockLost` 可能读不到。
- **🟡 R12-C（低）**：**`RTK_LOCK_DISABLED=1` 时 `isOwned()` 恒为 `true`**（`:554`）⇒ 旁路一旦被误设，**fence 也一起失效**（这正是我构造对照实验用的开关）。建议在旁路告警里**明确写上「fence 同时失效」**。

---

## 1. Fence 的实现（读码，给行号）

- `isOwned = () => (disabled ? true : ownsLock() === 'yes')`（`server/rtkService.ts:554`）——与心跳**共用同一份 token+inode 校验**（`ownsLock()`），因此**不依赖心跳是否跑过** ✓
- `assertOwned()`（`:545-553`）→ 不持有则抛 `new RtkPlaneError(409, 'local', 'lock_lost_during_write', …)`
- 5 个落盘点的接线（**逐个**）：
  | # | 落盘点 | 接线位置 | 形态 |
  |---|---|---|---|
  | 1 | `applyHookJson`（JSON 兜底提交） | `:1682` | `lock.assertOwned()` 紧接 `applyHookJson(...)`（`:1684`） |
  | 2 | `restoreTargets`（失败回填） | `:1629-1632` | `if (!lock.isOwned()) return`（**宁可留着让用户重试**） |
  | 3 | `reconcileCollateral`（连带还原） | `:1638` | 传入 `{ fence: () => lock.assertOwned() }`；`reconcileCollateral` 在 `:1391-1393` 调用它 |
  | 4 | `preserveUserBaks`（用户 `.bak` 还原） | `:1615-1618` | `if (!lock.isOwned()) return []` |
  | 5 | `rollbackRTK`（rollback 提交点） | `:1920` | `lock.assertOwned()` |
- 另外 `success()` 在**做连带还原与 .bak 还原之前**还有一次 `lock.assertOwned()`（`:1669`）⇒ 「报成功」之前必经校验 ✓

---

## 2. 我独立构造的跨进程时序（**带对照**）

### 2.1 方法
自建两进程 harness（**不复用他们的测试**）：临时 HOME + 临时 `RTK_BACKUP_DIR` + 一个 **no-op 慢 CLI**（`touch 标记; sleep 2.5; exit 0`，模拟「CLI 什么也没做」，使唯一写入落在**兜底提交点**）：

1. **H**（子进程 A，真实 `setRTKAgentHook`）持锁进入 CLI；
2. 父进程等标记文件 → **`SIGSTOP` H**（心跳一并冻住，H 无从察觉）；
3. 等锁过期（`RTK_LOCK_STALE_MS=1000`，停 1400ms）→ **T = 另一个真实进程**（子进程 B，真实 `setRTKAgentHook`）**合法接管**并写入自己的状态；
4. **`SIGCONT` H** → H 的 CLI 返回 → 走兜底提交；
5. 读**钩子文件**判定「谁的内容活下来」。

**判别设计**（这一步我迭代了三次，把两次失败的设计也记下来，避免读者误读）：
- 最初两项设计**无法判别**：① 用「初始 = 空 PreToolUse」时 T 的 disable 是 **no-op**；② 用「初始 = 带 `--ORIG-SNAP` 标记的 rtk ON、H 想 OFF、T 想 ON」时，T 的 `verifyLocalHook(on=true)` **本来就为真** ⇒ T 以 `mechanism:"rtk-cli"` **成功但一个字节都没写**（`afterTaker` = 初始内容）。
- **最终判别设计**：**初始 = rtk ON；H 想 OFF；T 想 ON** ⇒ `final.hasRtk === true` 说明**T 的内容活下来**；`false` 说明 **H 覆盖了 T**。

### 2.2 结果（同一 harness，**只差一个环境变量**）
| | **A) fence 开** | **B) fence 关**（`RTK_LOCK_DISABLED=1`，**等价于修前语义**） |
|---|---|---|
| T（真实第二进程） | `code 0`，`afterTaker {hasRtk:true, len:102}` | `code 0`，`afterTaker {hasRtk:true, len:102}` |
| **H（被夺锁者）** | **`code 4`，`status 409`，`reason "lock_lost_during_write"`**，消息「写入锁在操作期间被接管（token_mismatch）：已放弃本次提交，改动可能未生效，请重试（可用 /api/rtk/rollback 恢复）」 | **`code 0`，`ok:true`，`mechanism:"hooks-json"`** ← **报告成功** |
| **最终文件** | **`{hasRtk:true, rtkCount:1, len:102}` = 与 T 写入后完全一致**（含长度）⇒ **T 的内容完整保留** | **`{hasRtk:false, rtkCount:0, len:42}`** ⇒ **H 覆盖了 T，且 H 报成功** |
| 结论 | ✅ **fence 起到「事前阻止」作用** | ✅ 复现了 R11-C 的危害（对照有效） |

**→ 我据此判定：fence 确实把 R11-C 从「事后标记」变成了「事前阻止」**，而且这次是**端到端、双向**的证据（不只是读码，也不只是蓝队自己的测试）。
**顺带**：`RTK_LOCK_DISABLED=1` 让「修前语义」可以在**不改一行代码**的前提下复现 —— 这是我这轮最省事也最可信的对照手法（但注意它同时关掉了 fence，见 R12-C）。

### 2.3 我另外验证的「快照回填不会盖掉接管者」（落盘点 2/3）
再做一组：**初始 = 带 `--ORIG-SNAP` 标记的 rtk ON（= H 的快照）**，H 想 ON、T 想 OFF。
```
taker : code 4 / 502 hook_write_unverified   ← T 没能改写文件（no-op CLI 达不到 OFF）
holder: code 4 / 409 lock_lost_during_write  ← H 被 fence 拦住
FINAL : {marker:true, len:114} == afterTaker == initial   ← H 在被夺锁后没有改动文件
```
**判定**：H 的 409 路径**确实走到了** `restoreTargets()`（该调用在兜底提交的 `catch` 里），而文件**没有被回填成快照** ⇒ **与 `restoreTargets` 的 fence 行为一致** ✓
**但我要如实说明限度**：这组里 **T 没能改写文件**（T 自己 502 失败），所以「fence 生效」与「回填本来就没东西可回填」**无法完全区分** ⇒ 我把落盘点 2/3/4 记为**代码级验证 + 部分 e2e 旁证**，**不写成完整 e2e**（§3 覆盖表已标注）。要做出完整判别需要「T 成功改写 + H 进入回填」的夹具（例如让 T 用真实 rtk 或让 T 走一条必然改文件的路径），**我未做到**。

---

## 3. 绕过 fence 的尝试 / 5 个落盘点覆盖表

### 3.1 `isOwned()` 在 **inode 复用**下会误判吗？——**不会**
`ownsLock()` = 先 `statSync().ino`（比不上一律 `stolen`）**再比 token**。inode 复用最多让第一道相等，**第二道 token 必然不等** ⇒ 仍判 `stolen`。反向（`ino === undefined`，`statSync` 失败）时**跳过多校验、只比 token**，同样安全。**结论：token 是绑定判据，inode 只是「文件被重建」的快速信号**（与上一轮 `heartbeat` 的结论一致）。

### 3.2 409 之后还有没有别的路径能写？——**代码上没有了**
409 从 `assertOwned()` 抛出后：catch 调 `restoreTargets()`（**自身 fenced，早退**）→ 抛错给调用方。而 `preserveUserBaks` / `reconcileCollateral` 只在 `success()` 里、**在 `:1669` 那次 `assertOwned()` 之后**才被调用 ⇒ 失去锁时**不可能**执行。我的 §2.3 实测也支持「被夺锁后文件零改动」（`final === afterTaker`）。

### 3.3 🟡 R12-A：「校验 → 写入」之间的窗口**存在但不可达**
`assertOwned()`（`:1682`）与真正的写入 `applyHookJson(...)`（`:1684`）之间**没有第二次校验**。要打进去需要：H 的校验通过（锁仍是 H 的）**之后**、写入**之前**，T 完成「判定 H 陈旧 → unlink → 新建 → 写入」——而此刻 H 的锁是新鲜的（H 刚恢复、心跳可能刚续期），T 必须先把它判为陈旧，这个判定本身要花毫秒级、且 H 的写入只隔一个系统调用。
**我没有再花轮次做随机时序压测**（上一轮对同构的 `rename` 窗口做了 300 次、0 命中），因此**标注为「结构上存在、未实测命中」**。**建议把文档措辞从「所有写入都不会落在接管之后」收敛为「每个写入前校验一次；校验与写入之间存在 ≤1 个系统调用的窗口，无原生 CAS 无法消除」**——这才是可辩护的强度。

### 3.4 落盘点覆盖表（**代码级 = 接线已核对；e2e = 我实跑过**）
| # | 落盘点 | 接线 | 我的覆盖 | 说明 |
|---|---|---|---|---|
| 1 | `applyHookJson`（兜底提交） | ✅ `:1682` | ✅ **e2e（含对照）** | §2.2：fence 开→拒绝且文件不动；fence 关→提交并覆盖 |
| 2 | `restoreTargets`（失败回填） | ✅ `:1631` | ⚠️ **代码级 + 部分 e2e** | §2.3：H 的 409 路径走到该函数且文件未被回填，但该组 T 未改写文件，**无法完全判别** |
| 3 | `reconcileCollateral`（连带还原） | ✅ `:1638` + `:1391-1393` | ⚠️ **代码级** | 需「会连带改文件的 agent（cursor/claude）+ 真实 CLI」才能 e2e，**本轮未做** |
| 4 | `preserveUserBaks`（`.bak` 还原） | ✅ `:1617` | ⚠️ **代码级** | 同上 |
| 5 | `rollbackRTK` 提交点 | ✅ `:1920` | ✅ **happy path e2e**（`ok:true`，恢复 **30 个文件**）；**被夺锁路径仅代码级** | 未做「rollback 期间 SIGSTOP」的时序 |

**5/5 都接上了**(没有漏的落盘点) ✓；**e2e 覆盖 2/5**（1 完整、5 的 happy path），其余 3 个是代码级 —— **这是本轮最大的证据缺口，我明确标出来**。

---

## 4. 边界声明是否诚实（④）

**文档 §3 原文要点**（`docs/qa/blue/rtk-fencing-and-heartbeat.md:96-110`）：
- 「**rtk CLI 自己的写入无法 fence**：CLI 是外部进程，它在 H 停顿期间或恢复后**可能已经把钩子文件写进磁盘**」
- 「检测到失去锁 → 不报成功（409）……**不用快照回填**去『撤销』它——那会盖掉接管者的写入」
- 「保证是：**本控制台自己的所有写入都不会落在接管之后，且任何被接管的操作都不会被报告为成功**；**CLI 已经落盘的那部分改动可能仍在**，需要用户用 `/api/rtk/rollback` 或重试来收敛」

**我的判断：诚实，不会被读成「接管后不会重复写」。** 理由：① 它**明确点出 CLI 可能已经写进磁盘**、且**改动可能仍在**；② 它把保证范围写成「**本控制台自己的写入**」+「**不报成功**」，这两条都限定得准确；③ 它**解释了为什么不用快照回填**（会盖掉接管者），这是主动交代取舍而不是含糊。
**唯一建议收紧的一处**（R12-A）：「所有写入都不会落在接管之后」应加上「校验与写入之间有 ≤1 个系统调用的窗口」。

**`TODO(fencing)` 的触发条件可执行吗？——可执行。** 代码注释（`:1621-1624`）与文档 §3.3 写的是：「若将来要求『**跨进程强互斥且 CLIs 的写入也必须原子化**』，就必须把 rtk 的写入收进我们自己的进程（或改成 CLI 只输出计划、由我们提交）」。
→ 这是一个**可判定的产品级条件**（不是「以后有空再说」），且给出了**两条具体实现路线**；文档还指向了 §3 作为触发条件出处 ✓。**我认为合格**。

---

## 5. Fence 有没有把正常路径改坏（②的后半）+ 性能

同一临时 HOME（no-op CLI、无争用）实测：

| 场景 | 结果 |
|---|---|
| `toggle codex ON` | ✅ `ok:true, mechanism:"hooks-json"`，文件 **含 rtk 钩子**（len 214），**27ms** |
| `toggle codex OFF` | ✅ `ok:true`，文件 **不含 rtk 钩子**（len 42），**20ms** |
| `toggle ON`（再次） | ✅ `ok:true`，文件回到含 rtk（len 214）⇒ 往返幂等 |
| **`rollbackRTK({confirm:true})`** | ✅ `ok:true`，**恢复 30 个文件**（`.codex/*`、`.claude/*`、`.cursor/*`、`.gemini/*`、`.copilot/*`、`.trae`、`.factory`、`.omp`、`.pi`、`.hermes`、`.vibe`…） |
| **写坏 JSON 的失败回填** | ✅ 拒绝并回填：`status 409, reason:"hook_file_unparsable"`，消息「…**已拒绝并回填操作前原文**；可用 /api/rtk/rollback 恢复」，文件 = 操作前原文（len 18） |
| 坏 JSON 下重试 | 仍 409 `hook_file_unparsable`（**不假装成功**，与文档一致） |

**⇒ fence 没有破坏正常路径** ✅（且失败原因可区分：`lock_lost_during_write` vs `hook_file_unparsable` vs `hook_write_unverified`，实测三种都出现过）

**性能（实测数字）**：
- `isOwned()` = **11.45 µs/次**、`assertOwned()` = **11.66 µs/次**（各 2000 次取均值；每次 = `statSync` + 读文件 + `JSON.parse`）
- 无争用 toggle 墙钟 = **20–27 ms**（含 no-op CLI 启动）
- **⇒ 一个操作最多几次 fence 校验 ≈ 50 µs，占操作的 ~0.2%，在当前量级上完全测不出来。** 即使慢盘上每次 `statSync`+读放大到 1–5 ms，几次校验也只增加 ≤25 ms，而 RTK 操作本身是**秒级**（真实 CLI 2.5s 级）⇒ **代价可忽略**。

---

## 6. 还原 / 边界证据

```
$ git status --short        →  (空：本轮对仓库零改动)
$ ls -d /tmp/cac-*.lock     →  不存在（浏览器锁与构建锁均未占用/已释放）
```
**真实 agent 配置（6 个）逐一与已发布基线一致**：
| 文件 | sha256 | 与基线 |
|---|---|---|
| `~/.codex/hooks.json` | `d234642427dd4c2ed1fca3f7dc98ad14106d9d5981dfd92327b03aa5858eec47` | ✅ |
| `~/.claude/settings.json` | `c08f957851d68845cff776ca9b15c22409c86fa10ab049667936c44347eaebe4` | ✅ |
| `~/.cursor/hooks.json` | `4734d152efa28ffb02d88f1a0ab99a6a7f650fe4e510b8f58d50b63a1b2d275c` | ✅ |
| `~/.gemini/settings.json` | `196e2dca8dacab1bff3a41f8b14bb1f7607f38d221136f4c0278c7d3c809f811` | ✅ |
| `~/.omp/agent/extensions/rtk.ts` | `d1555e0af5872a30ed04059423350bdb38302f200a9642c5a9bcc519c95a2257` | ✅ |
| `~/.pi/agent/extensions/rtk.ts` | `d1555e0af5872a30ed04059423350bdb38302f200a9642c5a9bcc519c95a2257` | ✅ |

- 所有实验都在 `mkdtemp` 临时 HOME + 临时 `RTK_BACKUP_DIR` + no-op CLI 下跑，结束即 `rmSync`（脚本打印 `cleaned`）；产品代码的 `assertNotRealHomeInTests` 也在其中生效 ✓
- **本轮不使用浏览器**（纯进程级复验）⇒ 无 TaskSpace 需要 `finish`；**也没有任何 TaskSpace 被创建**。

---

## 7. 未验证项（诚实列出）

1. **落盘点 3（`reconcileCollateral`）与 4（`preserveUserBaks`）没有 e2e**：需要「会连带改文件的 agent + 真实 rtk CLI」的夹具；我只核对了接线（`:1638`、`:1391-1393`、`:1615-1618`）。
2. **落盘点 5（rollback）的被夺锁路径没有 e2e**：只跑了 happy path（`ok:true`、30 文件恢复）。
3. **落盘点 2（回填）的 e2e 判别未完成**：§2.3 的夹具里 T 未成功改写文件，因此「fence 生效」与「无内容可回填」无法完全区分。
4. **R12-A 的窗口未做随机时序压测**（结构分析 + 同构窗口上一轮 300 次 0 命中的经验）。
5. **HTTP 层是否把 409 映射成响应里的 `lockLost`**：我只看到错误对象带 `reason`，`lockLost` 为 `null`；**未逐层核对 `rtkFailure`**（R12-B）。
6. **性能只在临时目录（APFS）测**，未在真实慢盘/网络盘上测；数字是 µs 级校验，结论（可忽略）对慢盘也成立，但**未实测**。

---

## 8. 判据速查（可原样复跑）

```bash
# ---- 跨进程时序（我自己那套，含对照）----
# worker: 调 setRTKAgentHook('codex', on, {plane:'local', home, bin: <no-op 慢 CLI>})
#   no-op CLI: #!/bin/sh\n[ "$1" = "init" ] || exit 0\ntouch <标记>\nsleep 2.5\nexit 0
# 初始文件: {"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook codex"}]}]}}
# H: ON=0（去掉 rtk）——先起，等标记文件出现后 kill -STOP H
# 等 1.4s（RTK_LOCK_STALE_MS=1000）→ T: ON=1（另一个真实进程，会合法接管）
# kill -CONT H → 读钩子文件
#   期望（fence 开）: H 退出码 4 / status 409 / reason lock_lost_during_write；文件与 T 写入后**完全一致**
#   对照（给 H 加 RTK_LOCK_DISABLED=1）: H 退出码 0 / ok:true；文件**被 H 覆盖**（hasRtk 翻转）
#
# ---- 正常路径回归 ----
# toggle ON / OFF / ON 往返 → ok:true 且文件 rtk 钩子随之增删；rollbackRTK({confirm:true}) → ok:true 且恢复 30 文件
# 写入坏 JSON（'{ not json'）→ 期望 409 reason=hook_file_unparsable + 消息含「已回填操作前原文」
#
# ---- 性能 ----
node --import tsx -e 'const s=await import("./server/rtkService.ts"); /* 持锁后 2000 次 isOwned()/assertOwned() 取均值 */'
#
# ---- R11-A 不变量 ----
node --import tsx -e 'import {rtkLockHeartbeatMs} from "./server/rtkService.ts";
for (const v of [5,10,50,100,150,199,200,201,300,600,1000,60000]) console.log(v, rtkLockHeartbeatMs(v))'
#   期望 interval <= max(staleMs,10) 恒成立
```

---

## 9. 建议（按性价比）

1. **🟡 R12-A 措辞收紧（一行文档）**：把「**所有**写入都不会落在接管之后」改成「**每个写入前校验一次**；校验与写入之间存在 ≤1 个系统调用的窗口（无原生 CAS 无法消除）」。这是唯一一处**声明强于实现**的地方。
2. **🟡 R12-C 补一句**：`RTK_LOCK_DISABLED` 的告警/文档里注明「**该开关会同时关闭 fence**（`isOwned()` 恒真）」，避免有人以为只是「少了互斥」。
3. **🟡 R12-B 核对 HTTP 映射**：确认 409 的响应体里带 `lockLost: true`（客户端若只读该字段会漏判）；否则在 `rtkFailure` 里补上。
4. **补齐证据缺口**：给落盘点 3/4/5 各加一条 e2e（用 cursor/claude 这类会连带改文件的 agent；rollback 期间做同样的 SIGSTOP 时序）。**当前 5/5 已接线，但只有 2/5 有 e2e。**
5. **✅ 可以结案**：fence **确实把 R11-C 从事后标记变成事前阻止**（我做了带对照的双向端到端验证）、`isOwned()` 在 inode 复用下不误判、409 之后无其他写路径、正常 toggle/rollback/坏 JSON 回填**都未被改坏**、失败原因可区分、**性能代价可忽略**（11.5 µs/次 vs 20–27 ms/操作）、**R11-A 不变量在 12 个取值上恒成立**、边界声明**诚实且不会被误读**、`TODO` 触发条件**可执行**。
