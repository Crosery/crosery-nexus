# RTK 写入锁 R9 修复（task-33 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依据：`docs/qa/red-team/rtk-lock-and-responsive-verification.md`（红队第九轮）+ task-33

上一轮六条主张里 ①②③④⑤ 经红队独立验证通过；本轮处理红队新发现的 4 条 + 1 条验收面问题。

---

## 0. 汇总

| # | 缺陷 | 级别 | 状态 | 修后判据 |
| --- | --- | --- | --- | --- |
| R9-A | `release()` 读不出载荷时按「mtime 是否比我早」判断归属，方向反了 → 可能删掉接管者刚建的锁，造成**两个持有者同时写** | 中（确定性） | ✅ | 读不出载荷**一律不删** + `lost=true`；用例「陌生空锁 + 新 mtime → release 后文件必须仍在」 |
| R9-B | 退避 `sleep` 用 `.unref()` → 短命进程既不拿锁也不报错地静默退出 | 低（会让验证假绿） | ✅ | 去掉 `.unref()`；用例「短命进程必须以 503 超时错误退出（exit 3 + 打印 reason）」 |
| R9-C | 只看 mtime/本地时钟、无心跳 → 可夺走**活着**的持有者；临界区超过 staleMs 会被夺 | 中 | ✅ | 载荷 `at` 纳入交叉校验（分歧 > 5s → 判 `suspicious`，**不接管**）+ 心跳续期（`staleMs/3`，至少 1s）；时钟假设写进代码注释与本文 §4 |
| R9-D | `RTK_LOCK_DISABLED` 旁路不可观测 | 中 | ✅ | `info.disabled=true`、响应 `lockDisabled:true`、进程级一次性 `console.warn` |
| R9-E | 载荷 `home` 从不校验 | 低 | ✅ | 跨 home 共用备份目录时只接管**已死**进程的锁（`foreignHome` + 不基于超时接管），并在 note 里说明 |
| 验收面 | `test:magpie` 逐文件枚举，新增 `server/rtkX.test.ts` 会被静默排除 | — | ✅ | 改成 `server/rtk*.test.ts`，新增 `server/rtkLock.test.ts` 已被收纳（本次 87 用例） |

验证汇总（全部 exit 0）：

```
npm run test:magpie → ℹ tests 87 · pass 86 · fail 0 · skipped 1     exit 0
npm test            → ℹ tests 606 · pass 605 · fail 0 · skipped 1   exit 0
npx tsc -b --pretty false                                           exit 0
npm run build       → ✓ built in 635ms                              exit 0
npm run lint        → 仅既有 server/nativeResponses.ts:200/203 告警  exit 0
```

---

## 1. R9-A（必修）：release() 不得删除读不出载荷的锁

**修前复现**（红队给出的完整路径；我用**忠实还原旧实现**的方式复跑，见 §6.1）：

```
H 持有锁 → H 被判陈旧 → T 删掉 H 的锁并 open('wx') 建了新文件（此刻文件空、mtime 新）
→ H 才走到 release()：旧实现看「mtime 是否早于 startedAt-1s」→ 新的 mtime 判为「不是我」→
   ……但旧逻辑在 mtime 更新时**继续往下走并 fs.rmSync(lockPath)** → 删掉 T 的锁
→ T 往已 unlink 的 inode 写、自认持锁，而路径已空 ⇒ 两个持有者同时写
```

**修法**（红队建议的最小改动）：`release()` 里 `readLockPayload()` 返回 null（文件不存在 / 空 / 内容不可解析）时**一律不删**，只置 `lost = true` 告知调用方「你已不再持锁」；回收交给陈旧判据（不可解析 + 5s 后可接管）。

**修后证据**：

```
=== 修前（忠实还原旧 release）：node --test --test-name-pattern="R9-A 陌生空锁" server/rtkLock.test.ts
ℹ pass 0 · fail 1     AssertionError: 读不出载荷时必须如实上报 lost
=== 修后：同一用例
ℹ pass 1 · fail 0
```

用例内容：acquire → 自己把锁文件删掉并写一个**空文件（新 mtime）**→ `release()` → 断言 `lost === true` 且**文件仍在**；另一条用例覆盖「H 陈旧 → T 接管 → T 的载荷不得被改写」。

---

## 2. R9-B：退避 sleep 不能 unref

**修前复现**：

```
=== 修前（把 .unref?.() 加回去）：node --test --test-name-pattern="R9-B 短命进程" server/rtkLock.test.ts
✖ R9-B 短命进程在锁被占用时必然得到 503 超时错误 · ℹ pass 0 · fail 1
```
子进程（`node --import tsx -e …`，锁被别人占着、`timeoutMs=800`）在旧实现下**直接退出、既不拿锁也不打印错误**——红队的验证脚本正是卡在这里。

**修法**：`const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms) })`（去掉 `.unref()`），并加注释说明原因。

**修后证据**：✅ 用例通过 —— 子进程 `exit code = 3`、stdout 打印 `ERROR rtk_lock_timeout`，且**没有删除别人的锁**（断言锁文件内容仍属于原持有者）。

---

## 3. R9-C：时钟假设、at 交叉校验与心跳

**修前复现**（红队：把**活着**的持有者锁 mtime 改老 2h → `stolen=true`）：

```
=== 修前（去掉 at×mtime 交叉校验）：--test-name-pattern="R9-C 活着的持有者"
✖ ℹ pass 0 · fail 1
```

**修法**（两处）：

1. **`at` 纳入交叉校验**（此前 `at` 写了却从未使用）：`|Date.parse(at) - mtime| > 5s` → 判 `suspicious`，**不接管**，note 写明「按时钟不可信处理，需要人工确认持有者 pid」。因此「只改 mtime」不再能夺锁；`holder_dead`（pid 不存在）仍然优先，不受时钟影响。
2. **心跳续期**：持锁期间每 `max(1000, staleMs/3)` 毫秒重写载荷（`at` 更新 + 原子 rename 刷新 mtime，token 不变），于是**临界区超过 staleMs 也不会被误夺**。

**时钟假设（写进代码注释与本文）**：

- 判定只使用**本机时钟**与文件 mtime；载荷 `at` 仅用于交叉校验；
- 参与互斥的两个实例**必须共享同一时钟**（同机，或同一 VPS 上时钟同步的容器）。**跨主机 / 时钟偏移超过 5s 的场景不支持**：此时 `at` 与 mtime 分歧 → 我们选择不接管（宁可等超时报错，也不夺走活着的持有者）；
- `holder_dead` 判据不依赖时钟，因此在时钟异常时仍能回收「进程已死」的残留锁（这正是 runbook §4 双实例健康检查最可能遇到的形态：第二实例退出后留下的锁）。

**关于「临界区超过 staleMs」**：本机写入的临界区是「快照 + rtk CLI + 校验」，实测 10–60ms（慢盘/杀毒扫描可达数百毫秒）；远端平面走 HTTP，不经过本机锁。有了心跳后，即使 CLI 卡住数分钟也不会被夺；真正卡死的进程由 `holder_timeout`（需 at/mtime 一致过期）或 `holder_dead` 回收。

**修后证据**：

```
✔ R9-C 活着的持有者 mtime 被改老 2h：at 与 mtime 分歧 → 不接管，只告警
✔ R9-C 心跳：临界区超过 staleMs 也不会被夺走，释放后下一个才能拿到
   （staleMs=1000，持有 2.5s：他人 acquire 必须 rtk_lock_timeout，而不是 stolen）
```

---

## 4. R9-D：旁路必须可观测

**修前复现**：`RTK_LOCK_DISABLED=1` 时不建锁文件，但 `info` 与「一次就拿到锁」完全无法区分（`✖ ℹ pass 0 · fail 1`）。

**修法**：`RtkLockInfo` 增加**必填** `disabled`；旁路分支照常返回（`release` 为空操作），并打一条**进程级一次性** `console.warn`；`POST /api/rtk/toggle` 的响应新增 `lockDisabled: true` 与 `lock.disabled`。

**修后证据**：✅ 用例断言 `lock.info.disabled === true`、不创建锁文件、`setRTKAgentHook` 响应里 `lockDisabled === true`。
**生产不得设置**：当前 launchd 环境里 `RTK_LOCK_DISABLED` 出现次数 = **0**（§7 抽验④），属安全状态；文档与代码注释都标注了这一点。

---

## 5. R9-E：home 字段校验

**修法**：载荷 `home` 参与判定——若与本次不同（两个 home 共用同一个 `RTK_BACKUP_DIR` 的场景），视为 `foreignHome`：

- **不基于超时接管**（note 说明是另一个 home 的锁，请人工确认）；
- 但**持有者已死时仍可接管**（`holder_dead` 优先）。

**修后证据**：✅ 用例「跨 home 的活锁不基于超时接管（`foreignHome:true`） + 持有者已死仍可接管」。

---

## 6. 逐条修前/修后证据汇总

### 6.1 修前复现（把修复逐条还原后跑新用例）

方法：临时把对应修复改回旧行为 → 跑新用例 → 记录失败 → 还原修复版（脚本 `/tmp/r9-prerevert.py`，R9-A 用忠实还原的旧 `release()` 整段替换）。

| 还原项 | 结果 |
| --- | --- |
| R9-A（旧 `release()`：mtime 方向判断 + 继续删除） | `✖ ℹ pass 0 · fail 1` — `AssertionError: 读不出载荷时必须如实上报 lost` |
| R9-B（`sleep` 加回 `.unref?.()`） | `✖ ℹ pass 0 · fail 1` — 子进程静默退出 |
| R9-C（去掉 at×mtime 交叉校验） | `✖ ℹ pass 0 · fail 1` — 活锁被夺 |
| R9-D（`info` 不带 `disabled`） | `✖ ℹ pass 0 · fail 1` — 旁路不可观测 |

还原修复版后同样四条用例全部 `✔`（§1–§5 各自的修后证据）。

### 6.2 验收面：`test:magpie` 的 glob

`package.json` 只改这一行（Lead 本次授权）：

```diff
-"test:magpie": "node --test --test-timeout=30000 --import tsx server/magpie*.test.ts server/rtkService.test.ts server/modelSync.test.ts"
+"test:magpie": "node --test --test-timeout=30000 --import tsx server/magpie*.test.ts server/rtk*.test.ts server/modelSync.test.ts"
```

验证：新增真实用例文件 `server/rtkLock.test.ts` 后，`npm run test:magpie` 的用例数从 **80 → 87**，且输出里能看到 `✔ R9-A …`、`✔ R9-B …` 等新用例 —— 证明新文件确实被收纳（不是「改了 glob 但没生效」）。`--test-timeout=30000` 未回退。

---

## 7. 真实配置零改动自证与重启抽验

所有测试与复现都使用临时 `RTK_HOME`/`RTK_BACKUP_DIR`；`server/rtkService.test.ts` 与 `server/rtkLock.test.ts` 的 `after()` 都会比对真实 agent 配置的 sha256。本轮跑完（含 npm test 606 用例）后：

| 文件 | sha256 |
| --- | --- |
| `~/.codex/hooks.json` | `d234642427dd4c2ed1fca3f7dc98ad14106d9d5981dfd92327b03aa5858eec47` |
| `~/.claude/settings.json` | `c08f957851d68845cff776ca9b15c22409c86fa10ab049667936c44347eaebe4` |
| `~/.cursor/hooks.json` | `4734d152efa28ffb02d88f1a0ab99a6a7f650fe4e510b8f58d50b63a1b2d275c` |
| `~/.gemini/settings.json` | `196e2dca8dacab1bff3a41f8b14bb1f7607f38d221136f4c0278c7d3c809f811` |
| `~/.omp/agent/extensions/rtk.ts` | `d1555e0af5872a30ed04059423350bdb38302f200a9642c5a9bcc519c95a2257` |
| `~/.pi/agent/extensions/rtk.ts` | `d1555e0af5872a30ed04059423350bdb38302f200a9642c5a9bcc519c95a2257` |

服务端改动已按新规矩重启（取 `/tmp/cac-build.lock` 串行执行，**等待**队友用完而不是抢），并对运行实例抽验（必然被拒绝的输入，零写入）：

```
$ curl -X POST /api/rtk/toggle -d '{"agent":"windsurf","on":true,"plane":"local","confirm":true}'
  → 501 {"error":"Windsurf 在 rtk 0.50.0 只能按项目初始化…","plane":"local","reason":"project_scoped_only"}
$ curl -X POST /api/rtk/install -d '{}'
  → 501 {"error":"控制台不代为安装本机 rtk…","reason":"local_install_not_supported"}
$ curl /api/rtk/status
  → {"plane":"local","backupKeep":10,"backupGraceMs":120000,"backupOrphans":0}
$ ls ~/.agents/crosery/magpie-console/rtk-write.lock
  → No such file or directory                     （运行实例无残留锁）
$ launchctl print gui/501/com.crosery.console-magpie | grep -c RTK_LOCK_DISABLED
  → 0                                             （生产未开旁路）
```

---

## 8. 改动文件

| 文件 | 说明 |
| --- | --- |
| `server/rtkService.ts` | R9-A 释放语义、R9-B 去 unref、R9-C at 交叉校验 + 心跳 + 时钟注释、R9-D `disabled` 字段与告警与 `lockDisabled` 响应、R9-E home 校验 |
| `server/rtkService.test.ts` | 「活着但超时」用例改为 at/mtime 一致过期（旧的只改 mtime 语义已被 R9-C 废止） |
| `server/rtkLock.test.ts`（新增） | 7 条 R9 回归用例（A×2 / B / C×2 / D / E），同时用于验证 `test:magpie` 的 glob |
| `package.json` | 仅 `test:magpie` 一行：`server/rtkService.test.ts` → `server/rtk*.test.ts` |
| `docs/qa/blue/rtk-lock-r9-fixes.md` | 本文件 |

未碰 `server/index.ts`、其它 `server/*.ts`、`src/**`、`MANIFEST.sha256`、`RELEASE.json`；未新增生产依赖。

---

## 9. 仍未验证 / 限制

1. **跨主机 / 时钟偏移**：不支持（§3 的时钟假设）。若将来要在两台机器间互斥，需要带租约（lease）与单调时钟的方案，而不是文件 mtime。
2. **NFS/SMB**：`O_EXCL` 的原子性依赖服务端实现，未验证（当前本机 APFS）。
3. **心跳间隔下限 1s**：`staleMs` 配得比 3s 还小时，心跳可能比锁的判定阈值慢；测试里用的 `staleMs=1000` 仍能保持（心跳 1s ≤ 阈值 1s，边界），但**不建议把 `RTK_LOCK_STALE_MS` 设到 3000 以下**（已在代码里用 `Math.max(1000, staleMs/3)` 兜底）。
4. `release()` 现在对「文件不存在」也报 `lost = true`（语义是「你已不再持锁」），调用方据此如实上报；这不影响正常路径（正常路径自己的锁一定读得出来）。
5. 红队第九轮报告里的**响应式/UI 部分**不在本任务范围（`src/**` 是蓝队 B 的范围）。
