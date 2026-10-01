# RTK 本机写入的跨进程互斥（task-30 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 关联：`docs/qa/deploy/release-runbook.md` §4（第二实例健康检查）、task-16 交付 `rtk-round3-fixes.md`

---

## 0. 结论摘要

| 项 | 结果 |
| --- | --- |
| 跨进程互斥 | 已实现：`<状态目录>/rtk-write.lock`，`fs.open(…, 'wx')` + 退避重试 + 陈旧锁接管 |
| 与进程内锁的顺序 | 固定「① 进程内闸 → ② 文件锁」，无等待环（论证见 §2） |
| 可观测 | 写操作响应带 `lockWaitMs` / `lockStolen` / `lockLost` / `lock{path,waitedMs,stolen,lost,stolenFromPid?,stolenFromAgeMs?}` |
| 双实例并发（有锁） | 12 路交叉并发 + 3 轮连带竞态：**全部一致**（最终态=最后成功写入、backupId 都在、无非法 JSON、无残留锁） |
| 对照（去掉锁） | **复现出不一致**：round 5/6 —— A 实例 `cursor ON` 返回 200，钩子却被 B 实例的连带还原撤回（详见 §5.2） |
| 真实配置 | 6 个 agent 配置文件 sha256 全程不变（§6） |
| 验证 | `test:magpie` / `tsc -b` / `build` / `lint` 全部 exit 0（§7） |

---

## 1. 锁的形态

```
默认位置： <home>/.agents/crosery/magpie-console/rtk-write.lock
自定义：   dirname(RTK_BACKUP_DIR)/rtk-write.lock     （与备份目录同源）
           RTK_HOME 决定默认位置；两者都被尊重
内容：     {"token":"<16hex>","pid":12345,"at":"<ISO>","purpose":"toggle codex on","home":"/Users/…"}
```

- 获取：`fs.openSync(lockPath, 'wx', 0o600)`（O_EXCL 原子创建），紧接着写入诊断内容再关闭。
- 释放：`finally` 里调用 `lock.release()`；**只删自己的锁**——先读回内容比对 `token`，不匹配（被接管）或文件已消失则标记 `lost=true` 并放弃删除，绝不删接管者的锁。
- 退避：每次失败后 `8 + rand(22)` ms 重试，上限 `RTK_LOCK_TIMEOUT_MS`（默认 **15000**，可配 0–300s）；超时抛 `RtkPlaneError(503,'local','rtk_lock_timeout')`，错误体带锁路径与持有者 pid。
- 目录不可写等非 EEXIST 错误 → `500 rtk_lock_unavailable`（不假装拿到锁）。

**陈旧锁判定与接管**（`inspectRtkLock()`，阈值 `RTK_LOCK_STALE_MS` 默认 **60000**，可配 1s–3600s）：

| 判据 | reason | 说明 |
| --- | --- | --- |
| 内容里的 pid 已不存在（`process.kill(pid,0)` → ESRCH） | `holder_dead` | 进程被杀留下的残留锁 |
| pid 还活着，但锁文件 mtime 超过 staleMs | `holder_timeout` | 持锁进程卡死（例如 rtk CLI 挂住） |
| 内容不可解析且超过 5s | `unreadable_lock` | 刚 mkdir/open 就被杀，内容没写完 |

接管动作：删除陈旧锁 → 重新尝试 O_EXCL 创建（两个接管者竞争时只有一个能创建成功，另一个继续重试）。接管会在响应里如实上报 `lockStolen: true` 与 `stolenFromPid` / `stolenFromAgeMs`。

---

## 2. 与进程内锁的顺序（死锁论证）

代码里固定顺序：**① 进程内闸 `withFileLock('rtk-local-write:' + home)` → ② 跨进程文件锁**，释放顺序相反（finally 先放文件锁，再放进程内闸，由 `withFileLock` 的 promise 链自然完成）。

- 任何路径都按同一顺序获取，不存在反向获取路径；
- 文件锁的持有者在临界区里只做本地文件写入，**从不等待别的进程的内存锁**（进程内闸是纯内存 promise 链，不会等待文件锁持有者以外的任何东西）；
- 因此等待图不可能成环 → 无死锁。

**为什么不是「先文件锁、再进程内锁」**：同一进程的两个 toggle 会先去抢文件锁，而文件锁被本进程另一个请求整个临界区（含 rtk CLI 调用，实测 10–60ms，慢盘上更长）持有，白白消耗跨进程锁的等待预算，还把两个进程的问题混在一起。先过进程内闸能让同进程请求自然排队，再以「一个进程同时只有一个请求在跨进程临界区里」的状态去竞争文件锁。

**同进程并发没有退化**：新增用例「锁：同进程并发不退化」——6 个 agent 并发 ON，全部成功且都带 `lockWaitMs`，总耗时断言 < 20s（实测百毫秒级）。`rollback` 与 `toggle` 现在共用同一把进程内闸 `rtk-local-write:<home>`（此前 rollback 用的是另一把 key，二者其实并不互斥，本轮一并修正）。

**对照开关**：`RTK_LOCK_DISABLED=1` 跳过文件锁（仅供「去掉锁」的对照实验，正常部署不要设），代码与文档都标注了这一点。

---

## 3. 可观测

`POST /api/rtk/toggle` / `POST /api/rtk/rollback` 的响应新增：

```json
"lockWaitMs": 37,            // 等锁时长（毫秒）；0 = 一次拿到；远端平面恒为 0
"lockStolen": true,          // 仅在本次接管了陈旧锁时出现
"lockLost": false,           // 释放时锁已不属于自己（被接管）
"lock": { "path": "…/rtk-write.lock", "waitedMs": 37, "stolen": true, "lost": false,
          "stolenFromPid": 4711, "stolenFromAgeMs": 12345 }
```

---

## 4. 逐条要求对照

| task-30 要求 | 实现 |
| --- | --- |
| 锁文件放状态目录旁、尊重 `RTK_HOME`/`RTK_BACKUP_DIR` | §1（`rtkLockPath()` = `dirname(rtkBackupRoot(home, env))/rtk-write.lock`） |
| `fs.open(…, 'wx')`、内容含 pid/时间/目的 | §1 |
| 退避重试 + 有上限 | 8–30ms 抖动退避，上限 `RTK_LOCK_TIMEOUT_MS` |
| 陈旧锁判定与接管 + 如实上报 | 三种判据 + `lockStolen`/`stolenFrom*` |
| `finally` 必释放、异常路径不留锁 | 用例「异常路径（409）也必须释放」 |
| 进程被杀后的残留锁自动清理 | 用例「残留锁会被下一次写入自动清理并在响应里上报」（dead pid → 接管 → 写入成功 → 锁文件消失） |
| 与进程内锁不死锁、同进程不退化 | §2 + 用例「同进程并发不退化」 |
| 响应带 `lockWaitMs` | §3 |
| 双实例并发测试 | §5.1 |
| 去掉锁的对照 | §5.2 |
| 真实配置 sha256 | §6 |

---

## 5. 测试与证据

> 说明：新增用例全部放在 **`server/rtkService.test.ts`**（该文件在 `npm run test:magpie` 的 glob 里）。task-30 允许新建 `server/rtkLock.test.ts`，但 `package.json` 的 `test:magpie` 脚本没有 glob 到它，而 `package.json` 不在本任务写范围——为了让新增用例真正进入 `test:magpie` 的验收范围，统一放在既有文件里，并在本文件说明。

### 5.1 双实例并发（有锁）

`server/rtkService.test.ts` 里启动**两个** `server/index.ts` 实例：不同 `PORT`（自动挑空闲端口）与不同 `DATA_DIR`，**同一个 `RTK_HOME` 与 `RTK_BACKUP_DIR`**，登录后交叉并发打同一个 agent：

```bash
$ npm run test:magpie        # 退出码 0
ℹ tests 80 · pass 79 · fail 0 · skipped 1

✔ 双实例并发（有跨进程锁）：最终状态=最后一次成功写入的意图，backupId 都还在，无残留锁
✔ 双实例跨进程「连带还原」竞态：A 的 cursor ON 不得被 B 的 claude OFF 撤回
```

断言（全部通过）：

1. 12 个并发请求（两实例交叉、ON/OFF 混合）**全部 200**，无 5xx；
2. 最终钩子状态 == **最后一次完成**的成功写入的意图；
3. 每个成功响应返回的 `backupId` 目录（含 `manifest.json`）**仍然存在**——另一个进程的轮转没有互删；
4. 并发期间每 4ms 采样一次钩子文件，**非法 JSON 采样数为 0**（原子 rename 写入，不会写出半截）；
5. 结束后 `<状态目录>/rtk-write.lock` **不存在**；
6. 每个成功响应都带 `lockWaitMs`（数值 ≥ 0）。

第二组（连带竞态）每轮：起始 `.claude/settings.json` 带 rtk 钩子、`.cursor/hooks.json` 不存在；A 实例 `cursor ON`、B 实例 `claude OFF` 同时发。3/3 轮都是「cursor 保持挂载 + claude 已关闭」，且无残留锁。

### 5.2 对照实验：去掉文件锁（`RTK_LOCK_DISABLED=1`）

脚本 `/tmp/rtk-collateral-race.mjs`（双实例、同一 `RTK_HOME`、`RTK_BIN` 换成「sleep 80ms 再交给真 rtk」的包装器把临界区放大到可稳定观测；生产上慢盘/杀毒扫描同样会拉长这个窗口）：

```
=== A) 去掉文件锁 (RTK_LOCK_DISABLED=1)   ROUNDS=6
inconsistentRounds = 1 / 6
  round 5:  {"cursorToggleHttp":200, "claudeToggleHttp":200,
             "cursorHookAfter":false, "claudeHookAfter":false,
             "inconsistent":true, "collateralReverted":["claude"]}
```

**不一致的具体形态**：A 实例的 `cursor ON` 返回 200，但 B 实例（`claude OFF`）的快照窗口里落进了 A 的写入，于是 B 把 A 刚打开的
`.cursor/hooks.json` 当成「rtk 的连带改动」撤回 —— 响应说成功，磁盘上却没有。这正是 task-30 预判的风险（跨进程版的 task-16 P1-a 竞态）。

同一脚本、同一参数、**有锁**再跑一遍：

```
=== B) 有文件锁（默认）                  ROUNDS=6
inconsistentRounds = 0 / 6
  每轮：cursorHookAfter=true, claudeHookAfter=false（两边意图都正确落地）
```

另一组更基础的对照（`/tmp/rtk-nolock-control.mjs`，12 路同一 agent 的 ON/OFF，无锁）跑 5 轮**没有**复现出「最终态 ≠ 最后写入意图 / backupId 被互删 / 非法 JSON」——
如实记录：这类「同一 agent 双向覆盖」的竞态在当前时序下不稳定复现（原子 rename 让文件永远合法，响应顺序≈落盘顺序），
**能稳定复现的是 5.2 的连带还原竞态**（不同 agent 交叉）。

### 5.3 单元级锁行为用例（全部通过）

`✔ 锁：基本获取/释放，内容可诊断，释放后无残留` · `✔ 持锁进程已死 → 接管并如实上报 stolenFromPid` ·
`✔ 持锁进程还活着但超时 → 也算陈旧并可接管` · `✔ 等待超时 → 503 rtk_lock_timeout，且不删别人的锁` ·
`✔ 释放时锁已被接管 → 不删别人的锁并上报 lost` · `✔ 进程被杀留下的残留锁会被下一次写入自动清理，并在响应里如实上报` ·
`✔ 异常路径（409）也必须释放，不留残留锁` · `✔ 同进程并发不退化` · `✔ RTK_LOCK_DISABLED=1 时不创建锁文件`

---

## 6. 真实配置零改动自证

所有测试/对照都使用临时 `RTK_HOME`（`mkdtemp`）与临时 `RTK_BACKUP_DIR`；跑完后真实配置逐字节不变：

| 文件 | sha256 |
| --- | --- |
| `~/.codex/hooks.json` | `d234642427dd4c2ed1fca3f7dc98ad14106d9d5981dfd92327b03aa5858eec47` |
| `~/.claude/settings.json` | `c08f957851d68845cff776ca9b15c22409c86fa10ab049667936c44347eaebe4` |
| `~/.cursor/hooks.json` | `4734d152efa28ffb02d88f1a0ab99a6a7f650fe4e510b8f58d50b63a1b2d275c` |
| `~/.gemini/settings.json` | `196e2dca8dacab1bff3a41f8b14bb1f7607f38d221136f4c0278c7d3c809f811` |
| `~/.omp/agent/extensions/rtk.ts` | `d1555e0af5872a30ed04059423350bdb38302f200a9642c5a9bcc519c95a2257` |
| `~/.pi/agent/extensions/rtk.ts` | `d1555e0af5872a30ed04059423350bdb38302f200a9642c5a9bcc519c95a2257` |

（`server/rtkService.test.ts` 里 `after()` 钩子另外断言 10 个真实 agent 文件的 sha256 与测试开始时一致；
`rtkLock.test.ts` 未新建，理由见 §5 开头。）

---

## 7. 验证命令与退出码

```
$ npm run test:magpie   → ℹ tests 80 · pass 79 · fail 0 · skipped 1     exit 0
$ npx tsc -b --pretty false                                             exit 0
$ npm run build         → ✓ built in 614ms                              exit 0
$ npm run lint          → 仅既有 server/nativeResponses.ts:200/203 两条告警   exit 0
```

服务端改动已按规矩重启并对**运行实例**抽验（用必然被拒绝的输入，零写入）：

```
$ launchctl kickstart -k gui/501/com.crosery.console-magpie    # 取 /tmp/cac-build.lock 串行执行
$ curl -X POST /api/rtk/toggle -d '{"agent":"windsurf","on":true,"plane":"local","confirm":true}'
  → 501 {"error":"Windsurf 在 rtk 0.50.0 只能按项目初始化…","plane":"local","reason":"project_scoped_only"}
$ curl -X POST /api/rtk/install -d '{}'
  → 501 {"error":"控制台不代为安装本机 rtk…","reason":"local_install_not_supported"}
$ curl /api/rtk/status
  → {"plane":"local","backupKeep":10,"backupGraceMs":120000,"backupOrphans":0}
$ ls ~/.agents/crosery/magpie-console/rtk-write.lock
  → No such file or directory      （运行实例没有留下锁文件）
```

---

## 8. 未验证 / 限制

1. **网络文件系统**：`O_EXCL` 在 NFS/SMB 上的原子性依赖服务端实现（NFSv3 上历史上不可靠）。当前部署是本机 APFS，未验证网络盘；若把 `RTK_BACKUP_DIR` 指到网络盘，锁的语义需要重新验证。
2. **多主机**：锁是「同一文件系统上的多个进程」互斥，不是跨主机互斥（两台机器各自写自己的 HOME 时互不相关，也不该相关）。
3. **接管窗口内的极小竞态**：判定「陈旧」与「删除」之间没有 CAS（先读内容、再 unlink），理论上存在「刚被判陈旧、但原持有者恰好完成并释放/重建锁」的窗口。实际影响有限：删除后重新 O_EXCL 创建，失败者继续退避重试；且陈旧判据本身要求持有者已死或超时。要彻底消除需要 `flock`/`fcntl` 级别的锁（Node 需要原生依赖，任务禁止新增生产依赖），已在代码注释与本文件写明。
4. **`RTK_LOCK_DISABLED` 是测试后门**：只用于对照实验；生产环境不应设置（若被误设，行为回到 task-16 的进程内锁）。
5. **对照实验用的是「加宽临界区」的包装器**：真 rtk 在慢盘/被杀毒扫描时也会变慢，但生产环境是否会出现同样长的窗口，取决于磁盘与安全软件，未在 VPS 上实测。
6. 窗口内 `getRTKStats`（`rtk gain`/`--version`）仍可能被 `RTK_BIN` 指向的慢包装器影响；这是测试夹具特性，不是产品行为。
