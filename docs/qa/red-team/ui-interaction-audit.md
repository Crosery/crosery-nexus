# Crosery API Console — UI 交互反人类审计（红队 B / vs TUF 参考实现）

对象 `/Users/crosery/work_file/crosery-api-console`（commit `281c30e`，实例 <http://127.0.0.1:8791>）｜参考 TUF（只读）`/Users/crosery/work_file/geek_main/app/console/src`｜审计人 `ux-auditor` / task-2｜仅写入 `docs/qa/red-team/`，未改动产品代码。
**先决结论**：活代码是 `index.html → src/main.ts → App.vue + router.ts → pages/*.vue`（`.vue` 树）；`src/` 下并存的整套 `.tsx`/`App.tsx`/`main.tsx` 是**无人引用的 React 死树**，且前端测试**只读死树**（见 D29）——下文「现状」均指 `.vue` 树。

**Top 10（严重度降序，每条一句话 + 证据位置）**

1. **阻断**｜「请求明细」调错接口且无运行时校验，把 41.6% 真实错误率渲染成 `0.0% 健康稳定`（`AnalyticsPage.vue:45`，`shots/analytics-零数据但真实错误率41.6%-桌面.png`）
2. **阻断**｜接口失败退化成会消失的 toast，7 秒后页面与「本来就没数据」完全无区别且无重试（`KeysPage.vue:142-146`，`shots/keys-接口失败-toast消失后-桌面.png`）
3. **阻断**｜「重置额度」三键单击即执行、零确认，含不可逆的「重置总计用量」（`KeysPage.vue:642-649`，`shots/keys-额度弹窗-重置无确认-桌面.png`）
4. **阻断**｜「清理失效残留」是批量删渠道，普通按钮单击即删，无确认无预览无撤销（`ChannelsPage.vue:274`）
5. **阻断**｜移动端 390px 下 `minWidth` 列宽塌陷为 **0px**，列标题与文字重叠不可读（`KeysPage.vue:113-121`，`shots/keys-列表-移动端.png`）
6. **阻断**｜「图表分析」是 18 行占位组件，**永久显示加载中且从不发请求**（`ChartsPage.vue:14-16`，`shots/charts-永久加载中-桌面.png`）
7. **高**｜行内唯一详情入口是死点击（`emit('select-key')` 无监听者）、且 `div` 不可聚焦、行无样式（`KeysPage.vue:375`）
8. **高**｜全部列表无排序/分页/批量/列控，`/models` 裸渲染 **527 行**，表头连 `aria-sort` 都没有
9. **高**｜筛选/搜索/分页完全不进 URL，刷新即丢、不能分享、不能后退（`grep route.query src --include=*.vue` → **0 命中**，TUF 有 10+ 处）
10. **高**｜删除确认**叠在编辑弹窗之上**（两 Modal 同开），且弹窗打开时焦点停在遮罩上（`KeysPage.vue:595`+`:750`，`shots/keys-删除确认-桌面.png`）

---

## 0. 审计时点、并发变更与「现状复核」（**必读**）

**审计时间窗**：2026-10-01 08:14–08:23。**浏览器取证对应运行实例当时服务的 `dist/` 构建（构建于 05:40）**，与我在 08:14–08:20 读到的源码一致。

**并发变更**：审计进行期间，另一路（蓝队）**正在改 `src/`**，并在 08:18–08:24 新增了共享原语、改写 3 个页面、于 **08:24:22 重新构建 `dist`**（即运行实例在我取证结束后已经变了）。新增文件（审计开始时**均不存在**）：`src/lib/{confirm,errors,format,resource,listState,viewport}.ts`、`src/components/{PageHeader,ErrorPanel,LoadingBlock,ConfirmHost,EmptyState}.vue`。

**复核（08:25 对当前源码逐条复查）**：

| 状态 | 缺陷 | 复核依据 |
|---|---|---|
| ✅ **审计期间已修复** | **D19**（VersionWidget 重复挂载/重复请求） | `ConsoleShell.vue:16-17,56-57,73,78` 改为 `v-if="isMobile"` 条件渲染，注释明确写着「用 `display:none` 藏起来的那份照样会挂载、照样会打 `/api/version`」；新增 `src/lib/viewport.ts` |
| ✅ **部分修复（仅 3 页）** | **D12/D13/D16/D17** 在 `AnalyticsPage`/`UsagePage`/`DashboardPage` | 这 3 页已接入 `PageHeader`+`ErrorPanel`+`LoadingBlock`+`EmptyState`+`useResource`+`lib/format`+`lib/listState`（含 `TxPagination`、`useQueryState`） |
| 🟡 **原语已就位但无人使用** | **D5/D6/D7/D26** 的修复前提 | `src/lib/confirm.ts` 已存在且 `App.vue` 已挂载 `ConfirmHost`；但 `KeysPage.vue`/`ChannelsPage.vue` 对 `lib/confirm` 的引用数 = **0** —— 危险操作尚未接入 |
| ❌ **仍然存在（已复核）** | **D1** | `AnalyticsPage.vue:32` 仍为 `api.usageBreakdown<AnalyticsData>(...)`；`api.ts:63` 仍原样透传 `/api/usage-breakdown` 响应、**无任何字段映射** → 形状错配这一根因未修（页面外壳被重构了，取数错误被保留） |
| ❌ **仍然存在（已复核）** | **D3** | `src/pages/ChartsPage.vue` 仍为 **18 行**占位，仍硬编码「加载图表数据中...」 |
| ❌ **仍然存在（已复核）** | **D4/D13/D21/D22/D25/D27** | `KeysPage.vue`/`ChannelsPage.vue` **未在本次改动范围内**（`git status` 未列出），`route.query`/`useQueryState` 引用数 = 0 |
| ❌ **仍然存在（已复核）** | **D18** | `ConsoleShell.vue:75` 仍是 `<!-- reserved for breadcrumb or context -->` |
| ❌ **仍然存在（已复核）** | **D20** | `ConsoleShell.vue:110-124`：`.shell__desktop-header` 仍是 `max-width:1360px; margin:0 auto`，父级 `.shell__main` 仍是 `display:flex; flex-direction:column` → 列向 flex 下 `margin:auto` 仍会取消 stretch、缩到 fit-content |
| ⬜ **未触及** | **D2/D8/D9/D10/D11/D14/D15/D23/D24/D28/D29/D30/D31/D32** | 相关文件未在改动范围内 |

**给蓝队排期的建议**：新增的 5 个组件 + 6 个 lib 正是本报告 §5 推荐的形状，方向正确。**当前最大的两个缺口是：(1) D1 取数错配未修（重构了外壳但保留了错误的接口与断言）；(2) D5/D6 危险操作尚未接入已经就位的 `confirm()`。** 其次是把 `KeysPage`/`ChannelsPage` 按同样模板迁移——这两页承载了 Top 10 里的第 4、5、7、9 条。

> 说明：本报告 §4 的每条缺陷都标注了审计时的代码行号与截图；截图对应 05:40 构建，**在 08:24 重建后不再代表运行实例的当前画面**。上文「复核」列是唯一针对当前源码的判断。

---

## 1. 额外系统性提示（非交互层，不计入 Top 10）

> **审计时实测**：`/api/version` 每次冷启动请求 **2 次**（`ConsoleShell.vue:51`+`:72` 双实例，靠 CSS `display:none` 隐藏而非条件渲染，且各自注册一套全局 `mousedown`/`keydown`）；桌面头部盒子仅 **257px** 宽且居中悬浮，与页面内容（280→1525）完全错位，而它本该是面包屑位（`ConsoleShell.vue:69` 只剩一行 `<!-- reserved for breadcrumb or context -->`）。详见 D19/D20。
>
> **现状**：D19 已在审计期间被蓝队修复（见 §0）；**D20 与面包屑缺口仍存在**（`ConsoleShell.vue:110-124`、`:75`）。

---

## 2. 审计方法、取证覆盖率与边界

### 2.1 方法
1. **静态对照**：逐条读 TUF 的交互原语（`PageHeader/ErrorPanel/LoadingBlock/ConfirmHost/CapabilityGate` + `lib/{confirm,resource,errors,format,nav,http}.ts`），再与现存 `.vue` 树逐条比对。
2. **浏览器取证**：ego-browser 单 TaskSpace（`spaceId=1`），真实登录后走页面、开弹窗、切移动端、注入接口故障（`Network.setBlockedURLs`）、用 CDP 统计网络请求与测量布局。**未执行任何破坏性写操作**（未删 Key/渠道、未剪枝、未重置额度、未改开关），以免污染生产数据；危险路径用「打开但不确认」+ 代码行号取证。
3. **禁止事项遵守**：全程未调用 `Network.clearBrowserCookies`、未清缓存/存储、未动 profile 目录；密码仅从 Keychain 读出后经 stdin 管道注入浏览器脚本，**未写入任何文件、argv、日志、报告或截图**。

### 2.2 真实打开过并截图/测量过的页面（覆盖率高）
| 路由 | 打开 | 截图 | 额外取证 |
|---|---|---|---|
| `/login` | ✅ | `login-登录页-桌面.png` | 表单 `label` 关联探针、heading 层级 |
| `/dashboard` | ✅ | `dashboard-概览-桌面.png` | `/api/version` ×2 请求计数 |
| `/keys` | ✅ | 桌面/筛选/创建/编辑/删除/额度/接口失败×2/移动端/抽屉（10 张） | 列宽坍缩测量、模态堆叠、焦点、死点击、URL 状态、故障注入 |
| `/channels` | ✅ | `channels-列表-桌面.png` | 移动端列宽测量 |
| `/models` | ✅ | `models-列表-桌面.png` | 527 行裸渲染、移动端列宽 |
| `/oauth` | ✅ | `oauth-登录池-桌面.png` | 请求计数 |
| `/charts` | ✅ | `charts-永久加载中-桌面.png` | 确认零数据请求 |
| `/analytics` | ✅ | `analytics-请求明细-桌面.png`、`analytics-零数据但真实错误率41.6%-桌面.png` | 响应形状对比（`usage-breakdown` vs `analytics`） |
| `/usage` | ✅ | `usage-统计-桌面.png` | 未定价告警文案 |
| `/cache` | ✅ | `cache-缓存-桌面.png` | SSE 已连接、37 行实时流 |
| `/monitor` | ✅ | `monitor-账号监控-桌面.png` | **当前无上游账号 → 空态，确认框无法走通** |
| `/help` | ✅ | `help-帮助-桌面.png` | 目录导航存在 |

**只做静态分析、未在浏览器打开的**：`RequestDetail` 模态的下钻路径（`/analytics` 因 D1 无数据可点）、所有破坏性确认的**最终提交**（故意不执行）、OAuth 真实第三方授权回路、`/audit` 与凭据管理（**路由中不存在对应页面**）。

### 2.3 环境
- 目标 `http://127.0.0.1:8791`（Vue 树，`dist` 与 `src` 一致）；上游 `http://127.0.0.1:8790/health` = `{"engine":"magpie","ok":true}`
- 浏览器 ego-lite Chromium；桌面视口 1557×958 / 1560×900，移动端 390×844
- 数据实况：14 个 Key、5 个渠道、527 条模型索引、`/api/analytics` 7 天 214 请求

---

## 3. 逐页 × 交互面矩阵

图例：✅ 合格 ｜ ⚠️ 有缺陷 ｜ ❌ 缺失

| 页面 | 页头/面包屑 | 加载态 | 错误态 | 空态 | URL 状态 | 排序/分页 | 危险操作确认 | 键盘/焦点 | 移动端 |
|---|---|---|---|---|---|---|---|---|---|
| Dashboard | ⚠️ 内联无面包屑 | ⚠️ 无骨架 | ❌ 无 | ⚠️ | ❌ | ❌ | — | ⚠️ | ⚠️ |
| Keys | ⚠️ 内联无面包屑 | ⚠️ 仅表格 spinner | ❌ **toast 即消失** | ⚠️ 中英混排 | ❌ | ❌/❌ | ❌ **重置额度无确认** | ❌ 死点击、图标按钮无 aria-label | ❌ **列宽塌陷重叠** |
| Channels | ⚠️ 内联无面包屑 | ⚠️ | ❌ | ⚠️ | ❌ | ❌/❌ | ❌ **批量剪枝无确认**（删除有） | ❌ 单元格 div 不可聚焦 | ❌ 三列塌到 31px |
| Models | ⚠️ 内联 | ⚠️ | ❌ | ❌ 英文默认 | ❌ | ❌/❌ **527 行** | ⚠️ 同步无确认 | ❌ | ⚠️ 可横向滚动 |
| OAuth | ⚠️ 否 | ⚠️ | ⚠️ | — | ❌ | — | ⚠️ 取消无确认（可接受） | ❌ | ⚠️ |
| Charts | ⚠️ 内联 | ❌ **永久加载** | ❌ | ❌ | ❌ | — | — | ❌ | ❌ |
| Analytics | ✅ 唯一用 `<section>` | ⚠️ | ❌ **`catch{}` 静默** | ⚠️ | ❌ | ❌/❌ | — | ❌ | ⚠️ 列挤到 50px |
| Usage | ⚠️ 内联 | ⚠️ | ⚠️ 未定价告警 | ⚠️ 有下一步文案 | ❌ | ❌/❌ | — | ❌ | ✅ 基本可用 |
| Cache | ⚠️ 内联 | ⚠️ | ❌ | ❌ 英文默认 | ❌ | ❌/❌ | — | ❌ | ⚠️ |
| Monitor | ⚠️ 内联 | ⚠️ | ❌ | ✅ **有原因+下一步** | ❌ | ❌/❌ | ✅ **有确认框（唯一）** | ❌ | ⚠️ |
| Help | ⚠️ 内联 | — | — | — | ❌ | — | — | ⚠️ | ⚠️ |
| Shell（全局） | ❌ **面包屑位留空注释** | — | — | — | — | — | — | ⚠️ 抽屉可用 | ❌ 头部错位 |

**交互面整体结论**：
- **导航与信息架构**：有分组与当前项高亮（`ConsoleNav.vue:19-54`），但**全站零面包屑**，`ConsoleShell.vue:69` 只留了一行 `<!-- reserved for breadcrumb or context -->`；无详情路由，故无深链、无返回语义（浏览器后退会跨页跳走）。
- **列表页**：7 张表一致地缺排序、分页、批量、列控；空态/加载态/错误态三态没有共享原语，各页各写，结果三态都不可靠（错误态最严重）。
- **危险操作**：5 处危险动作里只有 1 处（Monitor 重置额度）有确认；确认 UI 有 3 套手写实现且约定不一致。
- **表单与弹窗**：校验只在提交时触发、错误统一落在表单底部而非字段旁；弹窗可嵌套；打开弹窗不移焦。
- **数据可读性**：`compact`/金额/百分比各有 6/5/4 套实现，输出不一致（`n/a` vs `未定价` vs `—`）；时间格式 6 种，**无一处固定时区**。
- **响应式**：断点 900px 与 TUF 相同，抽屉可用；但 `min-width` 列在 `table-layout:fixed` 容器溢出时塌成 0，Keys/Channels 窄屏不可读。
- **可访问性**：设计系统侧（Tuffex）**做得不错**——`TxFilterChips` 有 `role=toolbar`+`aria-pressed`+roving tabindex，焦点环 76/77 元素可见；**问题全在应用层**：图标按钮无 `aria-label`、可点击 div 无 `role/tabindex`、表格无 `aria-sort`、按钮可访问名与可见文案不一致。
- **文案**：术语漂移（见 D30），且英文串泄漏到 `lang="zh-CN"` 界面。

---

## 4. 缺陷清单（32 条）

### 阻断（Blocker）

#### D1 — 「请求明细」页调错接口 + 类型断言说谎，把 41.6% 错误率渲染成「健康稳定」
- **现象**：`/analytics` 顶部四张卡恒为 `请求量 0 / Token 消耗 0 / 错误率 0.0% 健康稳定 / 平均响应时间 0ms`，Key 排行显示「无 Key 使用数据」，明细表空。而同期 `/api/analytics?days=7` 返回 `requests:214, tokens:76762, avgLatency:4842.57, errorRate:0.4159`。
- **根因**：`AnalyticsPage.vue:45` 调的是 `api.usageBreakdown(...)` 并断言成 `AnalyticsData`；而 `/api/usage-breakdown` 实际返回 `{days,keyId,quotaTimeZone,models,totals,unpricedModels,keys}`，与 `AnalyticsData`（`types.ts:255-268`：`summary/trend/keyUsage/clients/requests…`）**除 `days` 外零字段重叠**。Vue 无运行时 props 校验，断言在运行时不存在 → 读到的全是 `undefined`，被 `|| 0` 兜成 0。真正形状正确的 `/api/analytics`（`api.ts:19`）**零调用者**。`catch{}` 还会吞掉一切异常，保证「永远显示健康的 0」。
- **复现**：登录 → 侧栏「用量分析 › 请求明细」→ 观察四张卡；然后 `page.evaluate(() => fetch('/api/analytics?days=7').then(r=>r.json()))` 对比 `errorRate`。
- **严重度**：**阻断**（可观测性页面在故障时给出相反的结论，是该产品最危险的失效方向）
- **证据**：`shots/analytics-零数据但真实错误率41.6%-桌面.png`、`shots/analytics-请求明细-桌面.png`；`src/pages/AnalyticsPage.vue:45,47-49,64-74`；`src/types.ts:255-268`；`src/api.ts:19`
- **TUF 对应做法**：`pages/Applications.vue:37-42` 用 `useResource(fetcher)` 让**类型与请求同源**，`ErrorPanel`（`Applications.vue:89`）接管失败；`lib/errors.ts:24-55` 把错误翻成「出了什么事 + 下一步」。

#### D2 — 接口失败 = 空数据，且 toast 消失后无痕
- **现象**：屏蔽 `/api/bootstrap` 后 `/keys` 展示「暂无匹配的 API Key / No data available yet.」，筛选 chips 全变 `(0)`；约 7 秒后 toast 自动消失，**页面全文再无「失败/错误/无法」字样**，也没有「重试」按钮。
- **复现**：`page.cdp("Network.setBlockedURLs",{urls:["*/api/bootstrap*"]})` → 打开 `/keys` → 等 7 秒 → 读取 `document.body.innerText`（`anyErrorText=false`）。
- **严重度**：**阻断**（全站故障被读成「这个账号一个 Key 都没有」）
- **证据**：`shots/keys-接口失败-桌面.png`（含 toast）、`shots/keys-接口失败-toast消失后-桌面.png`（无痕）；`src/pages/KeysPage.vue:142-146`（catch → 仅 toast，无 error ref）、`:371 empty-text`；同类还有 `ChannelsPage.vue:98-102`、`DashboardPage.vue:102-115`
- **TUF 对应做法**：`lib/resource.ts:14-39` 的 `useResource` 暴露持久 `error` ref；`components/ErrorPanel.vue:15,40-52` 渲染「标题+说明+重试/重新登录」（`:20-25` 决定主按钮）；`Applications.vue:89` 的 `v-if="list.error.value"` 是固定写法。

#### D3 — 「图表分析」页永久加载，从不请求数据
- **现象**：`/charts` 永远显示「加载图表数据中...」，CDP 只看到 `/api/session` 与 `/api/version`，**没有任何 charts 请求**。
- **根因**：`ChartsPage.vue` 只有 18 行，模板里硬编码一行 `<p class="muted">加载图表数据中...</p>`，无脚本、无 fetch。服务端 `/api/charts`（`server/index.ts:597`）与客户端 `api.charts`（`api.ts:20`）都已就绪，页面却没实现。
- **复现**：登录 → 侧栏「用量分析 › 图表分析」→ 等待任意时长，文案不变。
- **严重度**：**阻断**
- **证据**：`shots/charts-永久加载中-桌面.png`；`src/pages/ChartsPage.vue:14-16`（全文 18 行）
- **TUF 对应做法**：`components/LoadingBlock.vue:10-13` 是**受控**加载态（`v-else-if="!data"`，有数据就不再显示，见 `Applications.vue:90`），不会出现「永远在加载」。

#### D4 — 移动端表格列宽塌陷为 0，文字重叠不可读
- **现象**：390px 下 `/keys` 的「名称与标识 / 授权渠道分组 / 额度消费进度」三列 **`getBoundingClientRect().width === 0`**，列标题与单元格文字叠在一起，Key 名、渠道标签、时间戳互相压字；「操作」列起点 x=378 已越出 390 视口，图标按钮被裁掉。`/channels` 同样三列塌到 **31px**。
- **根因**：`table-layout="fixed"` + `scroll-x`，列定义同时给「必须有的列」`minWidth`（名称 200/分组 220/额度 220）和其余列固定 `width`（120/140/100/160）。固定宽度合计 520px 已超过容器 354px，浏览器在 fixed 布局下**优先满足固定宽度并把 `min-width` 列压到 0**（`min-width` 被忽略），而不是让表格按 minWidth 之和撑宽。
- **复现**：`Emulation.setDeviceMetricsOverride({width:390})` → 打开 `/keys` → 读各 `th` 的 `getBoundingClientRect().width`。
- **严重度**：**阻断**（移动端主列表完全不可读）
- **证据**：`shots/keys-列表-移动端.png`；实测 `名称与标识 w=0 / 授权渠道分组 w=0 / 额度消费进度 w=0`、scroller `scrollWidth 520 > clientWidth 354`；`src/pages/KeysPage.vue:113-121`、`:364-372`；`src/pages/ChannelsPage.vue:69-75`
- **TUF 对应做法**：`Applications.vue:92` 在表格上给 `style="--table-min: 680px"` 用**单个最小宽度变量**兜底，列定义中只有主列无 `width`、其余给固定 `width`，不混用「多列 minWidth + 溢出固定宽度」；窄屏靠 `scroll-x` 整表滚动而不是压列。

#### D5 — 「重置额度」三个按钮点击即执行，零确认（含不可逆的累计总额）
- **现象**：额度弹窗底部三个「重置今日用量 / 重置本周用量 / **重置总计用量**」按钮直接调 `api.resetQuota`，无任何确认框；只有成功后的 toast。其中「重置总计用量」按页面自述是「达到后密钥停用，仅可手动重置」的唯一闸门，单击即归零且不可恢复。
- **复现**：`/keys` → 找有额度条的行（如「非雨」）→ 点 `title="配置额度上限"` → 观察三个按钮；对照 `KeysPage.vue:296-309` 无 confirm 调用。
- **严重度**：**阻断**
- **证据**：`shots/keys-额度弹窗-重置无确认-桌面.png`；实测同一弹窗内 `resetButtons:["重置今日用量","重置本周用量","重置总计用量"]`；`src/pages/KeysPage.vue:642-649`、`:669-676`、`:696-703` → `:296-309`
- **TUF 对应做法**：`lib/confirm.ts:12-20` 提供 `await confirm({title,body,confirmText,danger})`，全站唯一弹窗由 `App.vue:9` 挂载的 `components/ConfirmHost.vue:13-23` 渲染（`:17` 初始焦点落在「取消」，`:18` 危险操作 `variant="danger"`）；`:14` 还处理了「上一个确认未答复就被替换」按取消收尾，避免调用方永久挂起。

#### D6 — 「清理失效残留」是批量删除渠道，单击即删，无确认
- **现象**：`/channels` 页头第三个按钮「清理失效残留」直接 POST `/api/channels/prune-stale` 并返回删除了哪些渠道，**无确认、无将被删除的清单预览、无撤销**。它和「添加渠道」并排，且是 `variant="secondary"`（视觉权重与危险度不符）。
- **复现**：`/channels` → 观察页头三个按钮 → 对照 `ChannelsPage.vue:274` 直连 `handlePruneStale`。
- **严重度**：**阻断**（批量不可逆删除）— *本次为保护生产数据未实际点击执行*
- **证据**：`src/pages/ChannelsPage.vue:274-276`（按钮）、`:162-174`（实现）；对比同页单个删除**有**确认 `:473-484`
- **TUF 对应做法**：同 D5 的 `confirm()`；TUF 中所有破坏性操作都先 `await confirm(...)` 再发请求。

### 高（High）

#### D7 — 没有统一确认原语，3 套手写实现且约定不一致
- **现象**：`KeysPage.vue:69` `showDeleteConfirm` 的目标取自 `editingItem`（`:249-250`），`ChannelsPage.vue:64-65` 用独立的 `deletingChannel`（`:142-145`），`MonitorPage.vue:28-29` 又是 `confirmingAccount/confirmModalOpen`（`:97-99`）。三处各写一套 `ref + v-model + Modal`，目标变量的来源与命名都不同。
- **影响**：新增危险操作必须复制粘贴，且极易像 Keys 那样把「确认目标」耦合到另一个弹窗的状态上；本仓库已经出现同一动作两种行为（见 D26）。
- **严重度**：高
- **证据**：`src/pages/KeysPage.vue:68-70,249-263,750-761`；`src/pages/ChannelsPage.vue:63-66,142-160,473-484`；`src/pages/MonitorPage.vue:28-29,97-119,250-258`
- **TUF 对应做法**：`lib/confirm.ts`（唯一）+ `components/ConfirmHost.vue`（唯一）；调用点只写 `if (!(await confirm({...}))) return;`。

#### D8 — 删除确认叠在编辑弹窗之上（Modal 套 Modal）
- **现象**：删除入口被放在**编辑弹窗的 footer**（`KeysPage.vue:591-598`，`v-if="editingItem"`），点击后 `showDeleteConfirm=true` 而**不关闭编辑弹窗**。实测两个 dialog 同时可见、两层遮罩同时存在。用户看到的是「弹窗上的弹窗」，且语义上「删除」被藏进「编辑」里，退出删除后仍停在编辑弹窗。
- **严重度**：高
- **证据**：实测 `visibleDialogTitles=["编辑 API Key","删除密钥确认"]` 同时成立；`shots/keys-删除确认-桌面.png`；`src/pages/KeysPage.vue:591-598`（触发）、`:750`（同级第二个 Modal）
- **TUF 对应做法**：危险操作在**列表行内或详情页**直接 `await confirm()`，确认框与业务弹窗互斥（唯一 host 挂在 `App.vue:9`），不产生嵌套。

#### D9 — 弹窗打开时不移动焦点，焦点停在遮罩上
- **现象**：点击「创建 API Key」后 `document.activeElement` 是 `DIV.tx-modal__overlay`，不是第一个输入框；编辑弹窗、删除确认同样如此。键盘用户必须 Tab 穿过遮罩才能进入表单；Esc 关闭后焦点**能**正确回到触发按钮（这点是好的）。
- **严重度**：高
- **证据**：实测 `activeElement=DIV.tx-modal__overlay tx-modal-enter-from`；`src/pages/KeysPage.vue:529-533`
- **TUF 对应做法**：`components/ConfirmHost.vue:17` 显式 `autofocus` 在「取消」上；`lib/errors.ts:62-65` 连主按钮语义都区分 signin/retry。

#### D10 — 移动端「菜单」按钮的可访问名与可见文案不一致（WCAG 2.5.3）
- **现象**：`ConsoleShell.vue:41` 的按钮可见文本是「菜单」，但 `aria-label="打开导航"` 覆盖了可访问名。语音控制用户说「菜单」无法激活它（`loc=role:button[name*="菜单"]` 实测 0 命中，必须用「打开导航」）。
- **严重度**：高（可访问性合规 + 语音控制不可用）
- **证据**：实测 `{visibleText:"菜单", ariaLabel:"打开导航"}`；`src/components/ConsoleShell.vue:38-45`
- **TUF 对应做法**：`components/ConsoleShell.vue:39` 同一按钮写了 `aria-label="打开导航"`，但**可见文本同样是「菜单」**——TUF 此处有同样的隐患，迁移时应以「可见文本作为可访问名主体」修正（见 M12）。

#### D11 — 表格内图标按钮无 `aria-label`，可访问名只靠 `title`
- **现象**：Keys 的复制/额度/编辑/启停、Channels 的查看模型/删除共 6+ 个图标按钮 `aria-label=null`，可访问名只能回退到 `title`。`title` 在触屏与多数移动端读屏下不可靠，且键盘聚焦时**没有可见提示**（不像 tooltip）。
- **严重度**：高
- **证据**：实测 6 个按钮全为 `{text:"", ariaLabel:null, title:"..."}`；`src/pages/KeysPage.vue:495-522`；`src/pages/ChannelsPage.vue:350-363`
- **TUF 对应做法**：TUF 侧栏图标显式 `aria-hidden="true"`（`components/ConsoleNav.vue:102`），交互控件带可见文本（如 `Overview.vue:132`「查看全部」）。

#### D12 — 全部列表无排序 / 无分页 / 无批量 / 无列控，`/models` 裸渲染 527 行
- **现象**：7 张表一致缺失：点表头无排序、无分页控件、无行选择复选框、无列宽拖拽与列显隐。`/models` 一次性渲染 **527 行** DOM。
- **复现**：`grep -riE "sortable|pagination|pageSize|selectedRows|resizable|aria-sort" src --include=*.vue` → 仅命中无关的 checkbox 装饰类；实测 `/models` `rowCount=527`、所有 `th aria-sort=null`。
- **严重度**：高（527 行的表没有排序与分页时，定位一个模型只能靠浏览器查找）
- **证据**：`shots/models-列表-桌面.png`；`src/pages/ModelsPage.vue` 全文无排序/分页；`src/pages/KeysPage.vue:113-121`
- **TUF 对应做法**：`pages/Applications.vue:26` `PAGE_SIZE = 20` + `:38` 服务端 `limit/offset`；`:33` 页码来自 URL。

#### D13 — 筛选/搜索/分页完全不进 URL
- **现象**：在 `/keys` 输入搜索词并切换筛选后，`location.search` 仍是空串；按刷新后搜索框清空、chip 回到「全部密钥 (14)」、行数回到 14。无法分享带筛选的链接，后退键会直接离开页面向导，书签无效。
- **复现**：填搜索 → 选 chip → 读 `location.href` → `reload()` → 读输入框与 `aria-pressed`。
- **严重度**：高
- **证据**：实测 `{"url":"http://127.0.0.1:8791/keys","search":""}`；刷新后 `searchInputValue=""`、`activeChip="全部密钥 (14)"`；`shots/keys-筛选后-桌面.png`；`src/pages/KeysPage.vue:43-44`（本地 ref）；`grep -rn "route.query" src --include=*.vue` **0 命中**
- **TUF 对应做法**：`pages/Applications.vue:31-33` 把 `status/q/page` 全部读自 `route.query`；`:44-48` `setQuery()` 用 `router.replace` 合并写回（不刷历史）；`:34-35` 用本地 draft 同步搜索框避免每击键都写 URL；`:37-42` `useResource(..., [status,q,page])` 依赖变化自动重取。其它例：`Audit.vue:35,36,46`、`People.vue:52,58,62,63`、`github/Repos.vue:29,58`、`Feedback.vue:34,41`。

#### D14 — 时间格式化不固定时区，且页面自称「服务器时区：UTC」而服务端是 Asia/Shanghai
- **现象**：Keys 页头副标题渲染「（服务器时区：UTC）」，但同一实例的 `/api/usage-breakdown` 返回 `quotaTimeZone:"Asia/Shanghai"`。根因是 `KeysPage.vue:29` 的默认值 `quotaTimeZone:'UTC'`，而 `router.ts:18` 直接挂载页面、**从不传 props**，于是默认值被当成事实展示。同时「最近调用」列（`:465-470`）与 `formatResets`（`:126`）用 `toLocaleString('zh-CN',…)` **不带 `timeZone`**，按浏览器本地时区渲染——即「用浏览器时区的时间，标注成 UTC」。
- **严重度**：高（审计/排障时会把时间读错，且两个来源互相矛盾）
- **证据**：实测页头文本 `…（服务器时区：UTC）`，`browserTZ=Asia/Shanghai`，API `quotaTimeZone=Asia/Shanghai`；`src/pages/KeysPage.vue:29,124-132,327,465-470`
- **TUF 对应做法**：`lib/format.ts:4` 固定 `TIME_ZONE="Asia/Shanghai"`，`:13`/`:19` 显式传 `timeZone`，并在 `:1-2` 说明「不跟浏览器时区走」。

#### D15 — 空态文案中英混排（英文默认串泄漏）
- **现象**：`/keys` 的接口失败态显示「暂无匹配的 API Key / **No data available yet.**」，在 `lang="zh-CN"` 页面里出现英文。仅 2 张表设了 `empty-text`，其余（Models / Analytics / Usage / Cache / Monitor 的表）会直接用 Tuffex 默认英文串。
- **严重度**：高（文案 + 三态可靠性）
- **证据**：`shots/keys-接口失败-桌面.png`、`shots/keys-列表-移动端.png`；仅 `src/pages/KeysPage.vue:371`、`src/pages/ChannelsPage.vue:301` 设置了 `empty-text`
- **TUF 对应做法**：TUF 各页显式传中文空态/说明（如 `pages/UsagePage`-style 用法），并在 `lib/errors.ts:27,36-54` 统一中文错误文案。

#### D16 — 数字/金额/百分比格式化 6 套 compact、5 套金额、4 套百分比；**同一个数字在两个页面显示成不同单位**
- **现象**：同一「压缩数字」逻辑被写了 6 遍，且分成两个**互不兼容的流派**：
  - `Intl.NumberFormat('zh-CN', {notation:'compact'})`：`chartTheme.ts:40`、`DashboardPage.vue:49`、`ModelsPage.vue:52` → 走中文「万」；
  - 手写 `k/M/B` 阈值：`CachePage.vue:55-59`、`MonitorPage.vue:91-94`、`UsagePage.vue:38-41` → 走公制前缀。

  实测同一个 `76,762` token：**Dashboard 显示 `7.7万`，Usage 页显示 `76.8k`**；`2,140,000` 分别是 `214万` 与 `2.1M`。即用户在同一产品里看到同一量级的两种单位，无法心算比较。
  金额格式另有 5 套：`CachePage.vue:64-67`（<1 用 `toFixed(4)`）、`UsagePage.vue:44`（同精度但缺值 `n/a`）、`ModelsPage.vue:53`（缺值 `未定价`，阈值 0.01）、`RequestDetail.vue:106`（`toFixed(5)`）、`KeysPage.vue:440`（`toFixed(1)`）。百分比缺值分别渲染为 `n/a`（`CachePage.vue:70`）、`未计算`（`RequestDetail.vue:105`）、`—`（`ModelsPage.vue:54`）。
- **影响**：同一屏内「$1.2 / $1.2000 / $1.20000」并存；缺值三种写法，用户无法判断 `n/a` 是「未定价」还是「没数据」；`7.7万` vs `76.8k` 让跨页对账直接算错。
- **严重度**：高
- **证据**：实测 `76,762 → Dashboard "7.7万" / Usage "76.8k"`、`2,140,000 → "214万" / "2.1M"`（`shots/dashboard-概览-桌面.png`、`shots/usage-统计-桌面.png`）；上列 `path:line`
- **TUF 对应做法**：`lib/format.ts` 单点收口（`fmtDate/fmtDay/fmtRelative`），全站只有一处实现。

#### D17 — 页头（page-head + eyebrow）在 9+ 页复制粘贴，无共享组件
- **现象**：`<header class="page-head"><div class="page-head__text"><div class="eyebrow-tag">…` 结构在 Keys/Channels/Dashboard/Analytics/Cache/Help/Models/Monitor/Usage/OAuth 反复出现，且每页**重新定义同名 scoped CSS**（`.page-head`、`.page-head__text h1`、`.page-head__actions`）：`AnalyticsPage.vue:260-285`、`CachePage.vue:349-374`、`HelpPage.vue:274-280`、`DashboardPage.vue:323`、`ChartsPage.vue:7-13` 等。改一次页头要改十处，且已经漂移（有的用 `<header>`、有的用 `<section>`、`ChartsPage` 连 actions 都没有）。
- **严重度**：高（这是「完全没有借鉴 TUF」最直接的证据）
- **证据**：`grep -rn "page-head" src/pages/*.vue` 命中 10+ 文件
- **TUF 对应做法**：`components/PageHeader.vue:19-31` 单组件（`title`/`description`/`#meta`/`#actions` 插槽），`Applications.vue:69-80` 是标准调用。

#### D18 — 无面包屑、无深链详情页；面包屑位只剩一行注释
- **现象**：`ConsoleShell.vue:69` 写着 `<!-- reserved for breadcrumb or context -->`——位置留了，功能没做。全站 0 个 `TxBreadcrumb`。请求明细的「下钻」是**弹窗**（`AnalyticsPage.vue:249`）而非路由，所以单条请求无法分享链接、无法在新标签打开。列表→详情的路径只在 OAuth 页有硬编码 `router.push('/channels')`（`OAuthPage.vue:230`）。
- **严重度**：高
- **证据**：`src/components/ConsoleShell.vue:67-74`；`src/pages/AnalyticsPage.vue:249`
- **TUF 对应做法**：`components/PageHeader.vue:6,13-16,22` 支持 `crumbs: {label,to}[]` 并走 `router.push`；`Applications.vue:63` `detailHref` 生成 `/console/applications/:id` 真路由；`github/repo/ThreadDetail.vue:76` 提供「返回列表」按钮。

#### D19 — 顶部 VersionWidget 重复挂载，`/api/version` 每次冷启动请求 2 次
- **现象**：CDP 统计 dashboard 冷启动 42 个请求，其中 **`/api/version` × 2**；DOM 里 `.version-widget-trigger` 恒为 **2 个**（一个在 `display:none` 的 `.shell__topbar` 内，一个在 `.shell__desktop-header` 内）。两个实例各自 `onMounted` 发请求（`VersionWidget.vue:96-98`）并各注册一套全局 `mousedown`/`keydown` 监听（`:94-95`）。移动端实测仍为「DOM 2 个 / 可见 1 个」。
- **严重度**：高（重复请求 + 重复全局监听 + 两个独立 popover 状态可能同时打开）
- **证据**：实测 `{"triggerCount":2, shells:[{cls:"shell__topbar",display:"none",widgets:1},{cls:"shell__desktop-header",display:"flex",widgets:1}]}`、`API request counts {"/api/version":2}`；`src/components/ConsoleShell.vue:50-52` 与 `:71-73`
- **TUF 对应做法**：TUF 的 `ConsoleShell.vue` **没有**这个组件；顶栏放的是无副作用的 `TitleBadge`（`:44`），上下文信息放在 `shell__context`（`:52-56`）。`ConsoleNav` 的两次渲染（`:35`/`:48`）本身无请求，是可接受的模式——**说明重复 Nav 是照搬的，重复 Widget 是自己加的**。

#### D20 — 桌面顶部头部盒子只有 257px 宽并居中悬浮，与页面内容完全不对齐
- **现象**：`.shell__desktop-header` 是 `display:flex; justify-content:space-between; max-width:1360px; margin:0 auto`（`ConsoleShell.vue:104-111`）。父级 `.shell__main` 是 `flex-direction: column`，在列向 flex 中 `margin: 0 auto` 会**取消 stretch 并缩到 fit-content**——实测该盒 `left=774, right=1031, width=257`（正好是 VersionWidget 193 + 左右 padding 32×2）。于是版本控件悬浮在页面水平中央，而页头/表格在 `280→1525`，右侧 500px 空白。`.shell__content`（`:120-123`）也没有 max-width/padding，和 header 不是同一套容器。
- **严重度**：高（全局视觉与交互锚点错位；且 `:69` 的注释说明这个盒子里本该放面包屑）
- **证据**：实测 `desktopHeader {left:774,right:1031,width:257}` vs `pageHead {left:280,right:1525}`；`shots/keys-列表-桌面.png` 中版本控件位于页面顶部中央
- **TUF 对应做法**：`components/ConsoleShell.vue:82-97` 只用 `.shell__context`（`margin:0 auto; padding:14px 32px 0; justify-content:flex-end`），且该元素是**有内容的 flex 行**，不存在「空盒子居中」；TUF 也没有第二个 header。

### 中（Medium）

#### D21 — 列表内唯一详情入口是「死点击」，且不可键盘到达
- **现象**：`KeysPage.vue:375` 的 `.cell-key-name` 写了 `@click="emit('select-key', row)"`，但**全仓库无人监听 `select-key`**（`defineEmits` 声明了 4 个事件，0 个监听者）。实测点击后 URL 与 DOM 均无变化 → 点击无反应。该 div 无 `role`、无 `tabindex`，`focus()` 不生效；行本身 `role=null, tabindex=null, cursor:auto`，也没有可点击样式。结果：**从列表打开一个 Key 的唯一途径是那个无 `aria-label` 的编辑图标按钮**。
- **严重度**：中→高（交互承诺落空 + 键盘用户几乎无法进入详情）
- **证据**：实测 `{"url":"…/keys","anyDialog":false}`（点击前后一致）、`{tag:"DIV",tabindex:null,role:null,isFocusable:false}`、行 `{role:null,tabindex:null,cursor:"auto"}`；`src/pages/KeysPage.vue:34-38,375`
- **TUF 对应做法**：`Applications.vue:92` 用 `@row-click` 让整行跳详情，`:95` 主标识用 `TxCellLink`（**真链接**，支持中键/新标签/键盘）；`pages/Overview.vue:95-96` 卡片同时绑 `@click` 与 `@keydown.enter`。

#### D22 — 各页 `defineEmits` 全部无人监听、`props` 全部无人提供（组件契约孤儿）
- **现象**：`router.ts:17-27` 直接挂载页面组件，不传 props、不接事件。于是：
  - `KeysPage` 的 `keys/groups/quotaTimeZone/gatewayModelAccess` 全部落到 `withDefaults` 默认值（**这正是 D14 时区谎报的机制**）；
  - `emit('refresh')`（`KeysPage.vue:141`）、`emit('notify')`、`emit('open-oauth')`（`ChannelsPage.vue:277`）、`emit('select-key')`（`:375`）全部是空操作；
  - 每个页面都被迫写了 `effectiveX = props.x ?? internalX` 双份状态（`KeysPage.vue:47-48`、`ChannelsPage.vue:40`），以及 `onMounted(() => { if (!props.x) reload() })` 分支。
- **影响**：页面看起来能用只是因为「props 永远为空 → 永远走 internal 分支」。这层双份状态是持续出 bug 的温床（D1 的形状错配、D14 的时区谎报都是它的直接后果），也让「组件复用」变成假的。
- **严重度**：中
- **证据**：`src/router.ts:17-27`；`src/pages/KeysPage.vue:19-38,47-48,141,311-315`；`src/pages/ChannelsPage.vue:18-33,40,257-261`
- **TUF 对应做法**：TUF 页面是**自取数据**（`useResource` 在页内调用接口），父级只通过路由 meta 与 `CapabilityGate` 干预（`components/ConsoleShell.vue:57-60`），不存在「props 永不传入」的双份状态。

#### D23 — 一次性密钥弹窗唯一出口是「复制密钥并关闭」，剪贴板失败即被困
- **现象**：`KeysPage.vue:731-746` 的 footer 只有一个按钮，内联 async 箭头先 `navigator.clipboard.writeText` 再关闭弹窗。若剪贴板写入抛错（非安全上下文、权限被拒、无剪贴板焦点），**弹窗不会关闭且无任何错误提示**；而同一弹窗的正文刚警告过「完整的 API Key 仅在此处展示一次，窗口关闭后将无法再次直接查看明文」。用户面临「复制不了 / 关了就没」两难。
- **严重度**：中（不可逆凭据丢失风险）
- **证据**：`src/pages/KeysPage.vue:720-747`（`:725` 警告文案、`:731-746` 唯一出口）
- **TUF 对应做法**：`lib/resource.ts:42-57` `useAction` 把「进行中/错误」标准化，配合 `lib/errors.ts` 给失败一个可读原因与下一步，而不是把成功路径当唯一路径。

#### D24 — OAuth 轮询无上限、无超时，错误被吞
- **现象**：`OAuthPage.vue:161-177` `setInterval` 每 3s 轮询一次，**没有最大次数或总超时**；`:174-176` `catch {}` 把网络/服务端错误静默跳过。于是「等待授权」状态可以无限期挂着，用户看不到「一直没成功」的判定，也不知道该怎么办（只能点「取消」）。
- **严重度**：中
- **证据**：`src/pages/OAuthPage.vue:161-177`（清理逻辑 `:233` 是有的，无泄漏）
- **TUF 对应做法**：`lib/errors.ts:52` 对 429 等给出「请稍等一分钟再试」这类明确下一步；错误一律经 `ErrorPanel` 呈现而非吞掉。

#### D25 — 表单校验只在提交时触发，错误落在表单底部而非字段旁
- **现象**：`saveKeyEditor`（`KeysPage.vue:207-215`）与 `submitCreateChannel`（`ChannelsPage.vue:218-230`）都是「点提交 → 顺序 if → 写单个 `editorError/createError` → return」，错误统一渲染在**表单最底部**（`KeysPage.vue:586`、`ChannelsPage.vue:… createError`）。字段本身没有 error 态、没有 `aria-describedby`/`aria-invalid`，用户需要自己往上找是哪个字段错了。
- **严重度**：中
- **证据**：`src/pages/KeysPage.vue:207-215,586`；`src/pages/ChannelsPage.vue:218-233`
- **TUF 对应做法**：TUF 用 `TxFormItem` 的字段级校验（`Applications.vue` 等同族页面均为 `TxFormItem label required` 结构），错误贴字段。

#### D26 — 同一类「重置额度」在 Monitor 有确认、在 Keys 没有
- **现象**：`MonitorPage.vue:250-258` 为「重置账号窗口配额」提供了完整确认框（含「将消耗 1 次主动重置额度…此操作不可逆」），而 `KeysPage` 的三种额度重置完全没有确认（D5）。同一个产品里对同一类不可逆操作给出两种人格。
- **严重度**：中（正是 D7「无统一原语」的可见后果）
- **证据**：`src/pages/MonitorPage.vue:250-258` vs `src/pages/KeysPage.vue:642-649`
- **TUF 对应做法**：集中式 `confirm()`（`lib/confirm.ts:12`）保证同类操作体验一致。

#### D27 — 渠道开关即时生效，无确认也无撤销提示
- **现象**：`ChannelsPage.vue:341-344` 的 `TxSwitch` 一拨即 PATCH `/api/channels/:name`，该渠道全部流量立刻受影响；成功只有 toast，无「撤销」入口。拨动一个直接停服生产渠道的开关，代价与一次点击不匹配。
- **严重度**：中
- **证据**：`src/pages/ChannelsPage.vue:105-117,341-344`
- **TUF 对应做法**：TUF 对影响面大的写操作先 `confirm(...)`，且操作结果通过资源重载反映（`useAction` + `reload`）。

#### D28 — 表格无语义：无 `role`、无 `aria-label`、表头无 `aria-sort`/`tabindex`
- **现象**：`<table>` 无 `role`/`aria-label`，`<th>` 无 `aria-sort`、无 `tabindex`（因为压根不支持排序，D12）。屏幕阅读器无法获知表格用途，也无法获知可排序列。
- **严重度**：中
- **证据**：实测 `{ariaSort:[null×7], tableRole:null, tableAriaLabel:null}`；`src/pages/KeysPage.vue:364-372`
- **TUF 对应做法**：TUF 用 `TxDataTable` 的同时给主标识 `TxCellLink`（真链接语义，`Applications.vue:95`），并在表格上给 `--table-min` 与 `aria-label` 类提示。

#### D29 — 迁移未收尾：`.tsx` 死树 + 7 个零调用 API + 测试只覆盖死树
- **现象**：
  1. `src/` 同时存在完整的两套实现（`App.tsx` + `main.tsx` + `pages/*.tsx` + `components/*.tsx`），活代码是 `.vue`；`.tsx` 无人引用（`docs.html` → `docs-entry.tsx` 除外）。
  2. `api.ts` 中 **7 个方法零调用**：`analytics`(`:19`)、`charts`(`:20`)、`chartsLatency`(`:21`)、`usagePage`(`:22`)、`usageKeySummaries`(`:23`)、`audit`(`:28`)、`cacheAnalytics`(`:64`)；另有一整组凭据方法（`:46-61`）无页面。
  3. **前端测试只读死树**：`server/reportPageFrontend.test.ts`、`server/analyticsNavigationFallback.test.ts` 读取的是 `src/App.tsx`、`src/pages/ChartsPage.tsx`、`src/pages/CachePage.tsx`、`src/pages/AnalyticsPage.tsx`；**引用 `.vue` 的断言数为 0**。
- **影响**：这正是 D1/D3 能长期存活的原因——`npm test` 绿灯，而它验证的是一个没人运行的页面。「完整 Tuffex 迁移」的验收信号是假的。
- **严重度**：中（工程风险，非直接交互缺陷）
- **复现**：`grep -rn "\.tsx'" server/*.test.ts` → 6 处；`grep -rn "\.vue'" server/*.test.ts` → 0 处；`grep -rn "api\.analytics\b" src --include=*.vue` → 0
- **证据**：`server/reportPageFrontend.test.ts:6,12,14,51-52,64`；`server/analyticsNavigationFallback.test.ts`；`src/api.ts:19-28,64`
- **TUF 对应做法**：TUF 的 `lib/nav.ts:1`、`lib/errors.ts:1`、`lib/format.ts:1` 注释都点明「纯函数 + 可被 tests 直接测」，把可测逻辑抽到 `lib/` 而不是塞在页面里——迁移时应把 `.vue` 页面的逻辑抽到 `src/lib/` 并让测试指向它。

#### D30 — 术语漂移
- **现象**：同一实体在不同位置叫法不同：
  - 渠道：侧栏「渠道账号」（`ConsoleNav.vue:30`）/ 页标题「渠道与服务网关」（`ChannelsPage.vue:270`）/ 表格列「渠道名称」（`:70`）/ `KeysPage` 正文却叫「中转站」（`KeysPage.vue:342`「模型调用通过中转站准入层统一受控」）；
  - 时间：`KeysPage.vue:327`「服务器时区」vs `:631`「服务器本地 00:00」；
  - 分组：「渠道分组」（`KeysPage.vue:326`）/「授权渠道分组」（`:115`）/「渠道组」（`:562`「选择允许此密钥使用的上游模型渠道组」）；
  - 模型映射：「模型列表」（`ChannelsPage.vue:72`）/「模型映射」（`:289`）/「服务渠道映射」（`ModelsPage` 表头）。
- **严重度**：中
- **证据**：上列 `path:line`
- **TUF 对应做法**：`lib/nav.ts:11-16` 把分组标签集中为 `NAV_GROUPS` 常量、`lib/statuses.ts` 集中状态文案，术语只有一处定义。

#### D31 — 危险确认框的按钮变体与文案不统一
- **现象**：Monitor 的重置确认里「取消」用 `variant="ghost"`（`MonitorPage.vue:255`），Keys/Channels 的删除确认里「取消」用 `variant="secondary"`（`KeysPage.vue:757`、`ChannelsPage.vue:480`）；确认文案分别为「确认删除」（Keys/Channels）与「继续」类隐含语义（Monitor 未显式给 `confirmText`）。同一产品里危险确认框长得不一样。
- **严重度**：中
- **证据**：`src/pages/MonitorPage.vue:250-258`；`src/pages/KeysPage.vue:750-761`；`src/pages/ChannelsPage.vue:473-484`
- **TUF 对应做法**：`components/ConfirmHost.vue:17-20` 统一次序（取消在前、`autofocus`）+ 统一危险色（`options.danger` 决定 `variant`）+ 统一 `confirmText`。

### 低（Low）

#### D32 — 侧栏当前项高亮在未知路径下静默兜底为「运行概览」
- **现象**：`ConsoleNav.vue:50-54` 用 `route.path` 去掉前导斜杠后与 `navEntries[].value` 字符串比较，匹配不到就返回 `'dashboard'`。当前所有路由恰好同名，所以看不出问题；但任何新增嵌套路由（例如 `/keys/:id` 若不是 `authored` 精确匹配）会**高亮错误的导航项**而不是不高亮。
- **严重度**：低（潜在，当前未触发）
- **证据**：`src/components/ConsoleNav.vue:50-54`
- **TUF 对应做法**：`lib/nav.ts:64-71` `activeNavId()` 用「最长前缀匹配 + `end` 精确匹配」的显式规则，并返回 `null` 表示无匹配，不做静默兜底；规则是纯函数可直接测。

---

## 5. 值得照搬的 TUF 交互模式（14 条）

每条给「参考文件:行」+「迁移到 `src/` 的最小形状」。

**M1｜全局唯一确认框 + `await confirm()`**
- 参考：`lib/confirm.ts:12-20`（`confirm()` 返回 Promise，`:14` 处理「上一个未答复按取消」）；`components/ConfirmHost.vue:13-23`（`:17` 焦点在取消，`:18` `danger` 控制危险色）；挂载点 `App.vue:9`。
- 最小迁移：新增 `src/lib/confirm.ts`（reactive 单例 + `confirm()`/`settleConfirm()`）与 `src/components/ConfirmHost.vue`；在 `src/App.vue` 的 `<TxToastHost>` 旁加 `<ConfirmHost />`。调用方约定：`if (!(await confirm({title, body, danger:true, confirmText:'删除'}))) return`。**先改 D5/D6 两处**（收益最大、改动最小）。

**M2｜`useResource`：加载/错误/旧数据保留/竞态丢弃**
- 参考：`lib/resource.ts:14-39`（`:23-33` seq 比对丢弃过期响应；`:28` 成功才写 data → 刷新时保留旧数据不闪空；`:36` `watch(deps, reload, {immediate:true})`）。
- 最小迁移：新增 `src/lib/resource.ts` 导出 `useResource/useAction`。页面写法固定为三段式：`<ErrorPanel v-if="r.error.value" :error=".." :retry="r.reload" />` → `<LoadingBlock v-else-if="!r.data.value" />` → `<TxCard v-else>`。**直接消灭 D2/D3 的成因**。

**M3｜`ErrorPanel`：把错误翻成「出什么事 + 下一步」**
- 参考：`components/ErrorPanel.vue:15,18-25,40-52`；错误字典 `lib/errors.ts:24-55`（401→重新登录、403→缺哪项能力、404/409/429/5xx 各自文案）；主按钮决策 `lib/errors.ts:62-65`。
- 最小迁移：新增 `src/lib/errors.ts`（`describeError/errorTrace/errorAction`，返回 `{kind,title,detail,code,status}`）+ `src/components/ErrorPanel.vue`（渲染 Tuffex `TxErrorState`/`TxPermissionState`，`:20-25` 逻辑照搬）。替代所有 `toast({title:'加载XX失败'})`。

**M4｜`LoadingBlock` 是受控骨架，不是「永久加载」**
- 参考：`components/LoadingBlock.vue:10-13`（`TxCard role="status" :aria-label` + `TxSkeleton`，行数由调用方按内容给）。
- 最小迁移：新增 `src/components/LoadingBlock.vue`；用法恒为 `v-else-if="!data"`（如 `Applications.vue:90`），保证「有数据就绝不显示骨架」，从结构上排除 D3。

**M5｜`PageHeader` 统一页头，含面包屑插槽**
- 参考：`components/PageHeader.vue:6,13-16,19-31`（`crumbs: {label,to}[]` 走 `router.push`，`#actions`/`#meta` 插槽）。
- 最小迁移：新增 `src/components/PageHeader.vue`（内部用 `TxBreadcrumb`，`props: {title, description, crumbs?}`）。把 `KeysPage.vue:321-335`、`ChannelsPage.vue:267-284` 等 10 处内联 `page-head` 换成 `<PageHeader>`；**顺手删掉 10 份重复 scoped CSS**（D17），并让 `ConsoleShell.vue:69` 那行注释变成真正的面包屑来源（D18）。

**M6｜筛选/搜索/分页写进 URL（`setQuery` + `router.replace`）**
- 参考：`pages/Applications.vue:31-33`（读 `route.query`）、`:44-48`（合并写回，不刷历史）、`:34-35`（本地 draft 与 URL 同步，避免每击键写 URL）、`:83`（chips 变更时同时清 `page`）、`:84-86`（`<form role="search">` + `TxSearchInput` 的 `@search`/`@clear`）。
- 最小迁移：新增 `src/lib/query.ts` 导出 `setQuery(route, router, next)`（照搬 `:44-48`）；`KeysPage` 把 `searchQuery/statusFilter` 换成 `computed(() => route.query.q/status)`，chips 与搜索框改为写 URL。**按 `Audit.vue:35,36,46` / `People.vue:52,58,62,63` 的形状抄**。

**M7｜依赖驱动的重取：URL 即状态源**
- 参考：`pages/Applications.vue:37-42`（`useResource(fetcher, [status, q, page])`）。
- 最小迁移：页面不再手写 `loadAnalytics()/reloadData()`，改为把 URL 派生的 computed 作为 deps 传给 `useResource`，加载与重取全自动（同时消掉 D22 里 `onMounted` 的 `if (!props.x)` 分支）。

**M8｜主标识用真链接（`TxCellLink`），整行可点**
- 参考：`pages/Applications.vue:92`（`@row-click`）、`:95`（`TxCellLink :href :label @open`）、`:63`（`detailHref` 生成真路由）。
- 最小迁移：给 Key/渠道加真实详情路由（如 `/keys/:id`），列表主标识换 `TxCellLink`、行加 `@row-click`。**直接修掉 D21 的死点击与键盘不可达**；`pages/Overview.vue:95-96`（`@click` + `@keydown.enter` 成对出现）是要照抄的「可键盘激活卡片」写法。

**M9｜空/长文本的截断与提示习惯**
- 参考：`pages/Applications.vue:100`（`:title` 提供完整值）、`:103`（`clamp-2 muted` 两行截断）、`:96`（`cell-sub` 次级信息）。
- 最小迁移：抽 `src/components/Ellipsis.vue` 或直接约定「所有可能溢出的单元格加 `:title` + CSS clamp」。当前 `KeysPage.vue:379-380`（maskedKey/note）、`ChannelsPage.vue:317`（baseUrl）都没这层保护。

**M10｜`lib/format.ts` 单点收口时间与数字（固定时区）**
- 参考：`lib/format.ts:1-4`（注释明确「不跟浏览器时区走」）、`:10-14` `fmtDate`、`:16-20` `fmtDay`、`:22-36` `fmtRelative`（含「刚刚/马上」与 ≥30 天退回日期）。
- 最小迁移：新增 `src/lib/format.ts`，导出 `fmtDateTime/fmtDay/fmtRelative/compactNumber/formatUsd/formatPercent`（**时区固定 `Asia/Shanghai`**）。把 6 套 compact、5 套金额、4 套百分比、6 套时间全部替换掉（D16 + D14），并删掉 `KeysPage.vue:29` 那个 `'UTC'` 默认值。

**M11｜能力/权限决定「可见/禁用+原因/隐藏」，而非全部隐藏**
- 参考：`lib/nav.ts:39-43`（`navState` 三态）、`:45-52`（`blockReason` + `BLOCK_REASON_TEXT` 中文原因）、`:57-61`（`visibleNav` 裁剪）；`components/CapabilityGate.vue` + `ConsoleShell.vue:57-60`（按路由 `meta.anyOf` 包一层）。
- 最小迁移：`ApiKeyItem`/渠道行上的操作按钮按后端返回的能力字段渲染为 `disabled` + `TxTooltip`（照抄 `Applications.vue:71-77`：无能力隐藏、mock 态用 `TxTooltip` 解释「开发预览不能导出，请连接本地后端」）。这解决「按钮点了才报 403」的体验，也让「为什么是灰的」有答案。

**M12｜可访问名与可见文案一致**
- 参考（**正面**）：`components/ConsoleNav.vue:102` 装饰图标 `aria-hidden="true"`；`pages/Applications.vue:75-76` 链接内按钮 `tabindex="-1"` 避免重复焦点；`components/LoadingBlock.vue:10` `role="status" :aria-label`。
- 参考（**要修正**）：`ConsoleShell.vue:39` 的 `aria-label="打开导航"` + 可见文本「菜单」是我们 D10 的同款问题——迁移时应让 `aria-label` 以可见文本开头（如 `"菜单：打开导航"`）或直接不设。
- 最小迁移：约定「图标按钮必须 `aria-label`，且若同时有可见文本则 `aria-label` 必须包含该文本」；给 `KeysPage.vue:495-522`、`ChannelsPage.vue:350-363` 的 6+ 个图标按钮补 `aria-label`（D11）。

**M13｜图标一律走 Carbon 矢量，无 emoji**
- 参考：`components/ConsoleNav.vue:102` 用 `i-carbon-*` + `aria-hidden`；`lib/icons.ts` 集中图标名。
- 最小迁移：已有 `src/lib/icons.ts`，应把散落在页面里的图标字符串常量集中过去（`KeysPage.vue:331,499,506,513,520`、`ChannelsPage.vue:274,277,280,353,360`），避免拼错类名导致图标静默丢失。

**M14｜可测逻辑放 `lib/`，页面只做拼装**
- 参考：`lib/nav.ts:1`、`lib/errors.ts:1`、`lib/format.ts:1` 的注释都写明「纯函数，tests 直接测」；`lib/nav.ts:64-71`/`lib/errors.ts:24-55` 是典型纯函数。
- 最小迁移：把 `KeysPage.vue:92-110`（筛选）、`:124-132`（重置时间格式化）、`AnalyticsPage.vue:64-74`（指标推导）搬到 `src/lib/`，并补 `.vue` 侧测试。**这是修 D29「测试只覆盖死树」的最小可行路径**：先让新逻辑落在有测试的 `lib/` 里，页面变薄。

---

## 6. 未验证项（不确定，不猜）

1. **Monitor 重置额度的确认流程未能走通**：当前 `/api/monitor` 无上游账号，页面显示空态「暂未接入上游监控账号」，`MonitorPage.vue:250-258` 的确认框无法在真实数据下触发。其行为仅作静态判断。
2. **所有破坏性操作的最终提交未执行**：删除 Key、删除渠道、剪枝 stale 渠道、重置额度、切换渠道开关**均只观察到触发点，未点击确认**，以免改动生产数据。因此「失败后是否可恢复/是否有回滚」只按代码（toast + `reloadData()`）推断，未实测。
3. **`RequestDetail` 弹窗的下钻路径未实测**：因 D1 导致 `/analytics` 明细表为空，无行可点。其 Escape/焦点行为未验证。
4. **对比度未量化**：未用工具测量色值对比度，因此本报告**不包含对比度结论**（避免无依据断言）。
5. **屏幕阅读器实际播报未验证**：无辅助技术可用；`aria-*` 相关结论均来自 DOM 属性检查，未验证 AT 的实际播报顺序与内容。
6. **键盘 Tab 全序未逐页穷举**：只做了「77 个可聚焦元素中 76 个有可见焦点环」的抽样（`INPUT.tx-input__inner` 依赖外层容器焦点样式），未验证完整 Tab 顺序与跳焦。
7. **仅测了 ego-lite Chromium**：Firefox / Safari（尤其 iOS Safari 的 `clipboard`、`position:sticky`、`100vh`）未验证。
8. **CachePage SSE 断线重连行为未验证**：`CachePage.vue:129` 的 `error` 回调只置 `sseConnected=false`，未验证是否自动重连、断线时表格是否停更且用户是否知情。
9. **OAuth 真实授权回路未验证**：需要真实第三方账号与被禁的凭据操作，未执行。
10. **`/audit` 与凭据管理无页面**：`api.audit`(`api.ts:28`)、`api.uploadCredentials`(`:50`) 等无路由，属 D29 范畴，无 UI 可测。
11. **D4 的修复方案未验证**：本报告只证明现状塌陷与 TUF 的 `--table-min` 用法差异，**未实际改样式验证修复有效**（red team 不改产品代码）。

---

## 7. 附录

### 7.1 复现关键命令
```bash
# 活代码是 .vue 树（.tsx 是死树）
curl -s http://127.0.0.1:8791/ | grep -o 'src="[^"]*"'        # → /src/main.ts（源码）或 /assets/console-*.js（dist）
grep -rn "route.query" src --include=*.vue                      # → 0 命中（D13）
grep -rn "\.tsx'" server/*.test.ts | wc -l                      # → 6（D29）
grep -rn "\.vue'" server/*.test.ts | wc -l                      # → 0（D29）
grep -rniE "sortable|pagination|selectedRows|resizable|aria-sort" src --include=*.vue   # → 无排序/分页/批量/列控（D12）
wc -l src/pages/ChartsPage.vue                                  # → 18（D3）
```

### 7.2 截图清单（`docs/qa/red-team/shots/`，22 张）
| 文件 | 对应缺陷 |
|---|---|
| `login-登录页-桌面.png` | 登录表单无 `label` 关联（§3 可访问性） |
| `dashboard-概览-桌面.png` | D19（版本控件）、D20（头部错位） |
| `keys-列表-桌面.png` / `keys-列表-移动端.png` | D4（列宽塌陷） |
| `keys-筛选后-桌面.png` | D13（URL 不保存） |
| `keys-创建弹窗-桌面.png` / `keys-编辑弹窗-桌面.png` | D9（焦点不入弹窗） |
| `keys-删除确认-桌面.png` | D8（Modal 套 Modal） |
| `keys-额度弹窗-重置无确认-桌面.png` | D5、D26 |
| `keys-接口失败-桌面.png` / `keys-接口失败-toast消失后-桌面.png` | D2（故障=空数据且无痕） |
| `keys-移动端导航抽屉.png` | §3 响应式（抽屉正常） |
| `channels-列表-桌面.png` | D6（剪枝按钮）、D27 |
| `models-列表-桌面.png` | D12（527 行无分页/排序） |
| `oauth-登录池-桌面.png` | D24 |
| `charts-永久加载中-桌面.png` | D3 |
| `analytics-请求明细-桌面.png` / `analytics-零数据但真实错误率41.6%-桌面.png` | D1、D15 |
| `usage-统计-桌面.png` / `cache-缓存-桌面.png` | D16（格式不一致） |
| `monitor-账号监控-桌面.png` | D26、§6 未验证项 1 |
| `help-帮助-桌面.png` | 参考 |

### 7.3 一句话总评
用户说「UI 交互非常反人类，完全没有借鉴 TUF 里比较合理的交互逻辑」——**本次取证的结论是成立的，而且有比「不好看」严重得多的问题**：TUF 的六个交互原语（`PageHeader` / `ErrorPanel` / `LoadingBlock` / `ConfirmHost`+`confirm` / `useResource` / `lib/format`）在本仓库 `src/` 下**一个都没有对应物**，代价不是「不够精致」，而是**观测页会撒谎（D1）、故障会伪装成空数据（D2）、删库级操作一键执行（D5/D6）、移动端主列表不可读（D4）**。好消息是：**设计系统（Tuffex）本身能力足够**（`TxFilterChips` 的 `aria-pressed`/roving tabindex、76/77 元素的可见焦点环、`TxEmptyState`/`TxErrorState`/`TxSkeleton` 都现成），缺的只是一层薄薄的 `src/lib/` + `src/components/` 共享原语。按 M1→M2→M3→M10→M6 的顺序迁移，可以在很小的改动面内消掉 Top 10 里的 7 条。
