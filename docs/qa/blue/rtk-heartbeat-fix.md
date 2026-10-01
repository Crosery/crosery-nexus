# RTK 写入锁心跳修复（task-37 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依据：`docs/qa/red-team/round10-verification.md`（红队第十轮）+ task-37

红队第十轮确认上轮 R9-A…R9-E 五条修复全部成立（原攻击失效），但**新加的心跳引入两条新缺陷**。本轮修复。

---

## 0. 汇总

| # | 缺陷 | 级别 | 状态 | 修后判据 |
| --- | --- | --- | --- | --- |
| R10-A | 心跳续期不校验 token，`renameSync` 无条件覆盖锁路径 → 被接管后**按周期把锁抢回来**，`lost` 仍为 false，`release()` 还会删掉接管者的锁 ⇒ 2–3 个写入者 | 高 | ✅ | 续期前 **token + inode 双校验**，不匹配就**不续期 + 停表 + `lost=true` + `lostReason`**；红队攻击实测锁里仍是 `THIEF-TOKEN` |
| R10-B | 续期失败被 `catch {}` 吞掉 → 「假活锁」（mtime 不前进，随时被夺却自认持锁） | 中 | ✅ | 失败计数 + 最后错误进 `info`（`renewFailures`/`renewLastError`）并进响应 + `console.warn`；连续 3 次失败主动降级 `lost=true, lostReason=renew_failed`；临时文件不留残留 |
| 附 | 心跳周期与 `staleMs` 的关系未约束 | — | ✅ | `rtkLockHeartbeatMs(staleMs) ≥ 200ms 且 ≤ staleMs`（断言覆盖 300ms–1h）；端到端：`staleMs=600` 时持有者持续续期，等待者只能 503 |
| 附 | `at`×mtime 的措辞过强；时钟偏移下的 503 缺少排查线索 | — | ✅ | 注释/文档收紧为「**时钟偏移探测器，不是防篡改**」；503 文案新增「时钟疑似不一致：两个实例必须共享同一时钟」 |

四项命令退出码（另有 `npm test`）：

```
npm run test:magpie → ℹ tests 93 · pass 92 · fail 0 · skipped 1     exit 0
npm test            → ℹ tests 612 · pass 611 · fail 0 · skipped 1   exit 0
npx tsc -b --pretty false                                           exit 0
npm run build       → ✓ built in 611ms                              exit 0
npm run lint        → 仅既有 nativeResponses.ts:200/203 告警        exit 0
```

---

## 1. R10-A（高）：心跳不得抢回被接管的锁

**修前复现（红队攻击手法，实际跑出来的）**：

```
=== 修前（旧心跳：不校验 token，renameSync 无条件覆盖）===
tick 之后锁里的 token = 263b1712b05bc6df          ← 持有者自己的 token：把接管者的锁抢回来了
info.lost = false | lostReason = undefined        ← 完全不自知
release 之后锁文件还在 = false | 接管者的锁被删了  ← release 又删掉了 T 的锁
```

即：H 被判陈旧 → T 合法接管（锁内 `THIEF-TOKEN`）→ **一个心跳周期后 H 把锁覆盖回自己** → H 与 T 都自认持锁，
且 H 释放时删除 T 的锁。**按 `max(1s, staleMs/3)` 周期性发生**，不是微秒竞态。

**修法**：

1. **续期前双校验**（`ownsLock()`）：先比 inode（rename 会换 inode，「被别人删掉重建」立刻可见），再读载荷比 token；
   读不出载荷 → 视为 `unreadable`。
2. **不匹配就不续期**：停表 + `onLost('token_mismatch' | 'lock_file_unreadable')` → `info.lost = true`、`info.lostReason` 写入，
   并打一条 `console.warn`；此后**不再写锁路径**，`release()` 的既有 token 守卫也不会去删别人的锁。
3. **写回不再无条件覆盖**：采用「校验 → 写临时文件 → **再校验** → rename」，残余窗口只有两次校验之间的微秒级；
   即使撞上，下一个 tick 立刻检出，且 `release()` 不会删接管者的锁——残余窗口与可接受判据写在代码注释里。

**修后证据**（同一攻击脚本）：

```
=== 修后 ===
[rtk] 写入锁已不再属于本进程（token_mismatch），后续不再续期、也不删除他人的锁（锁：…/rtk-write.lock）
tick 之后锁里的 token = THIEF-TOKEN
info.lost = true | lostReason = token_mismatch
release 之后锁文件还在 = true | token = THIEF-TOKEN
```

**语义级负向验证**（`server/rtkLock.test.ts`，修前两条都失败）：

```
=== 修前（旧心跳）===
✖ R10-A 心跳不校验 token 时会抢回被接管的锁（修前复现：断言必须失败） — AssertionError: 失去锁必须如实上报
✖ R10-A 原地改 token（inode 不变）也必须被检出并停止续期
ℹ pass 0 · fail 2
=== 修后 ===
✔ R10-A 心跳不校验 token 时会抢回被接管的锁（修前复现：断言必须失败）
✔ R10-A 原地改 token（inode 不变）也必须被检出并停止续期
```

两条用例分别覆盖「删掉重建（inode 变）」与「原地改写（inode 不变）」两种接管形态，断言：锁里仍是接管者的 token、
`lost === true`、`lostReason === 'token_mismatch'`、`release()` 后接管者的锁仍在。

---

## 2. R10-B（中）：续期失败必须可见

**修前复现**（把目录 `chmod 500` 让续期写临时文件必然失败）：

```
=== 修前 ===
✖ R10-B 续期失败可见（计数 + 最后错误 + 连续失败降级为 lost），且不留 *.renew-* 残留
  AssertionError: 首次失败就要可见：{"path":"…/rtk-write.lock","disabled":false,"waitedMs":0,"stolen":false,"lost":false}
```

旧实现 `catch {}` 吞掉一切：持有者活着、`lost=false`、但 mtime 不再前进 → 会被判陈旧夺走（假活锁）。

**修法**：

- 失败**计数**（`info.renewFailures`）+ **最后错误**（`info.renewLastError`，脱敏、截断 120 字符）；
  首次失败即写进 `info` 并 `console.warn`；响应里透出 `lock.renewFailures` / `lock.renewLastError`，
  顶层另有 `lockRenewFailures` / `lockRenewLastError`。
- **连续 3 次失败**主动降级：停表 + `lost=true` + `lostReason='renew_failed'`（不再假装还持锁）。
- **临时文件清理**：失败路径 `fs.rmSync(temp, {force:true})`；另加 `sweepStaleRenewTemps()`，
  在 acquire 时清理「同目录 + 同前缀 + 够老（≥ max(30s, staleMs)）」的 `*.renew-*` 崩溃残留，不会误删进行中的续期。
- 成功续期后清零计数（`renewFailures = 0`）。

**修后证据**：

```
✔ R10-B 续期失败可见（计数 + 最后错误 + 连续失败降级为 lost），且不留 *.renew-* 残留
   → renewFailures ≥ 1、renewLastError 匹配 EACCES/EPERM、随后 lost=true + lostReason=renew_failed、目录内无 *.renew-*
✔ R10-B 残留的 *.renew-*：够老的会被清理，新鲜的保留（不误删进行中的续期）
```

---

## 3. 附带：心跳周期断言与措辞收紧

- **周期与 `staleMs` 的关系**（新增导出 `rtkLockHeartbeatMs()`）：
  `max(200, min(floor(staleMs/3), staleMs))` —— 保证 **interval ≤ staleMs**（否则活锁会被自己的心跳「跑输」而误判陈旧）
  且不低于 200ms。用例对 `staleMs ∈ {300, 600, 1s, 3s, 60s, 1h}` 断言两条性质；端到端再验一次：
  `staleMs=600` 的持有者持续续期 1.5s 后锁仍新鲜，等待者只能拿到 `rtk_lock_timeout`。
- **措辞收紧**：代码注释与本文都写明 `at`×mtime 是**时钟偏移探测器**，不是防篡改——同时改掉 `at` 与 mtime 仍会被判超时并接管；
  它防的是时钟不同步导致的误判，不防本机同用户的恶意改写。
- **503 文案**：等待者超时且探到 `suspicious` 时，消息里加「时钟疑似不一致：两个实例必须共享同一时钟，请检查时钟偏移」
  （用例 `时钟疑似不一致时：等待者 503 且文案带排查提示`）。时钟偏移下只能 503 是**有意的取舍**：宁可让运维看到明确的
  「时钟不对」提示，也不夺走一个活着的持有者。

---

## 4. 改动文件

| 文件 | 说明 |
| --- | --- |
| `server/rtkService.ts` | 心跳重写（token+inode 双校验、不覆盖他人锁、失败可见与降级、临时文件清理与扫描）、`rtkLockHeartbeatMs`、`sweepStaleRenewTemps`、`RtkLockInfo` 新字段、503 文案、措辞注释 |
| `server/rtkLock.test.ts` | 新增 6 条用例（R10-A ×2、R10-B ×2、周期断言、时钟文案） |
| `docs/qa/blue/rtk-heartbeat-fix.md` | 本文件 |

未新增依赖；未碰 `server/index.ts`、其它 `server/*.ts`、`src/**`、`package.json`。

---

## 5. 重启与运行实例抽验（必然被拒绝的输入，零写入）

取 `/tmp/cac-build.lock` 时**等待**（当时 blue-ui 在用），未抢锁；`launchctl kickstart -k` 后：

```
session=200
toggle windsurf → 501 {"error":"Windsurf 在 rtk 0.50.0 只能按项目初始化…","plane":"local","reason":"project_scoped_only"}
install {}      → 501 {"error":"控制台不代为安装本机 rtk…","reason":"local_install_not_supported"}
status          → {"plane":"local","backupKeep":10,"backupGraceMs":120000,"backupOrphans":0}
ls ~/.agents/crosery/magpie-console/rtk-write.lock      → No such file or directory（无残留锁）
launchctl print … | grep -c RTK_LOCK_DISABLED           → 0（生产未开旁路）
```

真实 6 个 agent 配置的 sha256 与基线一致（`rtkService.test.ts` 与 `rtkLock.test.ts` 的 `after()` 双重断言，本轮 `npm test` 612 用例跑完仍不变）。

---

## 6. 仍未验证 / 残余风险

1. **续期的残余竞态**：两次校验之间（微秒级）若恰有接管，本次 rename 仍可能覆盖一次；随后 ≤1 个心跳周期内必被检出
   （`token_mismatch` → `lost` + 停表），且 `release()` 的守卫保证不删接管者的锁。彻底消除需要 `flock`/`fcntl` 级别的原子比较交换，任务禁止新增依赖。
2. **恶意改写本机文件**（同时改 `at` 与 mtime）仍可导致误接管——已按「时钟探测器」定位，不承诺防篡改。
3. **跨主机 / 时钟偏移**：不支持（同前一轮），偏移时等待者只能 503，文案已给排查提示。
4. **NFS/SMB**：`O_EXCL` 与 rename 语义未在网络上验证（当前本机 APFS）。
5. 心跳间隔下限 200ms（`staleMs` 极小时）；仍建议 `RTK_LOCK_STALE_MS ≥ 3000` 以避免过于频繁的续期。
