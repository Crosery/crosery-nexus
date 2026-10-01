# Crosery API Console — 第四轮 UI 对抗验证（红队 B / task-20）

**被验对象（本地 HEAD）**：`0b7aab9`（`e52617a` 删 25 个 React 死文件 + /models 新功能 → `fabd4fe` 删死树残留 → `0b7aab9` 对齐发布元数据）
**实例** <http://127.0.0.1:8791>｜**dist 构建时间**：`dist/index.html` 与 `dist/docs.html` 均为 `2026-10-01 09:57:33`｜**dist 不早于 src** 已核对：`find src index.html docs.html -newermt "$(stat -f '%Sm' dist/index.html)"` → **0 个文件**（最新 src `AnalyticsPage.vue` 09:51:45）
**审计人** `ux-auditor` / task-20｜**实测时点** 2026-10-01 09:58–10:06｜浏览器：TaskSpace `spaceId=27`（+ `28` 用于列显隐复测），均已 `finish({keep:[]})`；浏览器锁与构建锁均已 `rmdir` 释放
**写入边界**：只写 `docs/qa/red-team/**`（新目录 `shots-r4/`，11 张截图）。产品代码仅在**第 3 条自证**期间临时改动 2 次，**均已按 sha256 逐字节还原**（见 §3）。

---

## 0. 结论速览

| # | 主张 | 判定 |
|---|---|---|
| 1 | `/models` 批量启停有确认框、取消零写、文案交代影响面 | ✅ **已验证**（文案披露「逐条执行、失败会如实列出」） |
| 1 | `/models` 列显隐深链 / URL 同步 / 刷新保持 | ✅ **已验证** |
| 1 | `/models` `aria-sort` 与 `?sort=&dir=` 一致、键盘可排序 | ⚠️ **部分被推翻**：`sort=input/usage/sources/name` 一致且键盘可用；**`sort=output` 时 `aria-sort` 落在错误列**（新缺陷 R4-A） |
| 1 | `/models` 分页 × 筛选 × 排序自洽 | ✅ **已验证** |
| 2 | 删 25 个 React 死文件无可见回归（含静态资源 404） | ✅ **已验证**：15 条路由 **0 个 4xx/5xx、0 个 JS 错误**；构建产物**260 个 chunk 引用全部可解析** |
| 3 | blue-ui 的 3 个守卫测试「改坏活代码就红」 | ✅ **已验证（能变红）**，但 ⚠️ **该自证的说服力被推翻**：它们是**源码文本正则断言**，我把竞态守卫**语义上打瘫**后**全套 546 个测试仍然全绿**（新发现 R4-B） |
| 4 | `/ab` 只读闸门仍生效 | ✅ **已验证**：拦截计数 +1，且 **CDP 独立观测到 0 个非 GET 离开页面** |
| 4 | `/ab` 投票通道可用 | ✅ **已验证**：投票成功，`data/ab-preferences.jsonl` 2 → **3** 行 |

**本轮独立发现的问题 2 条**：R4-A（`aria-sort` 错位，中）、R4-B（守卫测试只做文本匹配，中）。**未发现**删死树导致的任何可见回归（这是我本来预期最可能出问题的一面，结果是干净的）。

---

## 1. `/models` 新功能真伪

### 1.1 批量启停 ✅
**判据**：`/models` → 勾选 2 行 → 观察批量条 → 点「批量停用渠道映射」→ 读确认框 → **点取消** → 断言页内 `window.__w`（所有非 GET 被短路成假 200，服务端不被触达）为空。

| 步骤 | 实测 |
|---|---|
| 行复选框 | `tbody [role="checkbox"]` **25 个**，带 `aria-checked="false"`、`aria-disabled="false"`（真 a11y 语义，不是装饰） |
| 选中 2 行后 | `[role="region"][aria-label="批量操作"]` 出现，文本 `已选 2 个模型（2 行） 批量启用渠道映射 批量停用渠道映射 清除选择` |
| 点「批量停用渠道映射」 | 确认框出现：标题 `批量停用渠道映射`；正文 `将对 2 个模型的 2 条渠道映射执行「停用」。停用会让使用这些映射的调用失败，操作逐条执行、失败会如实列出。`；按钮 `取消` / `批量停用` |
| **点取消** | `window.__w === []`（**零写请求**），确认框关闭 |

**关于「是否说明不保证原子」**：原文是 **「操作逐条执行、失败会如实列出」**——没有出现「原子」二字，但**准确披露了逐条执行与部分失败**，我认为这满足该要求的实质意图（比写「不保证原子」更可读）。判定：**满足**。

证据：`shots-r4/models-批量选中-桌面.png`、`shots-r4/models-批量停用-确认框-桌面.png`

### 1.2 列显隐 ✅
**判据**：深链 `?cols=model,pricing` → th 数量；点 `[aria-label="显示哪些列"]` 里的按钮 → URL 是否同步；`reload()` → 是否保持。

| 步骤 | URL | 表头 | 按钮 `aria-pressed` |
|---|---|---|---|
| 深链 `?cols=model,pricing` | 原样保留 | `模型名称 / 每 1M Token 定价`（+1 个选择列）= **2 个数据列** | — |
| 默认 | `/models`（默认值不进 URL ✓） | 4 列 | 4 个全 `true` |
| 点掉「每 1M Token 定价」 | **`/models?cols=model,sources,usage`** | 3 列（定价列消失） | 定价 `false`，其余 `true` |
| **`reload()` 后** | `?cols=model,sources,usage` 保持 | **仍是 3 列** | 状态与 URL 一致 |

**判定：深链 / URL 同步 / 刷新保持三项全部通过。** 至少留一列的护栏存在于 `ModelsPage.vue:262-266`（`if (!next.length) return`）。
证据：`shots-r4/models-列显隐-深链-桌面.png`、`shots-r4/models-列显隐-切换后-桌面.png`

### 1.3 `aria-sort` 与键盘 ⚠️ **发现 R4-A**

**先验证通过的部分**（`th` 内是**真 `<button type="button">`**，原生可聚焦）：
- 初始：`模型名称` = `ascending`，其余 `none`（与默认 `sort=name&dir=asc` 一致）✓
- 点「每 1M Token 定价」表头 → URL `?sort=input`、`定价` = `ascending`、`模型名称` = `none` ✓（`pricing` 列映射到 `input` 单价，是有意的映射）
- 再点一次 → `?sort=input&dir=desc`、`定价` = `descending` ✓ **翻转正确**
- 深链 `?sort=usage&dir=desc` → `用量与花费` = `descending` ✓
- **键盘**：`th button` 聚焦后按 `Enter` → URL 变 `?sort=input`、`aria-sort` 正确移到定价列 ✓ **键盘可排序**

**🔴 R4-A（中）：选择「按输出单价」后 `aria-sort` 落在错误列，且没有任何可见指示器能纠正它**
- **复现（纯 UI 操作，无需改 URL）**：`/models` → 打开 `[aria-label="排序字段"]` → 选 **「按输出单价」**
- **实测结果**：
  - URL = `/models?sort=output`（合法值）✓
  - **表格行序确实变了**（首三行从 `~anthropic/claude-*` 变成 `qcn-qwen3.7-flash …`）→ 说明**真的按输出单价排了**
  - 但 `aria-sort`：`模型名称 = ascending`，**`每 1M Token 定价 = none`** ❌
  - 即：**表格按「输出单价」排序，`aria-sort` 却告诉屏幕阅读器「按模型名称升序」**
- **根因**（`src/pages/ModelsPage.vue:240-242`）：
  ```js
  const SORT_BY_COLUMN = { model: 'name', sources: 'sources', pricing: 'input', usage: 'usage' }  // 无 'output'
  const columnOfSort = computed(() => Object.entries(SORT_BY_COLUMN).find(([, k]) => k === sortKey.value)?.[0] ?? 'model')
  ```
  `SORTS`（**`ModelsPage.vue:28-34`**）有 5 个值 `name/input/output/usage/sources`，而 `SORT_BY_COLUMN`（`:240`）只映射了 4 个。`sort=output` 找不到对应列 → **兜底成 `'model'`** → `tableSort = { key:'model', order }` → `模型名称` 拿到 `aria-sort`。
- **放大影响的一点**：我检查了表头按钮的 class，`tx-data-table__sort-button is-align-left`，在任何排序状态下都**没有** `is-active/is-asc/is-desc` 之类的可见标记；Tuffex 的排序按钮样式里也**没有**激活态箭头样式。所以**唯一**的排序指示就是 `aria-sort` 本身——它错了，就没有第二个信号能纠正。**结论：任何用户都无法看出表格正按输出单价排序；屏幕阅读器用户则被明确告知错误的排序列。**
- **最小修法**（二选一，推荐后者）：
  1. 把 `output` 也映射到定价列：`{ …, pricing: 'input', output: 'pricing' }` —— 但 `input`/`output` 会共用同一列，语义上可接受（该列同时显示输入/输出价）。
  2. **把兜底从 `?? 'model'` 改成返回「无匹配」**（如 `?? null` 并让 `tableSort.key` 为空 → Tuffex 不给任何列打 `aria-sort`）。这样**未来任何新增的未映射排序键都不会再谎报列名**，是 fail-safe 的方向。
- 证据：`shots-r4/models-排序-output-aria错位-桌面.png`（另 `models-排序-aria-sort-桌面.png` 为 `sort=input` 的正确对照）

### 1.4 分页 × 筛选 × 排序 ✅
**判据**：越界页码是否夹回且 URL 是否纠正；筛选变更是否重置页码；排序是否在筛选后保持；结果计数是否与筛选一致。

| 场景 | URL | 计数文本 | 行数 | `aria-sort` |
|---|---|---|---|---|
| `?page=99`（越界） | **被改写为 `?page=22`** ✓ | `共 527 个模型，第 22 / 22 页` | 2 | 模型名称 ascending |
| `?sort=usage&dir=desc&page=2` | 原样 | `共 527 个模型，第 2 / 22 页` | 25 | 用量与花费 descending ✓ |
| 在 page=2 上改筛选 | `?filter=contested&sort=usage&dir=desc`（**`page` 被丢弃** ✓，`size=25` 是默认值本就不写） | `共 0 个模型（已筛选，原 527 个），第 1 / 1 页` | 1（空态行） | 用量与花费 descending **保持** ✓ |

- **页码夹回并写回 URL**：`ModelsPage.vue:193-197` 的 `watch(() => paged.value.page, …)` 把夹回值写回 `scope.state.page` → URL 与实际视图一致 ✓
- **计数与筛选一致**：计数文本明确区分「已筛选，原 N 个」 ✓
- **三者组合自洽** ✅
- 证据：`shots-r4/models-筛选排序分页组合-桌面.png`

---

## 2. 死树删除的可见回归扫描 ✅ **未发现回归**

### 2.1 15 条路由逐条打开（含 `/`、`/docs` 两个入口）
**判据**：用 `Page.addScriptToEvaluateOnNewDocument` 在**任何应用脚本之前**注入 `error` / `unhandledrejection` 监听；`Network.enable` 后逐条 `goto`，每次读 `window.__errs` 与 CDP 的 `responseReceived`。

| 路由 | 4xx/5xx | loadFailed | JS 错误 | `document.title` | `h1` |
|---|---|---|---|---|---|
| `/`（Vue 入口，→ dashboard） | 0 | 0 | 0 | Crosery API Console | 运行概览 |
| `/dashboard` | 0 | 0 | 0 | Crosery API Console | 运行概览 |
| `/keys` | 0 | 0 | 0 | Crosery API Console | API Key 管理 |
| `/channels` | 0 | 0 | 0 | Crosery API Console | 渠道与服务网关 |
| `/oauth` | 0 | 0 | 0 | Crosery API Console | OAuth 授权登录 |
| `/models` | 0 | 0 | 0 | Crosery API Console | 模型总览 |
| `/rtk` | 0 | 0 | 0 | Crosery API Console | RTK Token 压缩 |
| `/charts` | 0 | 0 | 0 | Crosery API Console | 图表分析 |
| `/analytics` | 0 | 0 | 0 | Crosery API Console | 使用统计与请求明细 |
| `/usage` | 0 | 0 | 0 | Crosery API Console | 统计和使用情况 |
| `/cache` | 0 | 0 | 0 | Crosery API Console | 缓存命中率分析 |
| `/monitor` | 0 | 0 | 0 | Crosery API Console | 上游账号与额度监控 |
| `/help` | 0 | 0 | 0 | Crosery API Console | 接入帮助指南 |
| `/ab` | 0 | 0 | 0 | Crosery API Console | A / B 交互对照台 |
| **`/docs`（React 入口）** | **0** | **0** | **0** | **Crosery API 文档** | **拿到 API Key 后直接发请求** |

**合计：15 条路由、0 个 4xx/5xx、0 个加载失败、0 个 JS 错误。**

**两点需要澄清，避免误报**：
- `/` 与 `/dashboard` 在我第一遍扫描里命中了我自己的宽松选择器（`[class*="error-panel"], [role="alert"]`），复记为 **`tx-alert tx-alert--error`「高错误率预警 当前错误率为 41.6%，建议前往账号监控或请求明细页排查。」**——这是**正常的业务告警**（而且恰好证明第一轮那个「41.6% 被渲染成 0.0%」的谎言确实修好了），**不是阻断级错误**。
- `/models` 页面在 `?page=99` 场景下 `tbody tr` 计数为 2，是末页真实数据行；筛选 0 结果时为 1 行空态行。二者都不是错误。

### 2.2 静态资源 404 —— 结论：**没有 404 面**
删文件后最可能留下的回归是「旧引用残留」。我做了**三层**核对，全部干净：

1. **两个入口 HTML 的每一个本地引用都存在**
   - `dist/index.html` 7 个引用（`/favicon.ico`、`/icon-192.png`、`/apple-touch-icon.png`、`/assets/console-DcbL7GlC.js`、`/assets/modulepreload-polyfill-Dezn_h7o.js`、`/assets/card-Dnz3VttA.js`、`/assets/console-CLk7TSk0.css`）→ **全部 OK**
   - `dist/docs.html` 6 个引用（含 `/assets/docs-BAITTIl8.js`、`/assets/docs-_KdOmDRz.css`）→ **全部 OK**
   - 我独立测得 `dist/assets/docs-BAITTIl8.js` = **210,892 字节**，sha256 前缀 `1faf432bcf9557de`；`docs.html` 里引用的正是这个文件名 → 与清理前一致（**这是我自己量的，不是引用 Lead 的数**）。
2. **构建产物内部的 chunk 图完整**：扫描 `dist/assets/*.js|*.css` 中所有 `"assets/…"` 与 `"./…"` 引用共 **260 条**，按正确基准目录解析后 → **缺失 0 条**。
3. **源码里没有任何指向已删 React 模块的引用**：`grep -rn "App\.tsx|main\.tsx|pages/*Page\.tsx|components/*\.tsx|CredentialUploadPage" src server index.html docs.html vite.config.ts package.json` → **0 命中**（仅 3 个测试文件的**注释**里提到历史文件名，不是引用）。

**未被误删的验证**：`src/` 下仍保留 **2 个** `.tsx`（`docs-entry.tsx`、`docs.tsx`）——它们是 `/docs` 的 React 入口，**必须保留**，且删除清单里没有它们 ✓。`src/docs.css`（被 `docs.tsx:3` 引用）与 `src/index.css`（被 `docs-entry.tsx:3` 引用）**都还在且仍被引用**，所以「`index.css`/`docs.css` 缺失」这一风险**不成立**。`src/App.css` 已随死树删除，且**无任何文件再引用它** ✓。

### 2.3 `/ab` 实验台 ✅
**只读闸门**（判据：状态文本中的拦截计数 + **CDP 独立观测**，不依赖页面自己的埋点）
- 闸门提示常驻：`本页是只读对照：A/B 两侧的写操作（删除、重置、剪枝、开关）都会被拦截，不会改到真实数据；要真的执行请到对应真实页面。`
- 在 A 侧（legacy KeysPage，`?flow=keys-access&v=a`）点「重置今日用量」→ 计数文本变为 **`已拦截 1 次写请求（最近：api.resetQuota()）`** ✓（+1）
- **CDP 独立复核**（`Network.enable` 收集 `requestWillBeSent` 中 `method !== GET`）→ **`[]`，零个非 GET 离开页面** ✓ 说明闸门在**函数层**就挡住了，根本没走到网络层。
- 代码依据：`src/ab/readOnlyGate.ts:11-30`（三层拦截面 fail-closed + 只读白名单）、`:58`（**唯一放行** `POST /api/ab/preference`）、`:61`（拦截文案）；页面展示 `src/pages/AbLabPage.vue:255-262`。
- 证据：`shots-r4/ab-只读闸门-拦截-桌面.png`

**投票通道** ✅（本轮**唯一允许的写操作**，我只投了 1 票）
- 三个选项按钮带 `aria-pressed`；选「选 B（迁移后更顺手）」+ 填一句话理由 → 点「提交这一票」
- 结果：`类名 = ab-lab__status--ok`，文本 `已记录（abp_muow4yuw_7fb6067e）：这一票会出现在 data/ab-preferences.jsonl 里。` ✓
- **落盘核对**：`data/ab-preferences.jsonl` **2 → 3 行**，末行内容为
  `{"schema":1,"id":"abp_muow4yuw_7fb6067e","at":"2026-10-01T02:04:07.928Z","flow":"keys-access","choice":"b","note":"r4 红队复核：…","blocker":"","userAgent":"…","admin":true,"redacted":false}`
  → `flow`/`choice`/`note`/时间/UA 齐全，`admin:true`，`redacted:false` ✓
- 且此时拦截计数仍为 `none`（未被 +1）→ 证明投票被白名单正确放行，没有误伤 ✓
- 证据：`shots-r4/ab-投票-填写-桌面.png`、`shots-r4/ab-投票-成功-桌面.png`

---

## 3. 独立复现 blue-ui 的「改坏活代码就红」自证

### 3.1 我挑的改动点（与 blue-ui 不同）
`src/lib/resource.ts` 的**序号守卫**（`useResource` 的竞态丢弃）。被验测试：`server/reportPageFrontend.test.ts`，其断言为
`server/reportPageFrontend.test.ts:31-32`：
```js
assert.match(resource, /const mine = \+\+seq/)
assert.match(resource, /if \(mine === seq && !disposed\) \{\s*data\.value = result/)
assert.match(resource, /if \(mine === seq && !disposed\) error\.value = err/)
assert.doesNotMatch(resource, /data\.value = undefined/)
```
**基线**：`git status --short src/lib/resource.ts` 为空（相对 HEAD 干净）；sha256 = `c37db61cc289335201f5bcef9182a44834fca157cc254613a59519a68098d46b`；单文件测试 **5 pass / 0 fail**。

### 3.2 改动 A：文本改动 → **确实变红（复现了 blue-ui 的主张）** ✅
改动：`const mine = ++seq` → `const mine = seq + 1`（1 行）
```
✖ report 页面用专用 loader，竞态由 useResource 的序号守卫统一丢弃过期响应
ℹ tests 5   ℹ pass 4   ℹ fail 1
AssertionError: The input did not match the regular expression /const mine = \+\+seq/
```
→ **判定：blue-ui 的「改坏就红」主张成立。**

### 3.3 改动 B：语义改动（保留全部被断言文本）→ **仍然全绿（推翻了该自证的说服力）** 🔴 **R4-B**
改动：在守卫**之前**插入一行**无守卫**的写入
```diff
       const result = await fetcher()
+      data.value = result
       if (mine === seq && !disposed) {
         data.value = result
```
这一行让 `data` **无条件被写**，于是迟到响应会覆盖新结果——**序号守卫在语义上已被完全打瘫**（正是该测试的名字所声称保护的东西）。而四条断言**全部仍然成立**（`++seq` 原样、带守卫的块原样、`data.value = undefined` 未出现）。

实测：
- 单文件测试：**5 pass / 0 fail**（绿）
- **整套 `npm test`：`tests 546 / pass 545 / fail 0 / skipped 1`**（绿，与你引用的基线数字**完全一致**）

→ **判定：这 3 个守卫测试是「源码文本正则断言」，不是行为测试。** 它们能挡住「把字符串改掉」，但**挡不住同类的语义回归**——只要被断言的那几行文本还在，竞态守卫被打瘫也不会红。
**实际风险**：`npm test 546/545/0/1` **不能**作为「竞态保证仍然成立」的证据。未来任何人在 `reload()` 里多加一处无守卫的写入、或把守卫拆到另一个函数里，测试都会继续全绿。
**最小修法建议**：把该断言从「正则匹配源码」升级为**行为断言**——`src/lib/resource.ts` 是纯函数式的（只需 Vue 的 `ref/watch`），可以在测试里 `import { useResource }`、用一个受控的 deferred fetcher 造出「先发慢、后发快」的两次调用，断言 `data` 等于**第二次**的结果、且第一次的迟到响应不覆盖它。这不需要新增生产依赖（`vue` 已在 devDeps/依赖中）。

### 3.4 还原证据（两次改动均已逐字节还原）✅
每次改动后我都从**改动前的字节备份**恢复，并以 sha256 与 git 双重核对。**还原后**：
```
$ shasum -a 256 src/lib/resource.ts
c37db61cc289335201f5bcef9182a44834fca157cc254613a59519a68098d46b  src/lib/resource.ts
$ cat /tmp/r4-resource-baseline.sha256
c37db61cc289335201f5bcef9182a44834fca157cc254613a59519a68098d46b  src/lib/resource.ts     # 基线
$ git status --short src/lib/resource.ts      # 空 → 相对 HEAD 干净
$ git diff -- src/lib/resource.ts             # 空 → 无差异
$ git status --short                          # 全仓仅：
?? docs/qa/red-team/shots-r4/                 # 我的本轮交付
?? public/tuffex-dashboard-preview.png        # 本轮之前就存在的未跟踪文件，非我产生
$ npm test  →  tests 546 / pass 545 / fail 0 / skipped 1
```
临时字节备份与基线哈希文件已删除（`/tmp/r4-resource-backup.ts`、`/tmp/r4-resource-baseline.sha256`），构建锁已 `rmdir`。
**结论：产品代码零残留改动。**

---

## 4. 本轮独立发现的问题

### R4-A（中）`/models` 按「输出单价」排序时 `aria-sort` 落在错误列
见 §1.3。**可由纯 UI 操作触发**，根因 `ModelsPage.vue:240-242` 的兜底 `?? 'model'`。修法见 §1.3（推荐把兜底改成「无匹配」）。

### R4-B（中）3 个「守卫测试」只做源码文本匹配，挡不住同类语义回归
见 §3.3。**证据强度**：单文件 + 整套 546 个测试在守卫被语义打瘫后**全绿**。

**其余未发现**：删死树没有留下任何可见回归（§2）；`/models` 的批量、列显隐、分页×筛选×排序均按声称工作（§1.1/1.2/1.4）；`/ab` 闸门与投票均正常（§2.3）。**没有为了凑数而登记的问题。**

---

## 5. 未验证项（明确列出）

1. **R4-A 的可见影响未做屏幕阅读器实测**：`aria-sort` 错位是 DOM 属性层面的确证；AT 实际播报未验证（无辅助技术）。可见层面我确证的是「任何排序状态下表头按钮都无 `is-active` 类」→ 无第二个指示器，但这是 class 层面的推断，未做人眼视觉确认截图比对。
2. **`?sort=<非法值>` 的行为只测了 `pricing`**：页面会静默回退到 `name` 排序，**且不重写 URL**（URL 继续显示 `sort=pricing`），即 URL 与表头状态不一致。这属 R4-A 同族的「URL 未归一化」问题；我未穷举所有非法值。
3. **`/models` 批量操作的真实提交未执行**：按任务要求只做「打开确认框 → 取消」。因此批量启停的**服务端逐条失败语义**（文案承诺的「失败会如实列出」）**未实测**，只验证了文案存在。
4. **死树删除的构建层回归未验证**：我做的是「产物完整性 + 运行时 404」核对，未复跑完整 `npm run build`（构建属串行区且非本轮必需）；`npm test` 已复跑（§3.3）。
5. **对比度**：未量化，故本报告**不含对比度结论**（沿用前三轮口径）。
6. **非 Chromium 浏览器**：只测 ego-lite Chromium；Firefox/Safari（尤其 iOS 的 `clipboard`、`100vh`）未验证。
7. **`/ab` 的 `?v=split` 视图**：未测试（本轮只测 `v=a` 与 `v=b`）。
8. **`/rtk` 业务正确性**：只确认页面正常挂载（无 4xx/5xx、无 JS 错误、h1 正确）；其业务行为属 task-3/task-9 范围。
9. **一个测量假警报（记录以免误导）**：我用 `el.focus()` 读排序按钮的 `outlineStyle` 得到 `none`，一度怀疑焦点不可见；随后在 Tuffex 样式里查到 `.tx-data-table__sort-button:focus-visible{outline:2px solid var(--tx-color-primary);outline-offset:-2px}` —— 是因为**程序化 `focus()` 不触发 `:focus-visible`**，属测试手法问题，**不是缺陷**。已排除。

---

## 6. 判据速查（可原样复跑）

```bash
# 0) 基线：HEAD + dist 不早于 src
git log --oneline -1                       # 期望 0b7aab9
find src index.html docs.html -type f \( -name '*.vue' -o -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.html' \) \
     -newermt "$(stat -f '%Sm' dist/index.html)"          # 期望：空

# 1) 静态资源面无 404（三层）
python3 - <<'PY'
import re,os,glob
for h in ["dist/index.html","dist/docs.html"]:
    for r in re.findall(r'(?:src|href)="(/[^"]+)"', open(h).read()):
        print(("OK  " if os.path.exists("dist"+r) else "MISS"), r)
miss=[]; n=0
for f in glob.glob("dist/assets/*.js")+glob.glob("dist/assets/*.css"):
    t=open(f,errors="ignore").read()
    for m in set(re.findall(r'"(assets/[A-Za-z0-9_.\-]+\.(js|css))"',t))|set(re.findall(r'"(\./[A-Za-z0-9_.\-]+\.(js|css))"',t)):
        c=os.path.join("dist",m) if m.startswith("assets/") else os.path.normpath(os.path.join(os.path.dirname(f),m)); n+=1
        if not os.path.exists(c): miss.append((f,m))
print("chunk refs",n,"missing",len(miss))
PY

# 2) 旧死树引用残留
grep -rn "App\.tsx\|main\.tsx\|CredentialUploadPage" src server index.html docs.html vite.config.ts package.json   # 期望：仅测试注释

# 3) 测试自证（构建锁内）
for i in $(seq 1 36); do mkdir /tmp/cac-build.lock 2>/dev/null && break || sleep 5; done
shasum -a 256 src/lib/resource.ts          # c37db61c…
node --test --import tsx server/reportPageFrontend.test.ts     # 基线 5/0
#   改动A: 'const mine = ++seq' -> 'const mine = seq + 1'        => fail 1（红）
#   改动B: 在守卫前插入 'data.value = result'                     => 仍 5/0（绿）+ npm test 仍 545/0
cp <改动前备份> src/lib/resource.ts && shasum -a 256 src/lib/resource.ts && git diff -- src/lib/resource.ts
rmdir /tmp/cac-build.lock
```

浏览器关键选择器（`spaceId=27`，均已实测）：

| 项 | 选择器 | 期望 |
|---|---|---|
| 批量条 | `[role="region"][aria-label="批量操作"]` | 选中行后出现；`批量停用渠道映射` → 确认框 → 取消 → `window.__w == []` |
| 行复选框 | `tbody [role="checkbox"]` | 25 个，带 `aria-checked` |
| 列显隐 | `[aria-label="显示哪些列"] button` + `aria-pressed` | 点掉一列 → URL `?cols=…`；reload 保持 |
| 排序 | `th button`（真 button，可 Tab+Enter）；深链 `?sort=input&dir=desc` | `aria-sort` 落在对应列 |
| **R4-A 复现** | `[aria-label="排序字段"]` → 选「按输出单价」 | URL `?sort=output` 但 `aria-sort` 落在**模型名称** ❌ |
| 分页 | `?page=99` → URL 应被改写为 `?page=22`；`[aria-label="模型目录分页"]` | 夹回且 URL 纠正 |
| `/ab` 闸门 | `.lab-frame [title="配置额度上限"]` → `重置今日用量` | 计数 +1；CDP 非 GET 计数 = **0** |
| `/ab` 投票 | `[aria-label="显示哪些列"]`…（投票）→ `提交这一票` | `.ab-lab__status--ok`；`data/ab-preferences.jsonl` 行数 +1 |
| 路由扫描 | `Page.addScriptToEvaluateOnNewDocument` 注入 error 监听 + `Network.enable` | 15 条路由 0 个 4xx/5xx、0 个 JS 错误 |

---

## 7. 给 Lead 的建议（按性价比）

1. **R4-A 一行可修**：`ModelsPage.vue:241` 的 `?? 'model'` 改为「无匹配 → 不打 `aria-sort`」，或把 `output` 也映射进 `SORT_BY_COLUMN`。前者是 fail-safe，能防住未来新增排序键再次谎报列名。
2. **R4-B 建议单独立项**：把 `reportPageFrontend.test.ts:31-32` 的源码正则换成 `useResource` 的**行为断言**（受控 deferred fetcher，断言迟到响应不覆盖）。这是本轮唯一会**削弱既有验收结论**的发现——`npm test 546/545/0/1` 目前**不能**证明竞态保证成立。
3. **删死树这一轮可以判定为安全**：15 条路由 0 个 4xx/5xx、chunk 图 260/260、无残留引用、`/docs` 与 `/` 两个入口都正常。这一面不需要再加投入。
4. **`/ab` 的只读闸门值得作为范本**：它是本轮唯一「拦截 + 用户可见计数 + CDP 独立可验证」的设计，且把投票精确列入白名单。建议后续任何「实验/预览」面都照此实现。
5. **两个残留的小项**（不阻塞）：`?sort=<非法值>` 不归一化 URL（§5.2）；`/models` 批量提交的服务端部分失败语义未实测（§5.3）。
