# 第六轮整改：并发契约一致性 + 空值静默改写 + 汇总不收敛 + 死代码 + 路由/导航差集（task-25 / blue-ui）

日期：2026-10-01 · 依据：`docs/qa/red-team/ui-round6-verification.md`
构建：`npm run build` ✓ 637ms；截图 `docs/qa/blue/shots/r7-*.png` 3 张。

**一句话**：把「客户端宣告 1–1000、服务端只收 ≤500」的契约裂缝按**服务端权威**收口到 1–500 并加实测契约测试；并发从「可留空」改成必填（服务端会把空串静默变成 4）；底部汇总改为从字段错误**派生**；删掉死代码 `emptyKeyListCopy`；把「路由 ⊆ 导航」做成差集断言。

---

## 1. R6-C 客户端/服务端并发区间不一致（最先修）

### 修前复现
- 客户端：`KeysPage.vue` 的规则 `integerInRange(1, 1000, '并发数请填 1–1000 的整数…')`；
- 服务端：`server/policy.ts:9-11` `totalConcurrency > 500` 直接抛「总并发必须是 0 到 500 的整数，0 表示不限速」；
- 结果：填 501–1000 **表单判合法 → 提交被 400 拒**，两侧文案互相矛盾。

### 哪一侧权威（证据）
| 证据 | 内容 |
| --- | --- |
| `server/policy.ts:9-11` | 服务端唯一校验实现，>500 抛错；`server/index.ts:466/489` 在创建与更新两条路径上都调用它 |
| `git log -S"总并发必须是 0 到 500" -- server/policy.ts` | `9a909f8 feat: support explicit unlimited key policies`（服务端 500 来自既有业务提交） |
| `git log -S"1–1000" -- src/pages/KeysPage.vue` | **只有 `805ca80`（我第五轮加字段校验时自己写的 1000）** |
| `README.md` / `deploy/**` / nginx 配置 | 没有任何「并发上限 1000」的说明（`grep -rn 并发 README.md docs/*.md deploy/**/*.md` 只有一句定性描述） |
→ **结论：服务端权威，1000 是我上一轮凭空写的**。按服务端收口，不动服务端契约（也就无需向你申请放宽）。

### 改法
- `src/lib/validation.ts` 导出 `CONCURRENCY_LIMITS = { min: 1, max: 500 }`，注释写明「以 `server/policy.ts` 为权威」；
- `KeysPage.vue` 的并发规则改用该常量，文案改为「请填写最大总并发数（1–500 的整数，与服务端一致）；不想限速请打开「不限速」开关」；
- 新增 `server/concurrencyContract.test.ts`：**不比对字符串常量**，而是用服务端权威函数 `validatePolicy()` **实测接受区间**（1/2/499/500 接受，501/600/1000/2000 拒绝），再断言客户端常量与逐点行为一致。

### 修后证据
- 浏览器：并发填 **501** → 字段旁出现「请填写最大总并发数（1–500 的整数，与服务端一致）…」；改成 **500** → 错误消失（截图 `r7-concurrency-contract.png`）；
- 契约测试 5 条全绿（含边界逐点一致）。

### 语义级负向验证
把 `CONCURRENCY_LIMITS.max` 从 500 改成 1000（**只动语义，不改文案**）→ `server/concurrencyContract.test.ts`：`✖ 客户端区间上界 == 服务端接受上界`、`✖ 客户端规则与服务端在边界上逐点一致`，`pass 3 / fail 2`；还原后全绿。

## 2. R6-B 并发留空被服务端静默改成 4

### 修前复现
并发框清空 → 失焦无错误 → 提交校验通过 → 请求体 `"totalConcurrency": ""` → `server/index.ts:464` 的 `Number(req.body?.totalConcurrency || 4)` 把它变成 **4**，而用户从没输入过这个数字。

### 改法（客户端侧，服务端运行时校验按约束未动）
- `integerInRange` / `numberInRange` 增加**显式** `allowEmpty` 选项（默认 `true` 保持「留空 = 不限制」的额度语义），并发显式传 `{ allowEmpty: false }` → **必填**；
- 字段提示补足准确语义：「…填写 1–500 的整数，不限速请打开右侧开关（留空不会被默认成任何数字）」；
- 新增契约测试「R6-B：并发留空在客户端就被拦下」+ 额度类字段留空仍合法。

### 修后证据
浏览器：并发框留空 + 失焦 → 字段旁「请填写最大总并发数（1–500 的整数，与服务端一致）…」。请求体层面不再可能出现 `""`（提交被客户端拦住）。

### ⚠️ 仍未修（需要你决定，超出我的写范围）
`server/index.ts:464` 仍会 `Number(v || 4)` 静默把空串变成 4。按任务约束我**没有改服务端**。建议的最小改法（供你指派）：
```ts
// 现状：静默改写用户输入
const totalConcurrency = req.body?.totalConcurrency === 0 ? 0 : Number(req.body?.totalConcurrency || 4)
// 建议：显式拒绝空值 / 非整数，让 400 文案与 policy.ts 一致
if (req.body?.totalConcurrency === '' || req.body?.totalConcurrency === undefined) {
  return res.status(400).json({ error: '请填写总并发数：1–500 的整数，0 表示不限速' })
}
```
（更新路径 `:487` 的 `Number(req.body?.totalConcurrency ?? row.total_concurrency)` 也需要同样的显式处理，否则 PATCH 传空串会变成 0 = 不限速，方向相反但同样静默。）

## 3. R6-A 底部汇总不随字段修正收敛

### 修前
`editorError` / `quotaError` 只在提交时写一次，字段改好了汇总仍挂着「还有 1 处需要修改」，直到下次提交成功才清。

### 改法
两个弹窗都改成**派生 computed**：
```ts
const editorSummary = computed(() => {
  const count = Object.keys(editorFieldErrors).length
  if (count) return `还有 ${count} 处需要修改，已定位到第一个字段。`
  return editorError.value   // 只承载服务端返回的错误
})
```
提交时不再写死汇总文案（`editorError = ''`），服务端错误仍走同一个 Alert。

### 修后证据（浏览器，不提交）
| 步骤 | 汇总 | 字段错误 |
| --- | --- | --- |
| 名称留空 + 并发留空 | 「还有 **2** 处需要修改，已定位到第一个字段。」 | 2 条 |
| 只改好名称 | 「还有 **1** 处需要修改，已定位到第一个字段。」 | 1 条 |
| 并发也填 4 | **null（汇总消失）** | 0 条 |

截图：`r7-summary-two-errors.png`、`r7-summary-derived.png`。

## 4. R6-E 死代码 `emptyKeyListCopy`

- 事实：`grep -rn emptyKeyListCopy src server` 在改动前只有 2 处——定义本身 + 它自己的测试；生产代码零引用；文案里含「密钥数据…」不符词表。
- **决定：删除**（而不是「用起来」）。理由：它描述的是「列表为空时该说什么」，而这类文案现在由 `EmptyState.vue` + 各页空态直接给（且已按词表统一为 API Key）；保留一个没人调用、措辞过时的函数只会继续漂移。
- 同步删除 `server/gatewayStatus.test.ts` 里它那一条测试；其余 **3 条**测试（网关状态文案、Magpie 命名、scope 隔离）原样保留，覆盖面没有减少。

## 5. R6-F 「路由 ⊆ 导航」差集断言

- 为什么不用「访问 `/nope`」验收：路由表有 catch-all `path: '/:pathMatch(.*)*' → /dashboard`，任何未知路径都会被静默重定向，观察不到 D32 想验的东西。
- 新增 `server/navRoutes.test.ts`：从 `src/router.ts` 解析出所有**有 `name` 的子路由**，从 `src/components/ConsoleNav.vue` 的 `navEntries` 解析出 `to:` 目标，断言**双向差集为空**（今天两侧都是 13 项 → 通过）；附一条合成样本自检（漏一个导航项必须被抓出来）。
- **负向验证**：临时在 router.ts 里加 `{ path: 'ghost', name: 'ghost', … }` → `✖ 路由表与侧栏导航一一对应（差集为空）`：`这些子路由没有对应的侧栏导航项：ghost。`，`pass 1 / fail 1`；还原后全绿（`grep -c ghost src/router.ts` → 0）。

## 6. 服务端文案（你已决定不改）——登记 + 前端缓解方案

- 位置：`/rtk` 同屏会出现前端词表的「远端网关」与服务端 plane detail 里的「中转站」（服务端 `server/rtkPlane.ts` / `rtkService.ts` 的字符串经 API 返回）。
- 已按你的决定**不改服务端字符串**。前端侧可选缓解（供你决定，未实施）：
  1. 在 `RtkBoard.vue` 渲染服务端 detail 时做**一次性词表映射**（`中转站`→`远端网关`），并保留原文 `title` 供排障；
  2. 或在 plane 卡片标题旁加一行小字「服务端术语：中转站 = 远端网关」，把差异显式对译；
  3. 或维持现状（同页已有对译兜底）。

## 7. 命令与数字（含退出码）

```
$ npx tsc -b            → tsc_exit=0
$ npm run lint          → lint_exit=0（仅 2 条既存 no-control-regex warning）
$ npm run build         → build_exit=0 · ✓ built in 637ms
$ npm test              → test_exit=0
                          ℹ tests 584 · pass 583 · fail 0 · cancelled 0 · skipped 1
```
（`--test-timeout=30000` 未回退；门禁按退出码判定。）

## 8. 交付清单与边界

- 修改：`src/lib/validation.ts`（`allowEmpty` + `CONCURRENCY_LIMITS`）、`src/pages/KeysPage.vue`（区间/必填/派生汇总/提示语）、`src/gatewayStatus.ts`（删死代码）、`server/gatewayStatus.test.ts`（删对应测试）
- 新增：`server/concurrencyContract.test.ts`（5 条）、`server/navRoutes.test.ts`（2 条）
- 截图：`docs/qa/blue/shots/r7-{summary-two-errors,summary-derived,concurrency-contract}.png`
- 未触碰：`server/index.ts` 运行时校验、`src/router.ts`、`src/components/ConsoleNav.vue`、`src/api.ts`、`src/types.ts`、`src/ab/**`、`package.json`、`MANIFEST.sha256`、`RELEASE.json`、`server/testDataDir.ts` 与 22 个 `import './testDataDir.js'` 行
- 未验证：屏幕阅读器对字段错误与 `aria-invalid` 的实际播报；R6-B 的服务端静默改写仍在（已给出最小改法，等指派）；`/rtk` 的服务端术语映射方案未实施（等你选）。
