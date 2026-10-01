# RTK 测试门禁去 flake（task-44 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 触发：Lead 实测 `npm test` 间歇性失败（`落盘点 e2e：rollbackRTK 的被夺锁路径` ≈15% flake，某次耗时 34.1s）

---

## 1. 结论

| 指标 | 修前 | 修后 |
| --- | --- | --- |
| 该用例耗时 | **34.1s**（失败版本）/ 4.8s（中间版本） | **1.02s** |
| 该用例性质 | 概率性：父进程不停篡改，赌篡改落进「acquire→fence」的微秒级窗口（实测命中率随负载 10%~85%） | **确定性**：测试专用同步点，篡改必然落在窗口内 |
| `server/rtkLock.test.ts` | 17.8s | **6.75s** |
| `npm run test:magpie` | 13.2s | **6.84s** |
| 全量 `npm test` | 2s 基线 + 我这 13s | **7.6s**（连续 5 次 7.57–7.66s） |
| 连续 5 次全量 `npm test` | — | **5/5 exit 0，618 tests / 617 pass / 0 fail / 1 skip** |

---

## 2. 机制解释：为什么这条现在**不会** flake（不是「多跑几次就好了」）

### 2.1 原来的 flake 是什么

旧用例让父进程**不停**篡改锁文件，靠概率去撞子进程「`acquireRtkFileLock` 返回」与「`lock.assertOwned()`」之间那段窗口
（≈2 个系统调用）。这段窗口的宽度由调度决定，负载高时会漂移；而且最后的断言还依赖「最后一个写文件的是父进程」，
在负载下子进程可能最后落一次**合法**回滚（锁当时确实还是它的）⇒ 断言失败。两点叠加 ⇒ ~15% flake。

### 2.2 现在为什么必然命中

引入**测试专用**同步点（env 注入，默认 0、不生效）：

```ts
// server/rtkService.ts
export function rtkTestLockHoldMs(env = process.env): number   // RTK_TEST_LOCK_HOLD_MS，0..10000
// acquireRtkFileLock() 内、创建锁之后、返回之前：
const testHoldMs = rtkTestLockHoldMs(env)
if (testHoldMs > 0) await sleep(testHoldMs)
```

于是子进程的时间线是**可控的**：

```
子进程: acquire 创建锁 ──[同步点 450ms，锁文件已存在]──► 返回 ──► assertOwned() ──► 409
父进程:        轮询(2ms) 看到锁文件出现 ──► 篡改 token + 写接管者内容 ──► 等待下一轮
```

父进程只需要在 450ms 的窗口里被调度到一次（轮询步长 2ms ⇒ 约 200 次机会），而不是去撞 2 个系统调用；
断言也从「最后一个写者是谁」改成**每轮**在 409 之后立刻检查目标文件内容（判别式：`USER-BAK`/`CLI-BAK`/`THIEF-BAK` 三态互斥）。
子进程还做成**自适应轮数**（收集满 2 次被篡改的轮次即停，最多 12 轮），因此「某一轮父进程没赶上」只会让那一轮记为
`ok`（合法的成功回滚），不会让断言失真——**任一方向都不再依赖运气**。

**这个注入点为什么可以接受**：它是**测试专用**的（env，默认 0，生产不得设置），与已被红队接受、并用于构造对照实验的
`RTK_LOCK_DISABLED` 同类；它只在锁层加了一行「等到某时刻」，不含业务分支，也不改变任何默认行为。

### 2.3 概率性覆盖去哪儿了（方案 B）

原本靠「不停篡改撞窗口」的那部分证据没有被删掉，而是**挪出默认门禁**，变成手动 harness：

```
scripts/rtk-lock-race-harness.mjs          # 新增文件，默认不跑
  node --import tsx scripts/rtk-lock-race-harness.mjs                          # 有 fence
  RTK_LOCK_DISABLED=1 node --import tsx scripts/rtk-lock-race-harness.mjs      # 对照（fence 关）
  ITERATIONS=300 MODE=targeted node --import tsx scripts/rtk-lock-race-harness.mjs
```

实测（本机，40 次迭代 2.6s）：`MODE=targeted` 命中 4/40（10%），`clobberedByRollback: 0`，verdict **PASS**；
对照 `RTK_LOCK_DISABLED=1` → 回滚全部成功（`ok > 0`），verdict **PASS**（即「fence 关 = 会写」，与门禁里的确定性用例互补）。
harness 自带预期与退出码（0=符合预期，1=不符合），但仍**不属于门禁**：它会随负载漂移，只用于补充证据。

---

## 3. 全部时序相关用例的逐条审计

`grep` 依据：`setTimeout|waitUntil|hitRate|sleep|Date.now`。

| 用例 | 修前 | 判定 | 处理 |
| --- | --- | --- | --- |
| 落盘点 e2e：rollbackRTK 被夺锁路径 | 固定等待 + 概率篡改 | **概率性 ❌** | 改为同步点（§2.2），命中率 100% |
| R10-A（两种接管形态） | `sleep(700~900ms)` 赌心跳 tick | 概率性（负载下 tick 可能被推迟） | 改 **poll `waitUntil(() => info.lost)`，上限 10s**：条件一满足立刻返回 |
| R10-B（续期失败可见 + 降级） | `sleep(900ms)` 赌 3 次 tick | 概率性 | 改 poll（先等 `renewFailures ≥ 1`，再等 `lost`），上限 10s |
| R9-C 心跳（临界区 > staleMs） | `sleep(2500ms)` + staleMs=1000 | 语义要求「等远超阈值」；余量 2.5× | 保留语义，参数收紧为 800ms/400ms（2×），并写明「只有事件循环被阻塞 ≥0.8s 才会失真」 |
| 心跳周期断言（e2e 部分） | `sleep(1500ms)` | 同上 | 同上（800ms/400ms） |
| R11-C SIGSTOP 跨进程时序（已并入 `.bak` 判别） | 固定等待锁变陈旧 | **确定性**：等待是「越久越陈旧」的单调方向，且 SIGSTOP/SIGCONT 由测试自己控制 | 合并了原「落盘点 e2e（`.bak` 判别）」用例（同一条时序，避免重复 spawn 子进程），CLI sleep 2.5s→1.8s，等待 1.3s→1.15s |
| R9-B 短命进程 | 子进程 `timeoutMs=800` | 确定性（等待由被测代码的超时决定） | 收紧到 300ms（省 0.5s） |
| 时钟疑似不一致 503 文案 | waiter `timeoutMs=250` | 确定性 | 收紧到 120ms |
| R12-C / R12-B / R11-A / R9-A×2 / R9-D / R9-E / R10-B 残留清理 | 无定时 | 确定性 | 不动 |
| 双实例并发（有跨进程锁）/ 双实例连带竞态 | 两实例交叉并发 | **有锁时确定性**（写入被文件锁串行化；「最后完成」= 最后落盘） | 连带竞态 3 轮 → 1 轮（省 4 次实例启动）；断言不变 |
| `scripts/rtk-lock-race-harness.mjs` | 新增 | **概率性（有意）** | 默认不跑，手动跑，自带 verdict/退出码 |

结论：**默认门禁里已经没有任何「靠时序赌命中」的用例**；唯一带概率性质的覆盖被显式移到 `scripts/` 并标注「默认不跑」。

---

## 4. 验收证据

### 4.1 连续 5 次全量 `npm test`（每次 tests/pass/fail + 退出码 + 时长）

```
run#1 exit=0 dur=7.60s ℹ tests 618 ℹ pass 617 ℹ fail 0 ℹ skipped 1
run#2 exit=0 dur=7.57s ℹ tests 618 ℹ pass 617 ℹ fail 0 ℹ skipped 1
run#3 exit=0 dur=7.61s ℹ tests 618 ℹ pass 617 ℹ fail 0 ℹ skipped 1
run#4 exit=0 dur=7.66s ℹ tests 618 ℹ pass 617 ℹ fail 0 ℹ skipped 1
run#5 exit=0 dur=7.62s ℹ tests 618 ℹ pass 617 ℹ fail 0 ℹ skipped 1
```

（用例总数从 619 → 618，因为合并了重复的 SIGSTOP 用例。）

### 4.2 耗时对比

```
单条新用例（--test-name-pattern）      : 1020ms
server/rtkLock.test.ts（3 连跑）       : 6.75s / 6.74s / 6.74s（19 用例）
npm run test:magpie                    : 6.84s（99 用例）
npm test                               : 7.6s（618 用例；基线约 2s，差额几乎全部来自 rtkLock.test.ts 里
                                         6 条会 spawn 子进程/起实例的 e2e，见下表）
```

`rtkLock.test.ts` 内部耗时（修后）：合并后的 SIGSTOP 用例 ~1.8s、rollback 同步点用例 1.0s、心跳 1.1s、
周期 1.0s、R9-B 0.4s，其余 ~0。

### 4.3 其它命令

```
npx tsc -b --pretty false → exit 0 ；npm run build → ✓ 478ms exit 0 ；npm run lint → exit 0（仅既有 2 条告警）
```

### 4.4 重启抽验（零写入，服务端有改动：新增测试专用注入点）

```
session=200
toggle windsurf → 501 project_scoped_only
install {}      → 501 local_install_not_supported
status          → {"plane":"local","backupKeep":10,"backupGraceMs":120000,"backupOrphans":0}
ls ~/.agents/crosery/magpie-console/rtk-write.lock → No such file or directory
launchctl print … | grep -c RTK_LOCK_DISABLED → 0（生产未开旁路）
```

真实 6 个 agent 配置 sha256 不变。

---

## 5. 登记：测试专用开关

| 开关 | 作用 | 默认 | 生产 |
| --- | --- | --- | --- |
| `RTK_LOCK_DISABLED` | 旁路跨进程锁，**同时关闭 fencing** | 未设 | **不得设置** |
| `RTK_TEST_LOCK_HOLD_MS` | 在 `acquireRtkFileLock` 创建锁之后、返回之前插入等待，供测试把篡改确定性地排进窗口（用途、接线点、登记位置见本文件 §2.2 / §5） | `0`（不生效） | **不得设置** |

**默认零行为差异（Lead 要求 ①，已有测试钉住）**：`RTK_TEST_LOCK_HOLD_MS` 未设置 / `0` / 负数 / 非数字 / 空串 / 超上限（>10000）
一律返回 **0**；用例 `RTK_TEST_LOCK_HOLD_MS：不设置时零行为差异…` 做了差分验证——「未设置」与「显式 0」两次获取锁的行为字段
（`waitedMs` 量级、锁文件是否创建/释放、`disabled`、`stolen`）**完全一致**，且都在毫秒级；正向对照设 `300` 时才真的等 300ms。
生产路径上它只有一行 `if (testHoldMs > 0) await sleep(...)`，不设时该分支不进入、无任何业务分支。

---

## 6. 剩余 / 可选项

1. `npm test` 从基线 ~2s 涨到 ~7.6s，几乎全部来自 `server/rtkLock.test.ts` 的 6 条真跨进程 e2e（子进程 tsx 启动 ~1.2s/次 + 实例启动）。
   如果团队希望**快速门禁回到 3s 内**，可把这几条重时序 e2e 拆到不匹配 `test:magpie` glob 的文件（例如 `server/lockE2e.test.ts`，仍被 `npm test` 全量覆盖）——
   **我没有单方面这么做**，因为那会削弱 `test:magpie` 对 fence 的覆盖，需要你定。
2. 概率性/重时序覆盖在 `scripts/rtk-lock-race-harness.mjs`（默认不跑，自带 verdict 与退出码）。
3. `waitUntil` 上限 10s：若某天真的 10s 都没等到条件，会如实失败（那是真 bug 或极端停顿，不是 flake 掩盖）。
4. **拆分问题（Lead 已裁决）**：**不拆**。`test:magpie` 是 RTK 专用门禁，跨进程锁/fence 正是 A 线最需要守的覆盖；
   为了 5 秒把最重要的覆盖挪出专用门禁不划算，7.6s 的全量时长（基线 2s 是因为当时还没有跨进程 e2e）接受。
5. **HTTP 层 `lockLost`（Lead 在 `server/index.ts` 补的 5 处）目前只有类型检查与逐点核对、没有测试覆盖**。
   如果要做，用本轮这个确定性同步点很便宜：起一个实例并设 `RTK_TEST_LOCK_HOLD_MS=800` → 测试进程轮询锁文件出现后篡改 token
   → 断言 `POST /api/rtk/rollback` 返回 `409 { reason: 'lock_lost_during_write', lockLost: true }`（约 1.5-3s，确定性）。
   **本轮未做**（Lead 说明由红队独立复验该条），需要我加就说一声。
