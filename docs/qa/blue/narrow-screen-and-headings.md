# 第十三轮：`/cache` 窄屏静默裁表（R10-C）+ `/ab` 三个 h1（R10-F）+ 契约措辞（task-38 / blue-ui）

日期：2026-10-01 · 依据：`docs/qa/red-team/round10-verification.md`
构建：`npm run build` ✓ 614ms；截图 `docs/qa/blue/shots/r14-{cache-390-scrollable,cache-desktop,ab-single-h1}.png`。

**一句话**：`/cache` 的表格在 390/768 下被静默裁掉 378px（前十轮桌面审计发现不了），根因是**全站唯一一张没有加 `scroll-x` 的 `TxDataTable`**；已按既有 `--table-min` + `.is-scroll-x` 做法改成横向滚动。`/ab` 的 3 个可见 `<h1>`（实验台 + 两侧内嵌 `KeysPage`）改成「页级 1 个 h1、内嵌自动降级 h2」，`/keys` 正常页面不受影响。两条契约措辞已写进 `typography-unification.md`。

---

## 1. R10-C `/cache` 窄屏静默裁表

### 修前复现（Lead 的扫描器，本机重放）

```console
$ cat scripts/qa-viewports.mjs | ego-browser nodejs
{"viewport":"390(mobile)","route":"/cache","pageOverflow":0,"silentlyTruncated":1,"intentionalEllipsis":5,
 "sample":[{"cls":"tx-data-table.is-striped","overflowBy":378,"intentional":false,"silent":true,
            "text":"时间模型Key客户端输入输出缓存读缓存写"}]}
{"checked":98,"failing":1,"renderFailures":0,"silentlyTruncatedTotal":1}
EXIT=1
```

**根因**：`CachePage.vue` 的 `TxDataTable` 是全站**唯一**没有 `scroll-x` 的一张（`analytics`/`channels`/`keys`/`models`/`usage` 都有）。没有 `scroll-x` 时 Tuffex 不给容器加 `.is-scroll-x`，`.tx-data-table` 默认 `overflow:hidden` → 更宽的内容被**直接裁掉**：没有滚动条、也没有省略号（`text-overflow:clip`），右半张表（输入/输出/缓存读/缓存写/命中率/花费/耗时）**完全不可达**。

### 修法（照抄既有配方，不用省略号掩盖）

```diff
       <TxDataTable
         :columns="liveColumns"
         :data="liveEvents"
         row-key="requestId"
         striped
         bordered
+        scroll-x
+        :style="{ '--table-min': '760px' }"
         class="live-table"
       >
```
`760px` 取自实测的自然列宽（修前 `scrollWidth` 就是 732，取略大值避免列被压到内容宽度以下）。低于 760px 时保列宽、容器横向滚动；≥760px 时表格照旧占满 100%。

### 修后证据（浏览器计算样式 + 可达性实测）

| 视口 | 容器 class | `overflow-x` | clientWidth / scrollWidth | 可滚动 | 滚到最右后最后一列「耗时」位置 |
| --- | --- | --- | --- | --- | --- |
| 390（桌面模拟） | `… is-scroll-x …` | `auto` | 354 / **760** | ✅ | 表头右边缘 x=372（在 390 视口内）✅ |
| 390（mobile 模拟） | `… is-scroll-x …` | `auto` | 354 / **760** | ✅ | 同上 ✅ |
| 768 | `… is-scroll-x …` | `auto` | 732 / 760 | ✅（滚 28px） | x=750 ✅ |

列清单确认 11 列全在：时间 / 模型 / Key / 客户端 / 输入 / 输出 / 缓存读 / 缓存写 / 命中率 / 花费 / 耗时；单元格文本（如 `1.5s`）在滚动后可见 —— **数据靠滚动可达，不是靠 tooltip**。截图 `r14-cache-390-scrollable.png`、`r14-cache-desktop.png`。

### 全站逐页 390/768 复查（其它页有没有「恰好放得下」）

修后跑满扫描器全部 **7 视口 × 14 路由 = 98 组合**（含 768、390 桌面模拟、390 mobile 模拟）：

```console
$ cat scripts/qa-viewports.mjs | ego-browser nodejs
{"checked":98,"failing":0,"renderFailures":0,"silentlyTruncatedTotal":0}
EXIT=0
```

`failing: 0` + `silentlyTruncatedTotal: 0` 意味着**每个路由在每个视口**都没有页面级溢出（`pageOverflow ≤ 2`）也没有「`overflow:hidden` 容器内被裁」的情况 —— 修前唯一命中的就是 `/cache@390(mobile)`，其余页面确实只是「放得下」而不是「被裁」。**验收标准达成**。

## 2. R10-F `/ab` 的 3 个可见 h1

### 修前
`/ab` 可见 h1 = **3**：实验台自己的「A / B 交互对照台」 + A 侧冻结副本 `KeysPage.legacy` 的「API Key 管理」 + B 侧真实 `KeysPage` 的「API Key 管理」。样式一致但语义错：屏幕阅读器会在实验台里念出「一级标题：API Key 管理」。

### 修法（内嵌降级，且不动正常页面）

1. `src/components/PageHeader.vue`：
   - 新增 `level?: number` 属性（默认 1）；
   - 新增并从组件**导出**注入键 `EMBEDDED_HEADING_KEY`（放在同文件的普通 `<script>` 块里）；被内嵌时标题自动降级为 `h2`；
   - 标题元素改为 `<component :is="headingTag" class="page-head__title">`。
2. `src/styles/layout.css`：页头标题样式从标签选择器改为 `标签 + 类`（`.page-head h1, .page-head .page-head__title`），**保证降级成 h2 后仍是同一个视觉签名**（22px/600/30px）。
3. `src/pages/AbLabPage.vue`：`provide(EMBEDDED_HEADING_KEY, true)`；**自己那份页头显式 `:level="1"`**（provide 对自己的模板子孙同样生效，必须显式覆盖）。
4. `src/ab/variants/legacy/*.vue`（4 个冻结副本）：`<h1>` → `<h2 class="page-head__title">`；帮助页副本的本地 `<h1>` 规则同步改为类选择器（保留其冻结外观 24px）。
   > 依赖方向是「实验台 → 共享组件」：键定义在 `PageHeader` 里、由 lab 反向 import，组件不需要知道实验台存在。

### 修后证据（可见元素计算样式）

| 路由 | 可见 h1 数 | h1 文本 | 内嵌标题（原 h1） |
| --- | --- | --- | --- |
| `/ab` | **1** | A / B 交互对照台（H1 22px/600） | 两个 `H2 22px/600`「API Key 管理」✅ |
| `/ab?flow=help` | **1** | A / B 交互对照台 | 同上 ✅ |
| `/keys`（正常页面，**未被改坏**） | 1 | API Key 管理（H1 22px/600） | — |
| `/dashboard`、`/help` | 1 | 运行概览 / 接入帮助指南 | — |

截图 `r14-ab-single-h1.png`。

## 3. 契约措辞（防止被误「修」回去）

已写入 `docs/qa/blue/typography-unification.md` 的 **「唯一性检查必须按「角色 + 语境」分层」**一节：

| 组合 | 计算样式 | 结论 |
| --- | --- | --- |
| `.muted` × `.page-head p` | `14px/22px` | **合理、保留**：`.muted` 管颜色/弱化，`.page-head p` 管页头散文尺度，与 h1 的 22px/30px 成比例；压到 13px 会让页面说明比正文小、破坏层次 |
| 行内 `code` | **尺寸唯一** `12px/18px` mono；**颜色 3 个语境变体** | 尺寸层必须唯一；颜色层按语境继承，不算漂移 |

口径写成三条：**尺寸层必须唯一 / 颜色层按语境允许变体 / 组合层只要求同组合唯一**。并明确写了一句 「看到 `.muted` 在页头是 14px 就把它『修』成 13px，是**回归**，不是修复」。

## 4. 命令与退出码

```
$ npx tsc -b        → tsc_exit=0
$ npm run lint      → lint_exit=0（4 条 warning，见下）
$ npm run build     → build_exit=0 · ✓ built in 614ms
$ npm test          → test_exit=0 · ℹ tests 612 · pass 611 · fail 0 · cancelled 0 · skipped 1
$ cat scripts/qa-viewports.mjs | ego-browser nodejs → failing: 0 · EXIT=0
```

**lint 的 4 条 warning 中有 2 条不是我引入的**：`scripts/qa-viewports.mjs:37` 与 `scripts/qa-contrast.mjs:37` 的 `fillWithRetry` 声明未使用（`scripts/**` 是你的文件，我没动，仅报告）。另外 2 条是既存的 `server/nativeResponses.ts no-control-regex`。

本轮改动（8 文件，全部在授权范围内）：

```console
$ git diff --stat -- src/pages/CachePage.vue src/pages/AbLabPage.vue src/components/PageHeader.vue src/styles/layout.css src/ab
 src/ab/variants/legacy/DashboardPage.legacy.vue |  2 +-
 src/ab/variants/legacy/HelpPage.legacy.vue      |  5 +++--
 src/ab/variants/legacy/KeysPage.legacy.vue      |  2 +-
 src/ab/variants/legacy/OAuthPage.legacy.vue     |  2 +-
 src/components/PageHeader.vue                   | 29 +++++++++++++++++++++++--
 src/pages/AbLabPage.vue                         | 12 ++++++++--
 src/pages/CachePage.vue                         |  9 ++++++++
 src/styles/layout.css                           |  8 ++++++-
 8 files changed, 59 insertions(+), 10 deletions(-)
```

## 5. 未验证 / 剩余

1. `/ab` 的 h1 实测覆盖默认流程与 `?flow=help` 两种；其余流程（dashboard/oauth）走同一套 `provide` + 冻结副本降级逻辑，未逐一截图（4 个冻结副本的 `<h1>` 已全部改为 `<h2 class="page-head__title">`，`grep` 可复核）。
2. `--table-min: 760px` 是按**当前** `liveColumns` 调的值：将来给 `/cache` 加列需要同步上调，否则列会被压窄（不会静默裁掉——已可横向滚动）。
3. 冻结副本的 A 侧仍保留各自迁移前的外观（帮助页副本标题 24px 来自它自己的 scoped 规则），这是「A = 迁移前」的设计意图，不是漂移；若你希望 A 侧也统一到 22px，说一声我改。
4. 扫描器只覆盖 7 个固定视口；`2560/1280/1024/900` 四档本轮也全绿（含在 98 组合里）。
