# 蓝队 B（blue-ui / task-4）UI 交互重构交付说明

日期：2026-10-01 · 仓库：`/Users/crosery/work_file/crosery-api-console` · 参考实现（只读）：`/Users/crosery/work_file/geek_main/app/console/src`
对应红队报告：`docs/qa/red-team/ui-interaction-audit.md`（32 条缺陷 + Top 10）

## 0. 一句话结论

按 TUF 的交互原语重做了 `src/` 的执行层：新增 `src/lib/{resource,confirm,errors,format,listState,viewport,breadcrumbs,focus}.ts` + `src/components/{PageHeader,ConfirmHost,ErrorPanel,LoadingBlock,EmptyState}.vue`，并把 8 个页面迁到「URL 即状态 + useResource 三态 + 全局 confirm()」。红队 P0 五条（D1/D2/D3/D4/D5+D6）全部有改后实测证据；**仍未修**与**未验证**见第 5、6 节，不夸大。

---

## 1. 共享原语（第一阶段）

| 新文件 | 作用 | TUF 参考 |
| --- | --- | --- |
| `src/lib/resource.ts` | `useResource`（deps 重取 / 序号丢弃竞态 / **成功前不碰旧数据**）、`useAction` | `lib/resource.ts:1-58` |
| `src/lib/confirm.ts` | 全站唯一确认框的单例状态；新确认到达把上一个按「取消」结束 | `lib/confirm.ts:1-27`（含 `:14`） |
| `src/components/ConfirmHost.vue` | 唯一确认框宿主，挂在 `App.vue`；初始焦点在「取消」、danger 变色、Esc/遮罩/关闭键一律按取消 | `components/ConfirmHost.vue:1-38` |
| `src/components/PageHeader.vue` | 面包屑（站内路由）+ 标题 + 说明 + `#actions`/`#meta` 槽 | `components/PageHeader.vue:1-37` |
| `src/components/ErrorPanel.vue` | 失败态：可读原因 + 「重试」；技术行（HTTP 码 + 原文）等宽显示 | `components/ErrorPanel.vue:1-66`，文案字典 `lib/errors.ts:24-71` |
| `src/components/LoadingBlock.vue` | 受控骨架（只在「首次加载且无数据」时渲染，有数据绝不显示） | `components/LoadingBlock.vue:1-20` |
| `src/components/EmptyState.vue` | 空态给下一步动作（传 `to` 走站内路由，否则 `@action`） | TUF 各列表页空态 + 主按钮约定 |
| `src/lib/format.ts` | 时间/金额/百分比/大数/延迟/字节单点收口，**固定 Asia/Shanghai 24 小时制** | `lib/format.ts:1-36` |
| `src/lib/listState.ts` | `useQueryState`（筛选/搜索/分页 ↔ URL 双向同步，默认值不写进 URL，`router.replace` 不污染历史）、`paginate`、`debounce` | TUF `pages/Applications.vue:31-33,44-48`、`lib/nav.ts` 纯函数风格 |
| `src/lib/breadcrumbs.ts` | 路由 → 面包屑纯函数（外壳与页面共用一份标题表） | `lib/nav.ts:64-71` |
| `src/lib/focus.ts` | 弹窗打开后的焦点落点：等两轮 `nextTick` 越过 TxModal 遮罩的自动 focus 再补确认 | 由 `components/ConfirmHost.vue:17` 的 `autofocus` 语义推导（TxModal 源码 `modal/src/TxModal2.vue.js:39-58` 把焦点放在遮罩上） |
| `src/lib/viewport.ts` | `useMediaQuery`：需要「真的少渲染一份」时用 | TUF `ConsoleShell.vue:15-22` 的桌面/移动外壳切换 |

`src/App.vue` 挂载 `<ConfirmHost />`（对照 TUF `App.vue:9`）。

## 2. 逐页迁移（第二阶段）

| 页面 | 迁移内容 | TUF 对照 |
| --- | --- | --- |
| `DashboardPage.vue` | 改用 `useResource`（概览 + 密钥两路）；`days/keyId` 进 URL；加载/错误三态；空态给「去创建 API Key」；`compact/fmt*` 收口；网关状态由读取结果推导（不再写死「在线」） | `pages/Applications.vue:37-42,89-92` |
| `AnalyticsPage.vue` | **D1 修：改调 `/api/analytics`**；`days/keyId/q/page` 进 URL；搜索防抖 + 清除筛选；表格分页（20/页）；`#empty` 区分「无数据 / 筛掉了」 | 同上 |
| `UsagePage.vue` | `days/keyId/page` 进 URL；两张聚合表分页；`tokens/cost/percent` 全部改为 `lib/format` 实现 | `pages/Applications.vue:26,31-33` |
| `KeysPage.vue` | URL 搜索/状态/页码；`useResource` 三态；删除与三种额度重置走 `await confirm()`；删除入口从编辑弹窗移到行内（不再 Modal 套 Modal）；行内主标识改真按钮（可聚焦）；图标按钮补 `aria-label`；时区来自接口；一次性密钥弹窗两个出口 | `lib/confirm.ts:12-20`、`components/ConfirmHost.vue:13-23`、`pages/Applications.vue:31-48,92-103` |
| `ChannelsPage.vue` | 同上；删除渠道 + **批量剪枝** + 停用渠道走 `confirm()`；搜索/筛选/页码进 URL；模型列表入口改真按钮；OAuth 按钮从死 `emit` 改为 `router.push('/oauth')` | 同上 + `pages/Overview.vue:95-96` 的可键盘激活写法 |
| `ChartsPage.vue` | **D3 修：从 18 行占位改为真实页面**（`/api/charts`：趋势折线 + 模型/分组 Top8 + 最慢上游 + 状态码），受控加载态、空态可切周期 | `components/LoadingBlock.vue:10-13` |
| `MonitorPage.vue` | `useResource` 三态（原来 `catch {}` 把失败吞成「没有账号」）；重置额度走 `confirm()`（删掉手写弹窗）；倒计时/时钟走 `format.ts`；空态补「去 OAuth 登录池」 | `lib/resource.ts:14-39`、`lib/confirm.ts:12`、`lib/errors.ts:24-71` |
| `CachePage.vue` | 筛选（模型/客户端/渠道/时间）进 URL；`useResource` 三态；SSE 断线改为可感知 + 5s 自动重连；`tokens/money/percent/clock` 收口 | 同上 |
| `ConsoleShell.vue` | **只挂载一个 VersionWidget**（桌面头部 / 移动顶栏按断点条件渲染，不再是 `display:none` 双份）；`<!-- reserved for breadcrumb -->` 换成真面包屑；`.shell__desktop-header` 加 `width:100%` 修居中错位；菜单按钮 `aria-label` 含可见文本 | TUF `ConsoleShell.vue:15-22,82-97` |
| `VersionWidget.vue` | **诚实化**：RTK 不再是「本机装了 = 已接通」，改以 `/api/rtk/status` 的 `planes[]` 为真源逐平面显示；读取失败显示「状态未知 + 重试」；加 `/rtk` 入口；Esc 关闭后焦点回触发按钮 | 用户/Lead/blue-rtk 的 T12 结论 + `components/ConsoleShell.vue` 的诚实上下文行 |

## 3. P0 逐条改前/改后证据

> 改前证据取自红队 `docs/qa/red-team/shots/`；改后证据为本次实测（构建时间戳见第 6 节）。
> 实测口径：`page.evaluate` 读 DOM 数值 + `page.fetch` 拉同一接口做对照；破坏性操作**只打开确认框、不点确认**，生产数据未被改动。

### D1（阻断）Analytics 调错接口，把 41.6% 错误率渲染成「0.0% 健康稳定」
- 改前：`src/pages/AnalyticsPage.vue:45` `api.usageBreakdown<AnalyticsData>(...)`；红队证据 `docs/qa/red-team/shots/analytics-零数据但真实错误率41.6%-桌面.png`。
- 改后：`api.analytics<AnalyticsData>(days, keyId)`（`src/pages/AnalyticsPage.vue` 的 `useResource` 调用），类型与请求同源；`catch {}` 静默吞错改为持久 `error` → `ErrorPanel`。
- 实测（`/analytics?days=30`）：UI `请求量=214 / Token=7.7万 / 错误率=41.6% / 平均 4.8s`，`/api/analytics?days=30` 返回 `requests=214, errorRate=0.4159, avgLatency=4842.57, tokens=76762` —— 完全一致。
- 截图：`docs/qa/blue/shots/after-analytics-deeplink-30d.png`

### D2（阻断）接口失败退化成 7 秒消失的 toast，之后与「本来就没数据」无法区分
- 改前：`KeysPage.vue:142-146` / `ChannelsPage.vue:98-102` / `DashboardPage.vue:102-115` 只 `toast(...)`；红队 `shots/keys-接口失败-toast消失后-桌面.png`。
- 改后：8 个页面统一 `useResource` + `<ErrorPanel :error :retry>` + `<LoadingBlock>`；失败时**不渲染数据区**（不会出现「暂无一 Key」的假空态）。
- 实测：`Network.setBlockedURLs(["*/api/bootstrap*"])` → `/keys` 显示「连不上服务器」+「重试」按钮，表格不渲染；解除屏蔽点「重试」→ 14 行数据恢复。
- 截图：`docs/qa/blue/shots/after-keys-error-retry.png`

### D3（阻断）图表分析页永久「加载图表数据中...」，从不发请求
- 改前：`src/pages/ChartsPage.vue` 全 18 行占位；红队 `shots/charts-永久加载中-桌面.png`。
- 改后：真实页面 + `/api/charts`；加载态是受控骨架（有数据就不显示）。
- 实测：`/charts?days=7` → `请求总量=60 / 错误数=23 / 错误率=38.3% / 时间桶=4`，13 条 bar 行；`/api/charts?days=7` 返回 `trend=4, groups=1, models=8, statusCodes=4`；页面文本不再含「加载图表数据中」。
- 截图：`docs/qa/blue/shots/after-charts-desktop.png`

### D4（阻断）390px 下列宽塌陷为 0 / 31px，文字重叠
- 改前：Keys 三列 `width=0`、Channels 三列 31px（红队实测）；根因是 `table-layout="fixed"` + 「多列 minWidth 与固定 width 混用」。红队 `shots/keys-列表-移动端.png`。
- 改后：去掉 `table-layout: fixed`，列只给 `width`，整表用单个 `--table-min`（Keys 1120px / Channels 1080px）撑宽，`scroll-x` 在组件内部滚动。
- 实测（`Emulation.setDeviceMetricsOverride` 390×844）：
  - `/keys`：`document.scrollWidth = 390`（页面无横向溢出），列宽 `207/140/90/155/103/77/348`，组件内滚动 `client 354 / scroll 1120`；
  - `/channels`：`scrollWidth = 390`，列宽 `174/318/312/125/150`；
  - 另测 `/analytics`(81/129/71/79/61/69/160)、`/usage`(72/76/63/50/50/63)、`/cache`(81/124/47/70/50/50/63/63/75/50/60)：均 `scrollWidth = 390`，**无 0 宽列**（部分列偏窄但可读，靠组件内横向滚动）。
- 截图：`after-keys-mobile-390.png`、`after-channels-mobile-390.png`、`after-analytics-mobile-390.png`

### D5 + D6（阻断）「重置额度」三键单击即执行；「清理失效残留」批量删渠道无确认
- 改前：`KeysPage.vue:642-649/669-676/696-703`、`ChannelsPage.vue:274`；红队 `shots/keys-额度弹窗-重置无确认-桌面.png`。
- 改后：全部改走 `await confirm({danger: true})`（全局唯一确认框）：
  - 删除密钥、重置今日/本周/**总计**用量（文案写明「这是密钥因超额停用后唯一的恢复手段，且不可撤销」）；
  - 删除渠道、批量剪枝（列出将删除的失效渠道名）、停用渠道（影响线上流量）。
- 实测（点开但不确认）：确认框标题「删除密钥」、正文「…将被彻底删除，使用它的客户端会立即收到 401 认证失败，且无法恢复。」；`Esc` 关闭后行数仍为 14（未删除）；焦点回到触发按钮 `删除 龚翰林`。**注**：该轮「Escape 稳定性」后被 Lead 复验为 flaky（修复前 3 轮 1 轮可关），最终修复与 4/4 判据见 §5.1.1 / §5.1.2。
- 截图：`docs/qa/blue/shots/after-keys-delete-confirm-focus.png`

### D19 / D20（高，随 P0 一并收口）
- 改前：`ConsoleShell.vue:51+72` 两个 VersionWidget（`display:none` 藏着也照样挂载并各发一次 `/api/version`）；桌面头部实测 `width=257` 居中悬浮。
- 改后：按断点条件渲染，只挂载一个；`.shell__desktop-header` 加 `width:100%`。
- 实测：桌面 `versionWidgets = 1`；头部内容盒 `left=280, right=1525` 与 `.page-head`/卡片 `left=280, right=1525` 完全对齐。

## 4. VersionWidget 诚实化（Lead/blue-rtk T12）

- 改前：`VersionWidget.vue:177-186` 用 `cpa.rtk.connected` 渲染「RTK 适配：已接通 (v0.50.0)」；而该值在服务端由「本机是否有 rtk 二进制」推导 → 把「本机装了」说成「已接通」，中转站侧其实没有 RTK 路由（红队 T12：`/api/library/rtk` 404）。
- 改后：以 `api.getRTKStatus()`（`/api/rtk/status`）的 `planes[]` 为真源，逐平面显示；失败显示「状态未知（原因） · 重试」；「可用」只在对应平面 `state=available` 时出现并注明平面；Token 节省行改名为「**本机** RTK Token 节省」；新增 `/rtk` 入口。
- 实测：浮层显示 `内核：未接通 / 中转站：未接通 / 本机：可用`；`/api/rtk/status` 返回 `plane=local, planes=[kernel:not_supported, relay:not_supported, local:available]` —— 一致。
- 截图：`docs/qa/blue/shots/after-versionwidget-rtk-planes.png`

## 5. 仍未修（如实列出，红队第二轮按此复核）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| D7 部分 | **部分** | 已迁移的 8 个页面不再手写确认弹窗；`OAuthPage` / `ModelsPage` 未迁移（本轮优先 P0）。 |
| **新发现（本轮未修，已停手待下一批）** | **未修** | `MonitorPage.vue` 的重置按钮 `aria-label="重置账号 X 的窗口配额"` **不含可见文案「重置额度」**（WCAG 2.5.3 label-in-name，与 D10 同类）。修法一行：`aria-label="重置额度：X 的窗口配额"`。之所以还没改：Lead 已要求停手等 task-10 第二轮取证。 |
| D12 | **部分** | 已加**分页**（Keys/Channels/Analytics/Usage）；**排序/批量/列控**未做；`/models` 仍是 527 行一次渲染（且该页本轮未迁移）。 |
| D15 | **部分** | Keys/Channels/Analytics/Usage/Cache/Monitor 空态为中文且有下一步；`ModelsPage` 仍会用 Tuffex 默认英文串。 |
| D16 | **部分** | 迁移过的页面已收口到 `src/lib/format.ts`；`ModelsPage.vue` / `OAuthPage.vue` / `RequestDetail.vue` 仍有各自的时间/金额写法。 |
| D17 | **部分** | 8 个页面已换 `PageHeader`；`ModelsPage` / `OAuthPage` / `HelpPage`① 仍是内联 `page-head`。 |
| D22 | **部分** | 迁移的页面已删掉「props 永远为空」的双份状态；`ModelsPage` / `OAuthPage` 仍有。 |
| D24 | **未修** | `OAuthPage.vue` 轮询仍无上限/超时，`catch {}` 仍吞错。 |
| D25 | **未修** | 表单校验仍在提交时统一报错、落在表单底部，未做字段级 `aria-invalid`/`aria-describedby`。 |
| D28 | **部分** | 新表格带 `aria-label`；**排序未做**，故 `aria-sort` 无从谈起。 |
| D29 | **未修（非本任务范围）** | `.tsx` 死树、`server/*.test.ts` 只测死树，按 Lead 指示不动。 |
| D30 | **部分** | 未做术语统一（「中转站」等说法仍在文案里）。 |
| D32 | 未修 | `ConsoleNav.vue` 属 Lead 写范围。 |

① `HelpPage.vue` / `RtkPage.vue` 按 task-4 约定属蓝队 A，未动。

## 5.1 Lead 复验发现与修复（2026-10-01，收尾轮）

1. **确认框关闭后焦点没回到触发元素**（Lead 复验不通过 → 已修，含在 `ccee64e`）。
   - 根因：TxModal 自带的还原目标取自它自己的 props 变化时刻，部分路径下落到了 body/顶栏。
   - 修法：`src/lib/confirm.ts` 在 `confirm()` **同步调用点**抓 `document.activeElement`（`getConfirmTrigger()`）；`src/components/ConfirmHost.vue` 在关闭（Escape / 遮罩 / 右上角关闭三条路径）后显式 `focus()` 回该元素，`isConnected === false` 时退回页面主区第一个可聚焦控件；`ConsoleShell.vue` 给 `.shell__content` 加 `tabindex="-1"` 作为兜底落点。
   - **判据**（Lead 给定）：`document.activeElement.getAttribute("aria-label") === 触发按钮 aria-label`。我方复测 4 条路径：Escape ✅ / 遮罩点击 ✅ / 右上角关闭 ✅（三条都回到 `删除 龚翰林`）；把触发按钮从 DOM 移除后再 Escape ✅ 落到页面主区的「创建 API Key」，**不是 body**。
2. **Escape 关闭不稳定**（Lead 复验发现的真缺陷 → Lead 直接补丁，含在 `ccee64e`）。
   - 根因：Tuffex 的 Escape 绑在遮罩元素上（`modal/src/TxModal2.vue.js:36-58`），焦点一旦不在遮罩子树内就关不掉——而焦点修复后焦点会回到触发按钮，于是「弹窗留在原地、Esc 无效」。Lead 实测修复前 3 轮只 1 轮能关，在 `ConfirmHost.vue` 用 window 捕获阶段处理 Escape 后 **4/4 轮可关且焦点回归**。
   - **教训记录**：我早前两次「Escape 关闭 + 焦点回归 ✅」的结论是**在焦点仍在遮罩内的时序下测得的**，属于 flaky 通过，不应写成稳定结论。本文件先前的相应表述以此节为准。
3. **Monitor「额度重置」丢弃 `cooldownCleared`**（Lead 要求 → 已修，含在 `ccee64e`）。
   - 改法：接住 `reset-codex-quota` / `reset-claude-quota` 的返回值；`cooldownCleared === true` → success「已重置…失败冷却已清除」；`false` 或字段缺失 → **warning**「已重置，但上游失败冷却可能仍未清除，客户端可能仍被 429 挡住…稍后重试或联系管理员」；失败分支仍走 error 提示（顺手把 `TxAlert` 的 `type: 'danger'` 改成组件真正认的 `'error'`）。
   - **证据口径**：Lead 已实测两条分支；我方原计划的「浏览器里 patch `window.fetch` 造两种 `cooldownCleared` 各截一图」**未完成**（第一次尝试因按钮 `aria-label` 覆盖了可见文案、定位器没命中而中止，随后按 Lead 指示停手）。因此 `docs/qa/blue/shots/` 里**没有** `after-monitor-cooldown-*.png`，本条只有代码路径 + Lead 复验，不声称有我方截图。
4. **deploy-reconciler 的过期结论（记录用）**：其报告称「`VersionWidget.vue:184` 仍渲染已接通 (v0.50.0)」——那是基于旧快照的结论。当前实现以 `/api/rtk/status` 的 `planes[]` 为真源（`PLANE_LABEL` + `rtkPlanes`），实测显示「内核：未接通 / 中转站：未接通 / 本机：可用」，**已修，无需再改**。
5. **停手状态**：至 `ccee64e` 后我方不再改动 `src/**`（工作区无我方未提交改动），等 ux-auditor 的 task-10 第二轮取证结束再领下一批（Lead 计划：D12 `/models` 527 行无排序/分页/批量、D24 OAuth 轮询无超时）。

## 6. 未验证项与证据时间戳（重要）

1. **截图与构建的对应关系**：`docs/qa/blue/shots/` 中 08:34–08:41 的截图对应当轮构建；**08:42 最后一次代码构建**（含 `src/lib/focus.ts` 的焦点修复）后补拍了
   08:44 的三张：`after-keys-delete-confirm-focus.png`、`after-versionwidget-rtk-planes.png`、`after-analytics-mobile-390.png`。08:34–08:39 的截图**不含**后续焦点修复，但焦点修复不涉及这些页面状态；08:45 的最终构建与 08:42 的产物同哈希（`dist/assets/console-D_Mrm_FL.js`），即补拍截图与最终产物一致。
2. **未走完整提交路径**：删除密钥/渠道、剪枝 stale、重置额度（日/周/总）、停用渠道、重置账号配额**只验证到确认框出现与取消/ Esc 行为**，没有真正执行写操作（避免污染生产数据）。因此「失败后是否可恢复/是否有回滚」仍未实测。
3. **请求详情下钻**（`RequestDetail` 弹窗）只做了加载后可见性验证，未逐项验证其内部 Escape/焦点行为。
4. **Monitor 的额度重置确认框**：`/api/monitor` 当前无上游账号 → 页面是空态，确认框无法在真实数据下走通（与红队 §6.1 同）。
5. **屏幕阅读器实际播报**未验证（无辅助技术）：`aria-*` 结论仅来自 DOM 属性检查。**对比度**未量化。
6. **仅测 ego-lite Chromium**（桌面 1557×958 / 移动 390×844）；Firefox / Safari（iOS `position:sticky`、`100vh`、`clipboard`）未验证。
7. **SSE 自动重连**：代码里加了「断线可见 + 5s 重连一次」，但未在真实断网/服务端断开场景下验证重连是否成功（只验证了连接正常时「实时已连接」）。
8. **深链后退语义**：筛选写 URL 走 `router.replace`（不污染历史），已验证「刷新保持」与「分享链接」；**浏览器后退键回到上一页**这一条只做了代码路径确认，未逐步实测。
9. 浏览器会话在验证过程中出现过一次被服务端重启导致的登录失效（cookie 失效属预期），已重新登录后完成剩余取证；**全程未清除 cookie/缓存、未动 profile**，TaskSpace 以 `task.finish({ keep: [] })` 收尾一次。

## 7. 命令证据

```
$ npx tsc -p tsconfig.app.json --noEmit        # 排除 src/ab（ab-harness 的 A/B 实验台，非本任务范围）
(0 行输出)

$ npm run lint
server/nativeResponses.ts:200:128  warning eslint(no-control-regex)   # 既存 2 条，无新增
server/nativeResponses.ts:203:83   warning eslint(no-control-regex)

$ npm run build        # tsc -b && vite build --configLoader runner（取 /tmp/cac-build.lock 串行）
✓ built in 578ms       # 08:45 最终一次通过；dist/assets/console-D_Mrm_FL.js（与 08:42 同哈希）

$ npm run test:magpie  # node --test server/magpie*.test.ts server/rtkService.test.ts server/modelSync.test.ts
ℹ fail 0 · skipped 1 · duration_ms 745
```

## 8. 写范围自检

改动文件全部落在 task-4 写范围内：`src/lib/**`（新）、`src/components/{PageHeader,ConfirmHost,ErrorPanel,LoadingBlock,EmptyState}.vue`（新）、`src/App.vue`、`src/components/{ConsoleShell,VersionWidget}.vue`、`src/pages/{Dashboard,Analytics,Usage,Keys,Channels,Charts,Monitor,Cache}Page.vue`、`docs/qa/blue/**`。
未触碰：`src/router.ts`、`src/components/ConsoleNav.vue`、`src/api.ts`、`src/types.ts`、`server/**`、`src/pages/{HelpPage,RtkPage}.vue`、`src/ab/**`。
