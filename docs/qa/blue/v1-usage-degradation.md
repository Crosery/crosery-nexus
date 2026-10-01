# `/v1/usage` 降级 + OAuth 校验出口统一 + 跨 Key 隔离已验证（task-73 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依据：红队第二十六轮 `docs/qa/red-team/v1-authz-and-keyboard.md`

三件事：① R26-B 自助面不再因管理面抖动 500（降级而非掩盖）；② R26-A `/start` 与 `/callback`
共用同一个「校验失败 → 400」出口；③ 把红队**没能验证**的跨 Key 数据隔离**变成已验证**。

---

## 1. R26-B：`/v1/usage` 硬依赖管理面 → 改为「降级而非掩盖」

**修前链路**：`/v1/usage` 里 `activeProviderPredicate(await listGroupsForReporting(), 'provider')`
为做 provider 过滤去读渠道分组；管理面不可用（`CPA_MANAGEMENT_KEY 未配置`、上游 5xx）时**直接 500**，
而 `/v1/usage/requests` 不用这条依赖 → 同一个环境一个 500、一个 200（红队指出的可用性不一致）。

**修法**（`server/index.ts`，单点 helper `resolveActiveProviderFilter()`）：

| 管理面状态 | 行为 |
| --- | --- |
| 可用 | 返回的过滤条件与修前**完全一致**（同一个 `activeProviderPredicate` 结果），响应体里**不出现**降级字段、**不设置**降级 header ⇒ 逐字节不变 |
| 不可用 | **200**，过滤降级为 `1 = 1`（不过滤），并**显式暴露**：响应 header `X-Usage-Degraded: provider_filter_unavailable` + 响应字段 `degraded: { reason, note, detail }` |

**语义差异写清楚了**（不静默）：
> `note`: 无法读取渠道分组，本次结果未按 provider 过滤（可能包含已停用渠道的历史用量）

差异只可能"**多**"（把该 Key 自己历史上所有 provider 的用量都算进来），**不会**跨 Key —— SQL 仍然是
`WHERE key_hash = ?`，与 provider 过滤是两个独立条件（§4 ②的用例在降级状态下断言"仍看不到别的 Key 的标记模型"）。

**为什么不用"上次成功分组的缓存"**：`reportingGroupStore`（`app_settings` 里的
`reporting.groups.lastKnown.v1`）本来就是上次成功分组的落库结果，`listGroupsForReporting()` 优先读它；
只有当**它也没有**（全新实例 / 从未成功拉过）时才需要管理面。此时拿"更早的旧分组"去过滤，会把用户
**真实存在的用量藏起来**（比多显示更糟，而且不可见），所以选择"不过滤 + 显式标注"。

---

## 2. R26-A：`/start` 与 `/callback` 共用一个校验出口

修前：`/callback` 对非法 provider → **400**（带可选值文案）；`/start` → **500**（同一句话放在 500 里）。
500 会让监控误判、也可能被客户端重试放大。

修法：新增单点 `requireOAuthProvider(res, provider)` —— 白名单校验 + 统一构造
`400 { error: '不支持的 OAuth 提供商：… 可选：…', reason: 'provider_not_supported' }`；
`/api/cpa/oauth/start` 与 `/api/cpa/oauth/callback` **都只经过它**（回调侧原先的内联校验已删除）。

---

## 3. 跨 Key 隔离：从「未验证」到「已验证」

红队诚实地说"我不拿没报错当隔离成立"，而它当时因为 500 根本跑不到正向路径。现在补上（`server/v1UsageIsolation.test.ts`）：

**造数据**（临时实例 + 生产参数；直接写 SQLite，触发器自动维护 rollup）：
- 两个**真实 Key**：`sk-live-alpha-6f2a`（名称 alpha-key）、`sk-live-beta-91c7`（beta-key），
  `key_hash = sha256(key_value)`（与生产同一算法 `cpa.ts:hashKey`）；
- 一个活跃分组 `alpha`（`reporting.groups.lastKnown.v1`）；
- `usage_events`：A → `shared-model`×2 + `marker-alpha-model`×1；B → `shared-model`×1 + `marker-beta-model`×1
  （`provider='alpha'` 才不会被 provider 谓词过滤掉）；`usage_hourly_rollup` 由**触发器**同步生成。

**断言（集合级对照，不是"没报错"）**：
1. **独立参照**：直接查库得到 A、B 各自的模型集合，并先断言 `rollup` 与 `events` 两条路径**一致**
   （A = {shared, marker-alpha}，B = {shared, marker-beta}）；
2. `GET /v1/usage?days=30` 带 A 的 Key → 返回集合**等于库内 A 的集合**，且响应文本里**不含** B 的标记模型；
   带 B 的 Key → 对称成立；
3. 两边唯一的交集**恰好是 `shared-model`**（证明确实是"按 Key 切分"，而不是"渠道数据整体看不见"）；
4. **参数注入**：A 的凭据 + `?key=<B的Key>&keyId=<B的hash>&key_hash=&keyHash=&hash=&name=beta-key`
   → 返回里**仍然没有** B 的标记模型；
5. 同族 `/v1/usage/requests` 在同一环境两个 Key 都 200，且明细集合与汇总集合**逐个一致**
   （红队指出的可用性不一致已消失）；
6. 不存在的 Key → 401。

> 这一步是本轮最有价值的产出：**正向路径真的跑通了**，隔离是"看到的集合"级别的证据，而不是"没报错"。

---

## 4. 测试与负向验证

`server/v1UsageIsolation.test.ts` 三条（真子进程 + 生产参数 + 真实 HTTP + 真实 SQLite 数据）：

1. `跨 Key 隔离：两个真实 Key 各自只看到自己的标记模型（集合级对照 + 参数注入无效）`
2. `管理面不可用时 /v1/usage 降级为 200 + 显式标注（不是 500，也不静默改语义）`
3. `同一非法 provider：/start 与 /callback 状态码与 reason 必须一致（都不是 5xx）`
   —— 4 个非法变体（`evil.com`、`../../etc`、`claude; rm -rf /`、`unknown-provider`）逐个断言**两条路径状态码相等且都是 400**，并都带 `reason=provider_not_supported` 与「可选：」文案

**语义级负向验证**（临时还原两处修法）：

```
✔ 跨 Key 隔离：…                                   ← 与这两处修复无关，仍绿（说明它是独立证据）
✖ 管理面不可用时 /v1/usage 降级为 200 + 显式标注      ← 还原降级逻辑后必红
✖ 同一非法 provider：/start 与 /callback 状态码一致   ← /start 退回直接调用后必红
还原后 server/index.ts shasum = 9f8c1188… 与基线**逐字节相同** → 三条全绿
```

### 命令退出码

```
npm test run#1 → ℹ tests 680 · pass 679 · fail 0 · skipped 1（16.69s）  exit 0
npm test run#2 → ℹ tests 680 · pass 679 · fail 0 · skipped 1（17.22s）  exit 0
npm run test:magpie → ℹ tests 107 · pass 106 · fail 0 · skipped 1       exit 0
npx tsc -b --pretty false → exit 0 ｜ npm run build → ✓ built in 516ms ｜ npm run lint → exit 0
```

---

## 5. 现网状态与重启（按约束**没有重启**）

task-73 明确要求"不要重启/停服务"，因此本机 `com.crosery.console-magpie` **仍跑着改动前的代码**。
两点如实说明：

1. **R26-B 对本机实例本来就不会触发**：本机是 `GATEWAY_ENGINE=magpie` + `MAGPIE_CONTROL_PLANE=local`，
   `listGroupsForReporting()` 走本地分组存储、不需要 `CPA_MANAGEMENT_KEY`；
   红队的 500 出现在"管理面不可用"的环境（cpa 模式 / 密钥缺失 / 上游 5xx）——正是我们面向外部部署的形态。
2. **R26-A 的 500 在本机是可复现的**（`/api/cpa/oauth/start` + 非法 provider）；
   修好后要生效需要一次 `launchctl kickstart -k gui/$(id -u)/com.crosery.console-magpie`（**不是 bootout**）。
   我在隔离实例上验证了等价行为（同一份代码、同一批 HTTP 路由），**是否现在重启请你决定**：
   若要我重启并做现网抽验，回一句即可（我会用 `/start` 非法 provider → 400 做抽验，不碰真实凭据）。

---

## 6. 残余

1. **降级期间不再过滤 provider**：这是有意的语义放宽并已显式标注；若将来要求"降级也要过滤"，
   正确做法是**持久化上次成功分组**（已有 `app_settings` 通道）并在降级时用它，同时把
   `degraded.reason` 改成 `provider_filter_stale`、附上 `generatedAt`——本轮的实现为此留了扩展点。
2. `/v1/usage/requests` 不依赖管理面（本来就不依赖），未做任何改动；若将来它也引入外部依赖，
   应复用同一个 `resolveActiveProviderFilter()` 风格（降级 + 标注），而不是各自 catch。
3. 未新增依赖；`ok`/`reason` 的字段命名沿用本仓库既有约定（`reason` 为机器可读代码）。
