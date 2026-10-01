# 第七轮整改：服务端并发空值收口 + OAuthPage 迁移（task-26 / blue-ui）

日期：2026-10-01 · 依据：`docs/qa/red-team/ui-round6-verification.md` 与 Lead 的 task-26 授权
构建：`npm run build` ✓ 574ms；截图 `docs/qa/blue/shots/r8-oauth-*.png` 4 张。

**一句话**：(A) 把服务端 `totalConcurrency` 的两处静默改写收口成显式 400（空串/缺字段不再变成 4 或 0），并给出端到端 + 语义负向验证；(B) 把最后一个未迁移的数据页 `OAuthPage` 接到共享原语，过程中抓到两个真实缺陷（`initial` 语义误用、`TxFilterChips` 传错 prop）。

---

## A. 服务端静默改写收口（R6-B 的服务端一半）

### A1. 先查「有没有合法客户端会故意发空串」
| 调用方 | 证据 | 结论 |
| --- | --- | --- |
| 控制台 UI | `src/pages/KeysPage.vue`（唯一 UI 写入方）：`totalConcurrency: editorForm.unlimited ? 0 : editorForm.totalConcurrency`，第六轮已改为**必填** | 不会发空串 |
| 冒烟脚本 | `scripts/magpie-console-smoke.mjs:34` → `totalConcurrency: 1, groupConcurrency: { openrouter: 1 }` | 显式数字 |
| 文档 / crapi 相关 | `grep -rn totalConcurrency --include=*.md`：只有 QA 文档复述本缺陷，没有客户端契约 | 无 |
| 其它脚本 / 测试 | 其余命中都是直接调 `validatePolicy()` 的测试或读库对账（`nginxUnlimitedReconciler.ts`） | 不经 HTTP |
→ **没有任何合法客户端会故意发空串**，因此按任务要求**直接 400**，不保留静默兼容。

### A2. 改法（Lead 授权的两处表达式 + 局部常量/文案）
```ts
// server/index.ts（新增，紧邻两条路由）
const TOTAL_CONCURRENCY_RULE = '总并发必须是 0 到 500 的整数，0 表示不限速'   // 与 server/policy.ts:10 同源
function parseTotalConcurrency(raw: unknown, fallback?: number): number {
  if (raw === undefined || raw === null) {
    if (fallback !== undefined) return fallback          // PATCH 缺字段 = 保持原值
    throw new Error(`请填写总并发数：${TOTAL_CONCURRENCY_RULE}`)   // POST 缺字段不再默认 4
  }
  if (typeof raw === 'string' && raw.trim() === '') throw new Error(`总并发数不能为空：${TOTAL_CONCURRENCY_RULE}`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 500) throw new Error(TOTAL_CONCURRENCY_RULE)
  return value
}
```
| 路径 | 旧 | 新 |
| --- | --- | --- |
| `POST /api/keys`（`:464`） | `req.body?.totalConcurrency === 0 ? 0 : Number(v \|\| 4)` → 空串/缺字段静默变 **4** | `parseTotalConcurrency(v)` → 空串/缺字段 **400** |
| `PATCH /api/keys/:id`（`:487`） | `Number(v ?? row.total_concurrency)` → 空串静默变 **0 = 不限速**（方向更危险） | `parseTotalConcurrency(v, Number(row.total_concurrency))` → 空串 **400**，缺字段保持原值 |

```console
$ git diff --stat server/index.ts
 server/index.ts | 29 +++++++++++++++++++++++++++--
 1 file changed, 27 insertions(+), 2 deletions(-)
```
（diff 只有上面这一处新增 + 两行表达式替换；未触碰其它路由、中间件、静态托管、启动流程。）

### A3. 端到端测试（`server/totalConcurrencyRoutes.test.ts`，新增）
真起 `server/index.ts` 子进程 + 本地 CPA stub：临时 `DATA_DIR`、`CPA_BASE_URL` 指向 stub、`PORT` 随机空闲端口，`finally` 里 SIGTERM/SIGKILL 并删临时目录——**不碰真实数据与真实中转站**。

| 用例 | 断言 |
| --- | --- |
| POST 空串 | `400` + 「总并发数不能为空…0 到 500 的整数，0 表示不限速」 |
| POST 缺字段 | `400` + 「请填写总并发数…」 |
| POST 越界 501 | `400` + policy 同源文案 |
| PATCH 空串 | `400`，且**直接读库确认仍是原值 7**（没有被改成 0） |
| PATCH 显式 0 | `200`，落库 0，响应回传生效值 0 |
| PATCH 缺字段 | `200`，保持原值 7（合法的部分更新） |

> 为什么 PATCH 用「直接播种 sqlite 行」而不是先 POST 建 Key：新建 Key 会触发 `reconcileKeyModelAccess()` → `buildGroups()`，临时实例没有任何渠道，分组会被规范化成 `[]`，随后 `validatePolicy` 一律以「至少选择一个渠道分组」失败，测不到并发契约。

### A4. 语义级负向验证（改回旧的静默分支 → 必须红）
| 只改回… | 结果 |
| --- | --- |
| 两处表达式都改回旧分支 | `✖` 测试红：`actual: 'g1 分组并发必须在 1 到总并发之间'` / `expected: /总并发数不能为空/`（旧代码把空串吃成 4 后才走到策略校验） |
| **只**把 PATCH 改回旧分支 | `✖` 测试红：`PATCH 空串必须被拒 … actual: 200 / expected: 400` —— 正是「空串落成 0 = 不限速」的危险路径 |
两次均已还原（`grep -c parseTotalConcurrency server/index.ts` → 3 = 1 定义 + 2 调用）。

---

## B. OAuthPage 迁移到共享原语

### B1. 迁移内容
| 项目 | 之前 | 之后 |
| --- | --- | --- |
| 页头 | 手写 `<header class="page-head">`（含 `eyebrow-tag`） | `PageHeader`（面包屑「接入 → OAuth 授权登录」+ 标题 + 说明 + `actions` 槽） |
| 数据 | 无（页面不发任何读取请求） | `useResource(() => api.channels())` 读**上游账号池**；加载/失败/旧数据三态 |
| 失败态 | 无 | `ErrorPanel`（首次失败阻断式 + 重试）；有旧数据时 `inline` 横幅 + `staleHint` |
| 加载态 | 无 | `LoadingBlock`（骨架） |
| 空态 | 无 | `EmptyState`「还没有上游账号」，动作「去选择提供商」；筛选无结果时 `search-empty`「没有符合筛选的提供商」+「清除筛选」 |
| URL 状态 | 无 | `useQueryState({ provider, status })`：`?provider=kimi&status=waiting` 可分享、可后退、刷新保持 |
| 术语 | 「查看渠道与账号池」 | 「查看渠道与上游账号池」；新增文案统一用「上游账号池 / 渠道 / 提供商」 |

**D24 逻辑保留并复核**：`POLL_MAX_MS = 5 * 60 * 1000`（超时停止轮询 + 提示「重新发起 / 手动提交回调」）、`POLL_MAX_CONSECUTIVE_ERRORS = 3`（连续失败即停，不再 `catch{}` 静默吞）、`onUnmounted` 清理全部 `setInterval` ——三处代码未被本轮的模板改动触碰（`git diff` 中该段无变化），并在失败卡片里保留「返回 / 重新发起」两条出路，页面底部补了一句说明手动提交回调这条路径。

### B2. 过程中抓到的两个真实缺陷（都不是测试能直接告诉我的）
1. **`useResource.initial` 语义误用（会导致「永久骨架、错误态不可达」）**
   我最初写 `<LoadingBlock v-if="pool.initial.value" />` + `<ErrorPanel v-else-if="error && 空数据" />`。实测阻断 `/api/channels` 后发现页面**一直停在骨架**、错误态从不出现——因为 `src/lib/resource.ts` 里 `initial` **只在成功时**置 `false`（文档语义是「从未成功加载过」，不是「正在加载」）。修法：把「失败且无旧数据」分支排到骨架之前，并在模板里写明原因。
   > 这类缺陷是「共享原语的语义假设」被误用，静态检查与单元测试都不会报；只有把失败路径真的走一遍才会暴露。
2. **`TxFilterChips` 传错 prop（静默渲染成空芯片）**
   我写的是 `:options="..."`，该组件实际属性名是 **`items`**（对照 `ModelsPage.vue:481-486`）。传错时组件不报错、不警告，只渲染一排空芯片。修好后芯片正常渲染并可点击。
   > 这与第六轮 `tableSortState is not defined` 同类：`.vue` 的模板/属性错误在 `tsc -b` 与 `npm run build` 下都不会失败。**再次说明 `vue-tsc` 是结构性修复**（仍等你拍板）。

### B3. 实测（浏览器，1557×958 / 窄屏 390×844）
| 场景 | 结果 |
| --- | --- |
| 默认 | 页头「OAuth 授权登录」+ 面包屑「接入 / OAuth 授权登录」；上游账号池（0 账号 → 空态「还没有上游账号 … 去选择提供商」）；8 张提供商卡片；无横向溢出 |
| URL 深链 `?provider=kimi&status=idle` | 只剩「Kimi 国内站（kimi.com）」1 张卡 |
| 点芯片「Moonshot Kimi」 | URL → `/oauth?provider=kimi`，只剩该提供商 |
| 「清除筛选」 | URL 回到 `/oauth`，恢复 8 张卡 |
| `?provider=kimi&status=success`（无匹配） | 0 张卡 + 空态「没有符合筛选的提供商 … 清除筛选」 |
| **首次加载失败**（阻断 `*api/channels*`） | 「上游账号池读取失败 · 请检查网络或服务是否在运行，然后重试。 [重试] Failed to fetch」，**不再是永久骨架** |
| 点「重试」（解除阻断后） | 恢复为空态（该实例 0 个上游账号） |
| 窄屏 390px | `clientWidth 390 / scrollWidth 390`，无横向溢出 |

截图：`r8-oauth-empty-and-grid.png`、`r8-oauth-url-filters.png`、`r8-oauth-failure.png`、`r8-oauth-narrow.png`。
（阻断用 CDP `Network.setBlockedURLs`，仅作用于该页面会话，**没有**清 cookie/缓存/profile。）

---

## C. 命令与退出码

```
$ npx tsc -b        → tsc_exit=0
$ npm run lint      → lint_exit=0（仅 2 条既存 server/nativeResponses.ts no-control-regex warning）
$ npm run build     → build_exit=0 · ✓ built in 574ms
$ npm test          → test_exit=0
                      ℹ tests 585 · pass 584 · fail 0 · cancelled 0 · skipped 1
```
（`--test-timeout=30000` 未回退；门禁按**退出码**判定，不看 `fail` 计数。）

---

## D. 交付清单与未验证项

- 修改：`server/index.ts`（仅授权两处 + 局部常量/函数）、`src/pages/OAuthPage.vue`
- 新增：`server/totalConcurrencyRoutes.test.ts`
- 截图：`docs/qa/blue/shots/r8-oauth-{empty-and-grid,url-filters,failure,narrow}.png`
- 未触碰：`server/policy.ts`、`src/router.ts`、`src/components/ConsoleNav.vue`、`src/api.ts`、`src/types.ts`、`src/ab/**`、`package.json`、`MANIFEST.sha256`、`RELEASE.json`、`server/testDataDir.ts` 与 22 个 `import './testDataDir.js'` 行、其它路由/中间件/静态托管/启动流程
- **未验证**：
  1. `ErrorPanel` 的 `inline`（有旧数据 + 刷新失败）分支**未实拍**——该实例上游账号池为 0 个账号，而约束要求**不得触发真实 OAuth 授权回路**，所以走的是「失败且无数据 → 阻断式错误态」；
  2. 真实 OAuth 授权回路（设备码/回调）未触发，D24 的三条逻辑只做了代码复核（diff 未触碰）+ 上一轮已有的实测记录；
  3. `?status=waiting` 等状态筛选组合需要真实会话状态才有数据，本轮验证了 URL 生效与空态，未验证「有一张 waiting 卡时筛选后仍显示」。
