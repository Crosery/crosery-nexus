# 第八轮整改：并发文案同源 + 额度静默改写收口 + days NaN 兜底（task-28 / blue-ui）

日期：2026-10-01 · 依据：`docs/qa/red-team/ui-round7-verification.md`
**最后一步已做**：改完 `server/**` → `launchctl kickstart -k` 重启 `com.crosery.console-magpie` → 对**运行中的实例**发真实请求抽验（见 §4）。

---

## 1. R7-B 并发规则文案：两份重复字面量 → 单一真源

**修前**：`server/policy.ts:10` 内联 `'总并发必须是 0 到 500 的整数，0 表示不限速'`，`server/index.ts:466` 又抄了一份 `TOTAL_CONCURRENCY_RULE`——数值区间有契约测试锁，**文案没有**，两份副本可以各自漂移。

**修后**：`policy.ts` 导出唯一真源，`index.ts` 引用它（本地副本删除）：
```ts
// server/policy.ts
export const TOTAL_CONCURRENCY_RULE = '总并发必须是 0 到 500 的整数，0 表示不限速'
...
throw new Error(TOTAL_CONCURRENCY_RULE)
```
```ts
// server/index.ts
import { TOTAL_CONCURRENCY_RULE, validatePolicy } from './policy.js'
```

**测试**（新增 `server/policyCopy.test.ts`，3 条）：
1. 运行时语义：`validatePolicy` **实际抛出**的消息 === 导出的常量；
2. 仓库级不变量：该字面量在 `server/**`（非测试文件）里**只出现一次**，且必须是 `policy.ts ×1`；
3. 合成样本自检：再造一份副本必被扫出。

**语义级负向验证**：在 `index.ts` 里**重新内联一份同样的字面量**（语义完全不变，只是复制）→
`✖ 并发规则字面量在 server/** 里只有一处（真源在 policy.ts）`：`并发规则文案出现多处…index.ts ×1、policy.ts ×1`；还原后 3/3 绿。

## 2. R7-C 额度接口的同类静默改写

**修前**（`server/index.ts` 额度路由）：
```ts
totalUsd: Number(req.body?.totalUsd ?? row.quota_total_usd) || 0,
```
`''` → `0`、`'abc'` → `NaN || 0` → `0`：**用户什么都没填，却把额度改成了「不限额」**（`validateQuota` 收到的是干净的 0，因此不会报错）；且「缺字段」与「显式 0」无法区分。

**先确认没误伤 UI 语义**：`KeysPage.vue` 的提交路径是
`totalUsd: quotaUnlimited.value ? 0 : Number(quotaValues.total) || 0` ——「留空 = 不限制」由**「无额度限制」开关**表达并发送**显式 `0`**；表单字段本身在第六轮已改成 `numberInRange` 校验。所以边界定为：**显式 0 合法，空串/非数字 400**。

**修后**（形状与 `parseTotalConcurrency` 一致）：
```ts
function parseQuotaAmount(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback            // PATCH 缺字段 = 保持原值
  if (typeof raw === 'string' && raw.trim() === '') throw new Error('额度不能为空：填 0 表示不限额')
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error('额度必须是数字：0 表示不限额，上限 1000000')
  return value
}
```
范围与跨字段规则仍交给既有的 `validateQuota`（负数/超 100 万/日>周>总额度）。

**测试**（并入 `server/totalConcurrencyRoutes.test.ts` 的端到端夹具）：
| 输入 | 断言 |
| --- | --- |
| `{"totalUsd":""}` | `400` + 「额度不能为空」 |
| `{"totalUsd":"abc"}` | `400` + 「额度必须是数字」 |
| `{"totalUsd":-3}` | `400` + 「必须是 0 或正数」 |
| `{}`（缺字段） | `200`，保持原值 |
| `{"totalUsd":0}` | `200`（显式 0 = 不限额，不误伤） |

**语义级负向验证**：三处表达式改回 `Number(...) || 0` → `✖ 额度空串必须被拒 … actual: 200 / expected: 400`；还原后绿。

## 3. R7-D `req.query.days` 非数字 → NaN

**修前**：8 处 `Math.max(1, Math.min(retention, Number(req.query.days || 7|30)))` —— `'abc'` → `NaN`（其余 3 处已用 `boundedInteger`，只有这 8 处漏了）。
**真实复现（运行实例，重启前）**：`?days=7` → 200 / 8404 B / sha `41a00a48…`；`?days=abc` → 200 但**完全不同的 352 B / sha `52136dbf…`**（NaN 口径下报表退化成空结果，体量差 24 倍）。

**修后**：8 处统一改为既有的 `boundedInteger(req.query.days, 默认, 1, config.usageRetentionDays)`（`server/publicUsage.ts:7-12`：`undefined/null/''` → 默认；`!Number.isFinite` → 默认；再 `floor` + 夹取）。

**测试**：`?days=abc` 与 `?days=` 的响应体必须与 `?days=7` **逐字节一致**（旧实现给的是另一份空报表）；
**语义级负向验证**：只把 `usage-page` 那一处改回旧表达式 → `✖ days=abc 必须与默认口径完全一致`；还原后绿。

## 4. 重启 + 运行实例真实请求抽验（本轮必做项）

```console
$ launchctl kickstart -k gui/$(id -u)/com.crosery.console-magpie   # kickstart ok
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8791/api/session
200
```
```
① days=abc 现在与默认口径一致
usage-page?days=7   → 200 sha=41a00a486b924458
usage-page?days=abc → 200 sha=41a00a486b924458     ← 重启前是 52136dbf88d34616（352 B 空报表）
usage-page?days=    → 200 sha=41a00a486b924458

② 额度接口（拒绝发生在写入之前，无副作用）
{"totalUsd":""}     → 400 额度不能为空：填 0 表示不限额
{"totalUsd":"abc"}  → 400 额度必须是数字：0 表示不限额，上限 1000000
{"totalUsd":-3}     → 400 总额度必须是 0 或正数，0 表示不限额
{"totalUsd":"   "}  → 400 额度不能为空：填 0 表示不限额

③ 并发空串（R7-A 回归，新构建）
{"totalConcurrency":""} → 400 {"error":"总并发数不能为空：总并发必须是 0 到 500 的整数，0 表示不限速"}

④ 抽验无副作用
quota= {'totalUsd': 0, 'dailyUsd': 0, 'weeklyUsd': 0}  totalConcurrency= 0
```
（抽验用的 Key 是实例上已有的第一个 Key；三类拒绝都发生在任何 `UPDATE`/`addAudit` 之前，事后读回值与抽验前一致。）

### ⚠️ 我自己的操作披露（必须说明）
重启**之前**我在运行实例上发过一次 `PATCH {"totalUsd":""}` 作为「修前复现」——旧代码返回 **200** 并**真的写入了一份记录**（审计 `id=31826 update-quota 龚翰林 {"totalUsd":0,"dailyUsd":0,"weeklyUsd":0}`）。
- 影响评估：`server/db.ts:120-122` 的额度列默认值都是 `0`，该 Key 此前没有过任何 `update-quota` 审计记录，所以这次写入是 **0 → 0（幂等）**，**实际生效值没有变化**；副作用是一条审计记录。
- 教训（已按你们写进 `COORDINATION.md` 的方向对齐）：**对运行实例的抽验只发「必然被拒绝」的输入**（400 在写入之前返回），不要用真实 Key 发会成功的写请求；需要验证成功路径时用一次性 Key 并当场删除。
- 建议后续把这条也写进 COORDINATION：**「抽验优先用 reject-only 输入；需要写成功路径时先建临时对象、验完即删」**。

## 5. 命令与退出码

```
$ npx tsc -b        → tsc_exit=0
$ npm run lint      → lint_exit=0（仅 2 条既存 server/nativeResponses.ts no-control-regex warning）
$ npm run build     → build_exit=0 · ✓ built in 566ms
$ npm test          → test_exit=0 · ℹ tests 588 · pass 587 · fail 0 · cancelled 0 · skipped 1
```
```console
$ git diff --stat server/index.ts server/policy.ts
 server/index.ts  | 45 ++++++++++++++++++++++++++++++++-------------
 server/policy.ts | 11 ++++++++++-
 2 files changed, 42 insertions(+), 14 deletions(-)
```
（改动仅限三类相关表达式：并发文案引用、额度解析、8 处 `days`；未碰其它路由、中间件、静态托管、启动流程。）

## 6. 交付清单与剩余项

- 修改：`server/policy.ts`（仅导出常量）、`server/index.ts`（§1–§3 三类表达式）
- 新增：`server/policyCopy.test.ts`；扩展：`server/totalConcurrencyRoutes.test.ts`（额度 5 例 + days 3 例）
- 交付：本文件
- 未验证 / 仍是隐患：
  1. `boundedInteger` 会对小数 `floor`（`days=7.9` 旧行为是 7.9、现在是 7）——本轮统一了口径，未见依赖小数的调用方，但**未逐一核对 UI 是否有人传小数**（UI 只传 1/7/30/90）；
  2. 其余读接口（`/v1/usage` 等公开面）本来就用 `boundedInteger`，未再做真实请求抽验；
  3. 额度接口的**成功路径**在运行实例上未抽验（按上面的教训，需要一次性 Key 才安全），只在其端到端测试里覆盖。
