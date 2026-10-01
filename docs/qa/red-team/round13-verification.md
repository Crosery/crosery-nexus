# Crosery API Console — 第十三轮复验：flake / React 移除 / HTTP `lockLost`（红队 B / task-46）

**被验对象**：`8fa05fe`（flake 消除）、`d64e451`+`a3b4bc6`（React 移除）、`6991343`（HTTP `lockLost`）、`37104ca`（fence 收口）
**取证时 HEAD** `8346756`｜**审计人** `ux-auditor` / task-46｜**实测时点** 2026-10-01 14:19–14:40
**写入边界**：只写 `docs/qa/red-team/**`。**仓库文件 0 改动**；实验在 `/tmp` + `mkdtemp` 临时 HOME/DATA_DIR。真实 agent 配置零改动（§6 贴 sha256）。生产零写入。`git` 只用只读命令与显式路径。

> 🔄 **快照边界（收尾时发现，请连读）**：我的 **6× 全量**跑在**工作树 sha `a0f9783357f0452a`**（HEAD `8346756`）上。收尾时 HEAD 已前进到 **`22c52d6`（test(rtk): cover the HTTP lockLost propagation for toggle and rollback）**，**它恰好改了我测的那个文件**（`server/rtkLock.test.ts` → `1e361a7a2189a459`，用例 619→620）。我随即在**新 HEAD 上补跑 2 次**：**`620 tests / 619 pass / 0 fail / 1 skipped`，exit 0，8.92s / 8.97s** ⇒ **结论在两个修订上都成立**，但「6 次」这一读数的归属是旧 sha，特此标注。
> 附带影响：**（C）①「HTTP `lockLost` 无测试覆盖」这个前提在 `22c52d6` 之后已不成立** —— 新测试文件里 `lockLost` 出现 **15 次**，已覆盖 toggle 与 rollback 的传播。**我手工构造的真实 409 响应（§3.2）仍然是独立旁证**，不是唯一证据了。

> ⚠️ **工作树状态（影响读数，必须先说）**：取证时 `server/rtkLock.test.ts` 有**队友的未提交改动**（` M`，+52 行 = `RTK_TEST_LOCK_HOLD_MS` 那条新测试），sha256 `a0f9783357f0452a…`。**我没有触碰它**；我的 6 次全量都在该 sha 上跑，且**6 次前后 sha 完全一致**（见 §1），因此读数可比。这也解释了我的用例数 **619** 比 Lead 报的 **618** 多 1。

---

## 0. 结论速览

| # | 主张 | 判定 |
|---|---|---|
| A① | 那条 e2e 现在**确定性**且 ~1.02s；套件连续 6 次全绿 | ✅ **已验证**：**6/6 全绿**，`619 tests / 618 pass / 0 fail / 0 cancelled / 1 skipped`，**7.90–7.94s（极差 0.04s = 0.5%）**，exit 全 0 |
| A② | 「同步点生效但断言仍赌顺序」是否还存在 | ✅ **不是赌顺序**：同步点**强制**排序，断言要求**每一轮都命中 fence**（`lockLost === wantedRounds`、`tampered >= wantedRounds`）⇒ **宁可响亮失败也不空过**。残留：450ms 持锁预算 vs 父进程 2ms 轮询，**CPU 严重饥饿时仍会失败，但是响亮的**（§1.3） |
| A③ | `RTK_TEST_LOCK_HOLD_MS` 后门：默认零差异？生产误设会怎样？ | ✅ **默认零行为差异**（`if (testHoldMs > 0)` 分支不进入、无定时器）；**误设 = 有界降级不是 DoS**（每次获取多持锁 ≤10s，上限硬编码 10 000ms，正常释放）。**但缺一条告警**（§1.4） |
| A④ | 套件里还有没有别的「靠时序赌命中」用例 | ⚠️ **没有赌微秒窗口的残留**；但仍有 **3 处固定 sleep 的「前提等待」**（800ms 心跳 ×2、400/300ms SIGTERM 沉降），带 2 倍余量、**失败可见**（§1.5 逐条列出） |
| B | React 是否真移除 + `/docs` 能力是否完整 | ✅ **已验证**：`npm ls react --all` 空、`node_modules/react` 不存在、lock 里 react/recharts **各 0 条**、入口 JS React 运行时计数**全 0**；DOM 实测 **图标 40**、**14 代码块 / 14 复制按钮**、**21 个锚点全部可解析**、**无 `{{`/`${` 泄漏**、`BASE_URL` 引用**新旧各 14**、复制**成功/失败两条分支都对**（且旧 React 版**没有 try/catch** ⇒ 新版更好，**没有能力丢失**） |
| C① | 5 处 HTTP 失败响应带 `lockLost`（**无测试覆盖**） | ✅ **已构造真实响应验证**：篡改锁后 `POST /api/rtk/toggle` → **`409` + `lockLost: true` + `lockLostReason: "token_mismatch"`**；对照（不篡改）→ `200` |
| C② | `37104ca` 措辞是否还有「声明强于实现」 | ✅ **已收紧**：代码注释明确写「这是**每个写入前校验一次**，不是写入与校验原子；校验与写入之间存在 **≤1 个系统调用**的窗口（无原生 CAS 无法消除）」；`RTK_LOCK_DISABLED` 同时关闭 fencing 也已写明 |
| C③ | `success()` 收尾校验是否堵住「丢锁被 reconcile 吞掉仍返回 ok」 | ✅ **已验证**：`:1679` 在 `reconcileCollateral` + `preserveUserBaks` **之后**再 `assertOwned()`，注释明确说明「reconcile 返回 skipped 而不抛」的情形必须报出去 |

**新增发现 1 条**：**🟡 R13-A（低）`RTK_TEST_LOCK_HOLD_MS` 生效时没有任何告警**（与 `RTK_LOCK_DISABLED` 有 `console.warn` + `info.disabled` 的处理不对称）⇒ 生产被误设时是**静默**变慢。建议照 `RTK_LOCK_DISABLED` 的做法加一次性告警 + 在 `lock` info 里透出。

---

## 1. (A) flake 是否真消除

### 1.1 六次全量的原始数字（我自己的运行）
| run | exit | 耗时 | tests | pass | fail | cancelled | skipped | 被测文件 sha（前16） |
|---|---|---|---|---|---|---|---|---|
| 1 | **0** | **7.90s** | 619 | 618 | 0 | 0 | 1 | `a0f9783357f0452a` |
| 2 | **0** | **7.92s** | 619 | 618 | 0 | 0 | 1 | `a0f9783357f0452a` |
| 3 | **0** | **7.91s** | 619 | 618 | 0 | 0 | 1 | `a0f9783357f0452a` |
| 4 | **0** | **7.94s** | 619 | 618 | 0 | 0 | 1 | `a0f9783357f0452a` |
| 5 | **0** | **7.94s** | 619 | 618 | 0 | 0 | 1 | `a0f9783357f0452a` |
| 6 | **0** | **7.94s** | 619 | 618 | 0 | 0 | 1 | `a0f9783357f0452a` |

- **6/6 全绿**，耗时 **7.90–7.94s（极差 0.04s ≈ 0.5%）** —— 与修前的「~15% flake、34.1s」相比是**量级改善**，且**抖动比 Lead 的 3 次（7.57–7.61s）还小**。
- 我为了不让并发干扰，**先等构建锁释放再独占跑**（取证时另一队友正在跑 `test:magpie` + 3×`npm test`，我等到 14:21:01 才拿到锁）。这 6 次是**独占**条件下的读数。
- **用例数 619 而 Lead 报 618**：差 1 是因为队友那条**未提交**的 `RTK_TEST_LOCK_HOLD_MS` 测试（+52 行）。**我的结论建立在这个工作树上，而不是 HEAD 上**，特此标注。

### 1.2 这条用例现在怎么做的
`rollbackRTK` 被夺锁 e2e（`server/rtkLock.test.ts:475` 起）：
- 子进程用 `RTK_TEST_LOCK_HOLD_MS=450` 让 `rollbackRTK` 在**「锁已创建、尚未提交」**处**确定性停住** 450ms；
- 父进程**每 2ms 轮询**，在窗口内篡改锁；
- `wantedRounds = 2`，子进程循环直到 `lockLost` 达标或 25s 上限。

### 1.3 ② 断言是**赌顺序**吗？——不是
关键在**断言方向**：
```js
assert.ok(tampered >= wantedRounds, '父进程必须完成篡改（确定性同步点）')          // 篡改必须真的发生
assert.equal(parsed.lockLost, wantedRounds, '每一轮篡改都必须命中 rollbackRTK 的 fence')
assert.equal(parsed.clobberedByRollback, 0, '被夺锁的回滚不得写入目标文件')
assert.equal(parsed.other.rtk_lock_unavailable, undefined, ...)
```
- **同步点把「篡改 → 提交」的顺序变成了构造性事实**（持锁停住 → 父进程篡改 → 才继续），不是靠运气撞窗口；
- 断言要求**每一轮都命中 fence**（等式而非「至少一次」）⇒ 如果窗口没覆盖住，`lockLost < 2` 会**响亮失败**，而**不会**苟且通过。这正是「确定性」应有的形态（**失败可见 > 空过**）。
- **残留的负载敏感性（如实说）**：450ms 是**固定预算**，父进程的 2ms 轮询若被 CPU 饿死 >450ms，`tampered < 2` ⇒ 测试失败（**响亮**，不是 flake 式静默）。所以准确表述是「**无 CPU 饥饿时确定性；饥饿时失败可见**」。

### 1.4 ③ `RTK_TEST_LOCK_HOLD_MS` 后门（**单独结论**）
实现（`server/rtkService.ts:287-289`）：
```js
export function rtkTestLockHoldMs(env = process.env) {
  const raw = Number(env.RTK_TEST_LOCK_HOLD_MS)
  return Number.isFinite(raw) && raw > 0 && raw <= 10_000 ? Math.floor(raw) : 0
}
```
调用点（`:652-653`）：
```js
const testHoldMs = rtkTestLockHoldMs(env)
if (testHoldMs > 0) await sleep(testHoldMs)
```
**① 默认零行为差异：成立** ✅ —— 未设置 / `''` / `0` / 负数 / 非数字 / `>10000` 一律返回 **0**，`if (0 > 0)` **不进入分支** ⇒ **不创建定时器、不 await、不改变任何可观测状态**（`waitedMs` 也不含它）。队友那条未提交测试也覆盖了这套取值表（我读了它的用例，取值表与此一致）。

**② 生产被误设会发生什么：有界降级，不是 DoS/死锁** ✅（但**静默**）
- 它把**「已持有锁之后的返回」**推迟 ≤ **10 000ms**（硬上限）。持锁期间**心跳照常续期**（心跳在 hold 之前就已启动），所以不会因 mtime 不前进而被判陈旧；
- 后果是**每次本机 RTK 写入多占锁最多 10s**：并发写入者要排队等，而 `rtkLockTimeoutMs()` 默认 **15s** ⇒ 10s 的占用**仍在超时之内**，不会必然 503；表现为「写入明显变慢」，**不是死锁或永久占锁**；
- 它**不写盘、不删锁、不改变 fence 语义**，正常释放；
- **当前生产是否安全**：`com.crosery.console-magpie` 的 launchd `EnvironmentVariables` 只有 `MAGPIE_CONSOLE_RUNTIME` 与 `PATH`（我第 9 轮核对过），**未设置该变量** ✅。
- **🟡 R13-A（低，我的新发现）**：**生效时没有任何告警**。对比 `RTK_LOCK_DISABLED` 有一次性 `console.warn` + `info.disabled` 透出，这个后门是**完全静默**的 ⇒ 生产误设时运维只看到「变慢」而无从定位。**建议**：照 `RTK_LOCK_DISABLED` 加一次性告警，并在 `RtkLockInfo` 里透出（例如 `testHoldMs?: number`），让「慢」可归因。

### 1.5 ④ 其它「靠时序赌命中」用例的独立审计
我 grep 了 `server/*.test.ts` 里所有 `setTimeout`/`await sleep(`，逐条判断（是「前提等待」还是「赌窗口」）：

| 位置 | 形式 | 判定 |
|---|---|---|
| `rtkLock.test.ts:567` | 父进程 **2ms 轮询**篡改 + 子进程退出也用**轮询到 deadline** | ✅ **poll-until**，非赌 |
| `rtkLock.test.ts:158` / `:306` | `await sleep(800)` | ⚠️ **前提等待**：`staleMs=400`、心跳下限 200ms ⇒ 0.8s 内约 4 次续期（**2 倍余量**），随后断言「不该被判陈旧」。靠的是心跳真的跑了；饥饿 >800ms 才失败，**失败可见** |
| `rtkLock.test.ts:410` | `await sleep(1_300)` | ⚠️ 前提等待：等 `staleMs=1000` 的锁过期（1.3× 余量） |
| `rtkService.test.ts:1301` / `:1373` | `sleep(400)` / `sleep(300)` | ⚠️ SIGTERM 后的**沉降等待**，再读最终状态；若进程 >400ms 才退出，可能读到中间态（**失败可见**） |
| `rtkService.test.ts:1231` | 250ms 间隔的 **`for` 循环 + break** | ✅ poll-until（等服务器就绪），非赌 |
| `credentialUploadBatch` / `libConfirm` / `libResource` / `magpieEngine` | 15ms 模拟延迟、`setTimeout(0)` 让出事件循环、20ms 就绪轮询 | ✅ 均为 fixture 语义或 poll-until，**不是竞态赌注** |

**结论**：**没有留下「赌微秒窗口」的用例**（那类最坏形态已消除）；剩下 3 处是**带余量的前提等待**，它们的失败模式是**断言失败**而不是「随机通过/随机失败」。按「宁可响亮失败」的标准，这是可接受的取舍，但值得在文档里承认它们是**负载敏感的前提**。

---

## 2. (B) React 是否真移除 + `/docs` 能力对照

### 2.1 依赖证据（我自己跑的）
```
$ npm ls react --all          → crosery-cpe-console@0.1.0 └── (empty)
$ test -d node_modules/react  → NO
$ grep -c '"react"' package-lock.json      → 0     （lock 里 react* 唯一名列表为空）
$ grep -c recharts package-lock.json       → 0
package.json dependencies / devDependencies → 无 react / react-dom / lucide-react / @types/react* / @vitejs/plugin-react / recharts
```
**入口产物**（`dist/docs.html` → `assets/docs-CiWVj5H_.js`）里的 React 运行时计数：
`react` 0、`React` 0、`createElement` 0、`__SECRET_INTERNALS` 0、`useState` 0、`jsx` 0、`redux` 0、`scheduler` **全 0** ✅
**⇒ React 确实从依赖、lock、node_modules 与产物里都消失了。**

### 2.2 功能与外观对照（**我自己抓的 DOM**，不是他们的表）
| 项 | 我的实测 | 对照结论 |
|---|---|---|
| **图标** | `[class*="i-carbon-"]` = **40**（39 可见） | ✅ **与「40 个」精确吻合**（实现是 UnoCSS `i-carbon-*` 的 `<span>`，**不是 `<svg>`** —— 所以我第一次用 `svg` 计数得到 0，属我选择器错，不是能力丢失） |
| **代码块 / 复制按钮** | `copyButtons` = **14**；`pre` 与 `.docs-code` 嵌套计数 28 = 14×2 | ✅ **14 个代码块**；独立旁证：**旧 `src/docs.tsx` 里 `<Code …>` 用法正好 14 个** |
| **章节** | `<section>` = **11**、`<h2>` = **10**、侧栏导航 **12** 项 | ✅ 「10 个 section」指 **10 个内容章节（h2）**；第 11 个 `<section>` 是首屏/总览包装。**数字需这样对齐**，不是丢了一节 |
| **锚点** | `id` 12 个、页内 `#` 链接 **21** 条、**未解析 = []** | ✅ **全部锚点都能解析到真实元素**（无死锚） |
| **插值泄漏** | 渲染文本里 `{{` **无**、`${` **无** | ✅ 没有把模板占位符漏到页面上 |
| **`${BASE_URL}` 插值** | 新旧源码 **各 14 处** `BASE_URL` 引用；页面渲染出 **13 处** `https://ai.crosery.com` | ✅ **一处不少**（第 14 处是 `const BASE_URL = …` 声明本身） |
| **复制 · 成功分支** | 我把 `navigator.clipboard` 打桩成成功 → 按钮变 **「已复制」**、写入 68 字符、**1.6s 后回到「复制」** | ✅ 成功路径完好 |
| **复制 · 失败分支** | 真实 headless 下 `readText` 抛 `NotAllowedError`；点击后按钮**保持「复制」不变** | ✅ **这就是设计行为**（`catch { copiedId.value = '' }`，注释写明「不假装成功」） |
| **复制失败的对照（旧 React 版）** | 旧代码无 try/catch：`await navigator.clipboard.writeText(...)` 后直接 `setCopied(true)` | ⚠️ 旧版失败会**未处理的 Promise 拒绝**、且同样不变文案 ⇒ **新版显式处理，是改进；没有能力丢失** |
| **移动菜单（390px）** | 前：`aria-expanded="false"`、`aside.docs-sidebar`；点击后：**`aria-expanded="true"`、`aside.docs-sidebar open`**；再点侧栏链接 → **自动收起**（`aria-expanded="false"`）且 `location.hash = "#start"` | ✅ 开关状态、导航跳转、导航后自动收起**都工作** |

### 2.3 我**没有**验证到的（如实）
- **菜单「收起时」的视觉隐藏**：关闭态下 `<aside>` 的 `transform` 仍是 `none`、`left≈10`、宽度 370 —— 说明隐藏不是靠 transform。我靠 `aria-expanded`/class/链接可点性确认了**功能性**，但**没有做关闭态的截图对比**来确认它在视觉上确实不可见（`aria-expanded=false` + 面板仍占位，理论上可能是「覆盖在内容上但透明/被层级遮挡」）。**列为未验证项。**
- **移动菜单在 `mobile:true` 模拟下**未单独复测（只用了 `mobile:false`）。
- 我没有逐字符 diff React 版的**视觉**（只做了结构化 DOM 计数与交互），像素级外观对照依赖蓝队截图。

---

## 3. (C) HTTP `lockLost` 传播 + fence 收口

### 3.1 5/5 接线（grep 证据）
`server/index.ts` 五处失败响应各带 `...(failure.lockLost ? { lockLost: true } : {})` 与 `lockLostReason`：
`:1176`（`GET /api/rtk/status`）、`:1186`（`/api/rtk/planes`）、`:1209`（`POST /api/rtk/toggle`）、`:1224`（`POST /api/rtk/rollback`）、`:1242`（install/upgrade 一路）✅ **5/5**

### 3.2 ①**真实**「锁被夺」失败响应（Lead 说无测试覆盖，我构造出来了）
方法：临时 `DATA_DIR` + 临时 `RTK_HOME`/`RTK_BACKUP_DIR` + `RTK_BIN` 指向 no-op 慢 CLI（`touch 标记; sleep 3`）起一个**真实服务实例**；登录后发 `POST /api/rtk/toggle`；等标记文件出现（服务此刻**已持锁、正在跑 CLI**）→ **把锁文件改写成陌生 token** → 读响应。

**对照（不篡改）**：
```
status 200，body.ok true，lock: {path: …/rtk-write.lock, disabled:false, waitedMs:1, stolen:false, lost:false, renewFailures:0}
```
**篡改**：
```json
HTTP 409
{ "error": "写入锁在操作期间被接管（token_mismatch）：已放弃本次提交，改动可能未生效，请重试（可用 /api/rtk/rollback 恢复；锁：…/rtk-write.lock）",
  "plane": "local",
  "reason": "lock_lost_during_write",
  "lockLost": true,                     ← ✅ 确实透出
  "lockLostReason": "token_mismatch" }  ← ✅ 原因也在
```
→ **`lockLost: true` 与 `lockLostReason` 都出现在真实 HTTP 响应体里** ✅ **只读该字段的客户端不会把「放弃写入」误判成成功**。这条无测试覆盖的改动**实测有效**。
**顺带**：`lock.disabled:false` 也在 200 响应里（R9-D 的可观测性）✓。

### 3.3 ② 措辞是否还与实现一致
`server/rtkService.ts` 新增注释（`37104ca`）：
> 「措辞（R12-A）：这是「**每个写入前校验一次**」，不是「写入与校验原子」。**校验与写入之间存在 ≤1 个系统调用的窗口**（无原生 CAS 无法消除）；要打进去必须在 H 校验通过后的一个系统调用内完成 T 的「判陈旧 → unlink → 新建 → 写入」，而此刻 H 的锁是新鲜的（心跳还在续期），因此该窗口在现实的调度/IO 时延下不可达；即便撞上，下一次校验（或心跳）也会立刻把 lost 标出来。」

**⇒ 正是我上轮要求的收紧，已落地** ✅；并且 `RTK_LOCK_DISABLED` 同时关闭 fencing 也写进了代码注释（`:533`：「⚠️ 它同时关闭 fencing：`isOwned()` 恒为 true、`assertOwned()` 不抛（R12-C）」）✅。**我没再找到「声明强于实现」的表述**（本轮范围内）。

### 3.4 ③ `success()` 收尾校验是否真堵住「丢锁被 reconcile 吞掉仍返回 ok」
```js
const success = (…) => {
  lock.assertOwned()                                       // 提交点
  const collateral = reconcileCollateral(home, snapshot, guards, { fence: () => lock.assertOwned() })
  const preservedBak = preserveUserBaks()
  // 提交块结束时再校验一次：如果丢锁是在连带还原阶段被发现的（reconcile 返回 skipped 而不抛），
  // 这里必须把「本次没生效」如实报出去，绝不能返回 ok（R12-A 同族的诚实性要求）。
  lock.assertOwned()                                       // ✅ 收尾校验
  return { … }
}
```
**机制上成立** ✅：`reconcileCollateral` 的失败模式可能是**返回 `skipped` 而不抛**（它的 `{fence}` 回调不一定被调用），所以「提交点校验 + 收尾再校验」这两道才真正覆盖了「连带还原阶段才发现丢锁」的路径；`assertOwned()` 抛 409 ⇒ **不可能返回 ok**。
**限度（如实）**：我**没有**为这条收尾校验单独构造 e2e（要让 `reconcile` 走到 `skipped` 分支需要「会连带改文件的 agent + 真实 CLI」，与上一轮的落盘点 3/4 同一夹具缺口）⇒ 这是**代码级验证**，不是 e2e。

---

## 4. 未验证项

1. **`success()` 收尾校验（C③）无 e2e**：结论来自读码 + 机制推理（§3.4）。
2. **移动菜单的「关闭态视觉隐藏」**：未做截图对比；只验证了 `aria-expanded`、class、链接可点、导航后自动收起（§2.3）。
3. **`RTK_TEST_LOCK_HOLD_MS` 的 450ms 预算在重负载下**：未做压力下的重复跑（我只在独占空闲机器上跑 6 次）。1.3 的「饥饿则响亮失败」是推理，不是实测。
4. **复现「复制失败」用的是真实 headless 权限拒绝**（`NotAllowedError`）；未验证其它失败形态（例如主线程阻塞导致的手势超时）。
5. **`mobile:true` 下 `/docs` 未复测**。
6. **未逐字符 diff React/Vue 的视觉外观**（结构化 DOM + 交互已对照；像素级依赖蓝队截图）。
7. **619 用例里含队友未提交的测试**：我的读数对应工作树 `a0f9783357f0452a`，**不对应 HEAD**；若该改动被回退，用例数会回到 618。

---

## 5. 判据速查（可原样复跑）

```bash
# ---- (A) flake ----
# 先等构建锁释放，再独占跑（避免与队友的 npm test 抢 CPU 干扰耗时读数）
for i in $(seq 1 60); do mkdir /tmp/cac-build.lock 2>/dev/null && break || sleep 5; done
shasum -a 256 server/rtkLock.test.ts          # 每次跑前后都要一致，否则读数不可比
for run in 1 2 3 4 5 6; do /usr/bin/time -p npm test 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)|^real"; done
rmdir /tmp/cac-build.lock
# 后门取值（默认零差异）
node --import tsx -e 'import {rtkTestLockHoldMs} from "./server/rtkService.ts";
for (const v of [undefined,"0","-5","abc","","99999","250"]) { const e={}; if(v!==undefined) e.RTK_TEST_LOCK_HOLD_MS=v; console.log(JSON.stringify(v), rtkTestLockHoldMs(e)) }'
#  期望：undefined/0/-5/abc/""/99999 → 0；"250" → 250

# ---- (B) React 移除 + /docs ----
npm ls react --all                      # 期望 (empty)
test -d node_modules/react && echo present || echo absent
grep -c recharts package-lock.json      # 期望 0
grep -oE 'assets/docs-[A-Za-z0-9_-]+\.js' dist/docs.html   # 取入口 js
for p in react React createElement __SECRET_INTERNALS useState jsx redux scheduler; do
  printf "%s=%s " "$p" "$(grep -o "$p" dist/assets/docs-*.js | wc -l)"; done   # 期望全 0
# 浏览器（/docs）：[class*="i-carbon-"] 计数=40；pre/.docs-code 去重=14；复制按钮=14；
#   页内 # 链接全部能 getElementById 命中；innerText 不含 "{{" 或 "${"
#   复制成功分支：打桩 navigator.clipboard.writeText → 点按钮应变「已复制」并在 1.6s 后回「复制」
#   390px：.docs-menu-button 的 aria-expanded false→true，aside 加 open class，点侧栏链接后自动收起

# ---- (C) HTTP lockLost ----
# 临时 DATA_DIR/RTK_HOME/RTK_BACKUP_DIR + RTK_BIN=no-op 慢 CLI 起真实实例；登录后
#   POST /api/rtk/toggle {agent:'codex',on:true,plane:'local',confirm:true}
#   等 CLI 标记出现（此时已持锁）→ 把 <RTK_BACKUP_DIR>/../rtk-write.lock 改写成陌生 token
#   期望：409，body.reason==="lock_lost_during_write"，body.lockLost===true（对照不篡改应 200）
```

---

## 6. 还原 / 边界证据

- **仓库文件 0 改动**：我只做了只读 `git` 命令；`server/rtkLock.test.ts` 的 ` M` 是**队友的未提交改动**，**我没有触碰**（其 sha256 在我 6 次运行前后均为 `a0f9783357f0452a…`）。
- **真实 agent 配置零改动**：全部实验使用临时 `RTK_HOME`/`RTK_BACKUP_DIR`/`DATA_DIR`（`mkdtemp`，结束即 `rmSync`）；HTTP 实验的实例环境变量把 `RTK_HOME`/`RTK_BIN` 指向临时路径，**不含任何真实 HOME**。
- **生产零写入**：只对**我自己起的临时实例**发过请求；未触碰 8791 上的真实服务。
- **锁**：构建锁由队友持有 → 我等到 14:21:01 才取得并用完即释放；浏览器锁用后即释放（当前两把均空闲）。
- **TaskSpace**：本轮共 **2 个**，每个**恰好 1 次** `finish({keep:[]})`（第二个包在 `try/finally` 内）；未清 cookie/存储、未动 profile。

---

## 7. 建议（按性价比）

1. **🟡 R13-A 给 `RTK_TEST_LOCK_HOLD_MS` 加可观测性**：照 `RTK_LOCK_DISABLED` 的做法加一次性 `console.warn` + 在 `RtkLockInfo` 透出（如 `testHoldMs`）——它是**目前唯一一个生效后完全静默**的测试后门。
2. **🟡 把 3 处固定 sleep 的「前提」写进注释**（`rtkLock.test.ts:158/:306` 的 800ms、`:410` 的 1300ms、`rtkService.test.ts:1301/:1373` 的 400/300ms）：说明余量倍数与「饥饿时会响亮失败」，避免后人误以为是竞态赌注。
3. **🟡 补 `success()` 收尾校验的 e2e**（C③ 目前仅代码级）：与上轮落盘点 3/4 同一个夹具缺口（需要会连带改文件的 agent + 真实 CLI），可以一次补齐。
4. **✅ 可以结案**：**flake 已消除**（6/6 全绿、7.90–7.94s、极差 0.5%）、**那条 e2e 的断言不是赌顺序**（构造性排序 + 每轮必须命中 fence，失败响亮）、**`RTK_TEST_LOCK_HOLD_MS` 默认零行为差异且误设仅有界降级**、**React 从依赖/lock/node_modules/产物彻底消失**、**`/docs` 能力完整**（40 图标、14 代码块、21 锚点全可解析、无插值泄漏、`BASE_URL` 新旧各 14、复制成功/失败两分支都对且**优于**旧 React 版）、**HTTP `lockLost` 已在真实 409 响应中确认**、**措辞已收紧到与实现一致**、**收尾校验机制上堵住了「丢锁仍返回 ok」**。
