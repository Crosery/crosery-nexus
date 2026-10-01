# 第十轮：三个手写页头收口到共享 PageHeader + `/usage` 表格单元格角色统一（task-32 / blue-ui）

日期：2026-10-01 · 依据：Lead 的排版一致性扫描（task-32）
构建：`npm run build` ✓ 579ms；截图 `docs/qa/blue/shots/r10-{rtk,help,ab}-header.png`、`r10-usage-table.png`。

**一句话**：`RtkPage`/`HelpPage`/`AbLabPage` 的三份手写页头全部改走共享 `PageHeader`，13 个页面的 `h1` 现在**只有一个值** `22px/600/30px`（全部位于 `.page-head` 内）；`/usage`「行高 normal」的根因**不是数据单元格差异**，而是 Tuffex 的 `.tx-data-table__empty` 没有字体规则、空表时继承了页面级 14px/normal —— 已按数据单元格同角色收口为 `13px/1.5`。

---

## ① 三页页头迁移

| 页面 | 迁移前 | 迁移后 |
| --- | --- | --- |
| `/rtk` | 手写 `<section class="page-head">` + `.eyebrow="RTK"`；本地覆盖 `h1{24px/700}`、`p{13.5px/1.5}` | `<PageHeader title description :crumbs>`；`RTK` 语义移到**面包屑**「接入 → RTK 优化」+ meta 行「角色：RTK 控制面（只在本机写配置；远端网关只读）」；本地 `h1/p` 覆盖删除 |
| `/help` | 手写页头 + `.eyebrow="DOCUMENTATION"`；本地 `h1{24px/700}` | `<PageHeader>`；eyebrow 移到面包屑「首页 → 接入帮助」+ meta 行「文档 · DOCUMENTATION」（保留原字词与配色）；本地 `h1/p/.eyebrow` 覆盖删除 |
| `/ab` | `.ab-lab__hero` 手写 hero（`h1{26px/1.25}`、`.ab-lab__eyebrow`） | `<PageHeader>`；描述位承接「自助，不打断…」；eval 细节（含 `<code>281c30e</code>`）放 **meta 槽**（内容与标记原样保留）；两个按钮移入 **actions 槽**；`.ab-lab__hero*` 样式删除 |

**语义保真实测**（浏览器取 DOM）：

| 页面 | 面包屑 | meta | actions | `<code>` 是否保住 |
| --- | --- | --- | --- | --- |
| `/rtk` | 「接入 → RTK 优化」 | 「角色：RTK 控制面（只在本机写配置；远端网关只读）」 | — | — |
| `/help` | 「首页 → 接入帮助」 | 「文档 · DOCUMENTATION」 | — | — |
| `/ab` | 「首页 → A/B 实验台」 | 「同一个真实流程的新旧两版放在这里。A = 迁移前（提交 `281c30e` 的冻结副本）…」 | 「复制当前深链」「只看对照」 | ✅ `true` |

截图：[r10-rtk-header.png](docs/qa/blue/shots/r10-rtk-header.png)、[r10-help-header.png](docs/qa/blue/shots/r10-help-header.png)、[r10-ab-header.png](docs/qa/blue/shots/r10-ab-header.png)

### h1 计算样式：迁移前 → 迁移后（13 页全量）

| 页面 | 迁移前 | 迁移后 |
| --- | --- | --- |
| dashboard / keys / channels / oauth / models / usage / charts / analytics / cache / monitor（10 页） | `22px/600/30px` | `22px/600/30px`（未动） |
| **/rtk** | **`24px/700/30px`** | **`22px/600/30px`** |
| **/help** | **`24px/700/30px`** | **`22px/600/30px`** |
| **/ab** | **`26px/700/32.5px`** | **`22px/600/30px`** |

实测去重结果：`H1_UNIQUE = ["22px/600/30px"]`，且 `ALL_IN_PAGE_HEAD = true`（13/13 的 h1 都在 `.page-head` 内，即全部来自共享组件）。

### h2（section 级角色）对齐 `15px/600/22px`
| 页面 | 迁移前 | 迁移后 |
| --- | --- | --- |
| /rtk（h2 由 `RtkBoard.vue` 渲染，该文件不在本轮写范围） | `15px/700/normal` | `15px/600/22px`（用 `RtkPage.vue` 的 `:deep(.board-head h2)` 收口，页面作用域内生效） |
| /help | `16px/700/normal` | `15px/600/22px` |
| /ab | `16px/700/normal`（panel）/`15px`（task-card）/`17px`（vote） | 三处统一 `15px/600/22px` |

## ② `/usage` 表格「行高 normal」的根因与修法

**根因（不是「用了不同的表格组件」）**：`/usage` 与其他页面用的是**同一个 `TxDataTable`**；区别在**当时有没有数据**。

- Tuffex 的规则（`node_modules/@talex-touch/tuffex/dist/es/data-table/style.css:2`）：
  - `.tx-data-table__th, .tx-data-table__cell { font-size:13px; line-height:1.5 }` → **13px/19.5px**；
  - `.tx-data-table__empty { padding:24px 12px; text-align:center; color:… }` → **没有字体规则**，于是继承上层（`.tx-data-table` 14px ← `.tx-card` 14px）→ **14px/normal**。
- 实测：本实例 `/usage` 的 Key 统计表**没有任何数据行**（`days=7` 与 `days=90` 都是 `rows:1 / dataCells:0 / emptyCells:1`），所以扫描量到的是**空单元格**；而 models/analytics/cache 有数据行，量到的是 `.tx-data-table__cell` = 13px/19.5px。
- 也就是说：**有数据时 13px/19.5px、没数据时 14px/normal** —— 同一张表两种状态的排版角色不一致，这才是真问题。

**修法**：在 `UsagePage.vue` 的 scoped 样式里把空单元格拉回数据单元格同角色：
```css
:deep(.tx-data-table__empty) { font-size: 13px; line-height: 1.5; }
```
| 状态 | 迁移前 | 迁移后 |
| --- | --- | --- |
| `/usage` 空表单元格 | **`14px/normal`** | **`13px/19.5px`** |
| `/usage`（有数据时）数据单元格 | `13px/19.5px` | `13px/19.5px`（同组件默认，未动） |
| models / analytics / cache / keys / ab 数据单元格 | `13px/19.5px` | `13px/19.5px`（未动） |

截图：[r10-usage-table.png](docs/qa/blue/shots/r10-usage-table.png)

> **通用做法需要你授权**：真正的全局修法是往 `src/styles/layout.css` 加一条 `.tx-data-table__empty { font-size:13px; line-height:1.5 }`（一处修好全站空表）。`layout.css` 不在本轮写范围，所以我只在 `/usage` 做了页面级收口；其它页面将来出现空表时仍会退回 14px/normal。**要么授权我改 layout.css，要么你决定保持页面级。**

## ③ 其它排版角色漂移（**只报告，未改**）

浏览器实测（每页取第一个匹配元素的计算样式；空值 = 该页没有这个角色）：

| 角色 | 各页实测 | 是否一致 |
| --- | --- | --- |
| `.muted` | dashboard `13.02px/normal` · keys `14px/22px` · ab `14px/22px` · channels/oauth/models/charts `14px/normal` · rtk `12px/normal` · usage/analytics/cache/monitor/help 无 | ❌ **4 种取值**（13.02 / 14 / 12 + 行高 22 与 normal 混用） |
| `.stat-sub` | models / usage / analytics / cache 均 `11.5px/normal` | ✅ 一致 |
| 卡片标题 `.card-head strong` | usage / charts / analytics / cache 均 `14px/normal` | ✅ 一致 |
| 行内 `code` | channels `12.09px/18.14` · rtk `13.02px/normal` · help `12px/normal` · ab `12px/22px` | ❌ **4 种取值** |
| 代码块 `pre` / `.pre` | 仅 help 命中 `12px/18px`（`layout.css` 里 `.pre` 是 12.5px/20px，help 自己的 `pre` 覆盖了） | ⚠️ 单一采样，但 help 本地覆盖与全局 `.pre` 角色不一致 |
| 侧栏导航项 | 仅 help 命中 `12.5px/normal`（我的选择器只匹配到该页结构） | ⚠️ 采样不足，未定论 |
| 表格数据单元格 | 全部 `13px/19.5px` | ✅ 一致（本轮已含空单元格） |
| 页头 `h1` / `h2` | 全部 `22px/600/30px` / `15px/600/22px` | ✅ 一致（本轮修完） |

建议（供你决定，未实施）：把 `.muted` 与行内 `code` 各定一个主角色（大小 + 行高）写进 `layout.css`，再逐页删掉本地覆盖——这两处是目前剩下的主要漂移源。

## ④ 命令与退出码

```
$ npx tsc -b        → tsc_exit=0
$ npm run lint      → lint_exit=0（仅 2 条既存 server/nativeResponses.ts no-control-regex warning）
$ npm run build     → build_exit=0 · ✓ built in 579ms
$ npm test          → test_exit=0 · ℹ tests 599 · pass 598 · fail 0 · cancelled 0 · skipped 1
```
（`--test-timeout=30000` 未回退。）

本轮我改动的文件（`git diff --stat` 里另有 `scripts/qa-*.mjs` 两项**是工作区里别人的未提交改动，我没有触碰、也没有纳入提交**）：

```console
$ git diff --stat src/pages/RtkPage.vue src/pages/HelpPage.vue src/pages/AbLabPage.vue src/pages/UsagePage.vue
 src/pages/AbLabPage.vue  | 37 +++++-----
 src/pages/HelpPage.vue   | 43 +++++-----
 src/pages/RtkPage.vue    | 39 +++++-----
 src/pages/UsagePage.vue  | 12 +++++
```

## ⑤ 边界与未验证

- 未改：`src/router.ts`、`src/components/ConsoleNav.vue`、`src/api.ts`、`src/types.ts`、`src/ab/**`、`server/**`、`package.json`、`MANIFEST.sha256`、`RELEASE.json`、`scripts/**`（含工作区里那两项未提交改动）
- 未验证：① 移动端/窄屏下三页新页头的换行表现只做了桌面 1557×958 截图（`PageHeader` 自身已有既有响应式规则，但**本轮未逐页跑窄屏**）；② `/usage` 的**有数据**状态在本实例无法出现（该表当前无数据），所以「数据单元格 13px/19.5px」是取自其它页面同组件单元格 + Tuffex 规则，而非本页实测；③ 侧栏导航角色采样不足，未下结论。
