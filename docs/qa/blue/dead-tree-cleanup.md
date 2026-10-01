# React 死树清理 + 测试改为断言活代码（task-17 / blue-ui）

日期：2026-10-01 · 仓库 `/Users/crosery/work_file/crosery-api-console` · 相关前情：红队两轮都指出「页面坏了、`npm test` 却全绿」的存活机制是**测试只读 React 死树**。

**结论一句话**：删掉 25 个无人引用的 `.tsx`，保留 `/docs` 的两个 React 入口；把 4 条只读死树的断言改成读活代码的等价断言（2 条明确删除并说明理由）；并用两次「故意改坏活代码 → 测试变红」证明新断言真的能失败。

---

## 1. 判定方法（先证明再删）

写了一个一次性脚本（未入库，逻辑写在这里便于复现）：从两个真入口做**import 闭包**，闭包之外的一律是死树。

- 入口 A（控制台）：`index.html` → `src/main.ts` → `App.vue` + `router.ts` → `pages/*.vue`
- 入口 B（文档）：`docs.html` → `src/docs-entry.tsx` → `src/docs.tsx`

```
Vue 树(main.ts) 闭包：51 个文件
docs 树(docs-entry.tsx) 闭包：2 个文件（docs-entry.tsx, docs.tsx）
src/**/*.tsx 共 27 个 → 闭包内 2 个（保留），闭包外 25 个（删除）
```

交叉验证（全仓 grep，排除 `node_modules`/`dist`/`.git`）：

| 待删文件 | 谁引用它 |
| --- | --- |
| `src/App.tsx` | 无源码引用者；被 3 个测试文件与文档/RELEASE 提及（见 §4） |
| `src/main.tsx` | 无源码引用者（`index.html` 引的是 `/src/main.ts`） |
| `src/components/{Modal,ConfirmDialog,QuotaEditor,Select,UsageQueryDialog,ChannelCreateDialog,OAuthLoginDialog,RequestDetail,ResultDialog,VersionWidget}.tsx` | 只在死树内部互相引用（引用者全是被删的 `*.tsx`） |
| `src/pages/{Dashboard,Keys,Channels,OAuth,Models,Charts,Analytics,Usage,Cache,Monitor,Help,Login}Page.tsx` | 只被 `src/App.tsx`（已删）引用 |
| `src/pages/CredentialUploadPage.tsx` | **零引用者**（连 `App.tsx` 都不引） |

**保留（活着）**：`src/docs-entry.tsx`、`src/docs.tsx`（`docs.html` 的 `script src="/src/docs-entry.tsx"` 是唯一入口；`docs-entry` 用 react/react-dom，`docs.tsx` 用 lucide-react + `./docs.css`，`docs-entry` 还引 `./index.css`）。

删除命令记录：`git rm src/App.tsx src/main.tsx src/components/*.tsx(10) src/pages/*.tsx(13)`，共 **25 个文件**（`git status -- src | grep -c '^D'` → 25）。

## 2. `/docs` 入口没被误伤（构建产物对照）

| 产物 | 清理前 | 清理后 |
| --- | --- | --- |
| `dist/docs.html` | 存在，引 `assets/docs-BAITTIl8.js` | **存在，仍引 `assets/docs-BAITTIl8.js`**（sha256 `4a6f16b8…`） |
| `dist/assets/docs-BAITTIl8.js` | 210.89 kB | **210,892 B，sha256 `1faf432b…` 与清理前一致**（内容未变） |

即：控制台入口的 chunk 重新生成（`console-DcbL7GlC.js`），**docs 入口 chunk 字节级不变**，说明删掉的 25 个文件确实不在 docs 依赖图里。

实测两个入口都能打开（09:48 构建，见截图）：
- `/`（控制台）：登录后 `h1=运行概览`，标题 `Crosery API Console` → `r4-app-entry.png`
- `/docs`（文档）：标题 `Crosery API 文档`，`h1=拿到 API Key 后直接发请求`，正文 5849 字符，`#root` 存在 → `r4-docs-entry.png`

## 3. 测试改为断言活代码（`server/*.test.ts`）

改动的 3 个文件（任务允许的范围内）：

### 3.1 `server/analyticsNavigationFallback.test.ts`（原来读 `pages/AnalyticsPage.tsx` + `App.tsx`）
| 原断言 | 处置 |
| --- | --- |
| 「切到请求明细时不解引用缺失的 keyUsage」 | **等价改写**到 `AnalyticsPage.vue`：`const keyUsage = computed(() => analytics?.keyUsage ?? [])` + 模板 `v-for="(k, idx) in keyUsage"`，并反向断言不存在 `analytics?.keyUsage.map(` |
| 「Dashboard 的部分响应不覆盖已加载的完整 Analytics」 | **等价改写**到 `DashboardPage.vue`：Dashboard 只调 `api.dashboard`、不出现 `api.analytics`、不写 `analytics.value`；并断言依赖数组含 days/keyId（筛选失效会红） |
| — | **新增**一条 D1 回归守卫：`AnalyticsPage.vue` 必须 `api.analytics<AnalyticsData>(...)` 且不得出现 `api.usageBreakdown` |

### 3.2 `server/reportPageFrontend.test.ts`（原来读 `App.tsx` + `pages/{ChartsPage,CachePage}.tsx`）
| 原断言 | 处置 |
| --- | --- |
| report 页面用专用 loader + 每个 loader 各自的 request ref 竞态守卫 | **等价改写**：断言 Usage/Charts/Cache 各自的 `api.*` 调用，并断言 `src/lib/resource.ts` 的序号守卫（`const mine = ++seq` / `if (mine === seq && !disposed) { data.value = result` / `error.value = err`）与「成功前不碰 data」 |
| 「usage breakdown 拒绝过期响应、只渲染当前 scope」 | **等价改写**：断言三个页面的 `useResource` deps 都来自 URL 派生 scope；断言页面之间不互相 import 状态 |
| 「usage 先渲染 core 再后台合并 key summaries」 | **删除并说明**：Vue 版只有一次 `api.usageOverview`，不存在两段式合并 → 改断言「`api.usage*` 调用恰好是 `['api.usageOverview']`」+ 未定价告警仍渲染 |
| 「charts 先取 core 再取 latency」 | **删除并说明**：活代码只请求 `/api/charts`，`api.chartsLatency` 零调用 → 改为断言 `/api/charts` 真的被调用、trend 真的被画出来（`<path :d="line">`）、模板里不再有「加载图表数据中」 |
| 「cache 筛选目录 + 当前值在换 scope 时保留」 | **等价改写**：目录来自响应（`internalModels/internalClients`），选中值来自 URL（`:model-value="scope.state.model"` 等） |
| 「recharts 系列 `isAnimationActive={false}`」 | **删除并说明**：活代码不用 recharts，图表是 SVG/CSS，动画由 `styles/theme.css` 的 `prefers-reduced-motion` 统一处理 |

### 3.3 `server/reportRouteWiring.test.ts`（原来最后一条读 `App.tsx`）
- 原断言「channels/models 页面每 N 秒静默轮询（`refreshCurrent`）」→ **删除并说明**：该功能在 Vue 树里**根本不存在**（`grep -rn setInterval src/pages/*.vue` 只有 `OAuthPage.vue` 的授权轮询）。
- 替换为一条**与现状相符**的反向断言：活代码里带 `setInterval` 的页面恰好是 `['OAuthPage.vue']`，且 `App.vue` 里没有 `setInterval`/`refreshCurrent`。**若「静默轮询」是期望行为，应作为产品需求单独立项**，不能靠测试里的假断言维持印象。

其余 8 个测试组（路由/报告池/bootstrap 等）仍然读 `server/index.ts`，未受影响。

## 4. 负向验证（这是本次清理的意义所在）

**判据**：故意改坏**活代码**，测试必须变红。

| # | 故意改坏 | 结果 |
| --- | --- | --- |
| 1 | `src/pages/AnalyticsPage.vue`：把 `api.analytics<AnalyticsData>` 换回 `api.usageBreakdown<AnalyticsData>`（就是红队 D1 那个事故） | `node --test server/analyticsNavigationFallback.test.ts` → `✖ 请求明细页读的是 /api/analytics…`，`pass 2 / fail 1`；`npm test` → `tests 547 / pass 545 / fail 1` **红** ✅ |
| 2 | `src/lib/resource.ts`：去掉序号守卫（`if (mine === seq && !disposed)` → `if (!disposed)`） | `node --test server/reportPageFrontend.test.ts` → `✖ report 页面用专用 loader，竞态由 useResource 的序号守卫统一丢弃过期响应`，`pass 4 / fail 1` **红** ✅ |
| — | 恢复两个文件后 | `npm test` → `tests 547 / pass 546 / fail 0 / skipped 1` **绿** ✅ |

## 5. 命令与数字（最终一次，全部在 `/tmp/cac-build.lock` 串行区内）

```
$ npx tsc -b            → exit 0
$ npm run lint          → 仅 2 条既存 server/nativeResponses.ts no-control-regex warning
$ npm test              → ℹ tests 547 · pass 546 · fail 0 · cancelled 0 · skipped 1   (exit 0)
$ npm run build         → ✓ built in 562ms
                          dist/assets/console-DcbL7GlC.js（控制台）
                          dist/assets/docs-BAITTIl8.js 210,892 B（文档，与清理前同哈希）
```

## 6. 依赖清理建议（**未改 `package.json`**，等你决定）

| 包 | 谁在用 | 建议 |
| --- | --- | --- |
| `react` / `react-dom` | `src/docs-entry.tsx`、`src/docs.tsx`（活） | **保留** |
| `lucide-react` | `src/docs.tsx`（活） | **保留** |
| `@vitejs/plugin-react`(dev) | `vite.config.ts` 的 `include: /docs.*\.(jsx\|tsx)$/` → 只服务 docs 入口 | **保留** |
| `recharts` | **只有死树**（`pages/{ChartsPage,CachePage,DashboardPage}.tsx`）+ `src/App.css`（一份不引 recharts 的样式文件） | **可移除候选**，但 `package.json` 与 `src/App.css` 不在我的写范围，交你决定 |

## 7. 顺带完成的 D12 剩余项（`/models`）

| 项 | 实现 | 实测 |
| --- | --- | --- |
| **批量启用/停用** | 表格 `selectable` + 选中行出现批量条；一次确认后**顺序**调用 `setModelSourceEnabled`，统计成败，失败逐条列出（接口没有批量端点，不假装原子） | 勾选 1 行 → 批量条「已选 1 个模型（1 行）」；点「批量停用渠道映射」→ 确认框「将对 1 个模型的 1 条渠道映射执行「停用」。停用会让使用这些映射的调用失败…」，Esc 取消、未写任何数据 → `r4-models-batch.png`、`r4-models-batch-confirm.png` |
| **列显隐** | 工具栏列开关；`cols=model,sources,pricing,usage` 进 URL；至少保留一列 | `/models?cols=model,pricing` → 表头只剩「模型名称 / 每 1M Token 定价」 → `r4-models-columns-hidden.png` |
| **`aria-sort`** | 4 个数据列标记 `sortable`，受控 `:sort` + `@update:sort` 双向映射到 URL 的 `sort/dir`；排序仍在 JS 里做（未定价恒排最后），故 `:sort-on-client="false"` | 初始 `模型名称: ascending`、其余 sortable 列 `none`；点「每 1M Token 定价」表头 → URL `?sort=input`、该列 `aria-sort="ascending"`、首行变成最便宜的 `$0.03` → `r4-models-columns-arialsort.png` |

## 8. 未做 / 需要你决定 / 未验证

1. **`MANIFEST.sha256` 与 `RELEASE.json` 现在过期**（都不在我的写范围）：`MANIFEST.sha256` 有 **27 行** `src/**.tsx` 条目（其中 25 个文件已删）、`RELEASE.json` 提到 `App.tsx`。`deploy/edge/README.md:44` 明确要求「keep it and MANIFEST.sha256 in step with the tree」→ 需要重新生成或手工删条目，请你指派。
2. **第 4 个依赖死树产物的测试**：`server/pageMotionVisibility.test.ts` 读 `src/App.css`（`App.tsx` 独占的样式）。该文件**不在**本任务允许改的 3 个测试文件里，所以：**`src/App.css` 予以保留**，该测试保持原样（它与 Vue 树无关，属于残留）。若后续要清 `App.css`，必须同时处理该测试。
3. **未验证**：`recharts` 移除后的构建（没动 `package.json`，也不该在没批准前动）；`/docs` 页面的**交互**（只验证了渲染与标题，没点右侧目录、没验证移动端）；批量操作**没有真正提交**（按约定只到确认框即取消，所以「批量部分失败」的分支只有代码路径，没有实测）。
4. 全量 `npm test` 里 1 条 skipped 是既有状态（与本次改动无关）。

## 9. 改动清单

- 删除：`src/**/*.tsx` 25 个（`App.tsx`、`main.tsx`、`components/*.tsx` 10 个、`pages/*.tsx` 13 个）
- 保留：`src/docs-entry.tsx`、`src/docs.tsx`
- 修改：`server/analyticsNavigationFallback.test.ts`、`server/reportPageFrontend.test.ts`、`server/reportRouteWiring.test.ts`
- 顺带修改：`src/pages/ModelsPage.vue`（批量/列显隐/aria-sort）
- 截图：`docs/qa/blue/shots/r4-*.png` 6 张（09:48–09:49，与 09:48 构建同批）
- 未触碰：`src/router.ts`、`src/components/ConsoleNav.vue`、`src/api.ts`、`src/types.ts`、`server/index.ts`、`server/rtkService*.ts`、`src/ab/**`、`HelpPage.vue/RtkPage.vue/AbLabPage.vue`、`package.json`、`MANIFEST.sha256`、`RELEASE.json`
