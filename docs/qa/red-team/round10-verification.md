# Crosery API Console — 第十轮复验：锁 R9 修复 / 排版收口（含窄屏）/ 加固脚本（红队 B / task-36）

**被验对象**：`694558c`（锁 R9 系列）、`1ff78bb`+`f0469b0`（排版收口）、`ffb9790`（两个 QA 脚本加固）
**本地 HEAD** `f0469b0`｜**实例** <http://127.0.0.1:8791>｜**dist** `2026-10-01 12:29:42`｜dist 不早于 src：`find src index.html docs.html -newermt …` → **0 个**
**审计人** `ux-auditor` / task-36｜**实测时点** 2026-10-01 12:30–13:10｜浏览器 TaskSpace 共 **5 个**，每个**恰好 1 次** `finish({keep:[]})`（全部包在 `try/finally` 内）

> **⚠️ 快照边界（收尾时发现，请务必先读）**
> 我审计的四个对象 `694558c` / `1ff78bb` / `f0469b0` / `ffb9790` 的 **SHA 与内容全程未变** ✓，我的结论对它们有效。
> 但收尾时 HEAD 已从我取证时的 `f0469b0` 前进到 **`d3dcd40`**，期间队友落了 3 个提交：
> `a14236a`（RtkBoard 的 `.muted`/`.agent-id` 归入全局排版主角色）、`a573675`（`.mono` 0.93em 的说明文档）、`d3dcd40`（概览页新增 A/B 入口）。
> **因此**：(1) **§3 的所有计算样式结论、§4 的窄屏结论**都基于 **`dist` 12:29:42**（即 `f0469b0` 时点的产物），**不覆盖** `a14236a` 之后；
> (2) `a14236a` 恰好动的就是**排版角色**，`a573675` 恰好就是我在 §6 判断的那个决定，(3) `d3dcd40` 新增了 UI（概览页入口），**§3.1 的 `/ab` h1=3 与「13/13 页 h1 唯一」需要在 `d3dcd40` 上重测**。
> 上述三项我**未在 `d3dcd40` 上复测**（见 §8-10）。
**写入边界**：只写 `docs/qa/red-team/**`。**仓库文件 0 改动**（脚本破坏性实验全部在 `/tmp` 副本上做）。**真实 agent 配置零改动**、**生产零写入**。

---

## 0. 结论速览

### (A) 锁 R9 系列

| 主张 | 判定 |
|---|---|
| ① `release()` 读不出载荷时一律不删（`lost=true`） | ✅ **已验证**（我上轮的 R9-A 攻击已**不再成立**） |
| ② 去掉退避 `.unref()` → 短命进程必然 503 而不是静默退出 | ✅ **已验证**（我上轮的 R9-B 攻击已**不再成立**） |
| ③ `at`×mtime 交叉校验 + 心跳 → 「改老活锁 mtime 夺锁」不再成立 | ✅ **已验证**（R9-C 攻击已**不再成立**：`suspicious` + 抢锁者 **503**） |
| ④ `RTK_LOCK_DISABLED` 旁路透出 `disabled` | ✅ **已验证**（`info.disabled === true` + 一次性 `console.warn`） |
| ⑤ `home` 参与判定（跨 home 不按超时接管，持有者已死仍接管） | ✅ **已验证**（`foreignHome` + 已死 → `stolen=true, fromPid` 精确） |
| ⑥ `test:magpie` 改 `server/rtk*.test.ts`、新增 `rtkLock.test.ts`（80→87） | ✅ **已验证**（87 用例、exit 0，`rtkLock.test.ts` 被收纳） |

**🔴 但我在新加的心跳上找到 2 条新缺陷（1 条高危）**：
- **R10-A（高）心跳会「抢回」接管者的锁** —— 续期前**不校验 token**，`renameSync` **无条件覆盖**锁路径 → 我上轮的 R9-A 故障模式（两个持有者 + 释放时删掉别人的锁）**从另一扇门回来了**，而且这次是**按计划周期性发生**，不是微秒级竞态。
- **R10-B（中）心跳写失败被静默吞掉** → 退化为「假活锁」：持有者活着且自认持锁（`lost` 仍为 false），锁却因 mtime 不前进而被判陈旧夺走。

### (B) 排版收口

| 主张 | 判定 |
|---|---|
| ① 13/13 页 h1 计算样式唯一（22px/600/30px） | ✅ **样式唯一已验证**（15 个 h1 实例**共用一个 sig**）；🔴 **但「13/13 页 h1 唯一」被推翻**：`/ab` 有 **3 个可见 `<h1>`** |
| ② 四角色（`.muted`/行内 `code`/表格空单元格/代码块）单一真源、全站唯一 | ⚠️ **部分成立**：`td:empty` **1 个 sig** ✓、代码块 **1 个 sig** ✓；`.muted` **3 个 sig**、行内 `code` **3 个 sig**（仅颜色继承不同）；**「全站唯一」不成立** |
| ③ RtkBoard 两处例外归入主角色 | ✅ 未发现反例（见 §3.3） |
| ④ 没有视觉回归 | ⚠️ **桌面无回归**；**窄屏有**（R10-C） |
| 窄屏逐页复测（他们只测了 1557×958） | 🔴 **发现 R10-C**：`/cache` 在 **390px** 下**表格右半部分被静默裁掉 378px**（`overflow-x:hidden`，无滚动条、无省略号） |

### (C) 加固后的 QA 脚本

| 加固项 | 判定 |
|---|---|
| 未登录时失败而不是全绿 | ✅ **有效**（错密码 → `page.waitForURL` 超时抛错 → **退出码 2**） |
| 有失败时退出码非 0 | ✅ **有效**（我构造出 `failing:1` → **退出码 1**） |
| 容器裁剪检测（区分有意 ellipsis 与静默截断） | ⚠️ **有盲区**：`silent: !ellipsis && !hasElementChild` **豁免了所有含子元素的容器** → **R10-E**：`/cache`@390 那个被裁 378px 的表格容器**永远不被报**（实测 `hasElementChild: true` 是唯一豁免原因） |
| 渲染完成判据（空白/慢渲染不假绿） | 🔴 **无效**：`waitForFunction(...).catch(() => {})` **吞掉超时** → **R10-D**：把 bundle 拦掉让**全部页面空白**，脚本仍报 `{"checked":98,"failing":0}` |
| 390 双模拟（`mobile:false`+`mobile:true`） | ✅ 已实现（7 个视口项） |
| `try/finally` 释放 TaskSpace | ✅ 已实现（`finally { await task.finish(...) }`，随后 `process.exit(exitCode)`） |

**新发现合计 5 条**：R10-A（高）、R10-B（中）、R10-C（中）、R10-D（中）、R10-E（中）。

---

## 1. (A) 重放我上轮的 5 条攻击

全部在**临时 `RTK_BACKUP_DIR`** 下调用真实的 `acquireRtkFileLock` / `inspectRtkLock`（`node --import tsx`），不碰真实 HOME。

| # | 我上轮的攻击 | 修前（第九轮实测） | **修后（本轮实测）** | 判定 |
|---|---|---|---|---|
| **R9-A** | 用空内容 + 新 mtime 冒充「接管者刚 `open('wx')` 还没 write」，然后 `release()` | `lockStillThere:false`、`lost:false` → **删掉了别人的锁** | `{"lockStillThere":true,"lost":true}` → **不删 + 如实置 `lost`** | ✅ **已堵住** |
| **R9-B** | 短命子进程等锁（唯一待处理句柄是退避定时器） | `Detected unsettled top-level await` → 进程**静默退出** | `THREW status=503 code=undefined`，子进程 `exitCode: 0`（正常结束） | ✅ **已堵住** |
| **R9-C** | 把**活着**的持有者锁 mtime 改老 2h | `stolen:true, stolenFromAgeMs:7200000` → **夺走活锁** | `suspicious:true`（`载荷 at 与文件 mtime 相差 7199999ms`）+ 抢锁者 **`timeout(503)`** | ✅ **已堵住** |
| **R9-C′** | 时钟偏移（`at` 比 mtime 超前 60s） | 同类 | `suspicious:true` → 等待者 **503** | ✅ 安全（代价见 §2.4） |
| **R9-D** | `RTK_LOCK_DISABLED` 静默旁路 | `info` 无任何暴露 | `info.disabled === true`，且打印一次 `[rtk] RTK_LOCK_DISABLED 已启用：跨进程写入锁被旁路（…）` | ✅ **已堵住** |
| **R9-E** | 载荷 `home` 指向别处照样阻塞 | `home` 从不校验 | `foreignHome:true` + 说明性 `note`；**超时不接管**、**已死仍接管** | ✅ **已堵住** |
| **R9-F** | PID 复用 | 判据②兜底 | 不变（降级仍优雅） | — |

**⑤ 的死活分辨我单独测了**（这条最容易修过头）：
```
foreignHome + aged（pid 活着）  → {"stale":false,"foreignHome":true,"note":"锁属于另一个 home…不基于超时接管"}
foreignHome waiter              → 503  ← 正确拒绝
foreignHome + holder_dead       → {"stale":true,"reason":"holder_dead","pid":999999,"foreignHome":true}
foreignHome dead-holder waiter  → {"stolen":true,"fromPid":999999}  ← 已死仍能回收
```
→ **「跨 home 不抢活的、但能回收死的」这个分寸拿捏正确** ✓

**⑥ 独立核对（我真的跑了）**：`npm run test:magpie` → **`tests 87 / pass 86 / fail 0 / cancelled 0 / skipped 1`，`exit=0`** ✓
- `server/rtkLock.test.ts`（10880 B，**7 条**顶层用例）**确实被收纳并执行**，其中 4 条与我的攻击一一对应：
  `R9-A 陌生空锁 + 新 mtime：release() 必须不删`、`R9-A 完整路径：H 变陈旧 → T 接管 → H 释放时不能删 T 的锁`、`R9-B 短命进程…退避 sleep 不能 unref`、`R9-D …info.disabled 必须可观测`。
- **值得肯定的写法**：R9-A 那条是**行为测试**（真的走「陈旧 → 接管 → 释放」三步并断言磁盘状态），不是字符串守卫 —— 符合我在 R4-B 立的标准。
- glob 陷阱已消除（`server/rtk*.test.ts`）✓

---

## 2. (A) 新攻击面：心跳

### 2.1 🔴 R10-A（高）心跳**不校验归属就覆盖**锁路径 → 把接管者踢掉，重启我上轮那个双持有者故障
`server/rtkService.ts:363-376`：
```js
const timer = setInterval(() => {
  try {
    const temp = `${lockPath}.renew-${process.pid}`
    fs.writeFileSync(temp, JSON.stringify({ ...payload, at: new Date().toISOString() }), { mode: 0o600 })
    fs.renameSync(temp, lockPath)      // ← 无条件覆盖，没有任何归属校验
  } catch { /* 续期失败不抛 */ }
}, intervalMs)
```
**实测（`staleMs: 3000` → 心跳 1s）**：
```
A2 owner acquired:            ownerToken 9701df15129241c9, heartbeatMs 1000
A2 thief wrote its own lock:  tokenAfterThief "THIEF-TOKEN"
A2 after one heartbeat tick:  token 9701df15129241c9   ← *** 心跳把接管者的锁覆盖回自己的 ***
A2 owner still believes it holds it? {"lost":false,"infoLost":false}   ← 老实人完全不知情
A2 owner release deleted the lock?   lockStillThere:false              ← 释放时删掉了「接管者以为自己在用」的锁
```

**触发路径完全走的是「设计内」的正常分支，不需要任何伪造**：
1. 持有者 H 停顿超过 `staleMs`（`SIGSTOP`、长 GC、swap 抖动、调试器断点、阻塞的系统调用）→ **心跳同时也停**（同一进程）→ mtime 随之外推；
2. 等待者按 `holder_timeout` **合法接管**，写入自己的 token T2（这正是这套协议存在的意义）；
3. H 恢复 → **它的心跳按计划触发**，把自己的载荷 `renameSync` **覆盖**回去；
4. 于是**双方都认为自己持锁**（`lost` 在他们各自 release 前都是 `false`），而 H 释放时会**删掉锁文件**，此时 T2 还在写 → 第三个进程可以拿到锁 ⇒ **最多三个写入者**。

**为什么比 R9-A 更该修**：R9-A 的窗口是接管者 `open`→`write` 之间的**微秒级**缝隙；而心跳是**每 `max(1s, staleMs/3)` 触发一次的定时覆盖**，窗口是「H 恢复之后的任意一次心跳」，且**只在 H 停顿后才会发生**——也就是说，**恰恰在协议最需要正确性的那条恢复路径上**。

**最小修法（约 4 行）**：续期前先读当前锁，**只有 `token === 自己的 token` 才 `rename`**；否则**停止心跳并置 `lost=true`**（同时透出到 `info`），让调用方知道自己已被接管、应当中止本次写入。

**⚠️ 现有测试挡不住它（这也解释了为什么 87 条全绿仍有这个洞）**：`server/rtkLock.test.ts:139` 有一条心跳用例 `R9-C 心跳：临界区超过 staleMs 也不会被夺走`，但它只覆盖**happy path**（心跳让锁保持新鲜 ⇒ 别人拿不到）。而：
- `grep -n token server/rtkService.ts` 显示**唯一的 token 比对在 `release()`（`:418`）**，**续期路径没有任何归属校验**（`at :359` 的注释还写着「token 不变」，即**有意**把我们的 token 写回去）；
- 所以「**接管之后原持有者恢复并把锁抢回**」这条路径**既没有代码保护、也没有测试覆盖** —— 加上修复后，建议补一条用例：`acquire(staleMs 很短) → 人为写入他人 token → 等待一个心跳周期 → 断言锁里仍是他人 token、且我们的 lost===true`。

### 2.2 🟠 R10-B（中）心跳写失败被静默吞掉 → 「假活锁」→ 活着也能被夺
我用一个**确定性的手段**让续期永远失败：在 `${lockPath}.renew-${pid}` 处创建一个**目录** → `writeFileSync` 抛 `EISDIR` → 被 `catch {}` 吞掉。
```
A3 心跳写失败（临时路径处是目录）: {"mtimeAdvanced":false,"deltaMs":0}      ← 2 次心跳均未续期
A3 年龄超过 staleMs（持有者还活着且在干活）: {"stale":true,"reason":"holder_timeout","pid":71341,
     "ownerStillThinksItHolds":{"lost":false}}
     verdict: *** 假活锁：心跳静默失败，锁在持有者活着时已可被夺 ***
```
- 现实触发面：目录只读 / `ENOSPC` / 配额 / 权限被改 / 杀毒软件锁文件 / `rename` 跨设备失败——**都是静默降级**。
- **代码注释说「真正的失败会在 release 时体现为 lost」并不成立**：`release()` 只有在**读到不同 token** 时才置 `lost`；而心跳失败时锁里仍是**我们自己的 token**（没人改写它，只是 mtime 不前进），所以我们释放时会**照常删锁**，一路以为正常。
- **最小修法**：记录连续续期失败次数，在 `RtkLockInfo` 里透出（`renewFailures`），并在首次失败（或 N 次后）就**置 `lost=true` / 打日志**，让调用方中止写入而不是继续裸奔。
- 附带小问题：续期失败时 `${lockPath}.renew-${pid}` **不会被清理**；进程在 `write` 与 `rename` 之间被杀也会留下它（低危垃圾文件）。

### 2.3 `at`×mtime 交叉校验的**真实性质**：是「时钟偏移探测器」，不是「防篡改」
```
把 payload.at 与 mtime 一起改成 3 小时前 → {"stale":true,"reason":"holder_timeout"}  ← 仍可夺
```
→ 只改 mtime（我上轮的 R9-C）会被 `suspicious` 拦住 ✓，但**同时改 `at`** 就绕过了。这本身不可避免（能写锁文件的人就能写 `at`），**但我建议把文档措辞从「防止外部改动」收紧为「检测时钟不一致」**，否则读者会高估它的保护力。
另外 **`holder_dead` 优先于分歧判定**（实测：`at`/mtime 都被改到 3 小时前 + `pid=999999` → `reason: holder_dead`，照常回收）✓ —— 这个优先级顺序是对的，避免了「时钟不可信时连死锁都收不回」。

### 2.4 时钟偏移的**代价**（新的活性权衡，建议写进契约）
真实时钟偏移 >5s 时，`at` 与 mtime 分歧 → **不接管** → 等待者只能**阻塞到 `RTK_LOCK_TIMEOUT_MS`（默认 15s）后 503**：
```
A5 at 超前 mtime 60s → probe {"stale":false,"suspicious":true}，waiter → 503
```
**判断**：这是「宁可 503 也不双写」的**正确取舍**（比双写安全得多），代码注释里的时钟假设也写清楚了 ✓。但要注意它的连带效果：**「卡住但还活着的持有者」在时钟偏移下永远不会被接管**，运维看到的是 503 而不是自愈。建议在 `503` 的文案里带上「锁疑似时钟不一致（suspicious）」的提示，让排障方向明确。

---

## 3. (B) 排版唯一性（我自己的取数逻辑）

**判据**：桌面 1557×958，遍历 13 条路由，对每个角色取其**计算样式签名** `fontSize | fontWeight | lineHeight | color | fontFamily[0]`，统计全站**唯一签名个数**（脚本与他们的表无关）。

### 3.1 h1：**样式唯一 ✅**，但**「13/13 页只此一个 h1」被推翻**
| 项 | 实测 |
|---|---|
| h1 实例总数 | **15**（12 页 × 1 + **`/ab` × 3**） |
| 唯一签名数 | **1** → `22px | 600 | 30px | rgb(21, 27, 69) | -apple-system` ✅ |
| 每页 h1 数量 | 12 页 = 1；**`/ab` = 3** 🔴 |

`/ab` 的 3 个 h1（**全部可见、在文档流内**）：
```
"A / B 交互对照台"   1092×30 @ y=86    parent: H1 → page-head__text → page-head → ab-lab      ← 本页页头
"API Key 管理"       440×30 @ y=1318   parent: H1 → page-head__text → page-head → page        ← 变体 A 内嵌的 KeysPage
"API Key 管理"       440×30 @ y=1302   parent: H1 → page-head__text → page-head → page        ← 变体 B 内嵌的 KeysPage
```
→ `/ab` 把 **A/B 变体（整页 `KeysPage`）内嵌**进宿主文档，于是宿主文档里**多了两个 `<h1>API Key 管理</h1>`**。
**判定**：这正是你让我找的「**看起来一致但语义错**」——样式表看着完美统一（15 个 h1 一个签名），但**文档大纲里有 3 个一级标题，其中两个还是另一个页面的标题**。屏幕阅读器用户会听到「一级标题：API Key 管理」出现在 A/B 实验台里。
**归属**：我判断这**多半不是 `1ff78bb` 引入**的（`KeysPage` 的 `PageHeader` 迁移更早，`/ab` 内嵌整页是既有设计），但它使「13/13 页 h1 唯一」这个结论**不成立**，值得单独修。
**建议**：A/B 变体容器内嵌整页时，把内嵌页头的标题层级降级（或对内嵌副本加 `aria-hidden="true"` 并只保留视觉呈现），别让预览内容污染宿主大纲。

### 3.2 四角色唯一性：**两个成立、两个不成立**
| 角色 | 唯一签名数 | 实测签名 | 判定 |
|---|---|---|---|
| **代码块** `pre`/`.code-block` | **1** ✅ | `12.5px | 400 | 20px | rgb(53,61,104) | ui-monospace` | **完全统一** ✓ |
| **表格空单元格** `td:empty` | **1** ✅ | `13px | 400 | 19.5px | rgb(21,27,69)` | **统一** ✓（`th:empty` 是另一个签名 `13px|600`，属不同角色） |
| **行内 `code`** | **3** ⚠️ | 尺寸/行高/字体**完全相同**（`12px | 18px | ui-monospace`），**只有 color 不同**：`rgb(21,27,69)` / `rgb(83,91,133)` / `rgb(75,85,99)` | 尺寸口径统一，**颜色随上下文继承** |
| **`.muted`** | **3** ⚠️ | `13px|19.5px |-apple-system`、`14px|22px |-apple-system`、`13px|19.5px |ui-monospace` | 存在 14px 变体与 mono 变体 |

**判定**：
- 行内 `code` 的**颜色差异是继承的结果**（在标题里、在 muted 散文里、在正文里各随其父），这是**合理**做法——行内代码通常应融入周围文字色。**但「全站唯一」这句话在字面上不成立**，准确说法是「**尺寸/行高/字体单一真源，颜色随上下文继承**」。
- `.muted` 的 14px 变体来自你问的那条组合语义（§3.3）；mono 变体来自等宽上下文。同样：**「单一真源」成立，「全站唯一」不成立**。
- **一处自我纠正**：我第一遍统计 `td, th` 一起取，得到「空单元格 2 个签名」，看起来像缺陷；拆成 `td:empty` / `th:empty` 后确认**这是我选择器过宽**，`td` 角色本身是唯一的 ✓。

### 3.3 `.muted` 被 `.page-head p`（14px/22px）接管 —— 组合语义判断
实测确实存在（`/keys` 与 `/ab`）：
```
/keys  .page-head .muted.text-12  "额度按服务器时区（Asia/Shanghai）的 0…"  → 14px | 22px | -apple-system
/ab    同上（另一个变体内嵌）                                              → 14px | 22px | -apple-system
而 .page-head 之外的 .muted：13px | 19.5px
```
**我的判断：这个组合语义合理，建议保留，但必须写进文档。**
- `.muted` 承担的是**「弱化」这个强调角色**（`color: var(--tx-text-color-secondary)`）；
- `.page-head p` 承担的是**页头散文的排版尺度**（14px/22px，与 22px/30px 的 h1 成比例）。
- 两者职责正交：**一个管颜色、一个管尺度**。在页头里让尺度服从页头语境（14/22）是**正确的排版决定**——反过来强制 13px 会让页头描述比页面正文还小，破坏页头层次。
- **风险**：`.muted` 的**有效字号随语境变化**（13 / 14），而文档把它描述成「单一真源的角色」。下一个审查者（或未来的我）会把它当成漂移去「修」，反而破坏页头。**所以最小动作是把这条写成显式契约**：「`.muted` = 仅颜色角色；字号/行高来自上下文（默认 13px/19.5px，`.page-head` 内为 14px/22px，等宽上下文用 `--console-mono`）」。
- 另外**它触发了我的唯一性检查（3 个签名）**——这恰好说明：**唯一性检查必须按「角色 + 语境」分层**，否则会把有意的语境差异报成缺陷。这一点也适用于 `.mono`（§7）。

---

## 4. (B) 窄屏逐页复测（他们的结论只基于 1557×958）—— 🔴 发现 R10-C

**判据**（我自己的）：390 与 768 两个视口 × 13 页；每页检查 ① 页面级溢出 `max(documentElement.scrollWidth, body.scrollWidth) - innerWidth > 2`；② `overflow-x ∈ {hidden,clip}` 且 `scrollWidth > clientWidth + 2` 且**含文字**且 `text-overflow !== 'ellipsis'`（= 静默截断）；③ `h1` 数量 ≠ 1。

| 视口 | 失败页 | 明细 |
|---|---|---|
| **390** | 2 | `/cache`：**静默截断 1 处**；`/ab`：h1=3 |
| **768** | 1 | `/ab`：h1=3 |

**R10-C（中）/cache @390 的表格被静默裁掉 378px**：
```
cls: tx-data-table.is-striped
scrollWidth 732  vs  clientWidth 354   →  overflowBy 378
overflowX: hidden      ← 没有滚动条
textOverflow: clip     ← 没有省略号
whiteSpace: normal
text: "时间 模型 Key 客户端 输入 输出 缓存读 缓存写 命中率 花费 耗时 09/30 22:02:06 nemotro…"
```
→ **表格右半部分（输入/输出/缓存读/缓存写/命中率/花费/耗时）在 390px 下完全不可达**：既不能横滚、也没有省略提示，用户只能看到前 4 列。桌面 1557px 下表格放得下，所以这个缺陷**在桌面审计里不可能出现**——正是你要求逐页复测窄屏的价值所在。
**修法方向**：把该表格外层容器的 `overflow-x` 从 `hidden` 改成 `auto`（表格应当可横滚），或让窄屏下折叠列/换行。
**自我纠正**：我上轮（第九轮）§4.3 写「12 页静默丢字 = 0」，那个结论**只在桌面成立**——我的逐页裁剪分类当时是在 1560 宽下跑的（390 只做了页面级溢出统计，没做逐页裁剪分类）。**本轮修正为：390px 下 `/cache` 存在静默截断。**

`/ab` 的 h1=3 见 §3.1（在 390/768 下依然成立）。

---

## 5. (C) 加固脚本实测（破坏性实验全部在 `/tmp` 副本）

**说明**：我用 `cat 脚本 | ego-browser nodejs` 运行，链路里带了 `tail`，所以我自己打的 `EXITn=$?` 取到的是 **`tail` 的退出码**（全 0），**不是脚本的**——这是我测试脚手架的失误，**下面以 `ego` 自己报告的退出码为准**。

### 5.1 ✅ 「未登录时失败而不是全绿」：**有效**
把 `/tmp` 副本的密码改成错密码：
```
[error] {"error":"Error: page.waitForURL timed out after 20000ms: expected \"**/dashboard\"; last URL was \"http://127.0.0.1:8791/login\""}
ego's nodejs process exited with code 2.
```
两个脚本**都是同样的表现**（`qa-viewports.mjs` 与 `qa-contrast.mjs` 各测一次）✓
→ **退出码 2**（他们的 `catch { exitCode = 2 }` 生效），**没有产出任何「全绿」结论** ✓ 加固达标。

### 5.2 ✅ 「有失败时退出码非 0」：**有效**
不做任何输入伪造，只把 `/cache`@390 那个真实缺陷喂给它（见 §5.3 的 E2）：
```
{"viewport":"390","route":"/cache","pageOverflow":0,"silentlyTruncated":1,…}
{"checked":1,"failing":1,"silentlyTruncatedTotal":1}
ego's nodejs process exited with code 1.     ← ✓ failing>0 → exit 1
```
→ `if (failing > 0) exitCode = 1` + `process.exit(exitCode)` **确实生效** ✓

### 5.3 🔴 R10-E（中）：`.silent` 的 `!hasElementChild` 豁免让「容器级裁剪」永远不被报
他们的判据（`scripts/qa-viewports.mjs`）：
```js
const ellipsis = cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap";
const hasElementChild = [...el.children].some((c) => (c.textContent || "").trim().length);
silent: !ellipsis && !hasElementChild      // ← 含子元素的容器一律不算「静默截断」
```
**同一元素、同一时刻、用他们的字段实测**：
```
C) the element under THEIR PROBE rule:
   cls tx-data-table.is-striped, overflowBy 378, clientWidth 354, scrollWidth 732,
   overflowX "hidden", textOverflow "clip", whiteSpace "normal",
   childElementCount 1, hasElementChild true,
   intentional_THEIR false, silent_THEIR false,   ← 被 hasElementChild 豁免
   silent_MINE true
```
**对照实验**（同一脚本、只把 `silent` 改成 `!ellipsis`）：
```
E1（原样，390 + /cache）          → {"checked":1,"failing":0,"silentlyTruncatedTotal":0}
E2（silent := !ellipsis）          → {"checked":1,"failing":1,"silentlyTruncatedTotal":1}
                                    sample: tx-data-table.is-striped, overflowBy 378, silent true
```
→ **唯一差别就是那一句豁免**。所以：**只要被裁的是「包裹内容物的容器」（表格外层、卡片外层、分栏容器），这个检测器就看不见** —— 而恰恰是这类容器最容易被 `overflow:hidden` 裁掉。
**这也解释了他们全量跑 98 组合报 0**（我实测同一脚本、原样跑：`{"checked":98,"failing":0,"silentlyTruncatedTotal":0}`）——**不是没有缺陷，而是检测器把这个类别的缺陷排除了**。
**最小修法**：把 `silent` 的判据改成「`!ellipsis` 且**存在被裁掉的可见文字**」（例如进一步判断被裁的子树里是否有非空文本节点、且其右边界超出容器 `clientWidth`），而不是用「有没有子元素」来豁免；至少应把 `hasElementChild` 的情形**单独计数并输出**，让审计者看得到。

### 5.4 🔴 R10-D（中）：「渲染完成判据」挡不住空白页 → 仍是假绿
判据实现是：
```js
await page.waitForFunction(() => (document.querySelector("main")?.textContent || "").trim().length > 20, { timeout: 15000 }).catch(() => {});
```
`.catch(() => {})` **把超时吞掉**，于是「等不到内容」=「继续量」。我把 `/tmp` 副本改成登录后**拦掉全部 `/assets/*.js|*.css`**，让每个路由永远渲染不出应用：
```
SABOTAGE: app bundle blocked -> pages will stay blank
{"checked":98,"failing":0,"silentlyTruncatedTotal":0}
```
→ **98 个组合全是空白页，脚本报 0 失败**（ego 退出码 0）。**这就是一个完整的假绿**：bundle 挂了、构建产物错、CDN 404，脚本会告诉你「一切正常」。
**最小修法**：`waitForFunction(...)` 失败时**不要吞**——catch 里抛错或累加到一个 `renderFailures` 计数器，只要 >0 就让 `failing` 增长/退出码非 0；另外把「`main` 文本长度」这种弱判据换成「出现预期内容标记」（如 `tbody tr`、`.tx-card`）。
**附**：我为对比而做的 E3 测量显示，在 `/cache`@390 这个具体场景里，他们的判据**恰好已经等到表格渲染完成**（`mainTextLen 2788`、`rows 37`，2.6s 后仍是 37）——所以 **R10-D 是潜在机理、不是已发生的误判**；但它确实是「空白即绿」的充分条件（§5.4 已证）。

### 5.5 已实现的加固（读码确认，均属我上轮建议）
`let exitCode = 0` → `if (failing > 0) exitCode = 1` → `catch { exitCode = 2 }` → `finally { await task.finish({ keep: [] }) }` → `process.exit(exitCode)`；`const authed = …; if (!authed) throw`；7 个视口含 390 的两种模拟 ✓
**一个低危提醒**：`process.exit()` 会**截断尚未冲刷的 stdout**；若输出走管道且量大，末尾的 JSON 总结有被截掉的风险（本次未观察到）。建议退出前 `process.exitCode = …` 让其自然结束，或先 `await new Promise(r => process.stdout.write("", r))`。

---

## 6. `.mono` 的 `0.93em`：**结论站得住，但支撑证据链要修**

### 6.1 ✅ 规则本身**逐字节相同**（你的核心判断成立）
把两边的**真实规则**取出来（我第一遍误把注释里的 `` `.mono` `` 当成选择器，已修正）：
```
TUF  (geek_main/app/console/src/styles/theme.css) : .mono { font-family: var(--console-mono); font-size: 0.93em; letter-spacing: 0; }
OURS (src/styles/theme.css:119-123)               : .mono { font-family: var(--console-mono); font-size: 0.93em; letter-spacing: 0; }
IDENTICAL: True
```
→ **`0.93em` 确实来自参考实现，不是本项目的漂移** ✓ **我同意不该改**：等宽字体的字身（advance width / x-height 比例）与无衬线不同，按 em 等值排版会让等宽文本显得偏大，0.93 是常见的字身补偿；而且**保持与参考实现一致**本身就是价值（未来从 TUF 同步主题时不会产生无谓冲突）。
**唯一的代价**（注释里已写明，我实测复核）：出现非整数像素字号 —— 12.09px（父 13）/13.02px（父 14）/11.16px（父 12）✓ 三个数字算得对。需要整数口径的角色（`.muted`、行内 `code`）已在 `layout.css` 用**同等特异度**规则摘出来 —— 这一点我实测印证了：`.mono.muted` 计算值回到 **13px/19.5px**、行内 `code` 是 **12px/18px**（不含 0.93 系数）✓

### 6.2 ⚠️ 但注释里的「**diff 只差注释**」不成立 —— 建议改写这句证据
把两个 `theme.css` 的**注释全部剥离**后再 diff：**TUF 118 行 vs 我们 133 行，39 行非注释差异**。其中真实差异（非注释）：
| 差异 | 内容 | 性质 |
|---|---|---|
| `--tx-font-family` | TUF `"PingFang SC","Hiragino Sans GB",…,system-ui,-apple-system,"Segoe UI",sans-serif` → 我们 `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",…` | **真实令牌差异**（与 `.mono` 无关，且可能是更早的有意选择） |
| `.muted` 规则 | TUF 只有 `color`；我们加了 `:root{--role-muted-size/line-height}`、改成 `:where(.muted)`、加 `font-size/line-height`，并新增 `.mono.muted,.muted.mono` 覆盖 | **本轮 `f0469b0` 的有意改写**（角色收口） |
| 链接 | 新增 `text-decoration:none` 与 `a:hover{text-decoration:underline}` | 有意 |
| `--console-mono` / `--console-sidebar-width` | 位置搬移（值相同） | 无害 |

**影响**：注释里用「diff 只差注释」作为「我们与 TUF 一致」的论据，**下一个复核者一验就会证伪，从而连「0.93em 属参考行为」这个正确结论一起怀疑**。
**建议**：把那句改成**精确的**表述——「**`.mono` 这条规则与 `geek_main/app/console/src/styles/theme.css:110-114` 逐字节相同**；本文件整体为 TUF 主题的派生，另有三处有意差异（`--tx-font-family`、`.muted` 角色收口、链接下划线），与本条无关」。这样证据与结论强度匹配，且不会误导。
**是否仍有理由改 `0.93em`？** 我的结论是**没有**：真正的痛点是「**唯一性检查必须排除 `.mono` 派生尺寸**」，而不是 `0.93em` 本身；把 `.mono` 改成固定 px 会同时牺牲参考一致性与字身补偿。（如果将来确实想要整数口径，正确做法是给需要整数的角色显式指定 px —— 他们已经在这么做。）

---

## 7. 还原 / 边界证据

**仓库文件 0 改动**（破坏性实验全在 `/tmp` 副本）：
```
$ git status --short
A  docs/qa/blue/shots/r13-rtk-after.png        ← 并发队友暂存的改动，不是我的
A  docs/qa/blue/shots/r13-rtk-before.png       ← 同上
A  docs/qa/blue/shots/r13-rtk-busy.png         ← 同上
M  docs/qa/blue/typography-unification.md      ← 同上
M  src/components/RtkBoard.vue                 ← 同上（已暂存）
 M src/styles/theme.css                        ← 同上（未暂存）
?? docs/qa/red-team/round10-verification.md
?? docs/qa/red-team/shots-r10/                 ← 本轮证据截图
?? public/tuffex-dashboard-preview.png         ← 本轮之前既存
$ ls -d /tmp/cac-*.lock → 不存在（浏览器/构建锁均已释放）
```
- **我对 `src/**`、`scripts/**`、`server/**` 的改动数 = 0**：`git status` 里的 `src/components/RtkBoard.vue` 与 `src/styles/theme.css` 是**并发队友**正在做的 RtkBoard 例外收口 + theme.css 注释，**与我的发现无关**，我**没有触碰**——请在最终集成时按队友归属，**不要误记到本轮复验**。
- **脚本破坏性实验的对象**：`/tmp/r10-vp-login.mjs`、`/tmp/r10-vp-blank.mjs`、`/tmp/r10-ct-login.mjs`、`/tmp/r10-e1.mjs`、`/tmp/r10-e2.mjs` —— **全部是 `scripts/*.mjs` 的 `/tmp` 副本**，仓库脚本未被修改（可用 `shasum -a 256 scripts/qa-viewports.mjs scripts/qa-contrast.mjs` 对照 HEAD 复核）。
- **锁实验**：全部在 `mkdtemp` 临时目录 + 显式 `RTK_BACKUP_DIR`，结束即清理（脚本打印 `cleaned: <tmp>`）；心跳实验用的 `staleMs` 是**显式传入**的（3000/60000），**未改默认值**。
- **真实 agent 配置**：本轮未运行任何会写 agent 配置的路径（只调 `acquireRtkFileLock`/`inspectRtkLock`），6 个文件未被触碰。
- **浏览器**：5 个 TaskSpace，**每个恰好 1 次** `finish({keep:[]})`；未清 cookie/存储、未动 profile。

---

## 8. 未验证项

1. **R10-A 的端到端复现**：我用「持有者 + 人为写入接管者锁」的方式**精确复现了心跳覆盖**（token 被改回、`lost` 仍 false、释放时删锁）。**未做**的是「真实 `SIGSTOP` 停顿 → 另一进程合法接管 → `SIGCONT` 恢复 → 心跳覆盖」的完整跨进程时序；机理与代码路径一致，但完整时序**未实测**。
2. **R10-B 的现实触发**：我用「临时路径处放目录 → `EISDIR`」这一**确定性等价手段**触发续期失败；真实的 `ENOSPC`/只读挂载/杀毒锁文件**未实测**（效果等价：`writeFileSync`/`renameSync` 抛错被吞）。
3. **跨主机 / NFS / 真实时钟偏移**未实测（单机 APFS、单一时钟）；§2.4 的 503 结论来自**人为构造 `at` 超前**，不是真的两台机器。
4. **`test:magpie` 87 用例**我只核对了**总数与 `rtkLock.test.ts` 被收纳**，未逐条比对 11 条锁用例是否都在（用例名与分解可能不同）。
5. **R10-C 的修法效果**未验证（我没做产品改动）；只验证了现状：390px 下该表格容器 `overflow-x:hidden` + 内容 732px。
6. **`/ab` 的 h1=3 归属**：我判断多半**不是 `1ff78bb` 引入**（依据是 `KeysPage` 的 `PageHeader` 迁移更早、`/ab` 内嵌整页是既有设计），但**我没有逐 commit 二分确认**。
7. **`.muted` / 行内 `code` 的颜色继承差异**是否“应该”统一：我给的是**判断**（合理，建议文档化），不是可测结论。
8. **窄屏只测 390/768**（按你的要求）；未覆盖 1024/900 的逐页裁剪分类（第九轮的 84 组合覆盖了页面级溢出，但裁剪分类只在桌面 + 本轮 390/768 做过）。
9. **非 Chromium 浏览器**未测。
10. **`d3dcd40` 之后的复测缺失（快照边界）**：我的 (§3) 排版唯一性与 (§4) 窄屏结论基于 **dist 12:29:42**。收尾时 HEAD 已是 `d3dcd40`，期间 `a14236a`（**排版角色**：RtkBoard 的 `.muted`/`.agent-id` 归入主角色）、`a573675`（`.mono` 文档）、`d3dcd40`（**新增概览页 A/B 入口**）三个提交我都**没有复测**。其中 `a14236a` 直接影响 §3.2 的角色签名统计，`d3dcd40` 可能影响 §3.1 的 h1 计数 —— **建议在 `d3dcd40`（或之后）重跑 §3/§4 的判据**（§9 已给出可复跑命令）。

---

## 9. 判据速查（可原样复跑）

```bash
# ---------- (A) 锁 ----------
# 全部用临时 HOME/RTK_BACKUP_DIR，显式传入 env，并加 setInterval 保活（避免退出过早）
node --import tsx -e '
import { acquireRtkFileLock, inspectRtkLock, rtkLockPath } from "./server/rtkService.ts"
const env = { RTK_BACKUP_DIR: "<tmp>/backups" }, home = "<tmp>/home"
# R9-A: 写入空内容后 release() → 期望 {lockStillThere:true, lost:true}
# R9-B: 另起短命子进程在持锁者存在时 acquire(timeoutMs:400) → 期望 "THREW status=503"（不是静默退出）
# R9-C: 把活锁 mtime 改老 2h → inspect(...,home) 期望 {stale:false, suspicious:true}；抢锁者期望 503
# R9-D: env RTK_LOCK_DISABLED=1 → 期望 info.disabled===true 且不建锁文件
# R9-E: 载荷 home 指向别处 → 期望 {foreignHome:true, stale:false}（超时不接管）；pid 改成不存在 → stale:true/holder_dead
# R10-A ★: acquire(staleMs:3000) 后把锁文件换成别人的 token，等 >1s → 看 token 是否被心跳改回（当前：会被改回 = 缺陷）
# R10-B ★: 在 "${lockPath}.renew-${process.pid}" 处建目录 → mtime 不再前进；再等过 staleMs → inspect 报 holder_timeout
# R10-C(at×mtime): 同时改 at 与 mtime → 期望仍 stale:true/holder_timeout（说明 at 校验是时钟探测器，非防篡改）
'
npm run test:magpie      # 期望 87 用例 exit 0；确认 rtkLock.test.ts 被收纳
git log -1 --format=%ci -- server/     # 服务端改动后记得重启再抽验（第九轮教训）

# ---------- (B) 排版唯一性（我的取数） ----------
# 桌面 1557x958，逐页取签名 fontSize|fontWeight|lineHeight|color|fontFamily[0]：
#   h1 → 期望 1 个唯一签名；同时数每页 h1 个数（/ab 当前 = 3）
#   td:empty / th:empty 分开统计（合起来会把两种角色误报成缺陷）
#   .muted / 行内 code → 分别统计，并注意颜色继承与 .page-head 语境差异
# 窄屏逐页（390/768）：页面级溢出 + overflow-x:hidden 且 scrollWidth>clientWidth 且含文字且非 ellipsis + h1 个数
#   ← 当前在 390 下能抓到 /cache 的 .tx-data-table（overflowBy 378）

# ---------- (C) 脚本加固 ----------
cat scripts/qa-viewports.mjs | ego-browser nodejs          # 基线：当前报 {"checked":98,"failing":0}
# ① 未登录：把 /tmp 副本的密码改错 → 期望 ego 报 "exited with code 2"（无全绿输出）
# ② 有失败：用 silent := !ellipsis 的副本跑 390+/cache → 期望 failing:1 且 "exited with code 1"
# ③ 空白：/tmp 副本登录后 Network.setBlockedURLs ["*/assets/*.js","*/assets/*.css"] → 期望应当失败，
#    当前实测仍报 {"checked":98,"failing":0} ⇒ 假绿（R10-D）
# 注意：`cat … | ego-browser nodejs` 外层再 pipe 到 tail 时，$? 是 tail 的退出码；要判退出码请直接看 ego 的输出
```

---

## 10. 建议（按性价比）

1. **🔴 R10-A 必修（约 4 行）**：心跳续期前**先校验 token 归属**；不属于自己就**停表 + 置 `lost`**（并透出 `info`）。这是唯一的**高危**项：它让「停顿后恢复」这条正常恢复路径重新变成双写（且释放时会删掉接管者的锁）。
2. **🟠 R10-B 修**：续期失败**不能静默**——计数 + 透出（`renewFailures`），首次失败即让调用方知道（`lost`/审计），否则「活着却被夺」无法察觉；顺手清理 `*.renew-*` 残留。
3. **🟠 R10-D 修**：`waitForFunction(...).catch(() => {})` **把超时吞掉 = 假绿之源**（实测：bundle 全拦、98 组合空白页仍报 0 失败）。改成不吞、并累加渲染失败，让退出码非 0。
4. **🟠 R10-E 修**：`silent: !ellipsis && !hasElementChild` **豁免了所有含子元素的容器**——而这正是最容易被 `overflow:hidden` 裁掉的一类。实测同一元素 `hasElementChild:true` 是唯一豁免原因，去掉后立刻报出 `overflowBy 378`。
5. **🟠 R10-C 修**：`/cache` 表格外层 `overflow-x: hidden` → `auto`（390px 下右半张表不可达）；并**把窄屏逐页纳入常规门禁**（桌面的 84 组合抓不到它）。
6. **🟠 `/ab` 的 3 个 h1**：内嵌变体页头应降级标题层级或 `aria-hidden`，别让预览内容污染宿主文档大纲；同时**修正「13/13 页 h1 唯一」这个结论**。
7. **🟡 措辞修正三处**：① `theme.css` 注释里的「diff 只差注释」→ 改为「**`.mono` 这条规则与 TUF 逐字节相同**；文件整体另有 3 处有意差异」；② `at`×mtime 校验描述为「**时钟不一致探测**」而非防篡改（同时改 `at` 即可绕过，实测）；③ 把 `.muted` = **仅颜色角色 / 字号随语境**、以及「唯一性检查需按角色+语境分层、并排除 `.mono` 派生尺寸」写进契约。
8. **可以结案**：R9-A/R9-B/R9-C/R9-D/R9-E **五条修复全部实测生效**（我上轮的攻击逐条不再成立）、`holder_dead` 优先级正确、跨 home 的「抢活的/收死的」分寸正确、`test:magpie` glob 陷阱已消除、h1 **样式**唯一、`td:empty` 与代码块角色唯一、`.mono 0.93em` 与参考实现逐字节一致**不该改**、脚本的**未登录失败**与**非 0 退出码**两项加固**实测有效**。
