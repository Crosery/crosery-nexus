# Crosery API Console — 第五轮 UI 对抗复验（红队 B / task-22）

**被验对象**：`d5a8d3c`（「为 useResource/confirm 补行为级测试，修 /models aria-sort 错列」）
**实例** <http://127.0.0.1:8791>｜**dist 构建时间** `2026-10-01 10:27:55`｜dist 不早于 src 已核对：`find src index.html docs.html -newermt "$(stat -f '%Sm' dist/index.html)"` → **0 个**
**审计人** `ux-auditor` / task-22｜**实测时点** 2026-10-01 10:33–10:48｜浏览器：TaskSpace `spaceId=31`（已 `finish({keep:[]})`）；浏览器锁与构建锁均已 `rmdir`
**写入边界**：只写 `docs/qa/red-team/**`（新目录 `shots-r5/`，3 张截图）。产品代码为验证目的临时改动 **4 次**（3 个文件），**全部逐字节还原并附 shasum 证据**（§5）。

> ⚠️ 说明：本轮期间 `src/components/ConsoleNav.vue` 出现**他人并发改动**（`git status` 显示 `M`，属 Lead 的写入范围）。**不是我改的，我未触碰、也未还原它。**

---

## 0. 结论速览

| # | 被验主张 | 判定 |
|---|---|---|
| 1 | R4-B 已修：新的行为级测试能抓住我那套语义破坏 | ✅ **已验证**（我的原手法重放后 **3 条变红**，全量 `562/558/3`） |
| 1 | 旧的 3 个文本断言在该破坏下仍全绿 | ✅ **已验证**（`5/5` 绿——正如我在 R4-B 的结论） |
| 1 | 第二种语义破坏（`settleConfirm` 可多次 settle）能被 `libConfirm.test.ts` 抓住 | ✅ **已验证**（`1 fail`，断言文案精确） |
| 1 | 第二种语义破坏（新 `confirm()` 不结束上一个）能被抓住 | ⚠️ **抓住了，但以「挂起」而非「失败」的形式** → 新发现 **R5-A** |
| 2 | R4-A 已修：`sort=output` 落在定价列、未知 key 不打 `aria-sort` | ✅ **已验证**（**10/10** 逐列矩阵全对，其余列均 `none`） |
| 3 | `server/libImports.test.ts` 有牙齿 | ✅ **已验证**（删掉 import → `2 fail`，报错点精确到符号与模块） |
| 3 | 该守卫的边界 | ⚠️ 属**防回退**静态守卫，**不能防语义破坏**；且其自检存在**假阳性** → 新发现 **R5-B** |
| 3 | 「仓库没有 `vue-tsc`」的结构性缺口 | ⚠️ **我独立复现了该缺口**（`tsc -b` 在有悬空标识符时仍 **exit 0**）；**建议引入**，理由与分期方案见 §3.3 |

**本轮独立新发现 2 条**：R5-A（`npm test` 无 `--test-timeout`，挂起类回归会让套件无界挂死且汇总仍显示 `fail 0`）、R5-B（`libImports` 自检与生产文件的**单行 import 写法**硬耦合，合法重排即假红）。
**R4-A / R4-B 两条修复：均判定成立。**

---

## 1. R4-B 复验：重放我自己那次攻击

**基线**（改动前，三个相关测试文件 + 旧文本守卫）：**19/19 绿**（`libConfirm` 4 + `libResource` 5 + `libTableSort` 5 + `reportPageFrontend` 5）。

### 1.1 攻击 1a —— 只插 `data.value = result`（我在 R4-B 用的原手法）
```diff
       const result = await fetcher()
+      data.value = result
       if (mine === seq && !disposed) {
         data.value = result
```
| 测试集 | 结果 |
|---|---|
| **旧文本断言**（`reportPageFrontend.test.ts`） | `5/5 pass`，`fail 0` —— **仍然全绿**（复现我在 R4-B 的观察） |
| **新行为测试**（`libResource.test.ts`） | **`3 pass / 2 fail`（红）** |

失败的正是最该抓的两条，断言文案精确：
- ✖ `useResource：依赖变化触发重取，迟到的旧响应被丢弃（先发慢、后发快）` → `AssertionError: 迟到的旧响应不得覆盖新结果`
- ✖ `useResource：作用域销毁后不再写入（onScopeDispose 语义）` → `AssertionError: 销毁后返回的响应不得写入 data`

### 1.2 攻击 1b —— 同时插 `data.value = result` **与** `error.value = err`（blue 自报的场景）
```diff
       const result = await fetcher()
+      data.value = result
       if (mine === seq && !disposed) {
         data.value = result
         initial.value = false
       }
     } catch (err) {
+      error.value = err
       if (mine === seq && !disposed) error.value = err
```
| 测试集 | 结果 |
|---|---|
| 旧文本断言 | `5/5 pass`（仍绿） |
| 新行为测试 | **3 条红**：迟到的旧响应被丢弃 / 作用域销毁后不写入 / **旧请求失败不得覆盖新请求的成功结果** |
| **全量 `npm test`** | **`tests 562 / pass 558 / fail 3 / skipped 1`（红）** |

**与 blue 自报数字的对照（独立复现）**：
- blue 报「新增行为测试变红 **3** 条」→ **我实测 3 条，一致** ✓
- blue 报「全量 `560/556/3`」→ **我实测 `562/558/3`**。**`fail` 数完全一致（3）**；`tests/pass` 总数差 2，最可能是自报之后又补了 2 条测试（或自报时的 revision 略早）。差异不影响结论方向。
- **结论：R4-B 确实修好了。** 我的原攻击手法现在会被行为测试抓住，而旧文本断言依旧对语义破坏无感——这正是行为级测试应当提供的增量。

### 1.3 攻击 2a —— 让 `settleConfirm` 可被多次 settle（不清空 resolve 槽）
```diff
 export function settleConfirm(ok: boolean) {
   const resolve = confirmState.resolve
-  confirmState.resolve = null
   confirmState.open = false
   resolve?.(ok)
 }
```
**结果：被抓住 ✅** —— `libConfirm.test.ts` → `3 pass / 1 fail`：
- ✖ `settleConfirm 只 resolve 一次，重复 settle 不会再触发` → `AssertionError: resolve 槽必须清空，避免悬挂的调用方被二次唤醒`

### 1.4 攻击 2b —— 让新 `confirm()` 不结束上一个（删除 `confirmState.resolve?.(false)`）
```diff
   // 上一个还没答复就被新的替换时，按「取消」结束它，不让调用方永远挂起。
-  confirmState.resolve?.(false)
   return new Promise<boolean>((resolve) => {
```
**结果：被抓住了，但形式是「挂起」** —— 这是本轮的新发现。

单跑 `server/libConfirm.test.ts`（用 25s shell 守卫）：
```
✔ settleConfirm 只 resolve 一次，重复 settle 不会再触发
✖ server/libConfirm.test.ts (24968ms)
ℹ tests 2   ℹ pass 1   ℹ fail 0   ℹ cancelled 1
```
- 第 2 条测试 `新的 confirm 到达时，把上一个按「取消」结束` 里的 `await first` **永远不结算** → 该测试**永不完成**。
- node:test 把**整个文件**记为失败并计入 **`cancelled`**，而 **`fail` 仍是 0**。

**这带来两个真实风险（→ R5-A，见 §4.1）**：
1. **全量 `npm test` 会无界挂死**：我用 70s 守卫跑 `npm test`，**exit=124（被 timeout 杀掉），且从未打印汇总**。输出的最后几行只有
   `✖ server/libConfirm.test.ts (69565ms)` / `'Promise resolution is still pending but the event loop has already resolved'`。
   对照：基线全量套件 **`duration_ms ≈ 1.8s`**。也就是说，**一个 1.8 秒的套件会变成一个无限挂起的套件**。
2. **汇总里的 `fail` 仍是 0**：任何按 `fail > 0` 判断的 CI 门禁都会**漏掉**它。

**缓解验证**：加上 `--test-timeout=8000` 后，同一破坏被**有界**捕获：
```
✖ 新的 confirm 到达时，把上一个按「取消」结束（调用方不会永远挂起） (8001.68ms)
ℹ tests 4   ℹ pass 3   ℹ fail 0   ℹ cancelled 1
node exit code = 1        ← 关键：进程退出码非 0
```
即：**加 `--test-timeout` 后，挂起类回归会变成有界失败且退出码为 1**，CI 只要正确地按**退出码**判定就能拦住；但若只看 `fail` 计数仍会漏。

---

## 2. R4-A 复验：`aria-sort` 逐列实测

**判据**（每次导航到 `/models?sort=<key>&dir=<dir>`，等 2.6s 后读全部 `th`）：
1. 有且**仅有 1 个** sortable 列被标记（`aria-sort` ≠ `none`）；
2. 被标记列 == 期望列；3. 其值 == `ascending`/`descending`；
4. **其余 sortable 列全部为 `none`**。

| sort key | dir | 期望列 | 实测被标记列 | 实测值 | 其余列 | 判定 |
|---|---|---|---|---|---|---|
| `name` | asc | 模型名称 | 模型名称 | ascending | 全 `none` | ✅ |
| `name` | desc | 模型名称 | 模型名称 | descending | 全 `none` | ✅ |
| `input` | asc | 每 1M Token 定价 | 每 1M Token 定价 | ascending | 全 `none` | ✅ |
| `input` | desc | 每 1M Token 定价 | 每 1M Token 定价 | descending | 全 `none` | ✅ |
| **`output`** | asc | 每 1M Token 定价 | **每 1M Token 定价** | ascending | 全 `none` | ✅ **（R4-A 原缺陷点）** |
| **`output`** | desc | 每 1M Token 定价 | **每 1M Token 定价** | descending | 全 `none` | ✅ **（R4-A 原缺陷点）** |
| `usage` | asc | 用量与花费 | 用量与花费 | ascending | 全 `none` | ✅ |
| `usage` | desc | 用量与花费 | 用量与花费 | descending | 全 `none` | ✅ |
| `sources` | asc | 服务渠道映射 | 服务渠道映射 | ascending | 全 `none` | ✅ |
| `sources` | desc | 服务渠道映射 | 服务渠道映射 | descending | 全 `none` | ✅ |

**矩阵 10/10 通过。** 第四轮那个「`?sort=output` 时 `aria-sort` 落到模型名称」的缺陷**已消失**。
代码依据：`src/lib/tableSort.ts:15-20`（`pricing: ['input','output']`，一列承载两个排序字段）、`:23-28`（无匹配返回 `null`，不再兜底到第一列）。

**`?sort=zzz`（白名单归一化）**：
- 页面白名单把 `sortKey` 归一到 `name` → 被标记列 = **模型名称 ascending**（唯一标记）
- **表格实际行序与默认（name asc）逐行一致**（首三行都是 `~anthropic/claude-fable-latest` / `claude-haiku-latest` / `claude-opus-latest`）
- → **指示器与真实排序自洽** ✅（与 R4-A 的「谎报列名」是两回事）
- 残留（同第四轮 §5.2，非本轮修复范围）：URL 仍保留 `?sort=zzz`，页面**不把非法值归一化回写 URL**。属美观/可分享性问题，不影响指示器自洽。

**键盘排序**：聚焦 `每 1M Token 定价` 表头内的 `<button>`（`document.activeElement` 确认为该按钮）→ 按 `Enter` → URL 变 `/models?sort=input`，被标记列正确移到 `每 1M Token 定价 = ascending` ✅；5 个表头按钮均未禁用、无 `tabindex` 覆盖（原生可 Tab）✅

证据：`shots-r5/models-aria-sort-output-desc-桌面.png`、`shots-r5/models-sort-zzz-桌面.png`、`shots-r5/models-键盘排序-桌面.png`

---

## 3. `server/libImports.test.ts` 评估 + `vue-tsc` 判断

### 3.1 它「有牙齿」吗？—— **有** ✅
**判据**：删掉 `src/pages/ModelsPage.vue` 里真实存在的 `import { sortKeyForColumn, tableSortState } from '../lib/tableSort'` 一行，跑该测试。
```
✖ 每个 .vue 脚本用到的 src/lib 导出都必须被 import（防 ReferenceError 白屏）
✖ 守卫本身有牙齿：故意构造一个未导入的引用会被抓出来
ℹ tests 2  ℹ pass 0  ℹ fail 2
  src/pages/ModelsPage.vue: 用到 sortKeyForColumn（来自 src/lib/tableSort.ts）但没有 import
  src/pages/ModelsPage.vue: 用到 tableSortState（来自 src/lib/tableSort.ts）但没有 import
```
报错**精确到文件 + 符号 + 来源模块**，可读性很好。

### 3.2 按我的 R4-B 标准划定边界：**属「防回退」，不能防语义破坏**
它做的是「**文本级**存在性/一致性检查」。它能挡：
- ✅ 删掉/漏掉 `src/lib` 导出的 import（**正是它要防的那次真实事故**）
- ✅ 改回「用了但没导入」的旧写法

它**不能**挡（我按它的实现逐条推导，并标注哪些是我实测、哪些是读码推断）：
- ❌ `<template>` 里的引用：它只解析 `<script setup>`（`libImports.test.ts:71`），模板中的未定义标识符不在覆盖内。**读码推断**
- ❌ **非 `src/lib` 的模块**：`exportedSymbols()` 只枚举 `src/lib/*.ts`（`:22-38`），所以 `../api`、`../types`、`../components/*`、`../chartTheme` 等一律不覆盖。**读码推断**
- ❌ **局部标识符拼错**（不是 lib 导出）→ 不覆盖
- ❌ 类型错误、参数个数/形状错误、prop/emit 不匹配、模板类型错误
- ❌ `stripNoise`（`:56-63`）会把**字符串/模板字符串内**的真实引用一并抹掉
- ❌ 同符号在 lib 里被重命名且用法同步改名 → 两边一致 → 绿

**我的判断**：它是一道**定位准确、边界诚实的窄守卫**（`:13-14` 自己就写明「不能替代类型检查，也不是行为测试」），作为工具链盲区的**补丁**是合理且值得保留的；但它**不能**被当作「`.vue` 已经被检查过了」的依据。它枚举的是**实例**，类型检查枚举的是**规则**——新增盲区需要再手写一条守卫，成本线性增长。

### 3.3 🔴 **R5-B：该守卫的自检存在假阳性——与生产文件的「单行 import 写法」硬耦合**
**复现**：把 `ModelsPage.vue` 里那行 import **仅做重排**（语义完全相同，同样是 `sortKeyForColumn, tableSortState` 来自 `../lib/tableSort`）：
```diff
-import { sortKeyForColumn, tableSortState } from '../lib/tableSort'
+import {
+  sortKeyForColumn,
+  tableSortState,
+} from '../lib/tableSort'
```
**结果**：
```
✔ 每个 .vue 脚本用到的 src/lib 导出都必须被 import（防 ReferenceError 白屏）   ← 真守卫：绿（正确）
✖ 守卫本身有牙齿：故意构造一个未导入的引用会被抓出来                          ← 自检：红（假阳性）
   AssertionError: ModelsPage 应当有 tableSort 的 import 行（守卫的前提）
```
**根因**：`libImports.test.ts:104` 用单行正则 `/^import \{ sortKeyForColumn, tableSortState \}.*$/m` 从**生产文件**里"扣掉"那行 import 来构造自检样本。
**两个后果**：
1. **纯格式化改动（prettier/eslint --fix、或拆行）会让套件变红而代码完全正确**。这会训练人「把格式改回去让测试变绿」，长期削弱这道守卫的可信度。
2. 更本质：名为「守卫本身有牙齿」的测试，**实际断言的是「ModelsPage 仍在同一行导入这两个符号」**。若 ModelsPage 合法地不再需要 `tableSortState`，自检也会红——**它没在测自己，而在测别人的写法**。
**建议修法**（自包含，无需新依赖）：把检测逻辑抽成纯函数（`exportedSymbols`/`stripNoise` 已经是模块级，只差把"扫一个 .vue 源串"也提出来），自检改成**在测试内构造一段含引用但无 import 的合成源码**，断言该函数报出问题。这样自检与任何生产文件解耦。

### 3.4 「仓库没有 `vue-tsc`」的结构性缺口 —— **我独立复现了**

**证据链**：
1. `package.json`：`build` = `tsc -b && vite build`；`typecheck` = `tsc -b …`；**全仓库（含 `package-lock.json`）`vue-tsc` 零引用**。
2. `tsconfig.app.json`：`"include": ["src"]` + `"allowArbitraryExtensions": true` + **无 `vue-tsc`** → 普通 `tsc` 无法解析 `.vue` SFC；`allowArbitraryExtensions` 让 `.vue` 作为**不透明模块**可被 import，但**其内容从不被类型检查**。
3. **实测**：在上一步的「删掉 ModelsPage 的 import」状态下运行 `npx tsc -b` →
   ```
   tsc -b exit code = 0
   --- tsc output (empty = no errors reported) ---
   ```
   **类型检查这一半完全绿灯**，而 Vue 侧的标识符是悬空的。Vite/esbuild 只擦除类型不做检查 → 浏览器里就是 `ReferenceError`。
4. blue 自报的真实事故与该类完全一致（`ReferenceError: tableSortState is not defined`，`/models` 表格整块不渲染）。
5. **参考实现（用户认可的 TUF）恰恰做了这件事**：`geek_main/app/console/package.json`
   - `:8` `"build": "vue-tsc --noEmit -p tsconfig.json && vite build"`
   - `:9` `"typecheck": "vue-tsc --noEmit -p tsconfig.json"`
   - `:23` devDependencies `"vue-tsc": "3.3.11"`

**我的判断：建议引入 `vue-tsc`，但必须分期、且不要立刻卡 `build`。** 理由：
- **缺口是已被证明的，不是假设**：我本人复现了「`tsc -b` exit 0 + `.vue` 里悬空标识符」。这不是风格问题，是一类会白屏的静默失败。
- **类型检查的覆盖面与代码分布已经错位**：这个仓库**已经**为类型安全付了成本（3 个 tsconfig project、`noUnusedLocals`/`noUnusedParameters`/`verbatimModuleSyntax`），但迁移把**全部 UI 逻辑搬进了 `.vue`**——也就是说，**受检查的面积缩小了，而没被检查的面积变大了**。这正是「删死树 + 8 页迁移」之后的净结构性后果。
- **TUF 已经这么做**：整个迁移的理由就是「对齐 TUF 的合理做法」，而 `.vue` 类型门禁恰是 TUF 唯一没被搬过来的一条。**我们才是偏离方。**
- **代价可控**：`vue-tsc` 是 devDependency、无运行时影响；真正的风险是**存量报错**，而这只影响「何时卡门禁」，不影响「要不要装」。

**分期建议**（把风险压在可控范围内）：
1. 先加一条**独立脚本** `typecheck:vue`（不接进 `build`、不进 `verify`），跑一遍拿到存量报错清单与数量；
2. 若存量可控 → 逐个修；若存量很大 → 起一个**收窄的 tsconfig**（例如只含 `src/lib/**` + 8 个已迁移页面），先锁住**新写的**代码，再逐步扩面；
3. 存量清零（或已被显式 `@ts-expect-error` 标注）之后，再把它接进 `build` / `verify`。
这样不会出现「上个 PR 把 `build` 变成红」的爆炸半径。

**同时保留现有两道便宜防线**（即使装了 `vue-tsc` 也建议留着）：
- `libImports.test.ts`：对「模块级 ReferenceError」这类**渲染期即白屏**的失败，它给的是**精确到符号**的报错，比 `vue-tsc` 的报错更贴近事故现场；
- 把它的覆盖从「只查 `src/lib`」扩到**所有本地相对模块**（`../api`/`../types`/`../components/*`）、并把自检改成自包含（§3.3），是一个**零新依赖**、当天可做完的改进。

**必须由用户拍板的部分（我不做）**：新增 devDependency 属对外/供应链决策。另需提醒：本机 `node --version` = **v26.7.0**，而 `package.json` `engines` 锁 `>=24 <25` —— 引入与 TS/Vue 编译器版本联动的工具前，这个版本偏差值得先确认。

---

## 4. 本轮独立发现

### R5-A（中）`npm test` 无 `--test-timeout`：挂起类回归会让套件**无界挂死**，且汇总仍显示 `fail 0`
- **触发方式**：任何让某个 `await` 永不结算的语义回归（我实测的是「新 `confirm()` 不结束上一个」，见 §1.4）。
- **实测**：`npm test` 在 70 秒 shell 守卫下 **exit=124（被杀），从未打印汇总**；基线套件仅 **~1.8s**。单文件形式下 node 记为 `cancelled 1 / fail 0`。
- **两重危害**：① CI 从「1.8 秒失败」变成「无限挂起」（按 CI 超时才算失败，反馈延迟从秒级变成分钟级，且日志没有明确失败项）；② **汇总里 `fail` 仍是 0**，按 `fail > 0` 判定的门禁会**静默放行**。
- **验证过的缓解**：`--test-timeout=<ms>` 能把它变成有界失败，且**进程退出码为 1**（`node exit code = 1`，`fail 0 / cancelled 1`）。所以正确做法是：**加超时 + 门禁看退出码**（而不是看 `fail` 计数）。
- **最小修法**：`package.json` 的 `test` 脚本加 `--test-timeout=30000`（或给个别慢测试单独放宽）。**一行改动，零新依赖。**
- 这也是我 R4-B 结论的一个延伸：**「套件全绿」与「套件能给出可信信号」是两回事**——上一轮是「绿得不该绿」，这一轮是「红了但没人看得见」。

### R5-B（低-中）`libImports.test.ts` 自检与生产文件写法硬耦合 → 合法重排即假红
见 §3.3。**假阳性**会训练团队「改格式让测试变绿」，长期侵蚀这道守卫的权威性；修法是让自检自包含。

**其余未发现**：R4-A 的 10/10 矩阵、R4-B 的两次攻击被正确抓住、`libImports` 对真实删 import 的精确报错、`?sort=zzz` 归一化后指示器自洽、键盘排序——**都按声称工作**。**没有为了凑数而登记的问题。**

---

## 5. 还原证据（4 次临时改动，全部逐字节还原）

改动涉及 **3 个文件**，每次改动后我都从改动前的字节备份恢复，并用 sha256 + git 双重核对。

| 文件 | 基线 sha256（= 还原后） | `git diff` |
|---|---|---|
| `src/lib/resource.ts` | `c37db61cc289335201f5bcef9182a44834fca157cc254613a59519a68098d46b` | 空 |
| `src/lib/confirm.ts` | `0e48845bbe992ab5e4e9716435c8f4c23eba2373e3067ff4acd560779d1a5482` | 空 |
| `src/pages/ModelsPage.vue` | `9c4f3ba69153908258cd59154d19b6f3951c6965a54bfba3981e80909fb3d8fb` | 空 |

**最终核对（全部还原之后）**：
```
$ shasum -a 256 src/lib/resource.ts src/lib/confirm.ts src/pages/ModelsPage.vue
c37db61cc289335201f5bcef9182a44834fca157cc254613a59519a68098d46b  src/lib/resource.ts
0e48845bbe992ab5e4e9716435c8f4c23eba2373e3067ff4acd560779d1a5482  src/lib/confirm.ts
9c4f3ba69153908258cd59154d19b6f3951c6965a54bfba3981e80909fb3d8fb  src/pages/ModelsPage.vue
$ git diff --stat -- src/lib/resource.ts src/lib/confirm.ts src/pages/ModelsPage.vue
   (空)
$ git status --short
 M src/components/ConsoleNav.vue        ← 他人并发改动（Lead 写入范围），非我所为，我未触碰
?? docs/qa/red-team/shots-r5/           ← 我的本轮交付
?? public/tuffex-dashboard-preview.png  ← 本轮之前就存在的未跟踪文件
$ npm test  →  tests 562 / pass 561 / fail 0 / skipped 1     （与 blue 自报基线一致）
```
临时备份文件已删除；浏览器锁与构建锁均已释放（`ls -d /tmp/cac-*.lock` → 不存在）。
**产品代码零残留改动。**

---

## 6. 未验证项

1. **`vue-tsc` 装上去之后的真实存量报错数**：我**没有安装**它（新增 devDependency 需用户拍板），因此「存量报错可控/不可控」是**推断**而非测量。建议第一步就用 `npx vue-tsc --noEmit`（临时、不落 `package.json`）拿到真实数字再定分期。
2. **R5-A 在其他测试文件上的表现形式**：我只在 `libConfirm.test.ts` 上验证了「挂起 vs 失败」的语义；其他文件若出现 `await` 悬挂，表现形式未必相同。
3. **`libImports` 的模板盲区是读码推断**：我确认它只解析 `<script setup>`，但**未构造**一个「仅模板中引用未导入符号」的样本来实测它是否漏检。
4. **`libImports` 对非 `src/lib` 模块的盲区**同样是读码推断（`exportedSymbols` 只扫 `src/lib`），未逐模块实测。
5. **对比度**：未量化，本报告**不含对比度结论**（沿用前四轮口径）。
6. **非 Chromium 浏览器**：只测 ego-lite Chromium。
7. **`/models` 批量操作的真实提交**：本轮未涉及（第四轮已注明：只做「开确认框→取消」，服务端逐条失败语义未实测）。
8. **`ConsoleNav.vue` 的并发改动**：非我所为，未审查、未纳入本轮任何结论。

---

## 7. 判据速查（可原样复跑）

```bash
# 0) 基线
git log --oneline -1                                  # d5a8d3c
find src index.html docs.html -type f \( -name '*.vue' -o -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.html' \) \
     -newermt "$(stat -f '%Sm' dist/index.html)"      # 期望：空

# 1) R4-B 复验（构建锁内）
for i in $(seq 1 36); do mkdir /tmp/cac-build.lock 2>/dev/null && break || sleep 5; done
shasum -a 256 src/lib/resource.ts src/lib/confirm.ts src/pages/ModelsPage.vue   # 记基线
#   攻击1b: 在 resource.ts 守卫前插 'data.value = result'，catch 里插 'error.value = err'
npm test                                            # 期望 fail 3（562/558/3）
node --test --import tsx server/reportPageFrontend.test.ts   # 期望仍 5/5 绿（文本断言对语义无感）
#   攻击2a: 删 confirm.ts 的 'confirmState.resolve = null'
node --test --import tsx server/libConfirm.test.ts  # 期望 1 fail
#   攻击2b: 删 confirm.ts 的 'confirmState.resolve?.(false)'
timeout 70 npm test                                 # 期望 exit=124（挂死）→ R5-A
node --test --test-timeout=8000 --import tsx server/libConfirm.test.ts; echo $?   # 期望 exit 1
#   攻击3: 删 ModelsPage.vue 的 'import { sortKeyForColumn, tableSortState } from ../lib/tableSort'
node --test --import tsx server/libImports.test.ts  # 期望 2 fail（精确到符号）
npx tsc -b; echo $?                                 # 期望 0  ← 盲区证据
#   还原
cp <改动前备份> <file>; shasum -a 256 <file>; git diff --stat -- <file>
rmdir /tmp/cac-build.lock
```

浏览器关键判据（`spaceId=31`，均已实测）：

| 项 | 选择器 / URL | 期望 |
|---|---|---|
| 逐列矩阵 | `/models?sort={name,input,output,usage,sources}&dir={asc,desc}` | 恰好 1 个 `th[aria-sort]` = 期望列，值 = ascending/descending，其余 sortable 全 `none`（**10/10**） |
| 未知 key | `/models?sort=zzz` | 指示器 = 模型名称 ascending；行序与默认 name-sort 逐行一致 |
| 键盘 | 聚焦 `th` 内 `button` 后 `Enter` | URL 变 `?sort=input`；标记列移到 `每 1M Token 定价` |
| `sort=output` 截图 | `/models?sort=output&dir=desc` | 标记列 = 每 1M Token 定价 descending |

---

## 8. 给 Lead 的建议（按性价比，全部零新依赖）

1. **`package.json` 的 `test` 脚本加 `--test-timeout`**（建议 30000ms），并确保 CI 门禁**按退出码**判定而非按 `fail` 计数。一行改动，直接消掉 R5-A 的「无界挂死 + `fail 0` 静默放行」。
2. **把 `libImports.test.ts` 的自检改成自包含**（§3.3），并把覆盖从 `src/lib` 扩到所有本地相对模块。当天可做完，且能让这道守卫在格式化改动下不再假红。
3. **`vue-tsc` 走「先装后卡」的分期**（§3.4）：先用 `npx vue-tsc --noEmit`（临时、不落 `package.json`）量出存量报错数，再决定是全量接 `build`，还是先收窄到 `src/lib/**` + 已迁移页面。**是否引入需用户拍板**（新增 devDependency），我未安装、也未改动 `package.json`。
4. **R4-A / R4-B 两条修复可以结案**：我用的攻击手法（R4-B）与抽查范围（R4-A）都已被独立复现为「修复生效」。第四轮那两条发现不需要再投入。
