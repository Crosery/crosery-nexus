# RTK fencing R12 收口（task-42 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依据：`docs/qa/red-team/fencing-verification.md`（红队第十二轮）+ task-42

红队第十二轮独立判定 fence「从事后标记变成事前阻止」（自建两进程 harness、带对照双向验证）。本轮收口 4 条。

---

## 0. 汇总

| # | 条目 | 级别 | 状态 |
| --- | --- | --- | --- |
| ① | R12-A：文档措辞「**所有**写入都不会落在接管之后」过强 → 收紧为「每个写入前校验一次 + ≤1 个系统调用的窗口」并说明不可达性 | 低-中 | ✅ 只改措辞与注释 |
| ② | R12-C：`RTK_LOCK_DISABLED=1` 同时关闭 fencing，必须显式告知 | 低 | ✅ 一次性告警 / 注释 / 文档三处写明 + 断言 |
| ③ | R12-B：409 载荷缺 `lockLost` | 低 | ⚠️ **服务层已补**（`rtkFailure` 透出 `lockLost`/`lockLostReason`）+ 断言；**HTTP 层需 `server/index.ts` 一行**，不在本任务写范围（见 §3.3，附补丁） |
| ④ | 补落盘点 e2e：`preserveUserBaks`/`restoreTargets` 组 + `rollbackRTK` 被夺锁路径，并要求「T 真的改写文件」的判别条件 | — | ✅ 两条新 e2e；其中 `.bak` 内层守卫的**不可达性**如实说明（见 §4.3） |

另外顺手补了一处诚实性问题：`success()` 在提交块**结束后**再校验一次，避免「丢锁是在连带还原阶段被发现的（reconcile 返回 skipped 而不抛）」时仍然返回 ok。

命令退出码：

```
npm run test:magpie → ℹ tests 100 · pass 99 · fail 0 · skipped 1     exit 0
npm test            → ℹ tests 619 · pass 618 · fail 0 · skipped 1   exit 0
npx tsc -b --pretty false                                           exit 0
npm run build       → ✓ built in 486ms                              exit 0
npm run lint        → 仅既有 nativeResponses.ts:200/203 告警        exit 0
```

---

## 1. R12-A：措辞收紧（只改措辞，不实现第二次校验）

**改动**（`server/rtkService.ts` 的 fence 注释）：

> 这是「每个写入前校验一次」，不是「写入与校验原子」。校验与写入之间存在 **≤1 个系统调用的窗口**（无原生 CAS 无法消除）；要打进去必须在 H 校验通过后的一个系统调用内完成 T 的「判陈旧 → unlink → 新建 → 写入」，而此刻 H 的锁是新鲜的（心跳还在续期），因此该窗口在现实的调度/IO 时延下不可达；即便撞上，下一次校验（或心跳）也会立刻把 lost 标出来。

本文与 `rtk-fencing-and-heartbeat.md` 里原先「本控制台自己的**所有**写入都不会落在接管之后」的说法**同时收紧**为：

> 每个写入前校验一次；校验与写入之间的窗口是 ≤1 个系统调用，无原生 CAS 无法消除；该窗口不可达（见上），但**不作为原子性承诺**。

---

## 2. R12-C：旁路同时关闭 fencing

- 一次性告警（实测输出，对照实验里可见）：
  `[rtk] RTK_LOCK_DISABLED 已启用：跨进程写入锁被旁路，**同时关闭提交点 fencing**（isOwned() 恒为 true，锁被接管也不会阻断写入）。仅供「修前语义」对照实验，生产环境不得设置。锁文件：…`
- 代码注释两处（`acquireRtkFileLock` 的 `disabled` 说明、`isOwned()` 上方）都写明「该开关同时关闭 fencing」。
- 断言测试 `R12-C RTK_LOCK_DISABLED=1 时 isOwned() 恒为 true（该开关同时关闭 fencing）`：即使把锁文件换成别人的 token，`isOwned()` 仍为 `true`、`assertOwned()` 不抛 —— 把这条语义钉死，防止将来有人误以为旁路只影响锁。

---

## 3. R12-B：409 的 `lockLost`

### 3.1 现状核对（只读 `server/index.ts`）

RTK 路由的错误面是**显式字段列表**，只透出 4 个字段：

```
server/index.ts:1209
res.status(failure.status).json({ error: failure.error, ...(failure.plane ? { plane } : {}), ...(failure.reason ? { reason } : {}), ...(failure.backup ? { backup } : {}) })
```

⇒ 红队观察正确：409 里有 `reason: 'lock_lost_during_write'`，但**没有** `lockLost`。

### 3.2 本轮已做（服务层，我的写范围）

- `assertOwned()` 抛出的错误对象带上 `lockLost: true` 与 `lockLostReason`；
- `rtkFailure()` 透出这两个字段（`RTKFailure` 类型同步扩展）；
- 断言测试 `R12-B fence 失败载荷带 lockLost:true + reason（rtkFailure 透出）`：`rtkFailure(error).lockLost === true`、`.lockLostReason === 'token_mismatch'`、`.status === 409`、`.reason === 'lock_lost_during_write'`。

### 3.3 未做：HTTP 层需要 `server/index.ts` 一行（不在本任务写范围）

`server/index.ts` 明确不在 task-42 的写范围里（`server/rtkService.ts`、`server/rtkService.test.ts`、`server/rtkLock.test.ts`、`docs/qa/blue/**`），因此**我没有改动它**。给 owner 的现成补丁（1209 行，`/api/rtk/planes` 的 1176 行如需一致可同样处理）：

```diff
-    res.status(failure.status).json({ error: failure.error, ...(failure.plane ? { plane: failure.plane } : {}), ...(failure.reason ? { reason: failure.reason } : {}), ...(failure.backup ? { backup: failure.backup } : {}) })
+    res.status(failure.status).json({ error: failure.error, ...(failure.plane ? { plane: failure.plane } : {}), ...(failure.reason ? { reason: failure.reason } : {}), ...(failure.backup ? { backup: failure.backup } : {}), ...(failure.lockLost ? { lockLost: true } : {}), ...(failure.lockLostReason ? { lockLostReason: failure.lockLostReason } : {}) })
```

补上后即可满足「只读 `lockLost` 的客户端不能漏判」；在补上之前，客户端**必须**用 `reason === 'lock_lost_during_write'` 判断（服务层已经保证这两个信号同时出现）。

---

## 4. 落盘点 e2e

5 个落盘点接线 5/5；本轮把 e2e 从 2/5 提到 4/5（第 5 个见 §4.3 的不可达说明）。

### 4.1 `restoreTargets` + `.bak` 组：H 被夺锁后一个字节都不写（判别条件：T 真的改写文件）

用例 `落盘点 e2e（判别条件：T 真的改写了 hook 与 .bak）`：

1. 前置：`.codex/hooks.json` = 空钩子；`.codex/hooks.json.bak` = `USER-BAK`（用户自己的备份）；
2. 慢 CLI 像真实 rtk 一样把 `.bak` 覆写成 `CLI-BAK`、然后只发信号不写 hook（**只写一次**，避免「验证失败后重试 CLI」把 `.bak` 再写一遍而掩盖判别）；
3. H 进入 CLI 后被 **SIGSTOP**；等待者合法接管（`stolen=true`），把 hook 写成 `THIEF` 内容、把 `.bak` 写成 `THIEF-BAK`；
4. **SIGCONT** → H 的 CLI 返回、验证失败 → 走 JSON 兜底提交点 → 被 fence 拦下。

断言（判别条件全部指向「T 的内容」）：

| 观察点 | 修前（fence 降级为只上报） | 修后 |
| --- | --- | --- |
| H 的退出码 | **0**（`RESULT {"ok":true,"lockLost":true}`） | **4** |
| H 的错误 reason | —（没抛） | `lock_lost_during_write`（且错误对象带 `lockLost:true`） |
| `.codex/hooks.json` | H 的 `rtk hook codex` 覆盖了 T | **逐字节等于 T 的内容** |
| `.codex/hooks.json.bak` | `USER-BAK`（preserveUserBaks 跑了）或 `CLI-BAK`（回填跑了） | **逐字节等于 `THIEF-BAK`** |

即：`.bak` 的三种可能值（`USER-BAK` = `preserveUserBaks` 落盘、`CLI-BAK` = `restoreTargets` 落盘、`THIEF-BAK` = 谁都没写）**互相可区分**——这正是红队要的判别条件。

修前实测：`✖ AssertionError: H 必须以 409 失败退出，实际 0：[rtk] 写入锁已不再属于本进程（token_mismatch）…`

### 4.2 `rollbackRTK` 的被夺锁路径（e2e，实测命中率 ~85%）

用例 `落盘点 e2e：rollbackRTK 的被夺锁路径（定向篡改，实测命中率 ~85%）`（1.5s）：

- 子进程反复调用 `rollbackRTK({home, confirm:true, backup})`（24 次）；
- 父进程**定向篡改**：一旦锁文件出现就原地改写 token（同 inode，正是 token 判据要抓的形态）并把目标钩子文件写成接管者内容；篡改后的锁 50ms 无人使用就删掉，避免子进程卡在「别人的锁」上；
- 断言：`lockLost ≥ 1`（必须真的命中 fence）、`clobberedByRollback === 0`（报 409 之后目标文件里**不得**出现「操作前」内容）、最终目标文件不是回滚写回的内容。

实测：

```
有 fence ：{"ok":9,"lockLost":51,"other":{},"clobberedByRollback":0}   （60 次迭代，脚本 harness）
           {"ok":…,"lockLost":28,"clobberedByRollback":0}             （300 次迭代）
对照（RTK_LOCK_DISABLED=1，等价「fence 关」）：{"ok":150,"lockLost":0,"other":{}}  ← 150 次全部在锁被夺后写入
修前（fence 降级为只上报）：{"ok":24,"lockLost":0,"other":{},"clobberedByRollback":0}
```

可复现脚本（standalone，验证用；耗时 ~60s，因此**没有**塞进 test:magpie）：`/tmp/r12-rollback-fence.mjs`、`/tmp/r12-rollback-targeted.mjs`。

### 4.3 如实说明：`preserveUserBaks` 的**内层守卫**不可单独构造 e2e

`preserveUserBaks()` 里的 `if (!lock.isOwned()) return []` 在当前调用顺序下**不可达**：

```
success():
  lock.assertOwned()                                   // ① 断言
  reconcileCollateral(..., { fence })                  // ② 自带 fence，失败则返回 skipped（不抛）
  preserveUserBaks()                                   // ③ 内层守卫在这里
  lock.assertOwned()                                   // ④ 本轮新加的收尾断言
```

要让 ③ 成为**决策者**，丢锁必须发生在 ① 通过之后、② 的 fence 检查之前——这两者之间没有任何 IO，
窗口是「几条语句」，外部进程无法被确定性地排在中间。因此：

- 我没有用「代码级验证」冒充 e2e；**已用 §4.1 的 e2e 覆盖该组的可观察行为**（`.bak` 与回填都不写，判别值 `THIEF-BAK`）；
- ③ 保留为 defense-in-depth（若将来有人在 ① 与 ② 之间插入 IO/await，它会立刻变成有效防线），并在测试文件里写明这条不可达性。

### 4.4 `restoreTargets` 组的判别条件（红队点名）

已按红队要求补齐：T 会**真的改写** hook 文件与 `.bak`（§4.1 第 3 步），因此「文件仍是 T 的内容」能区分
「fence 生效」与「本来就无内容可回填」。修前对照见 §4.1 表格。

---

## 5. 改动文件

| 文件 | 说明 |
| --- | --- |
| `server/rtkService.ts` | fence 注释措辞（R12-A）；旁路告警/注释写明同时关闭 fencing（R12-C）；`assertOwned` 错误带 `lockLost`/`lockLostReason`，`rtkFailure` 透出（R12-B 服务层）；`success()` 收尾再校验一次 |
| `server/rtkLock.test.ts` | 新增 4 条：R12-C 旁路断言、R12-B 载荷断言、落盘点 e2e（`.bak` 判别）、rollbackRTK 被夺锁 e2e |
| `docs/qa/blue/rtk-fencing-r12.md` | 本文件 |

未新增依赖；未碰 `server/index.ts`（§3.3 给补丁）、其它 `server/*.ts`、`src/**`、`package.json`。

---

## 6. 重启抽验（零写入）

```
session=200
toggle windsurf → 501 project_scoped_only
install {}      → 501 local_install_not_supported
status          → {"plane":"local","backupKeep":10,"backupGraceMs":120000,"backupOrphans":0}
ls ~/.agents/crosery/magpie-console/rtk-write.lock → No such file or directory
find … -maxdepth 1 -name '*.renew-*' | wc -l → 0
launchctl print … | grep -c RTK_LOCK_DISABLED → 0
```

真实 6 个 agent 配置 sha256 不变（两个测试文件的 `after()` 双重断言；本轮 `npm test` 619 用例跑完仍不变）。

---

## 7. 仍未做 / 残余

1. **HTTP 层的 `lockLost` 需要 `server/index.ts` 一行**（§3.3），不在本任务写范围 —— 已给补丁，请 owner 决定。
2. `reconcileCollateral` 内部「fence 检查 → 逐个写入」之间同样是 ≤1 个系统调用的窗口（与 R12-A 同类，未再实现第二次校验）。
3. 跨主机 / 时钟偏移 / NFS 的边界同前几轮。
4. `rollbackRTK` 的 e2e 是**概率性**命中（~85%/次，用例 24 次迭代，P(0 命中) ≈ 1e-20），不是确定性构造；原因见 §4.3（acquire→fence 之间无 IO，无法注入）。
