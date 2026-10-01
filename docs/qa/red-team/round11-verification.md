# Crosery API Console — 第十一轮复验：心跳修复 / 窄屏与标题 / 扫描器第 4 次加固（红队 B / task-39）

**被验对象**：`d698ffb`（心跳 R10-A/B 修复）、`137ceb9`（窄屏表格 + h1 降级）、`e306150`/`fbb84db`/`2fb1035`（扫描器第 4 次加固）
**取证时 HEAD** `2fb1035`｜**实例** <http://127.0.0.1:8791>｜**dist** `2026-10-01 12:47:48`｜dist 不早于 src → **0 个**
**审计人** `ux-auditor` / task-39｜**实测时点** 2026-10-01 12:48–13:30｜浏览器 TaskSpace 共 **2 个**，每个**恰好 1 次** `finish({keep:[]})`
**写入边界**：只写 `docs/qa/red-team/**`。**仓库文件 0 改动**（破坏性实验全部在 `/tmp` 副本）。真实 agent 配置零改动、生产零写入。

> **快照边界**：`git status` 在收尾时**干净**（仅有既存的 `public/tuffex-dashboard-preview.png`），说明本轮**没有并发队友的未提交改动**混入我的测量 ✓。

---

## 0. 结论速览

### (A) `d698ffb` 心跳修复

| 主张 | 判定 |
|---|---|
| ① 续期前 **token + inode 双校验**，不匹配 → 不续期 + 停表 + `lost` + `lostReason` | ✅ **已验证**（我上轮的 R10-A 攻击**不再成立**：接管者的 token 原样保留，持有者报 `lost:true / token_mismatch`） |
| ② 写回是「校验 → 写临时 → 再校验 → rename」 | ✅ **已验证**（**300 次定向压测 0 次覆盖**；窗口已缩到 ≤2 个系统调用，且**结构上不可再缩小**——见 §2.2） |
| ③ 续期失败可见（`renewFailures`/`renewLastError`），连续 3 次降级 `lost`，清理 `*.renew-*` | ✅ **已验证**（实测 `renewFailures:3 / renewLastError:"EACCES" / lost:true / renew_failed`，之后心跳**确实停了**） |
| ④ `rtkLockHeartbeatMs()` 保证 200ms ≤ interval ≤ staleMs | ⚠️ **strandedMs ≥ 200 时成立**（实测 60000→20000、3000→1000、1000→333）；`staleMs < 200` 时下限 200 会超过阈值，但 `rtkLockStaleMs()` 把 env 值下限钳在 1000 ⇒ **经 env 不可达**（§2.4） |
| `sweepStaleRenewTemps()` 不误删进行中的续期临时文件 | ✅ **已验证**（新建的临时文件**存活**；120s 前的才被清） |

**我找不到能再打进去的门**；但确认了一条**设计边界**（不是回归）：`lost` 只是**被上报**，**没有阻断已经开始的写入**（§2.1）。

### (B) `137ceb9` 窄屏与标题

| 主张 | 判定 |
|---|---|
| ① `/cache` 窄屏可横向滚动、11 列全可达 | ✅ **已验证**（768/390/**320** 三档：`overflow-x:auto`、可滚到最右、**最后一列「耗时」完整可见**） |
| ② `/ab` 可见 h1 = 1，内嵌降级 h2 且**视觉签名不变** | ✅ **已验证**（5 种 URL 变体 h1 均 = 1；两个内嵌标题变 h2；h2 签名集合**包含** h1 的 `22px|600|30px`） |
| ③ `/keys` 未被改坏 | ✅ **已验证**（`/keys`、`/dashboard`、`/help`、`/rtk`、`/usage`、`/models` 各 h1 = 1） |
| 「将来加列不会再静默裁掉」 | ✅ **已验证**（我**在运行时注入**一个 260px 新列：表格 760 → **992.203px**、描边宽度随之增长、`overflow-x` 仍 `auto`、新列**可达**；`--table-min` 是 `min-width` 下界不是上限 —— §3.2） |

### (C) 扫描器第 4 次加固

| 加固项 | 判定 |
|---|---|
| 渲染判据现在**真的会执行**且失败可见 | ✅ **已验证**（拦掉 bundle → `failing:98, renderFailures:98`，**退出码 1**） |
| 容器裁剪现在**真的会报** | ✅ **已验证**（我把 `/cache` 的**修复前形态**在运行时还原 → `silentlyTruncatedTotal:16`，**退出码 1**） |
| 登录重试**不掩盖**真正的登录失败 | ✅ **已验证**（错密码 → `waitForURL` 超时 → **退出码 2**；两个脚本各测一次） |
| **还有假绿吗？** | **本轮没找到**。我先**怀疑**「`renderFailures` 没接进退出码」，实测**被推翻**（§4.6 如实记录）；只留下一条**低危**：`ego-browser` 包装器把内层 `2` 折叠成 `1`，两者都非 0（门禁仍会失败），但丢掉了「1=有发现 / 2=没量成」的区分（§4.7） |

**本轮新发现**：**R11-A（低）** 心跳区间在 `staleMs < 200` 时违反自身不变量（经 env 不可达）；**R11-B（低）** 退出码语义在 `ego-browser` 包装层丢失；**R11-C（中，设计边界）** `lost` 不阻断写入（§2.1）。

---

## 1. (A) 心跳修复：逐条实测

全部在临时 `RTK_BACKUP_DIR` + 显式 `env` 下调用真实 `acquireRtkFileLock`，并加 `setInterval` 保活（避免 R9-B 那类提前退出）。

### 1.1 ① 重放我上轮的 R10-A 攻击：**已堵住** ✅
```
1 REPLAY R10-A (in-place steal, same inode):
  {"lockToken":"THIEF-TOKEN","ownerLost":true,"lostReason":"token_mismatch",
   "clobbered":"FIXED (thief token intact)"}
```
- 我用的是**原地址改写**（`writeFileSync` 覆盖同一个 inode），所以 `ino` **没变** —— 这恰好证明**拦截它的是 token 校验**，而不是 inode。
- 持有者侧：`lost: true`、`lostReason: "token_mismatch"` ✓，并打印告警
  `[rtk] 写入锁已不再属于本进程（token_mismatch），后续不再续期、也不删除他人的锁（锁：…）` ✓

### 1.2 心跳在 `lost` 之后**真的停了** ✅
```
1b after lost（再等 4s ≈ 4 个心跳周期）: {"lockToken":"THIEF-TOKEN","newWarns":0,"lostReason":"token_mismatch"}
1c release after lost deleted the lock? {"lockStillThere":true}
```
→ 4s 内 **0 条新告警**、token 未被再次改写 ⇒ `clearInterval` 生效、**没有「继续跑并再次覆盖」** ✓；且丢掉锁之后 `release()` **不会删别人的锁** ✓

### 1.3 换 inode 的接管路径同样被拦 ✅
```
2 steal with new inode（rm + 新建）: {"lockToken":"THIEF2","ownerLost":true,"lostReason":"token_mismatch","clobbered":"FIXED"}
```
→ 双校验两条路径都工作。**inode 复用能不能骗过双校验？我的判断是不能**：inode 只是「文件被重建过」的快速信号，**token 在两次校验里都被比对**，而 token 是 8 字节随机；即使文件系统把刚释放的 inode 立刻复用（`ino` 相同），第二次比对仍会因 token 不同而返回 `stolen`。反过来 `ino === undefined`（`statSync` 失败）时代码**跳过多校验、只比 token**，也是安全的（§9 判据）。

### 1.4 ③ 续期失败可见 + 连续 3 次降级 ✅
用**确定性的等价手段**让续期永远失败：把锁目录 `chmod 0o500`（只读）→ 临时文件写入 `EACCES`。
```
3 R10-B renew failures visible + degrade:
  {"renewFailures":3,"renewLastError":"EACCES","lost":true,"lostReason":"renew_failed"}
3b after renew_failed（再等 2.5s）: {"newWarns":0,"renewFailures":3}     ← 已停表
```
→ 与我上轮「静默吞掉」完全相反：**次数、最后错误、降级、告警**都可见，且**达到阈值后停止续期** ✓
（注：临时文件名现在是 `${lockPath}.renew-${pid}-${random3}`，所以我无法再用「预先占位同名目录」的办法破坏它；改用目录权限，效果等价。）

### 1.5 `sweepStaleRenewTemps()` **不会**误删正在进行的续期 ✅
```
4 sweepStaleRenewTemps: {"freshSurvived":true,"oldRemoved":true,
   "removedFresh":[], "removedOld":["rtk-write.lock.renew-99999-oldold"]}
```
三重保护共同成立：① 新建的临时文件**存活**；② 120s 前的残留**被清**；③ 续期写临时→rename 在**同一个同步 tick** 内完成（寿命微秒级），而清理阈值是 `max(30s, staleMs)`；④ 文件名带随机后缀，不会与下一次续期互撞 ✓
**另一个我推演的安全边界**：若持有者在 `writeFileSync(temp)` 与 `rename` 之间被 `SIGSTOP`，临时文件会被后来的清理器删掉；恢复后 `renameSync` 抛 `ENOENT` → 进入失败计数 → 3 次后 `lost=renew_failed`，**不会覆盖接管者** ✓

### 1.6 ④ 心跳区间钳制 ✅（附一条边界说明）
```
0 heartbeatMs clamps: {"stale=60000":20000,"stale=3000":1000,"stale=1000":333,"stale=200":200,"stale=100":200}
```
`rtkLockHeartbeatMs = max(200, min(floor(staleMs/3), max(200, staleMs)))`
- `staleMs ≥ 200`：`interval ≤ staleMs` ✓（60000→20s、3000→1s、1000→333ms）
- **`staleMs < 200`：下限 200 会 > `staleMs`** ⇒ 心跳比阈值还慢，锁会在两次心跳之间被合法夺走（**R11-A，低**）。
  缓解事实：`rtkLockStaleMs(env)` 把配置值钳在 **1s–1h**（`< 1000` 回落 60000），所以**经环境变量不可达**；只有显式传 `staleMs < 200` 的调用方（目前只有测试）会踩到。**建议**：把下限也纳入 `min()`，即 `min(max(200, floor(staleMs/3)), staleMs)`，或让 `staleMs` 形参也钳到 ≥200。

---

## 2. (A) 我认为仍要注意的三点

### 2.1 🟠 R11-C（中，**设计边界**，非回归）`lost` 只被**上报**，不**阻断**已经开始的写入
`grep` 全部 `lost` 使用点显示：`info.lost / lostReason` 只被**序列化进响应**（`lockLost`/`lockLostReason`，`rtkService.ts:1782-1784`、`:1853-1854`），**写入路径没有任何一处因 `lost` 而中止**。
后果：**合法接管**（H 停顿超过 `staleMs`，T 依判定接管）发生时，H 的写入**仍会跑完**（快照 → CLI → 验证 → 连带还原）。于是我在第九轮记录的**跨 agent 连带还原竞态**（§5.2：B 把 A 刚写的钩子当成连带改动撤回）在**接管之后依然可能发生**——只是这次**事后会被标记** `lockLost: true`，而不是被阻止。
**这不是本次修复的缺陷**（心跳修复解决的是「心跳**主动**把锁抢回来」这一类）；它是**租约型锁的固有边界**：租约到期后，旧持有者的写入无法被收回，除非在**提交点**校验一个**单调递增的 fencing token / generation**（例如接管时把 generation +1 写进锁，写盘前再比一次，不一致就放弃写入）。
**建议**：在交付文档里明确写「本锁保证的是**不会因为心跳而互相覆盖**；租约到期后的重复写入只能被**上报**（`lockLost`），不能阻止」，并评估是否需要在 RTK 写入的提交点加 generation 校验。**运维/发布流程**若依赖「同一 agent 不会被两个实例同时写」，就要知道这条边界的存在。

### 2.2 ② 的残余窗口：**300 次定向压测 0 次命中**，且结构上不可再缩小
```
5 hammer the verify->rename window: {"attempts":300,"clobbers":0,
   "verdict":"not reproducible (window <= 2 syscalls)"}
```
我用 `staleMs=1000`（心跳 333ms）× 12 轮 × 每轮 25 次「随机时刻用新 token 覆盖锁」共 300 次尝试，**0 次**观察到心跳把接管者的 token 改回。
**为什么打不进去**：第二次 `ownsLock()` 与 `renameSync` 之间只隔**一个系统调用**，且 JS 单线程——除非 T 恰好在这两个调用之间完成「unlink + create + write」，否则必被发现。
**但要如实说清**：`rename` 本身是**盲目覆盖**的，所以**窗口不是 0**，只是窄到实用上打不进去（我 300 次没打进去 ≠ 不可能）。要做到零窗口需要 `renameat2(RENAME_NOREPLACE)`（Linux 专有，Node 未暴露）或基于 `link()` 的 CAS。**结论**：当前实现把窗口从「一个心跳周期」压到「≤2 个系统调用」，**这是没有原生依赖前提下能做到的合理上限**，我认为可以接受并在文档里如实标注（而不是宣称「已消除竞态」）。

### 2.3 文档建议：把「探测器的性质」写准
沿用我上一轮的意见：`at`×mtime 校验是**时钟不一致探测器**（同时伪造 `at` 即可绕过），`ino` 是**文件被重建的快速信号**（token 才是绑定判据）。这些都不影响当前的安全性，但写准了才不会让后续读者高估保护力。

---

## 3. (B) 窄屏与标题：我自己的判据实测

### 3.1 `/cache` 三档窄屏 —— R10-C 已修复，**含他们没测的 320px** ✅
判据：读 `.tx-data-table` 的 `overflow-x`、滚到最右后读 `scrollLeft`，并检查**最后一个表头**的右边界是否落在容器可视区内。

| 视口 | `overflow-x` | client | scroll | maxScroll | 滚到最右 | **最后一列（耗时）可见** |
|---|---|---|---|---|---|---|
| 768 | **auto** | 732 | 760 | 28 | 28 ✓ | **true** ✓ |
| 390 | **auto** | 354 | 760 | 406 | 406 ✓ | **true** ✓ |
| **320（他们未测）** | **auto** | 284 | 760 | 476 | 476 ✓ | **true** ✓ |

→ 表格保持 `--table-min`（760px）**保列宽**，容器横向滚动，**11 列全部可达**；证据截图 `docs/qa/red-team/shots-r11/cache-320-可横滚-桌面.png`。

### 3.2 「将来加列会不会又静默裁掉」——**结论：不会**（用注入实验验证，未改仓库）
我在浏览器里**运行时**给表头与所有表体行各追加一个 `min-width: 260px` 的新列（模拟未来的列），再测：
| 视口 | 表格宽度 | 容器 scrollWidth | `overflow-x` | 滚到最右 | 新列可达 |
|---|---|---|---|---|---|
| 768 | 760 → **992.203px** | 760 → **992** | **auto** | 260 ✓ | **true** ✓ |
| 390 | 760 → **992.203px** | 760 → **992** | **auto** | 638 ✓ | **true** ✓ |
| 320 | 760 → **992.203px** | 760 → **992** | **auto** | 708 ✓ | **true** ✓ |

**机制**（这解释了为什么硬编码 760px 不是天花板）：`--table-min` 落在 **`min-width`**（`layout.css:216-217`：`.tx-data-table.is-scroll-x .tx-data-table__table { min-width: var(--table-min, 0) }`），表格是 **`table-layout: auto`**，容器是 Tuffex 的 **`.tx-data-table.is-scroll-x { overflow-x: auto }`**（我在 `node_modules/@talex-touch/tuffex/dist/lib/data-table/style.css` 里核对到这条规则）。三者组合下，内容**可以超过** 760px，超出部分由容器滚动 ⇒ **加列只会让表更宽、滚动条更长，不会静默裁切** ✓
**残留提醒（低）**：如果将来有人给这张表加 `table-layout: fixed` 或把 `--table-min` 改成 `width`，这个性质就会失效。建议在 `CachePage.vue` 的注释里补一句「**依赖 auto 布局 + overflow-x:auto**，不要改成 fixed」。

### 3.3 `/ab` 标题层级 + 全站 h1 回归 ✅
| URL | h1 数 | h1 文本 | h2 数 | 内嵌页头 |
|---|---|---|---|---|
| `/ab` | **1** | A / B 交互对照台 | 6 | 2×「API Key 管理」（`v=split`）|
| `/ab?flow=keys-access&v=a` | **1** | 同上 | 5 | 1× |
| `/ab?flow=keys-access&v=b` | **1** | 同上 | 5 | 1× |
| `/ab?flow=keys-access&v=split` | **1** | 同上 | 6 | 2× |
| `/ab?flow=nope&v=a`（未知 flow 回落） | **1** | 同上 | 5 | 1× |
| `/keys` · `/dashboard` · `/help` · `/rtk` · `/usage` · `/models` | **各 1** | — | 0/2/8/5/0/0 | — |

- **`/ab` 可见 h1 = 1** ✓（我上一轮报告的是 3）→ **R10-F 已修复**
- **内嵌降级为 h2** ✓，且**视觉签名不变**：全站 h2 的签名集合 = `{15px|600|22px|rgb(21,27,69), **22px|600|30px|rgb(21,27,69)**}` —— 后者**正是 h1 的签名** ⇒ 降级只改了语义层级、没改观感 ✓
- **h1 签名全站唯一**：11 条 URL 的 h1 唯一签名数 = **1**（`22px|600|30px|rgb(21,27,69)|-apple-system`）✓
- **无回归** ✓（六个普通页面各 1 个 h1）

---

## 4. (C) 扫描器第 4 次加固实测（破坏性实验全在 `/tmp` 副本）

**退出码取法（这次做对了）**：`cat /tmp/copy.mjs | ego-browser nodejs > log 2>&1; echo $?` —— 管道**以 `ego-browser` 结尾**，所以 `$?` 就是它的退出码（上一轮我错用了 `| tail`，取到的是 `tail` 的）。

| 实验 | 改动（仅 `/tmp` 副本） | 结果 | 判定 |
|---|---|---|---|
| **A 基线** | 无（跑仓库脚本原样） | `{"checked":98,"failing":0,"renderFailures":0,"silentlyTruncatedTotal":0}`，退出码 **0** | ✅ 当前树无假阳性 |
| **B 空白页** | 登录后 `Network.setBlockedURLs(["*/assets/*.js","*/assets/*.css"])` | **98 条 `renderFailed`**；`{"checked":98,"failing":98,"renderFailures":98,…}`；**退出码 1** | ✅ **R10-D 已修且已接进门禁** |
| **C 修复前形态** | 每条路由探针前把 `.tx-data-table` 强制 `overflow-x:hidden` + 表格 `min-width:0` | `{"checked":98,"failing":16,"silentlyTruncatedTotal":16}`，样本 `tx-data-table.is-hover, overflowBy 20/276, silent:true`；**退出码 1** | ✅ **R10-E 已修且已接进门禁** |
| **D 错密码（viewports）** | 密码改成 `…-wrong-password` | `[error] Error: page.waitForURL timed out … last URL was "…/login"`；**退出码 2** | ✅ 登录重试不掩盖真失败 |
| **E 错密码（contrast）** | 同上 | 同上，**退出码 2** | ✅ |

### 4.6 我本轮**差点报错**的一条：`renderFailures` 没接进退出码？—— **被实测推翻**
我先只读了 `qa-viewports.mjs:140` 的 `if (failing > 0) exitCode = 1;`，看到它**只检查 `failing`**，于是怀疑「`renderFailures` 只是被统计、没被门禁」——如果成立，拦掉 bundle 就会 `renderFailures:98` 却 **退出码 0**（正是你最不想要的假绿）。
**实测把它推翻了**：实验 B 的 `failing` 是 **98**（不是 0），退出码 1。回读源码找到了原因——渲染失败分支里除了计数还有一句 `failing += 1`（`:116-120`）：
```js
if (!rendered) { renderFailures += 1; failing += 1; console.log({... renderFailed: true }); continue }
```
`qa-contrast.mjs` 同构（`:156-160` 的 `renderFailures += 1; total += 1;`，`:176` 的 `if (total > 0) exitCode = 1`）。
**记录这条的意义**：只读一行的条件就下结论会误报；**计数点可能在别处**。我把「未证实」和「已推翻」分开写在这里，而不是当成发现上报。

### 4.7 🟡 R11-B（低）退出码语义在 `ego-browser` 包装层被折叠：**2 → 1**
| 实验 | 我的启动器 `$?` | ego 自报的内层退出码 |
|---|---|---|
| A | 0 | （无 → 0） |
| B | 1 | **1** |
| C | 1 | **1** |
| D | **1** | **2** |
| E | **1** | **2** |

→ 两个脚本刻意区分 **1 = 有发现** 与 **2 = 没能量成（异常）**，但 **`ego-browser` 包装器只把非 0 统一成 1**。
**影响**：门禁**仍然正确**（失败必非 0，不会放行）；但**丢失了「是发现了问题，还是扫描本身挂了」的区分**。如果要保留语义，CI 需要读脚本自己打印的摘要行/`ego's nodejs process exited with code N` 这一行，而不是只看包装器状态。**建议**：在 `scripts/` 里加一层极薄的 runner（或让 CI 抓那行日志）来保留 1/2。

### 4.8 残留盲区（我仍未覆盖的）
1. **容器裁剪判据现在没有 `hasElementChild` 豁免**——这修好了漏报，但**引入了假阳性的新风险**：任何「含文字 + `overflow:hidden` + 非 ellipsis」的有意视觉效果（跑马灯、渐变裁切文字）都会被报。**当前树的实测是 0**（实验 A），所以暂无实际假阳性；但这条判据以后可能需要 `intentional` 白名单。**这是权衡，不是缺陷**，我会在下轮继续盯。
2. **`/docs` 的对比度解析**：仍不处理 `color(display-p3 …)`（当前产物未出现）。
3. **`mobile:true` 与 `mobile:false` 的两套数字仍不可直接互换**（模拟语义不同）；脚本现在两种都跑 ✓，但**未分别出报告**，读者可能把两套数字混着看。
4. **本次未复测 `qa-contrast.mjs` 的空白页路径**（只测了它的错密码路径）。我按对称性核对到它的渲染失败分支也有 `total += 1`（§4.6），但**没有实测**——这是明确的未验证项。
5. `/docs` 的 `max-age=300` 仍靠 `?v=<ts>` cache-bust；**未验证**服务端是否对带 query 的 HTML 也返回 `max-age=300`（若代理忽略 query，仍可能量到旧产物）。

---

## 5. 还原 / 边界证据

**仓库文件 0 改动**：
```
$ git status --short
?? public/tuffex-dashboard-preview.png     ← 本轮之前既存，非我产生
$ git diff --stat        →  (空)
$ ls -d /tmp/cac-*.lock  →  不存在（浏览器锁已释放；构建锁本轮未取）
```
- 本轮**没有任何临时改动需要还原**：心跳实验用 `mkdtemp` 临时目录 + 显式 `RTK_BACKUP_DIR`（跑完 `rmSync`，脚本打印 `cleaned`）；扫描器破坏性实验的 4 个副本全部在 `/tmp`（`r11-vp-blank.mjs`/`r11-vp-prefix.mjs`/`r11-vp-login.mjs`/`r11-ct-login.mjs`），**仓库 `scripts/*.mjs` 未被修改**。
- **`--table-min` 的「加列」实验是浏览器内 DOM 注入**（`document.createElement`），**没有改任何仓库文件或 dist** ✓
- **真实 agent 配置**：本轮只调 `acquireRtkFileLock`/`inspectRtkLock`/`sweepStaleRenewTemps`，未走任何写 agent 配置的路径 ⇒ 零改动。
- **浏览器**：2 个 TaskSpace，各**恰好 1 次** `finish({keep:[]})`；未清 cookie/存储、未动 profile。

---

## 6. 未验证项

1. **`qa-contrast.mjs` 的空白页路径未实测**（只读了对称代码；其 `renderFailed` 门禁按 §4.6 的对称性成立，但我没有像实验 B 那样拦 bundle 跑一遍）。
2. **R11-C（`lost` 不阻断写入）未做端到端复现**：结论来自「`grep` 全部 `lost` 使用点 + 写入路径无中止分支」的读码，没有构造「真实 `SIGSTOP` 停顿 → 接管 → 恢复 → 双方都写完」的跨进程时序。
3. **跨主机/NFS 下 inode 语义未实测**（本机 APFS）；§1.3 的结论是读码 + 同 inode 覆盖实验的推论。
4. **`ego-browser` 包装层退出码折叠**（§4.7）只在 5 个实验里观察到，未阅读包装器源码确证其规则。
5. **320px 只测了 `/cache`**（本轮 R10-C 的落点）；其余 12 页在 320px 未逐页复测（390/768 在上一轮已逐页做过）。
6. **`/ab` 的 h1 只覆盖 5 种 URL 变体**（默认、两个单边、split、未知 flow），未穷举所有 `flow` id。
7. **非 Chromium 浏览器**未测。

---

## 7. 判据速查（可原样复跑）

```bash
# ---------- (A) 心跳 ----------
# 全部在临时 HOME，显式 env，并加 setInterval 保活
node --import tsx -e '
import { acquireRtkFileLock, rtkLockHeartbeatMs, sweepStaleRenewTemps } from "./server/rtkService.ts"
const env={RTK_BACKUP_DIR:"<tmp>/backups"}, home="<tmp>/home"
# ① R10-A: acquire(staleMs:3000) → 用**同一个 inode** 改写锁为 "THIEF-TOKEN" → 等 >1 个心跳周期
#    期望：锁里仍是 THIEF-TOKEN；holder.lost===true、lostReason==="token_mismatch"；release() 后锁仍存在
# ② 停表验证：再等 4 个周期 → 无新告警、token 不再变化
# ③ R10-B: chmod 锁目录 0o500 → 期望 renewFailures 递增、renewLastError="EACCES"，
#    到 3 次后 lost=true / lostReason="renew_failed" 且不再续期；随后恢复 0o700
# ④ sweep: 新建 <lock>.renew-*-x → 期望存活；把 mtime 改到 120s 前 → 期望被清
# ⑤ 窗口压测: staleMs:1000 循环，每轮随机时刻用新 token 覆盖锁，统计 token 被改回的次数（当前 300 次 0 命中）
# ⑥ clamp: rtkLockHeartbeatMs(60000)=20000 / (3000)=1000 / (1000)=333；⚠️ (100)=200 > 100（经 env 不可达）
'
npm run test:magpie     # 上一轮 87 用例；本轮未复跑（见未验证项）

# ---------- (B) 窄屏与标题 ----------
# /cache：读 .tx-data-table 的 overflow-x 必须 auto；w.scrollLeft=w.scrollWidth 后读回值 == maxScroll；
#         最后一个 thead th 的 getBoundingClientRect().right <= 容器 right + 1 ⇒ 全列可达
#         320/390/768 三档都过；再在运行时 append 一个 min-width:260px 的新列 → 表格宽度应**增长**、容器仍可滚、新列可达
# 标题：逐 URL 统计**可见** h1/h2（过滤 rect 为 0 的），并比对签名 fontSize|fontWeight|lineHeight|color|family
#        期望：每条 URL h1===1；内嵌标题为 h2 且签名 == h1 签名；普通页面 h1===1 未回归
for u in /ab "/ab?flow=keys-access&v=a" "/ab?flow=keys-access&v=b" "/ab?flow=keys-access&v=split" /keys /dashboard /help /rtk; do …

# ---------- (C) 扫描器门禁（破坏性实验只在 /tmp 副本） ----------
# 退出码必须这样取（管道以 ego-browser 结尾，不要接 tail）：
cat scripts/qa-viewports.mjs | ego-browser nodejs > /tmp/A.log 2>&1; echo "exit=$?"
# B: 副本登录后 Network.setBlockedURLs ["*/assets/*.js","*/assets/*.css"] ⇒ 期望 failing==renderFailures>0、exit≠0
# C: 副本在 PROBE 前把 .tx-data-table 强制 overflow-x:hidden 且表格 min-width:0 ⇒ 期望 silentlyTruncatedTotal>0、exit≠0
# D/E: 副本把密码改错 ⇒ 期望 waitForURL 超时、exit==2（脚本内层；包装器可能报 1）
```

---

## 8. 建议（按性价比）

1. **🟠 把「`lost` 只上报、不阻断」写进交付文档**（R11-C）：这是租约型锁的固有边界，不要让它被误读成「接管之后不会有重复写入」。若发布流程确实依赖强互斥，**评估在 RTK 提交点加 generation/fencing 校验**。
2. **🟡 R11-A 一行修**：`rtkLockHeartbeatMs` 用 `min(max(200, floor(staleMs/3)), staleMs)`，或把 `staleMs` 形参也钳到 ≥200，消除 `staleMs < 200` 时「心跳慢于阈值」的自相矛盾。
3. **🟡 R11-B 保留退出码语义**：让 CI 读脚本自己打印的摘要/`exited with code N`，或加一层薄 runner —— 现在 1（有发现）与 2（没量成）在包装层被折叠成 1；**门禁不会放行**，但排障会分不清。
4. **🟡 文档补三句**：① `rename` 是盲目覆盖、残余窗口 ≤2 个系统调用（**不是零窗口**）；② `at`×mtime 是时钟探测、`ino` 是重建信号、**token 才是绑定判据**；③ `/cache` 的 `--table-min` 依赖 **auto 布局 + `overflow-x:auto`**，不要改成 `table-layout: fixed` 或 `width`。
5. **✅ 可以结案**：R10-A（心跳抢锁）**已堵住且实测**、R10-B（续期失败静默）**已可见且降级**、心跳 `lost` 后**确实停表**、清理器**不误删进行中的续期**、`/cache` 在 **768/390/320** 全部可横滚且末列可见、**加列不会再静默裁掉（注入实验证实 760→992px 仍可滚）**、`/ab` h1=1 且内嵌 h2 **视觉签名不变**、普通页面 h1 无回归、**扫描器的渲染判据与容器裁剪判据都真的执行、都被接进退出码**（实验 B/C）、**错密码仍退出码 2**（实验 D/E）。**本轮未发现新的假绿。**
