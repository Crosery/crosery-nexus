# 第四轮整改：行为级测试 + `aria-sort` 错列（task-21 / blue-ui）

日期：2026-10-01 · 依据：`docs/qa/red-team/ui-round4-verification.md`（R4-A / R4-B）
构建：`npm run build` → `dist/assets/console-D4QMXRvq.js`（10:19）后又一次重建（含本文件描述的全部改动）；截图 10:2x。

**一句话**：把「守卫」从**读源码文本**换成**真的跑状态机**（并用红队的同一手法反向验证了新测试确实会红）；修掉 `/models` 在 `?sort=output` 时把 `aria-sort` 标到错误列的问题；过程中还抓到并修掉一个**自己和工具链都放过**的真 bug（见 §4）。

---

## 1. R4-B：为共享原语补行为级测试

新增 4 个测试文件（`node --test --import tsx`，无 DOM、无新依赖）：

| 文件 | 覆盖 |
| --- | --- |
| `server/libResource.test.ts` | `useResource`：① 依赖变化重取 + **迟到的旧响应被丢弃**（受控 Promise 造「先发慢、后发快」）；② **刷新失败保留旧数据**且 `error` 被设置；③ `onScopeDispose` 之后不再写入；④ 旧请求失败不得污染新请求的错误态；⑤ `enabled()` 为 false 时不发请求 |
| `server/libConfirm.test.ts` | `settleConfirm` 只 resolve 一次、重复 settle 不改变结果；**新 `confirm()` 把上一个按 `false` 结束**（调用方不悬空）；Promise 不提前结算；触发元素记录/清空 |
| `server/libTableSort.test.ts` | 逐列映射（含 `input`/`output` 同属定价列）、方向、未知字段 fail-safe、列名不重复 |
| `server/libImports.test.ts` | 「页面脚本用到 `src/lib` 导出却没 import」的静态守卫（§4 的产物） |

无 DOM 的可行性：`effectScope()` 提供 `onScopeDispose` 所需的活跃作用域，`watch/ref/nextTick` 在组件外可用；`confirm()` 里的 `document.activeElement` 已有 `typeof document !== 'undefined'` 保护 → **不需要挂载组件，也不需要 DOM 环境**。

### 1.1 语义级负向验证（复现红队手法，不是改措辞）

在 `src/lib/resource.ts` 的守卫**之前**插入无条件写入（**保留全部被断言的文本**）：

```ts
const result = await fetcher()
data.value = result                    // ← 注入：守卫仍在，但语义已瘫
if (mine === seq && !disposed) { data.value = result; initial.value = false }
...
} catch (err) {
  error.value = err                    // ← 注入
  if (mine === seq && !disposed) error.value = err
```

结果：

| 测试集合 | 注入后 |
| --- | --- |
| 旧的 3 个**源码文本**断言（`analyticsNavigationFallback` / `reportPageFrontend` / `reportRouteWiring`） | `ℹ tests 17 · pass 17 · fail 0` → **全绿，抓不到**（复现红队结论） |
| 新增**行为**测试 `server/libResource.test.ts` | `✖` 3 条：乱序丢弃、作用域销毁后不再写入、旧请求失败不覆盖新成功 → `pass 2 · fail 3` |
| 全量 `npm test` | `ℹ tests 560 · pass 556 · fail 3` → **整套变红** |

还原后：`ℹ tests 562 · pass 561 · fail 0 · skipped 1`（562 = 560 + 本轮新增的 2 条静态守卫）。

### 1.2 旧的 3 条源码文本断言：保留，但写明边界

**结论：保留（同时新增行为测试），并在文件注释里写清它们能保证什么。**
- 能保证：**没有改回旧写法**（例如有人把 `/api/analytics` 换回 `api.usageBreakdown`、把序号守卫的文本删掉）。这类「回退式回归」成本极低、命中率不低。
- **不能保证**：逻辑被改坏但文本不变（红队本轮证明：注入一行 `data.value = result` 就能让竞态语义失效而文本断言全绿）。**语义正确性由新增的行为测试负责。**
- 因此两者的关系是「文本断言防回退 + 行为测试防语义破坏」，而不是互相替代。文档在此明确，避免把旧断言当成语义守卫。

## 2. R4-A：`/models` 的 `aria-sort` 错列

**根因**：`ModelsPage.vue` 的 `SORT_BY_COLUMN` 只映射 4 个排序字段，而 `SORTS` 有 5 个（多了 `output`），兜底 `?? 'model'` 于是把 `?sort=output` 的指示器打到了「模型名称」列。而 `aria-sort` 是这张表**唯一**的排序指示器（表头按钮没有 active 类），错列等于向屏幕阅读器播报错误信息。

**修法**：
1. 映射抽到 `src/lib/tableSort.ts`（纯函数，可测）：定价列同时承载 `['input', 'output']`；
2. **fail-safe**：`columnForSortKey()` 无匹配时返回 `null`，`tableSortState()` 返回 `null` → **不打任何 `aria-sort`**，不再兜底到第一列；
3. `ModelsPage.vue` 改为 `tableSortState(sortKey.value, dir.value)` 与 `sortKeyForColumn(next.key)`。

### 2.1 逐列实测表（浏览器，1557×958，`?sort=X&dir=Y` 直链）

| `?sort=` | `?dir=` | 带 `aria-sort` 的表头 | 值 | 首行（排序确实生效） |
| --- | --- | --- | --- | --- |
| `name` | `asc` | 模型名称 | `ascending` | `~anthropic/claude-fable-latest` |
| `name` | `desc` | 模型名称 | `descending` | `z-ai/glm-5v-turbo` |
| `input` | `asc` | 每 1M Token 定价 | `ascending` | `$0.03 / $0.13` |
| `input` | `desc` | 每 1M Token 定价 | `descending` | `$30 / $180` |
| **`output`** | **`asc`** | **每 1M Token 定价** | **`ascending`** | `$0.03 / $0.13` |
| **`output`** | **`desc`** | **每 1M Token 定价** | **`descending`** | `$30 / $180` |
| `usage` | `asc` / `desc` | 用量与花费 | `ascending` / `descending` | — |
| `sources` | `asc` / `desc` | 服务渠道映射 | `ascending` / `descending` | — |

其余可排序列在同一次快照里都是 `aria-sort="none"`（没有第二列被误标）。截图：`r5-models-aria-sort-output.png`（`?sort=output&dir=desc`）。

**一个如实的边界**：`?sort=zzz` 这类未知值会被页面先归一化成 `name`（`sortKey` 用 `SORTS` 白名单校验），所以实际排序与指示器仍然一致（模型名称=ascending），URL 里的 `zzz` 只是被忽略——**lib 层的 fail-safe（无匹配 → 不打指示器）由 `server/libTableSort.test.ts` 直接覆盖**，页面层走不到那条分支。

## 3. 命令与数字（最终一次）

```
$ npx tsc -b        → exit 0
$ npm run lint      → 仅 2 条既存 server/nativeResponses.ts no-control-regex warning
$ npm test          → ℹ tests 562 · pass 561 · fail 0 · cancelled 0 · skipped 1   (exit 0)
$ npm run build     → ✓ built in 559ms
```

## 4. 过程记录：一个被工具链放过的真 bug（为什么不只是「补测试」）

在改 R4-A 时，我用一次**没有断言的字符串替换**给 `ModelsPage.vue` 插入 `lib/tableSort` 的 import —— 它静默失败了（页面里 `useQueryState` 的 import 语句是 `{ debounce, paginate, useQueryState }`，我的匹配串写的是 `{ useQueryState }`，没有命中）。

后果：**`tsc -b` 绿、`npm run build` 绿、`npm test` 绿**，但浏览器里 `ReferenceError: tableSortState is not defined`，`/models` 的工具栏与整张表**不渲染**（只有页头和指标卡）。原因是本仓库没有 `vue-tsc`，`tsc` 根本不检查 `.vue` 的脚本/模板，Vite 构建也不会因为「用了未定义的标识符」失败。

处置：
1. 修好 import；
2. 新增 `server/libImports.test.ts`：静态解析 `src/lib/*.ts` 的导出名，逐个页面检查「用到了但没 import」（跳过本地同名声明，如 `RtkPage.vue` 自己的 `describeError`），并带一条「守卫本身有牙齿」的自检；
3. **把这条教训写进本文件**：真正的结构性修复是给仓库加 `vue-tsc` 让类型检查覆盖 `.vue` —— 那需要新增 `devDependencies`，按你的约束**我没有加**，留给你决定。

## 5. 写范围与未做项

- 改动：`src/lib/tableSort.ts`（新）、`src/pages/ModelsPage.vue`、`server/lib{Resource,Confirm,TableSort,Imports}.test.ts`（新）、`docs/qa/blue/**`
- 未触碰：`src/router.ts`、`src/components/ConsoleNav.vue`、`src/api.ts`、`src/types.ts`、`server/index.ts`、`server/rtkService*.ts`、`src/ab/**`、`MANIFEST.sha256`、`RELEASE.json`、`server/testDataDir.ts` 与 22 个 `import './testDataDir.js'` 行
- 未做/未验证：`vue-tsc`（需新增 devDependency，等你决定）；`sort=output` 只验证了指示器与排序结果，未验证屏幕阅读器的**实际播报**（无辅助技术）；`?sort=zzz` 时 URL 里保留了无效值（不影响排序与指示器一致性，未做 URL 归一化）。
