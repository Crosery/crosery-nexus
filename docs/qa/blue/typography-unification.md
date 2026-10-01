# 第十二轮：`.muted` / 行内 `code` / 表格空单元格收口到单一真源（task-34 / blue-ui）

日期：2026-10-01 · 依据：`docs/qa/blue/typography-consistency.md`（task-32 的角色漂移表）+ Lead 授权
构建：`npm run build` ✓ 595ms；截图 `docs/qa/blue/shots/r12-{empty-table-models,usage-roles}.png`。

**一句话**：三处漂移都收进了**单一真源**（空单元格 → `layout.css`；`.muted` → `theme.css` 的 token；行内 `code` / 代码块 → `layout.css`），并删掉页面级覆盖。实测：空单元格与数据单元格全站同为 `13px/19.5px`、行内 `code` 全站同为 `12px/18px`、代码块全站同为 `12.5px/20px`、`.muted` 的 `.mono` 组合全站同为 `13px/19.5px`。**剩两处越界项**（都在 `src/components/RtkBoard.vue`，不在本轮写范围，也是 blue-rtk 正在动的文件）已在 §5 列出并给出改动方案。

---

## 1. `/usage` 空单元格 → 全局 `layout.css`

**做法**：把 task-32 加在 `UsagePage.vue` 的页面级 `:deep(.tx-data-table__empty)` **删除**，改在 `src/styles/layout.css` 定义一次：

```css
.tx-data-table__empty {
  font-size: 13px;
  line-height: 1.5;
}
```

**实测（浏览器计算样式）**：

| 页面 / 状态 | 单元格 class | 迁移前 | 迁移后 |
| --- | --- | --- | --- |
| `/usage` 空表（唯一单元格） | `tx-data-table__empty` | `14px/normal` | **`13px/19.5px`** |
| `/models?q=zzz-no-such-model` 空表（**另一个页面**，临时筛选制造，未改码） | `tx-data-table__empty` | `14px/normal` | **`13px/19.5px`** |
| keys / channels / models / analytics / cache / ab 数据单元格 | `tx-data-table__cell` | `13px/19.5px` | `13px/19.5px`（未动） |

去重结论：`EMPTY_CELL_UNIQUE = DATA_CELL_UNIQUE = ["13px/19.5px"]` → **空表与有数据全站同角色**（第二个页面证明了是全局规则而不是页面级）。截图 `r12-empty-table-models.png`。

## 2. `.muted` → `theme.css` 单一真源（含 token 化）

**为什么取 13px/19.5px**：① `.muted` 绝大多数场合紧邻表格单元格/卡片说明，而数据角色就是 13px/19.5px；② 历史 4 种取值（12 / 13.02 / 14 / 14）的中位数是 13，改动面最小；③ 更密的 12px 已有现成工具类可用，默认值不该等于最小值。

```css
:root {
  --role-muted-size: 13px;
  --role-muted-line-height: 19.5px;
}
:where(.muted) {
  color: var(--tx-text-color-secondary);
  font-size: var(--role-muted-size);
  line-height: var(--role-muted-line-height);
}
.mono.muted, .muted.mono {           /* 组合场景也消费同一组 token */
  font-size: var(--role-muted-size);
  line-height: var(--role-muted-line-height);
}
```

两个关键取舍（都写进了 CSS 注释）：
1. **`:where()` 保持零特异度**：`theme.css` 在 `main.ts` 里排在 `uno.css` 之后，若用普通类选择器会凭源码顺序**静默吃掉**逐处工具类。（顺带实测确认：`text-12`/`text-11`/`text-xs` 这几个类名在本项目**根本没被生成**——`dist/assets/*.css` 里不存在，是历史死类名，对排版没有任何影响。这条也解释了我上轮把「20 处 `muted text-12`」当成显式尺寸覆盖的误判。）
2. **`.mono.muted` 组合规则**：`theme.css` 的 `.mono { font-size: .93em }` 会把字号再乘一次（13px→12.09px、14px→13.02px），实测 4 处（键值掩码、渠道别名）。组合规则让 `.muted` 角色说了算，且**消费同一组 token**，不产生第二份取值。

**实测**：

| 群体 | 迁移前 | 迁移后 |
| --- | --- | --- |
| `.muted` + `.mono`（掩码/别名等 4 处） | `12.09px/19.5px`、`13.02px/19.5px` | **`13px/19.5px`（唯一）** |
| 裸 `.muted`（表格、卡片、工具条） | `12px` / `13.02px` / `14px` / `14px/22px` | **`13px/19.5px`（唯一）** |
| `.muted` 出现在 `.page-head` 说明段落里 | `14px/22px` | `14px/22px`（**由页头散文角色 `.page-head p` 接管**，选择器更具体；全站只有这一种组合值，已作为「组合语义」写进注释，不算漂移） |

去重结论：`MUTED_COMBO_UNIQUE = ["13px/19.5px"]`；裸 `.muted` 只剩 `13px/19.5px`（默认）与 `14px/22px`（页头散文内）两种**确定性**取值。

## 3. 行内 `code` 与代码块 → `layout.css` 单一真源

```css
code, code.mono {
  padding: 1px 5px; border-radius: 4px;
  background: var(--tx-fill-color-lighter);
  font-family: var(--console-mono);
  font-size: 12px; line-height: 18px;
}
.pre, pre, .code-block { /* 12.5px / 20px / mono / 浅底 / overflow:auto */ }
pre code, .pre code, .code-block code { padding: 0; background: transparent; font-size: inherit; line-height: inherit; }
```

- `code.mono` 是必须的：`<code class="mono text-12">`、`<code class="fact-val mono">` 这类组合会被 `.mono` 的 `.93em` 再乘一次；加 `code.mono`（0,1,1）稳定压过 `.mono`（0,1,0）。
- 代码块把 `.pre`、裸 `pre`、帮助页的 `.code-block` 收进**同一条规则**；`.code-block` 用类选择器是为了稳定压过 `.mono`（帮助页的 `<pre class="code-block mono">` 同时带两个类，而 `layout.css` 在 `theme.css` 之后）。
- 顺手删掉的本地覆盖：`AbLabPage.vue` 的 `.ab-lab code{…font-size:12px}`（全局同值）、`UsagePage.vue` 的页面级 `:deep`；`HelpPage.vue` 的 `.code-block` 只保留盒模型与 `overflow-x:auto`——**`7b27f13` 的响应式修复保留**（`overflow-x:auto` + `max-width:100%`，浅底来自 `.code-wrapper`），只把它冲突的 `font-size:12px; line-height:1.5` 交给全局角色。

**实测**：

| 群体 | 迁移前 | 迁移后 |
| --- | --- | --- |
| `/channels`、`/rtk`、`/help`、`/ab` 行内 `code` | `12.09/18.14`、`13.02/normal`、`12/normal`、`12/22` | **`12px/18px`（唯一）** |
| `/help` 代码块（`pre.code-block`） | `12px/18px`（与全局 `.pre` 的 12.5/20 冲突） | **`12.5px/20px`**（与全局同角色） |

`CODE_UNIQUE = ["12px/18px"]`（唯一例外见 §5）；`PRE_UNIQUE = ["12.5px/20px"]`。

## 4. 侧栏导航项（task-32 未结论项）

正确取到 Tuffex 的类名后实测（`TxSidebarNav` 渲染）：

| 角色 | 选择器 | 计算样式 |
| --- | --- | --- |
| 导航项 | `.tx-bui-sidebar-nav__item` | `13px/normal` |
| 分组标题 | `.tx-bui-sidebar-nav__group-label` | 由 Tuffex 固定 `10.5px`（样式表内联值，只读） |

结论：导航项字号来自 Tuffex 组件自身（单一值 `13px`，各页一致，因为它只在 `ConsoleNav` 渲染一次）；**分组标题 `10.5px` 是库内固定值**，不属于我们的角色体系，本轮不动（`ConsoleNav.vue` 也不在写范围）。

## 5. 剩下的两处越界项（**都在 `src/components/RtkBoard.vue`，未改**）

| 位置 | 现状 | 影响 | 建议改法 |
| --- | --- | --- | --- |
| `src/components/RtkBoard.vue:361-364` `.busy, .muted { font-size: 12px; … }` | `/rtk` 的 `.muted` = `12px/19.5px`（全站其它页 13px） | 唯一剩下的 `.muted` 漂移 | 拆开：`.busy { font-size: 12px }` 保留（不同角色），`.muted` 那半删掉即可 |
| `src/components/RtkBoard.vue:351-354` `.agent-id { font-size: 11.5px }` | `/rtk` 有 `<code class="mono agent-id">` = `11.5px/18px` | 行内 `code` 的唯一例外 | 删掉 `.agent-id` 的 `font-size`（保留颜色），或改成 `12px` |

**为什么没动**：`src/components/**` 不在本轮写范围，且 `RtkBoard.vue` 正是 blue-rtk 正在活动的文件（它在做锁的 R9 系列）。**请授权/或指派 blue-rtk 改这两处**（各一行），改完全站 `.muted` 与行内 `code` 即为**绝对唯一**。

## 6. 命令与退出码

```
$ npx tsc -b        → tsc_exit=0
$ npm run lint      → lint_exit=0（仅 2 条既存 server/nativeResponses.ts no-control-regex warning）
$ npm run build     → build_exit=0 · ✓ built in 595ms
$ npm test          → test_exit=0 · ℹ tests 606 · pass 605 · fail 0 · cancelled 0 · skipped 1
```
（构建/测试全程等 `/tmp/cac-build.lock`，没有抢 blue-rtk 的锁；`--test-timeout=30000` 未回退。）

本轮改动：`src/styles/layout.css`、`src/styles/theme.css`、`src/pages/UsagePage.vue`、`src/pages/HelpPage.vue`、`src/pages/AbLabPage.vue` + `docs/qa/blue/**`；未碰 `src/router.ts`、`src/components/**`、`src/api.ts`、`src/types.ts`、`src/ab/**`、`server/**`、`scripts/**`、`package.json`、`MANIFEST.sha256`、`RELEASE.json`。

## 7. 未验证 / 剩余风险

1. 上述两处 `RtkBoard.vue` 例外仍在（待授权）。
2. `.mono` 的 `0.93em` 仍会影响**非 `.muted`** 的等宽文本（例如表格里的数字 `12.09px`）——本轮只把 `.muted`/`code` 两个角色从它的乘数效应里摘出来；`.mono` 自身是否该去掉字号增量属于另一个角色决策，**未动**（改它会影响全站 80 余处，需要单独一轮评估）。
3. 结论基于桌面视口 1557×958 的 13 页实测；窄屏下这些是纯字号/行高角色，未逐页复测（task-32 的页头窄屏项也仍是未验证项）。

---

# 附：RtkBoard 两处例外归入主角色（task-35，2026-10-01）

来源：本文 §5 登记的两处越界例外，Lead 授权后修复。写范围**仅** `src/components/RtkBoard.vue` 的两处 + 本文件。

## 改动（`git diff -- src/components/RtkBoard.vue`，只有这两处）

```diff
 .agent-id {
-  font-size: 11.5px;
+  /* 字号交给全局行内 code 主角色（task-34：12px/18px），这里只保留颜色。 */
   color: var(--tx-text-color-secondary, #535b85);
 }
-.busy,
-.muted {
+.busy {                                  /* 运行中指示是独立角色，保留紧凑的 12px */
   font-size: 12px;
   color: var(--tx-text-color-secondary, #535b85);
 }
+.muted {                                 /* 不再覆盖字号：交给全局 .muted 主角色 13px/19.5px */
+  color: var(--tx-text-color-secondary, #535b85);
+}
```

## 唯一性实测（`/rtk`，浏览器计算样式）

| 角色 | 改前 | 改后 | 全站主角色 |
| --- | --- | --- | --- |
| `.muted`（页内 7 处） | `12px/19.5px`（**全站唯一例外**） | **`13px/19.5px`（唯一值）** | `13px/19.5px` ✅ |
| 行内 `code`（含 `<code class="mono agent-id">`） | `12px/18px` + `11.5px/18px`（**例外**） | **`12px/18px`（唯一值）** | `12px/18px` ✅ |
| `.busy`（运行中指示） | `12px` | `12px`（未变） | 独立角色 |
| `.agent-name` | `13px/normal` | `13px/normal`（未变） | — |

编译产物交叉验证（作用域样式编译结果，证明只删了 `.muted` 那一半）：

```console
$ grep -o '\.busy\[data-v-[a-z0-9]*\]{[^}]*}' dist/assets/*.css
.busy[data-v-01b873ff]{color:var(--tx-text-color-secondary,#535b85);font-size:12px}
$ grep -o '\.muted\[data-v-01b873ff\]{[^}]*}' dist/assets/*.css
.muted[data-v-01b873ff]{color:var(--tx-text-color-secondary,#535b85)}      ← 已无 font-size
```

至此 **`.muted`、行内 `code`、表格单元格（含空表）、代码块、h1/h2** 五组角色在全站都是唯一取值。

### ⚠️ 唯一性检查必须按「角色 + 语境」分层（红队第十轮复审结论，**不要当漂移修回去**）

前几轮我（和扫描器）都按「一个角色一个计算样式」下结论，红队第十轮指出这**过严**，并确认下面两类组合是**有意的、应保留**：

| 组合 | 计算样式 | 为什么合理 |
| --- | --- | --- |
| `.muted` × `.page-head p` | `14px/22px`（不是 `13px/19.5px`） | `.muted` 管**颜色/弱化**，`.page-head p` 管**页头散文尺度**；散文 14px/22px 与 h1 的 22px/30px 成比例。强行压到 13px 会让「页面说明」比正文小，破坏层次。 |
| 行内 `code` 的颜色 | 3 个 color 变体（随上下文继承/继承自 `.fact-val`/表格色） | **尺寸、行高、字体统一**（`12px/18px` + mono），**颜色按语境**（页头散文、表格、卡片各有一套前景色）。颜色属于语境，不属于 code 角色。 |

所以本文件与后续检查的口径是：

1. **尺寸层（必须唯一）**：`font-size` / `line-height` / `font-family` 每组角色一个签名；
2. **颜色层（按语境允许变体）**：颜色由所在语境决定，**不得**因为「颜色不一致」去改 code/`.muted` 的尺寸；
3. **组合层（确定性即可）**：如 `.mono.muted`、`.muted × .page-head p`，只要求「同一种组合在全站只有一种结果」，不要求与裸角色相同。

> 换句话说：看到 `.muted` 在页头是 14px 就把它「修」成 13px，是**回归**，不是修复。

## 无视觉回归确认（`/rtk` 实拍）

- agent 行：`Codex CLI` / `Claude Code` / `Cursor` 行高实测 **21 / 21 / 20px**（与改前同量级），`agent-name` 13px、`agent-id` 12px/18px，两行文本**未重叠、未截断**，可读性正常；
- `busy` 态：规则未动（编译结果 `font-size:12px`），且与 `.muted` 拆开后不再互相牵连；
- 页面无横向溢出：`scrollWidth == clientWidth`（1557×958）；
- 截图：改前 `docs/qa/blue/shots/r13-rtk-before.png`、改后 `docs/qa/blue/shots/r13-rtk-after.png`。

> 探针说明：我试过临时插入一个 `.busy` 节点量计算样式，但 RtkBoard 是 **scoped 样式**（`[data-v-01b873ff]`），无作用域属性的注入节点匹配不到规则（量到的是继承值 14px），所以 `.busy` 的证据改用「源码 diff + 编译产物规则」给出；注入节点已即时移除（`document.querySelectorAll('.busy').length === 0`）。

## 命令与退出码

```
$ npx tsc -b        → tsc_exit=0
$ npm run lint      → lint_exit=0（仅 2 条既存 no-control-regex warning）
$ npm run build     → build_exit=0 · ✓ built in 632ms
$ npm test          → test_exit=0 · ℹ tests 606 · pass 605 · fail 0 · cancelled 0 · skipped 1
```
