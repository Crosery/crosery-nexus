# 键盘可达性：焦点指示器 / skip link / 对话框与错误 aria（task-72）

日期：2026-10-01 · 结论：**红队两条都成立，已修**；红队没测成的三项（对话框 trap/Esc/归还、错误提示读屏可感知、Tab 顺序）本轮补齐并**做成回归**（`scripts/qa-a11y.mjs`，25 条，退出码非 0）。
唯一改动前端：`src/styles/theme.css`、`src/index.css`、`src/components/ConsoleShell.vue`、`src/pages/LoginPage.vue`；**未改 `server/**`，未重启/停服务**（前端改动 + `npm run build` 后刷新即可）。

---

## 1. R26-C 焦点指示器：根因是**特异性输给组件库**，不是"没写规则"

我原来的 `:focus-visible` 规则其实**存在**（`src/styles/theme.css:193`），红队量到的现象也复现了，但原因不是没声明：

| 事实 | 证据 |
| --- | --- |
| 键盘聚焦后 `:focus-visible` **命中** | 浏览器实测 `focusVisible: true` |
| 但计算样式仍是 `outline-style: none`（宽度 3px、颜色 `rgb(21,27,69)`）——**与红队的三态完全相同** | 同一次实测 `outline: none 3px rgb(21, 27, 69)` |
| 谁赢的 | 组件库 scoped 规则 `.tx-input__inner[data-v-19b075d3]{…outline:none…}` = 特异性 **(0,2,0)**；我的 `:focus-visible` = (0,1,0)、`input:focus-visible` = (0,1,1) → **都输**，所以根本不绘制 |
| 另一条弱环 | `src/index.css:32` 用 `color-mix(… 55%, transparent)` 画半透明环，对白底只有 ~2:1 |

**修法**（`src/styles/theme.css`）：用 `html :is(a, button, input, select, textarea, summary, [tabindex]):focus-visible`
把特异性提到 **(0,2,1)**，并对三个 outline 属性加 `!important` 兜底（焦点可见性是硬性要求，组件库的 `outline:none` 不该赢）；
颜色改为实色 token `--console-focus-ring: #1b2a6b`（不再用半透明 mix）。`src/index.css` 的弱环同样换成该 token。

**修复前后证据**（同一探针，浏览器实测）：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 键盘 Tab 到输入框 | `outline-style: none`（**无环**） | `solid 2px rgb(27,42,107)` + 对比度 **13.21:1** |
| 键盘 Tab 到提交按钮 | `outline-style: none` | `solid 2px` + **13.21:1**（按钮底色 `#fff`） |
| 侧边栏导航项（真实 button） | 无环 | `solid 2px` + **13.21:1** |
| skip link | 不存在 | `solid 2px` + **12.22:1**（相邻背景 `rgb(244,246,252)`） |
| **鼠标**点击按钮 | — | `:focus-visible: false`、`outline-style: none`（**无环**，符合 `:focus-visible` 语义） |

> 对比度取"环所在的**相邻背景**"（环画在元素外侧、`outline-offset: 2px` 的缝隙显示父级背景）——这一点我第一版算错过：拿元素自身背景算，skip link 会得出 1.79 的**假失败**。
> 另外我原以为侧边栏是深色、配了亮色环（`#8ab4ff`），实测侧边栏/顶栏都是**浅色**，亮蓝环只有 **2.09:1**（不达标）⇒ 已删掉该变体，统一用同一个深色环。

**注意（浏览器语义）**：文本输入框在**鼠标点击**时也会命中 `:focus-visible`（Chromium 对可编辑元素的规范行为，因为接下来就是键盘输入）——"鼠标点击无环"这条只对按钮/链接成立，脚本里用注入的探针按钮验证规则语义。

## 2. R26-D skip link + landmark

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| 「跳到主内容」 | 0 个 | **1 个**，且是页面上**第一个可聚焦元素**（Tab 一次即命中） |
| `<nav>` | **0 个**（landmark 只有 main） | **2 个**：`控制台导航`（TxSidebarNav 自带，我试过再包一层 `<nav>` → 出现**两个同名导航**，已回退）+ `当前位置`（面包屑） |
| 回车后的焦点 | — | `Enter` → `document.activeElement === MAIN#main-content` ✓ **焦点真的落到主内容**（`main` 加 `id` + `tabindex="-1"`） |

**应用页结论**：skip link 对**已登录的应用页**同样需要（那里才有整条侧边栏要跳过）——红队只测了登录页，本轮在 `/dashboard`、`/keys`、`/models` 三个路由上验证：main + skip link + nav 都在，Tab 顺序前 6 项 = `跳到主内容 → Crosery API → 运行概览 → API Key → 渠道 → OAuth 登录`（首项即 skip link）。
**登录页**：无导航可跳，`<nav>` 无意义；本轮只保证它 1 个 main landmark ✓ 与错误 aria（下节）。**未加 login 的 skip link**（它的目标就是紧随其后的内容，属无效链接），如需"跳过品牌头部"可在后续轮次补。

## 3. 红队没测成的三项（改用 `keyboard.type()` + `press('Enter')`）

红队自述探针坏了（直接赋 `value` 驱动不了 Vue 的 v-model），三项没测成。本轮全部走真实键盘路径：

| 项 | 结果 | 证据 |
| --- | --- | --- |
| **键盘输入真的进 v-model** | ✅ | `keyboard.type` 后 `username=5`、`password=6` 字符；`Enter` → 进入 `/dashboard`（未登录则整轮判失败） |
| **对话框 focus trap** | ✅ | `/keys` 删除确认框，连按 6 次 Tab 的轨迹 = `删除 API Key → Close → 取消 → 删除 API Key → …`，焦点**未逃出** |
| **Esc 可关** | ✅ | Escape 后对话框**不可见**（按可见性判定） |
| **关闭后焦点归还** | ✅ | 关闭后 `activeElement` = 触发按钮「删除 …」，且带焦点环 |
| **表单错误读屏可感知** | ✅ | 错密码提交后：`[role=alert]` 文案「管理员账号或密码不正确」、`id=login-error`；两个输入框 `aria-invalid="true"`、`aria-describedby="login-error"` 且该 id **真实可解析**（`document.getElementById` 命中）。先前轮次已给 KeysPage 各字段加了 `aria-invalid` + `role=alert`，本轮补的是登录页这两条的**关联**（`aria-invalid`/`aria-describedby` + 稳定 id） |
| **Tab 顺序** | ✅ | 登录页：输入框 → 输入框 → 提交按钮（提交按钮 `disabled` 时不可聚焦，输入后才进 Tab 序列）；应用页：见上（首项 skip link） |

**我自己的两个探针 bug（如实记录，避免下一个人踩）**：
1. 用 `offsetParent !== null` 判弹窗可见性 —— **`position: fixed` 的元素 `offsetParent` 恒为 `null`**，会把"已关闭的弹窗"当成"还开着"，一度误报"Esc 关不掉"（实际 Esc 正常）。改用 `getBoundingClientRect()` 尺寸 + `visibility/display/opacity`。
2. 顺序焦点导航从**最后一次聚焦的元素**继续：想"从文档开头 Tab"必须先 `blur()`，否则 Tab 会从上一个元素的**后面**继续走。

## 4. 回归脚本：`scripts/qa-a11y.mjs`

```bash
cat scripts/qa-a11y.mjs | ego-browser nodejs                       # 退出码：任一检查失败 → 非 0
QA_A11Y_ROUTES=/dashboard,/keys,/models cat scripts/qa-a11y.mjs | ego-browser nodejs
```

形状照 `qa-contrast.mjs`：登录断言（未登录直接抛错，拒绝产出结论）、渲染等待、逐条 `{check, ok, detail}` JSON、`try/finally` 里 **只调一次** `task.finish({ keep: [] })`、**不清 cookie/存储**。
本轮实测：**25 条检查全过，退出码 0**（`/dashboard,/keys,/models`）。
覆盖：焦点环可见性 + 对比度（输入框/按钮/侧边栏项/skip link）、鼠标无环（探针）、landmark（main/nav+label/skip link）、skip link 首项 + 回车焦点落点、Tab 顺序、错误 aria 三件套、对话框 trap/Esc/归还。
**只读安全**：脚本只做只读操作 + 打开一次删除确认框后按 Esc 取消，不做任何写操作。

## 5. 验证与未验证清单

**已验证**：`tsc -b` 0 · `lint` 0（4 条既存 warning）· `build` 0 · `npm test` **0**（`680 / 679 / 0 / 1 skipped`）· `qa-a11y.mjs` **25/25，退出码 0**；修复前后计算样式与对比度数字见 §1；生产/本机**未重启服务**（纯前端 + build，刷新页面即生效）。

**未验证（如实列出）**：
1. **真实读屏软件**（VoiceOver/NVDA）未跑——只有 DOM/ARIA 层面的断言，没有"实际听感"证据。
2. **Tab 顺序只覆盖前 6 项**（未做全页枚举与"无键盘陷阱"的全量证明，仅验证了对话框这一个 trap）。
3. **高对比度模式 / 强制颜色（forced-colors）** 未测：`forced-colors: active` 下 `outline` 会被系统色覆盖，可能出现环不可见。
4. **表格行内操作、下拉（TxSelect）、侧边栏折叠态**只覆盖了部分控件（侧边栏项、删除图标按钮、提交按钮、输入框）；其余组件沿用同一条全局规则，但未逐个实测。
5. **登录页无 skip link**（见 §2 的理由），若产品要求"跳到表单"可补。
6. 红队截图 `shots-r26/focus-ring-login.png` 我未逐像素比对，只做了计算样式 + 对比度实测。
