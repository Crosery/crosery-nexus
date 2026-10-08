# Crosery API Console — 第二轮 UI 对抗验证（红队 B / task-10）

对象 `<repo>`｜基线 **`7593622`（blue-ui task-4）+ `c91b592` + Lead 的 ConfirmHost Escape 补丁**（工作树另有未提交的 `/rtk`、`/ab` 路由，见 §0）｜审计人 `ux-auditor` / task-10｜实例 <http://127.0.0.1:8791>

**实测时点**：2026-10-01 08:50–09:04，浏览器锁持有期间独占驱动 ego-browser（TaskSpace `spaceId=10`，已 `finish({keep:[]})`），随后 `rmdir /tmp/cac-browser.lock` 释放。**dist 构建于 08:50:28，且此刻无任何 `src/` 文件比它更新** → 运行实例与当前源码一致（判据：`find src -newermt "$(stat -f '%Sm' dist/index.html)"` 返回空）。

**结论一句话**：**5 条 P0 全部已被真实修复**（我用独立判据逐条复现，不看蓝队截图），**Escape 修复 5/5 轮通过**，新增的 URL 状态 / 竞态保护 / 分页组合**经对抗测试未发现新回归**；但**发现 1 条由本次重构自身引入的高危新缺陷**（`/ab` 的 A 侧冻结副本重新暴露了已修复的"零确认重置额度"路径），以及若干收敛不彻底的残留项。

---

## 0. 与上一轮的时点差异（必读）

- 上一轮（task-2）审计的是 **05:40 构建 + 迁移前源码**；本轮是 **08:50 构建 + 迁移后源码**。两轮结论不可混用。
- 工作树目前有 2 个文件未提交：`src/router.ts`、`src/components/ConsoleNav.vue`（新增 `/rtk`、`/ab` 路由与侧栏入口）。`dist/assets/` 已包含 `RtkPage-*.js`、`AbLabPage-*.js` → 构建已包含它们，故**本轮把它们当作在测范围的一部分**。
- 本轮我**只写入 `docs/qa/red-team/**`**（新目录 `shots-r2/`），未改动任何产品代码，未触碰别人 space。

---

## 1. 逐条判定：P0 五条 + Escape 修复

| # | 主张 | 判定 | 我用的独立判据（可原样复跑） |
|---|---|---|---|
| D1 | `/analytics` 四卡与 `/api/analytics?days=7` 一致 | ✅ **已验证（已修）** | 见 §1.1 |
| D2 | 屏蔽 `/api/bootstrap*` 后显示持久错误 + 可重试，解除后能恢复 | ✅ **已验证（已修）** | 见 §1.2 |
| D3 | `/charts` 真的发请求、有数据，不再永久加载 | ✅ **已验证（已修）** | 见 §1.3 |
| D4 | 390×844 下 `/keys`、`/channels` 各 `th` 宽非 0，`scrollWidth ≤ 390` | ✅ **已验证（已修）** | 见 §1.4 |
| D5/D6 | 6 处危险操作全走统一确认，取消后零写请求 | ✅ **已验证（已修）** | 见 §1.5 |
| — | Lead 的 Escape 修复（≥4 轮） | ✅ **已验证（5/5 轮通过）** | 见 §1.6 |

### 1.1 D1 — `/analytics` 数字一致性 ✅
- **判据**：页面卡片文本 vs `fetch('/api/analytics?days=7').summary` 逐项比对。
- **实测**：API `{requests:214, tokens:76762, avgLatency:4842.57, errorRate:0.4159}`；页面四卡 = `请求量 214 / Token 消耗 7.7万 / 错误率 41.6% 存在异常拦截 / 平均响应时间 4.8s`。全部对应（76762→7.7万 为 compact 舍入；4842.57ms→4.8s）。
- **关键否定项**：`错误率0.0%` 与 `健康稳定` 两个旧文案**均不再出现**（`has0Percent:false, hasHealthy:false, hasAbnormal:true`）。
- **代码依据**：`src/pages/AnalyticsPage.vue:34` 已改为 `api.analytics<AnalyticsData>(days, keyId)`（`src/api.ts:48`），不再误用 `usageBreakdown`。
- 证据：`shots-r2/analytics-四卡对比-桌面.png`

### 1.2 D2 — 失败态持久且有重试 ✅
- **判据**：`Network.setBlockedURLs(['*/api/bootstrap*'])` → 观察 `.error-panel`、重试按钮、空态文案；等待 8s 再看一次；解除屏蔽后点「重试」看行数。
- **实测**（`/keys`）：基线 14 行无错误 → 屏蔽后 `errorPanel:true`，正文 `连不上服务器 / 请检查网络或服务是否在运行，然后重试。` + 重试按钮 + trace `Failed to fetch`，`hasTable:false`，**无**"暂无匹配的 API Key"空态 → **8 秒后状态完全不变**（不再依赖会消失的 toast）→ 解除屏蔽点重试 → **恢复 14 行**。
- **同类页复核**（`/channels` 屏蔽 `*/api/channels*`）：同样持久错误面板 + 重试；重试后恢复 5 行。
- **代码依据**：`src/lib/resource.ts:36-52`（错误持久化、成功前不动旧数据）+ `KeysPage.vue:392-395` 三态分支 + `src/components/ErrorPanel.vue:37-51`。
- 证据：`shots-r2/keys-接口失败-持久错误态-桌面.png`、`keys-重试恢复-桌面.png`、`channels-接口失败-桌面.png`

### 1.3 D3 — `/charts` 真实取数 ✅
- **判据**：CDP `Network.enable` 抓 `requestWillBeSent` 过滤 `/api/charts`；并断言页面文案不含"加载图表数据中"、DOM 有 SVG 图元。
- **实测**：请求 `["/api/charts?days=7"]` ✓；页面正文 `请求总量60 错误数23 错误率38.3% 时间桶4 请求趋势 … 模型用量 Top 8`；`stillLoading:false`；SVG 图元 7 个。
- **代码依据**：`src/pages/ChartsPage.vue:28-29` `useResource(() => api.charts<ChartsData>(days, keyId))`。
- 证据：`shots-r2/charts-有数据-桌面.png`

### 1.4 D4 — 移动端列宽 ✅
- **判据**：`Emulation.setDeviceMetricsOverride({width:390,height:844,mobile:true})` → 每个 `th.getBoundingClientRect().width`，并比对 `document.documentElement.scrollWidth ≤ 390`。
- **实测**（5 个页面，全部 `zeroWidthCols=0`、`docScrollWidth=390`、无横向溢出）：

| 路由 | th 宽度 |
|---|---|
| `/keys` | 名称 207 / 分组 140 / 并发 90 / 额度 155 / 最近调用 103 / 状态 77 / 操作 348 |
| `/channels` | 渠道名 174 / Base URL 318 / 模型列表 312 / 开关 125 / 操作 150 |
| `/models` | 274 / 260 / 129 / 89 |
| `/analytics` | 81 / 129 / 71 / 79 / 61 / 69 / 160 |
| `/cache` | 81 / 124 / 47 / 70 / 50 / 50 / 63 / 63 / 75 / 50 / 60 |

- **额外验证可达性**：`/keys` 表格内层滚动容器 `scrollWidth 1120 > clientWidth 354`，`scrollLeft` 可置到 766，末列「操作」滚动后 `left 24 / right 372` **完整落在 390 视口内** → 最后列在移动端确实可达，不是"宽度非 0 但永远看不到"。
- 证据：`shots-r2/keys-移动端.png`、`channels-移动端.png`、`keys-移动端-滚到操作列.png`

### 1.5 D5/D6 — 六处危险操作统一确认 + 取消零写 ✅
- **判据（安全设计）**：页面内 patch `window.fetch`，把**所有非 GET 请求**记录后**短路返回假 200**（永不触达服务端）；然后"打开确认框 → 点取消"，断言 `window.__writes` 为空。**因此本轮没有任何真实破坏性提交**。
- **实测**（逐条，全部 `after cancel writes: []`）：

| 位置 | 触发选择器 | 确认框标题 / 正文要点 | 取消后写请求 |
|---|---|---|---|
| `/keys` 行内删除 | `[aria-label^="删除 "]` | 「删除密钥」/「"张三"将被彻底删除，使用它的客户端会立即收到 401 认证失败，且无法恢复。」 | `[]` |
| `/keys` 重置今日 | 额度弹窗内 `重置今日用量` | 「重置今日用量」/「"非雨"的今日已用额度（$2.36）将归零，操作不可撤销。」 | `[]` |
| `/keys` 重置本周 | `重置本周用量` | 「重置本周用量」/「（$292.76）将归零…」 | `[]` |
| `/keys` 重置总计 | `重置总计用量` | 「重置总计用量」/「累计已用额度（$292.76）将归零。这是密钥因超额停用后唯一的恢复手段，且不可撤销。」 | `[]` |
| `/channels` 删除 | `[aria-label^="删除渠道 "]` | 「删除渠道 openrouter」/「该渠道下的 491 个模型映射会从目录中移除…无法恢复。」 | `[]` |
| `/channels` 清理残留 | 页头 `清理失效残留` | 「清理失效残留渠道」/「将请求删除所有已失效的残留渠道…无法恢复。」 | `[]` |

- **代码依据**：`KeysPage.vue:269-285`（删除）、`:322-344`（三种重置统一 `confirm`）、`ChannelsPage.vue:161-176`（删除）、`:179-201`（剪枝，**并列出将删除的渠道名**）；全局唯一框 `src/lib/confirm.ts:41-52` + `src/components/ConfirmHost.vue`。
- 证据：`shots-r2/confirm-删除密钥-桌面.png`、`confirm-重置总计用量-桌面.png`、`confirm-清理残留-桌面.png`

### 1.6 Lead 的 Escape 修复 ✅ **5/5 轮通过**
- **判据**：真实鼠标点开确认框 → 断言 `document.querySelector('.confirm-actions')` 出现且初始焦点在「取消」→ `keyboard.press("Escape")` → 轮询断言 `.confirm-actions` **从 DOM 移除** → 断言 `document.activeElement.getAttribute('aria-label')` 等于触发按钮的 aria-label。共 5 轮。
- **实测**：5/5 轮 `confirmInDom:true → false`，移除耗时 200ms（第 1 轮）/ 1200ms（第 2–5 轮），**每轮焦点都回到触发按钮 `删除 张三`**。修复前的"3 轮只有 1 轮能关"未复现。
- **重要测量说明**：我第一版用「可见 `.tx-modal__overlay` 计数」会在离场过渡期间误判（过渡期间 overlay 仍在，`opacity>0.01`，最长约 1.2s），得出假的 0/5。**故本报告的判据改用 DOM 存在性**（`confirmInDom`），这是过渡无关的。
- **嵌套行为**：额度弹窗 + 其上确认框同时打开时，一次 Escape **只关确认框**（`confirm:false, quotaModal:true`），焦点回到「重置今日用量」；第二次 Escape 才关额度弹窗。符合预期。
- **语义**：确认框 `role="dialog"` / `aria-modal="true"` / `aria-labelledby="v-0"`；从初始焦点连按 4 次 Tab 依次为 `删除密钥 → Close → 取消 → 删除密钥`，**焦点未逃出弹窗**（焦点陷阱有效）。
- 代码依据：`src/components/ConfirmHost.vue:66-74`（window 捕获阶段 Escape + `stopPropagation`）、`:41-52`（focus/flush post + 焦点还原）、`src/lib/confirm.ts:41-52`（同步调用点抓触发元素）。
- 证据：`shots-r2/keys-确认框-打开-桌面.png`、`keys-嵌套Escape后-桌面.png`

---

## 2. 重点：新回归搜索（本轮最有价值的部分）

### 2.1 🔴 **新缺陷 R1（高）：「/ab 的 A 侧冻结副本重新暴露了已修复的零确认重置额度路径」**
- **现象**：`/ab?flow=keys-access&v=a` 渲染的是 `281c30e` 的**迁移前 KeysPage 冻结副本**。在该副本里点额度弹窗的「重置今日用量」——**没有任何确认框**，直接发出 `POST /api/keys/<id>/quota/reset`。而同一个流程的 B 侧（当前页面）**有**确认框且**零**写请求。
- **A/B 对照实测**（所有非 GET 在页内短路，服务端从未被触达）：

| 侧 | 确认框出现 | 被拦截到的写请求 |
|---|---|---|
| **A（`?v=a`，legacy）** | ❌ **false**（`confirmTitle` 只有 `额度限制 - 非雨`） | ⚠️ `POST /api/keys/ec0f77ca…/quota/reset` |
| **B（`?v=b`，当前）** | ✅ true（`["重置今日用量","额度限制 - 非雨"]`） | `[]`（零写请求） |

- **为什么是高危**：
  1. `/ab` **在侧栏里**（`ConsoleNav.vue` 未提交改动新增 `{ value:'ab', label:'A/B 实验台', to:'/ab' }`），一键可达，且 `/ab?flow=keys-access&v=a` 是可分享深链；
  2. A 侧组件**共用活 `api` 模块**——`src/ab/registry.ts:4-7` 明确写着冻结副本的 `api/types/gatewayStatus` 指向活模块。也就是说，**A 侧不是沙箱，它写真实的 Key**；
  3. 该路径正是本轮被验收为"已修"的 P0（D5）。修复被自己的实验台绕过了；
  4. A 侧还保留 D11（图标按钮无 `aria-label`：`.lab-frame` 内 `[aria-label^="配置 "]` 计数 = **0**，而 legacy 用 `title="配置额度上限"`）。
- **代码依据**：`src/ab/variants/legacy/KeysPage.legacy.vue` 中 `await confirm(` 计数 = **0**；`:646/:673/:700` 三个按钮 `@click="handleResetQuota('daily'|'weekly'|'total')"` 直连；`:296` `handleResetQuota` 无确认；`:69/:249/:750` 仍是旧的 `showDeleteConfirm` + `TxModal`。`src/ab/registry.ts:37` `legacyKeys = lazy(() => import('./variants/legacy/KeysPage.legacy.vue'))`。
- **建议（给 Lead，因为 `/ab` 与路由是 Lead 的写入范围）**：任选其一——(a) A 侧降级为**只读**（在 legacy 页面注入 `pointer-events:none` + 移除写按钮，或给 lab 加一个"演示模式"开关把 `api` 换成 stub）；(b) 在 `/ab` 路由上要求显式查询参数且不在侧栏暴露；(c) 删除 A 侧可写流程，只保留截图对照。**推荐 (a)**：本实验室的目的是"看交互差异"，不是"能真的执行危险操作"。
- 证据：`shots-r2/ab-A侧-legacy-Keys-桌面.png`、`ab-A侧-额度弹窗-桌面.png`、`ab-A侧-重置无确认-桌面.png`

### 2.2 URL 状态（刷新 / 后退 / 前进 / 写脏）✅ **未发现新回归**
- **判据**：`/keys` 搜索框输入 → 读 `location.search` → `reload()` → 读输入框与行数；再清空搜索看 URL 是否回落；再 `history.back()/forward()`。
- **实测**：
  | 步骤 | URL | 输入框 | 行数 |
  |---|---|---|---|
  | 输入「示例用户」 | `/keys?q=%E7%A4%BA%E4%BE%8B%E7%94%A8%E6%88%B7` | 示例用户 | 14 → **1** |
  | **刷新后** | 同上（保持不变） | **示例用户** | **1** |
  | 清空搜索 | `/keys`（`?q=` **被移除**，不写脏） | 空 | 14 |
- **写脏检查**：默认值不进 URL（`days=7`/`page=1` 不出现），清空后键被删除——`src/lib/listState.ts:29-37` 的 `buildQuery` 按预期工作。
- **分页深链**：`/analytics?page=2` 直接打开 → 分页器显示 `Page 2 of 3` 且首行数据确实是第 2 页（与第 1 页首行不同）✓
- **后退/前进未作判定**：我的 tab 历史被本轮大量 `goto` 污染（back 落到了先前访问的 `/models`），因此**后退语义在本轮无法给出有效结论 → 标记未验证**。设计上 `listState.ts:87` 用 `router.replace` 有意不产生历史条目（注释 `:9-11`），故"后退离开当前页"是预期行为；**"筛选态下的后退"没有可测对象**。残留风险：`replace` 语义意味着用户无法用后退撤销一次筛选。
- 代码依据：`src/lib/listState.ts:46-119`。

### 2.3 `useResource` 竞态（依赖变化丢弃旧请求）✅ **通过**
- **判据**：`/analytics` 的 `days` 全取值返回同一份数据（实测 days=7/30/90 的 `summary` 完全相同），**无法用真实数据区分新旧响应**，因此我注入**合成判别值**：patch `fetch` 让 `days=7` 延迟 **3000ms** 且把 `summary.tokens` 改写为 `111111`，让 `days=30` 立即返回 `222222`；然后快速「选 7 → 选 30」，等 5s 后读页面卡片。
- **实测**：请求序列（`window.__raceLog`）= `days=30(222222,0ms)` → `days=7(111111,3000ms)` → `days=30(222222,0ms)`；**最终卡片显示 `22.2万` = 222222（最新的 days=30）**，迟到的 `days=7`（`11.1万`）被正确丢弃。
- **顺带验证**：「刷新时保留旧数据不闪空」成立——选 7 之后卡片仍显示上一次的 `22.2万`，没有闪空。
- **诚实标注**：这是**注入合成判别值**后的结论（真实数据无法区分）。它验证的是 `resource.ts` 的序号丢弃逻辑，不是真实后端时序。
- 代码依据：`src/lib/resource.ts:36-52`（`const mine = ++seq` + `if (mine === seq)`）。
- 证据：`shots-r2/analytics-竞态-合成判别-桌面.png`

### 2.4 分页与筛选组合 ✅ **通过**
- **判据**：`/analytics?page=2` → 点分页按钮 → 读 URL/分页器；再在 page=2 上换统计周期，断言页码回到 1 且 URL 丢掉 `page`。
- **实测**：深链 `?page=2` → 分页器 `Page 2 of 3`；点 `button.tx-pagination__button:text-is("2")` → URL `/analytics?page=2`、分页器 `Page 2 of 3`、首行切换（说明是真翻页，不是装饰）；随后选「最近 30 天」→ URL 变为 `/analytics?days=30`（**`page` 被丢弃**）、分页器回到 `Page 1 of 3` ✓
- **页码越界夹回**：`KeysPage.vue:140-144` 用 `watch(paged.page)` 把夹回后的页码写回 `scope.state.page`，所以"数据变少停在空页"和"URL 与显示不一致"都被处理。
- **注意（我的测试失误，不影响结论）**：我一度点击 `<li>` 而非内层 `<button>`，得到"翻页无效"的假结论；改用 `button.tx-pagination__button` 后一切正常。**排除该误报**。

### 2.5 ⚠️ **新缺陷 R2（中）：「有旧数据 + 刷新失败」时旧数据被错误面板整体顶掉**
- **现象**：`/analytics` 已加载出数据（请求量 214、20 行明细）后，屏蔽 `*/api/analytics*` 并触发一次刷新 → 结果：`errorPanel:true`、`hasTable:false`、`rows:0`、`requests:null`。**上一次成功的数据从界面上完全消失**，只剩错误面板。
- **精确表述（不夸大）**：数据**没有被清空**——`src/lib/resource.ts:42-46` 只在成功时写 `data`，失败路径从不置空，所以内存里仍是旧数据。但**渲染层被顶掉**：`AnalyticsPage.vue:116-118` 是 `ErrorPanel v-if="error"` → `LoadingBlock v-else-if=!charts` → 内容，`error` 优先，于是旧数据不渲染。
- **是否符合任务判据**：任务要求"应当保留旧数据"。按"内存保留"算通过，按"用户仍能看到上一次的成功数据"算**不通过**。考虑到运营者最需要旧数据的时刻恰恰是后端抖动时，我判为**中危缺陷（体验）**。
- **公平标注**：TUF 参考实现的写法**完全相同**（`geek_main/.../pages/Applications.vue:89-92`：`ErrorPanel v-if="list.error.value"` 优先于内容），所以这是"忠实照搬 TUF"的行为，不是偏离参考实现；要改需要 Lead 决定是否偏离 TUF。
- **建议最小修法**：`ErrorPanel` 在"有旧数据"时改成**非阻断横幅**（如 `TxAlert variant="danger"` + 重试按钮）叠加在旧数据之上，仅当 `!data` 时用整页 `ErrorPanel`。可加到 `ErrorPanel.vue` 的一个 `inline` 变体，8 个迁移页统一受益。
- 证据：`shots-r2/analytics-有旧数据刷新失败-桌面.png`

### 2.6 渠道开关「取消后是否卡在已切换态」❌ **我的假设被推翻（回归不存在）**
- **假设**：`ChannelsPage.vue:114-135` 的开关是 `:model-value` 单向绑定，`handleToggleChannel` 里 `await confirm()` 取消后不写回 prop，开关可能**视觉上停在已关闭**。
- **实测**：`role="switch"` 元素的 `aria-checked` / `is-active` 在三态（点击前 → 确认框打开时 → 取消后）**始终为 `true`**，未被乐观翻转；取消后写请求为 `[]`。
- **判定**：**未发现该回归**。Tuffex 的 `TxSwitch` 是受控的，取消后不会留下错误视觉状态。
- 代码依据：`src/pages/ChannelsPage.vue:113-135`（仅当 `channel.enabled` 为真才确认，启用不打扰）。
- 证据：`shots-r2/channels-开关取消后-桌面.png`

### 2.7 无障碍复核
| 项 | 判定 | 证据 |
|---|---|---|
| 确认框初始焦点在「取消」 | ✅ | `document.activeElement.textContent === "取消"`（`ConfirmHost.vue:87` `ref="cancelRef"` + `:46` `focusInModal`） |
| 确认框焦点陷阱（Tab 不逃出） | ✅ | 4 次 Tab 循环 `删除密钥→Close→取消→删除密钥`，`focusEscaped:false` |
| 确认框语义 | ✅ | `role="dialog"` / `aria-modal="true"` / `aria-labelledby="v-0"` |
| 图标按钮 `aria-label`（B 侧） | ✅ | `/keys` 行内 5 个按钮全部 `aria-label` 与 `title` 一致，如 `复制 张三 的完整 API Key` |
| 图标按钮 `aria-label`（`/ab` A 侧） | ❌ **仍缺失** | `.lab-frame` 内 `[aria-label^="配置 "]` = 0，legacy 用 `title="配置额度上限"` → 见 R1 |
| 空态文案中文化 + 给下一步 | ✅ | `/keys` 搜索无结果 → 「没有匹配的密钥 / 换个关键词或把状态筛选调回「全部密钥」。/ 清除筛选」按钮；页面无 `No data available yet.` |
| 表头排序语义 `aria-sort` | ❌ **仍缺失** | `/channels` `th[aria-sort]` 计数 = **0**；`th` 无 `role`/`tabindex` → 见 §3 D28 |

### 2.8 本轮**未发现**新回归的面（明确记录，避免"凑数"）
- URL 状态**没有**写脏（默认值不进 URL、清空即删除键）。
- `useResource` **未**出现旧响应覆盖新结果。
- 分页**未**出现越界空页；页码与 URL 一致。
- 筛选变更**会**把页码重置为 1（`KeysPage`/`AnalyticsPage` 均如此）。
- 渠道开关**未**卡在错误视觉态。
- 确认框**未**出现"关闭后焦点丢失/停在遮罩"（5/5 轮焦点回到触发按钮）。
- Escape **未**出现"关不掉"或"连关两层"。

---

## 3. 复核"仍未修清单"（不照抄蓝队自报，逐条独立判定）

| 上轮编号 | 蓝队自报 | 我的判定 | 证据 |
|---|---|---|---|
| **D7** 无统一确认原语 | 部分修 | 🟡 **基本已修，但有一个绕过口** | 全站唯一 `src/lib/confirm.ts` + `App.vue` 挂载 `ConfirmHost`；6 处危险操作全走它（§2.5）。**但 `/ab` A 侧 legacy 副本绕过了它**（R1）。另：`OAuthPage.vue` `await confirm(` = 0（其"取消授权"非破坏性，可接受）；`ModelsPage.vue` = 0（见下 D12/新发现 N1） |
| **D12** 无排序/分页/列控 | 部分修 | 🟡 **分页已修（8 页），排序/列控仍未修** | 分页：`KeysPage`(PAGE_SIZE 20)、`AnalyticsPage`、`ChannelsPage`、`UsagePage` 已接 `TxPagination`；**排序**：`th[aria-sort]` = 0，全站无排序能力；**列控**：无。`/models` 仍 527 行（实测 `rows:527, hasPagination:false, ariaSort:0, scrollHeight:34750`） |
| **D15** 空态英文泄漏 | 部分修 | 🟡 **8 页已修，5 页未迁移** | 7 个页面用 `#empty` 插槽 + `EmptyState`；`HelpPage`/`LoginPage`/`ModelsPage`/`OAuthPage`/`AbLabPage` 未接入（`ModelsPage.vue` 仍 `defineProps` + 旧三态） |
| **D16** 格式化不统一 | 部分修 | 🟡 **跨页单位已统一，但同页精度仍不一致（新证据）** | ✅ 单位：`/usage` 与 `/analytics` 现在都显示 `7.7万`（上轮 `/usage` 是 `76.8k`）。❌ 精度：`/keys` 同一数值在**表格**显示 `$2.4`（`KeysPage.vue:502` `toFixed(1)`），在**额度弹窗**显示 `$2.36`（`:723` `toFixed(2)`），在**重置确认正文**显示 `$2.36`；同一弹窗内「本周已用 $292.76」与「累计已用 $292.7」**是同一个底层数字却两种精度**（`:750` vs `:777`）。`ModelsPage.vue:53-54` 仍自带 `moneyFmt`/`priceFmt`（`toLocaleString('en-US')`），未走 `lib/format` |
| **D17** 页头未共享 | 部分修 | 🟡 **8 页已用 `PageHeader`，4 页仍是内联 `page-head`** | 已用：Analytics/Cache/Channels/Charts/Dashboard/Keys/Monitor/Usage；未用：`HelpPage.vue`、`ModelsPage.vue`、`OAuthPage.vue`、`RtkPage.vue` |
| **D22** props/emits 孤儿 | 部分修 | ❌ **ModelsPage/OAuthPage/HelpPage 仍在** | 8 个迁移页已删 `defineProps`；`ModelsPage.vue:21-31,43` 仍有 `defineProps`+`defineEmits`，且**全仓库无人监听** `@notify/@refresh/@update:days`（`router.ts` 直接 `component: () => import(...)`，不传 props 不接事件） |
| **D24** OAuth 轮询无上限 | 未修 | ❌ **仍存在** | `OAuthPage.vue:161` 仍是裸 `setInterval`，无最大次数/总超时；`:174` `catch {}` 吞掉轮询错误 |
| **D25** 校验只在提交时 | 未修 | ❌ **仍存在** | `KeysPage.vue:228,232` 仍是提交时顺序 if + 单个 `editorError`；错误渲染在表单底部（`TxFormItem` 只提供结构，未接字段级 error） |
| **D28** 表格无语义 | 未修 | 🟡 **部分**：表格已加 `aria-label="API Key 列表"`；**`aria-sort`/排序能力仍为 0** |
| **D29** 测试只覆盖死树 | 未修 | ❌ **仍存在** | `server/*.test.ts` 引用 `.tsx` **6 处**、引用 `.vue` **0 处** |
| **D30** 术语漂移 | 部分修 | 🟡 **未逐条复核**（本轮未做全站术语扫描）→ 标记**未验证** |
| **D32** 侧栏高亮兜底 | 未修 | ❌ **仍存在** | `ConsoleNav.vue:52-54` 仍是 `route.path.replace(/^\//,'')` 精确比对 + 匹配不到兜底 `'dashboard'`（TUF 用 `lib/nav.ts:64-71` 的最长前缀匹配并返回 `null`） |

---

## 4. 我独立发现的新缺陷

> 除 R1（§2.1，高危）与 R2（§2.5，中危）外，另发现 1 条：

### N1（中）`ModelsPage` 的全局「同步上游模型」既无确认、反馈又全部丢失
- **现象**：`/models` 页头的「同步上游最新模型」按钮调用 `api.syncUpstreamModels()`（**全局写**：把上游模型目录同步进本地索引），**没有 `confirm()`**（`ModelsPage.vue` `await confirm(` = 0）。更严重的是它的成功/失败反馈走 `emit('notify', ...)`，而**没有任何监听者**——`ModelsPage.vue:157,161` 的提示、`:143` 的 `emit('refresh')`、`:167` 的 `emit('update:days')` 全部落空（`router.ts` 挂载页面时不接事件）。
- **后果**：管理员点下这个全局写操作后，**成功没有任何反馈，失败也没有任何反馈**（只剩按钮的短暂 loading）。这是"静默写"，且 `:160` 的 `catch {}` 连错误对象都丢掉。
- **判定依据**：
  - `grep -rn "@notify\|@refresh\|@update:days" src --include=*.vue` → 无任何消费者；
  - `ModelsPage.vue:153-165`（无 confirm、`emit('notify')`、`catch {}`）；
  - `src/router.ts:21` `{ path: 'models', component: () => import('./pages/ModelsPage.vue') }`（无 props/事件）。
- **严重度**：中（D22 孤儿契约的直接后果；与 D5/D6 同族但影响面小于删除类操作）
- **建议**：给 `handleSyncUpstream` 加 `await confirm({title:'同步上游模型目录', body:'将从上游拉取最新模型列表并合并进本地索引。', confirmText:'开始同步'})`，并把 `emit('notify', …)` 换成 `toast({...})`（迁移页的既有写法）。**这是 ModelsPage 未迁移的直接补丁。**

**未发现其他新缺陷**：本轮针对 URL 状态、竞态、分页组合、ErrorPanel 旧数据、开关回退、确认框焦点/Tab 序、图标 aria-label 逐项做了对抗测试，除上述 R1/R2/N1 外**没有发现新的重构回归**（§2.8 明确记录了被排除的假设，包括我自己那个被推翻的 TxSwitch 假设）。

---

## 5. 未验证项（明确列出，不猜）

1. **后退/前进语义**：tab 历史被本轮 `goto` 污染，未能构造干净历史；且 `listState` 有意用 `router.replace`（不产生历史条目），"筛选态下的后退"没有可测对象。**残留风险**：`replace` 语义意味着用户**无法用后退撤销一次筛选**（这是设计选择，不是 bug，但没经过产品确认）。
2. **`/rtk` 与 `/ab` 的功能正确性**：本轮只验证两页能正常挂载（`/rtk` h1「RTK Token 压缩」、`/ab` h1「A / B 交互对照台」，均无 `.error-panel`）。RtkPage/AbLabPage 的**业务行为**属 task-3/task-9 范围，本轮不判定。
3. **A 侧另外 3 个 legacy 副本**（`OAuthPage.legacy.vue`、`DashboardPage.legacy.vue`、`HelpPage.legacy.vue`）是否也含可写危险路径：**未逐个测试**。已确认的只有 `KeysPage.legacy.vue`（R1）。**建议 Lead 把 4 个 legacy 副本一起纳入只读化处理**，不要只修 Keys。
4. **`?v=split` 视图**：未测试（只测了 `v=a` 与 `v=b`）。
5. **对比度**：未量化，故本报告**不含对比度结论**（沿用上轮口径）。
6. **屏幕阅读器实际播报**：无辅助技术可用；`aria-*` 结论均来自 DOM 属性检查。
7. **非 Chromium 浏览器**：只测 ego-lite Chromium；Firefox/Safari（尤其 iOS 的 `clipboard`、`100vh`）未验证。
8. **D30 术语漂移**：未做全站术语扫描，标记未验证。
9. **真实后端时序下的竞态**：§2.3 用的是注入判别值；未在真实慢网络（`Network.emulateNetworkConditions`）下复测。

---

## 6. 判据速查（Lead 可原样复跑）

```bash
# 0) 环境前提：确认 dist 与源码一致
DIST=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' dist/index.html); echo "$DIST"
find src index.html -type f \( -name '*.vue' -o -name '*.ts' -o -name '*.css' -o -name '*.html' \) -newermt "$DIST"   # 应为空

# 1) 浏览器串行锁（COORDINATION.md）
for i in $(seq 1 36); do mkdir /tmp/cac-browser.lock 2>/dev/null && break || sleep 5; done   # 用完 rmdir

# 2) 凭据只走 Keychain→stdin（禁止明文/文件/argv）
PW="$(security find-generic-password -s com.crosery.console-magpie.local -a admin -w)"; PWJ="$(printf '%s' "$PW" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"
# 脚本内 const pw = __PWJ__; 然后 printf '%s' "${SCRIPT/__PWJ__/$PWJ}" | ego-browser nodejs
```

关键断言（与正文一一对应，均为我在 `spaceId=10` 实际跑过的判据）：

| 项 | 选择器 / 命令 | 期望值 |
|---|---|---|
| D1 | 卡片文本 vs `fetch('/api/analytics?days=7').summary` | `214 / 7.7万 / 41.6% 存在异常拦截 / 4.8s` |
| D2 | `setBlockedURLs(['*/api/bootstrap*'])` → `.error-panel` | 持久存在；8s 后仍在；解除后点「重试」→ 14 行 |
| D3 | CDP `Network.requestWillBeSent` 过滤 `/api/charts` | ≥1 个请求；页面不含「加载图表数据中」 |
| D4 | `setDeviceMetricsOverride({width:390})` → `th` 宽度 | 全部 ≠ 0；`documentElement.scrollWidth === 390` |
| D5/D6 | patch fetch 短路所有非 GET → 打开确认框 → 点取消 | `window.__writes === []`（6 处全过） |
| Escape | 点开确认框 → `press("Escape")` → 轮询 `.confirm-actions` | DOM 移除；`activeElement.ariaLabel` === 触发按钮 ariaLabel（5/5） |
| URL | 搜索 → `reload()` | URL 与输入框均保持；清空后 `?q` 被移除 |
| 竞态 | patch fetch 让 `days=7` 延迟 3s 且 `tokens=111111`，`days=30` 立即 `222222` | 最终显示 `22.2万`（不是 `11.1万`） |
| 分页×筛选 | `/analytics?page=2` → 选「最近 30 天」 | URL 变 `?days=30`（无 `page`）；分页器回 `Page 1 of 3` |
| R1 | `/ab?flow=keys-access&v=a` → 点「重置今日用量」 | **无 `.confirm-actions`** 且捕获到 `POST …/quota/reset`（A 侧）；B 侧有确认且零写 |

---

## 7. 给 Lead 的建议（按性价比排序）

1. **立刻处理 R1**（`/ab` A 侧可写）：这是本轮唯一的"高危 + 由本次重构引入"项，且只需在 lab 层加只读化或把 A 侧写操作禁用，**不用改任何业务页面**。顺手覆盖另外 3 个 legacy 副本（§5.3）。
2. **R2 是产品决策而非 bug**：`ErrorPanel` 顶掉旧数据的写法**与 TUF 完全一致**。若接受偏离 TUF，给 `ErrorPanel` 加 `inline` 变体，8 个迁移页统一收益；若不接受，就在报告里明确接受该行为。
3. **N1 加一行 `confirm` + 换 `toast`**：`ModelsPage` 的两处 `emit('notify')` 改 `toast` 是 5 行改动，直接消掉"静默全局写"。
4. **未迁移的 5 个页面**（`ModelsPage`/`OAuthPage`/`HelpPage`/`LoginPage`/`AbLabPage`）是 D15/D16/D17/D22/D24/D25 残留的共同来源。若要收口，`ModelsPage` + `OAuthPage` 优先级最高（前者有全局写，后者有无限轮询）。
5. **D29（测试只覆盖 `.tsx` 死树）建议单独立项**：它不产生用户可见缺陷，但正是"迁移后仍留旧缺陷"的结构性原因——本轮 D1/D3 能存活到第二轮，就是因为它。修法上轮已给（把页面逻辑下沉到 `src/lib/` 并让测试指向它）。
