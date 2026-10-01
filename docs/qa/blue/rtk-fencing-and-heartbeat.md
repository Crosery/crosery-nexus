# RTK 写入锁：提交点 fencing（R11-C）与心跳区间不变量（R11-A）（task-40 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依据：`docs/qa/red-team/round11-verification.md`（红队第十一轮）+ task-40

红队第十一轮确认心跳修复全部成立（R10-A 攻击不再成立、300 次定向压测 0 次覆盖、`lost` 后心跳确实停、`renewFailures` 可见、`sweepStaleRenewTemps` 不误删进行中的临时文件），剩下两条。

---

## 0. 汇总

| # | 缺陷 | 级别 | 方案 | 状态 |
| --- | --- | --- | --- | --- |
| R11-C | `lost` 只上报、不阻断已经开始的写入 | 中（设计边界） | **方案 A（fencing）** | ✅ 已实现：提交点 `assertOwned()`，被接管则**放弃写入**并报 409 `lock_lost_during_write`；SIGSTOP 时序实测通过 |
| R11-A | `rtkLockHeartbeatMs()` 在 `staleMs < 200` 时违反 `interval ≤ staleMs` | 低（一行） | 按建议改公式 | ✅ `max(10, min(max(200, floor(staleMs/3)), staleMs))`，断言覆盖极小值 |

命令退出码：

```
npm run test:magpie → ℹ tests 96 · pass 95 · fail 0 · skipped 1     exit 0
npm test            → ℹ tests 615 · pass 614 · fail 0 · skipped 1   exit 0
npx tsc -b --pretty false                                           exit 0
npm run build       → ✓ built in 647ms                              exit 0
npm run lint        → 仅既有 nativeResponses.ts:200/203 告警        exit 0
```

---

## 1. R11-C：为什么选方案 A

**改动面评估**（红队要求）：本机写入的落盘点一共 5 处，全部在 `applyLocalAgentHook` / `rollbackRTK` 内，都在同一个已持有锁的临界区里：

| 落盘点 | 处理 |
| --- | --- |
| rtk CLI 自己写钩子文件 | **无法 fence**（外部进程）；改为 CLI 返回后、任何后续写入与「报成功」之前 fence，检测到失去锁就**不报成功**（见 §3 残余边界） |
| JSON 兜底提交 `applyHookJson()` | 写前 `lock.assertOwned()` |
| 失败回填 `restoreTargets()` | 失去锁直接**跳过**（回填会盖掉接管者的写入） |
| 连带还原 `reconcileCollateral()` | 新增 `{ fence }` 选项：fence 不过则整体跳过，并如实回 `collateralSkipped[{agent,file,reason:'lock_lost'}]` |
| 用户 `.bak` 还原 `preserveUserBaks()`、回滚 `restoreRtkBackup()` | 写前 fence / 失去锁跳过 |

改动面仅限 `server/rtkService.ts` 一个文件、一个新增导出的锁方法（`isOwned()` / `assertOwned()`）+ 5 个调用点，无需改协议、无需新增依赖，因此**选方案 A**；方案 B 的「留 TODO」不再需要（但 §3 仍写清了固有边界）。

**修前复现（红队说他们没做的跨进程时序，这里做出来了）**：

时序：H 持锁进入 rtk CLI（慢 CLI `sleep 2.5` + `touch cli-started`）→ 父进程等到 `cli-started` 后 **SIGSTOP** H（心跳一起冻住，H 无从察觉）→ 等锁过期后父进程**合法接管**（`stolen=true`）并写入自己的钩子内容 → **SIGCONT** H → H 的 CLI 返回、走 JSON 兜底提交。

```
=== 修前（把 fencing 降级为「只上报不阻断」）===
AssertionError: H 必须以错误退出（本次没生效），实际 0：
  [rtk] 写入锁已不再属于本进程（token_mismatch），后续不再续期、也不删除他人的锁（…）
  RESULT {"ok":true,"lockLost":true}        ← lost 被上报了，但写入照样提交、还报成功
  0 !== 4
```

即红队读码所得结论被端到端证实：**接管发生后的写入仍然落盘，且 H 报成功** ⇒ 双方都写完，后写者静默覆盖了接管者（=成功的那次）的改动。

**修后（同一时序）**：

```
✔ R11-C 跨进程时序 SIGSTOP → 接管 → 恢复：不会「双方都写完」(5.1s)
  H 退出码 4、RESULT {"ok":false,"reason":"lock_lost_during_write","status":409}
  钩子文件内容 === 接管者写入的内容（H 的 'rtk hook codex' 没有落盘）
```

**语义级负向验证**（同一测试文件，修前/修后对照）：

| 用例 | 修前 | 修后 |
| --- | --- | --- |
| `R11-C assertOwned/isOwned：被接管后必须拒绝提交（409 lock_lost_during_write）` | 新增 | ✔ |
| `R11-C 跨进程时序 SIGSTOP → 接管 → 恢复：不会「双方都写完」` | ✖（H 报 `ok:true`、覆盖接管者） | ✔ |

**上报语义**：锁被接管时抛 `RtkPlaneError(409,'local','lock_lost_during_write', "写入锁在操作期间被接管（<lostReason>）：已放弃本次提交，改动可能未生效，请重试（可用 /api/rtk/rollback 恢复；锁：<path>）")`，`plane`/`reason`/`backup` 与其它失败一致；响应另带 `lockLost:true` / `lockLostReason`。

---

## 2. R11-A：心跳区间不变量

```
修前：Math.max(200, Math.min(floor(staleMs/3), Math.max(200, staleMs)))    # staleMs=100 → 200 > 100
修后：Math.max(10,  Math.min(Math.max(200, floor(staleMs/3)), staleMs))    # staleMs=100 → 100；staleMs=50 → 50
```

不变量：对任意 `staleMs ≥ 10` 都有 `10ms ≤ interval ≤ staleMs`；常规区间（env 可达，`rtkLockStaleMs()` 钳在 ≥1000）严格小于阈值。

**修前/修后**：

```
=== 修前（旧公式）===
✖ R11-A 心跳区间对极小 staleMs 也自洽：interval ≤ staleMs   ℹ pass 0 · fail 1
=== 修后 ===
✔ R11-A 心跳区间对极小 staleMs 也自洽：interval ≤ staleMs
   （覆盖 staleMs ∈ {5,10,50,100,150,199,200,201,300,600,1000,60000} + 常规区间严格小于）
```

---

## 3. 残余边界（诚实记录，带 TODO 与触发条件）

即使有 fencing，**租约型锁仍有一处无法消除的边界**，明确写在这里而不是含糊过去：

1. **rtk CLI 自己的写入无法 fence**：CLI 是外部进程，它在 H 停顿期间或恢复后可能已经把钩子文件写进磁盘。我们的处理是：
   - CLI 返回后立即 fence（在**任何**后续写入与「报成功」之前）；
   - 检测到失去锁 → **不报成功**（409 `lock_lost_during_write`）、不再做连带还原/回填、提示「本次可能未生效，请重试」；
   - **不用快照回填**去「撤销」它——那会盖掉接管者（锁的合法新持有者）的写入，把一次静默覆盖换成另一次。
2. 换句话说，方案 A 的保证是：**本控制台自己的所有写入都不会落在接管之后，且任何被接管的操作都不会被报告为成功**；CLI 已经落盘的那部分改动可能仍在，需要用户用 `/api/rtk/rollback` 或重试来收敛。
3. **触发条件（什么时候必须回头把这处也做掉）**：如果将来要求「跨进程强互斥且 CLIs 的写入也必须原子化」，就必须把 rtk 的写入收进我们自己的进程（或改成 CLI 只输出计划、由我们提交），也就是不再让外部进程直接写用户配置。
   `// TODO(fencing): 若 rtk CLI 的写入必须可回滚/可撤销，请改为「CLI 只产出计划 + 控制台统一提交」`
4. 时钟偏移、跨主机、NFS 的边界同前几轮（`rtk-cross-process-lock.md` §8、`rtk-lock-r9-fixes.md` §9、`rtk-heartbeat-fix.md` §6）。

---

## 4. 改动文件

| 文件 | 说明 |
| --- | --- |
| `server/rtkService.ts` | `RtkFileLock` 新增 `isOwned()`/`assertOwned()`（与心跳共用同一份 token+inode 校验）；`applyLocalAgentHook` 5 个落盘点接入 fence；`reconcileCollateral` 新增 `{fence}`；`rollbackRTK` 提交点 fence；`rtkLockHeartbeatMs` 公式修正 |
| `server/rtkLock.test.ts` | 新增 3 条（R11-A 不变量、fencing 单元、SIGSTOP 跨进程时序） |
| `docs/qa/blue/rtk-fencing-and-heartbeat.md` | 本文件 |

未新增依赖；未碰 `server/index.ts`、其它 `server/*.ts`、`src/**`、`package.json`。

---

## 5. 重启与运行实例抽验（零写入）

构建锁空闲，取锁后 `launchctl kickstart -k` 重启 `com.crosery.console-magpie`：

```
session=200
toggle windsurf → 501 project_scoped_only
install {}      → 501 local_install_not_supported
status          → {"plane":"local","backupKeep":10,"backupGraceMs":120000,"backupOrphans":0}
ls ~/.agents/crosery/magpie-console/rtk-write.lock   → No such file or directory（无残留锁）
find ~/.agents/crosery/magpie-console -maxdepth 1 -name '*.renew-*' | wc -l → 0（无续期残留）
launchctl print … | grep -c RTK_LOCK_DISABLED        → 0（生产未开旁路）
```

真实 6 个 agent 配置 sha256 与基线一致（两个测试文件的 `after()` 双重断言；本轮 `npm test` 615 用例跑完仍不变）。
