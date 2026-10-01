# 模型与上游自动更新：双源价格 + 全量模型 + magpie 安全更新（task-78 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 用户原话："支持自动更新上游最新的 magpie，支持自动更新上游最新的模型，
模型总览里面包含所有的模型以及对应 openrouter 和 models.dev 里面同步的最新价格。"

---

## 0. ⚠️ 一个必须先说的约束冲突（需要 Lead 接手一步）

任务要求"跨 harness 共享能力统一放 `~/.agents/crosery/`，改共享实现而不是 fork"。
但**我这一轮会话的文件沙箱是 `workspace-write`**，`~/.agents/crosery/` 在工作区之外 ⇒
实测 `touch ~/.agents/crosery/.dsh-write-test` → `Operation not permitted`（审批提示已关闭，不能提权）。

所以共享实现的改动**以补丁形式随仓库交付**，由有能力写共享目录的人（或 Lead 的会话）执行一步：

```bash
bash scripts/apply-shared-sync-pricing.sh --dry-run   # 先干跑
bash scripts/apply-shared-sync-pricing.sh             # 幂等：已应用过就跳过；有备份 + node --check
```

补丁：`docs/qa/blue/patches/crosery-sync-pricing.patch`（212 行，只动 `~/.agents/crosery/sync.mjs`）。
**没有 fork**：改的就是那唯一一份同步实现，只是"谁的手来落盘"不同。本仓库侧只做薄 adapter（§2）。

---

## 1. 现状复核（不照抄 Lead 结论）

| Lead 的说法 | 复核结果 |
| --- | --- |
| `server/modelCatalog.ts` 价格是"网关按 models.dev 动态富化" | ✅ 属实：`pricingFromGateway(definition)` 读 CPA 下发的 `cost`，本地 `pricing.data.json` 只兜底 |
| `server/modelSync.ts` 有 shared-catalog / channel-probe / merged 三种来源 | ✅ 属实，且 `sharedCatalogPath()` 已经读共享产物 `~/.agents/crosery/catalog.json` |
| 共享脚本 `~/.agents/crosery/bin/crosery-models-sync.sh` 在跑 | ✅ 属实（launchd `com.crosery.crosery-models-sync`），它是"唯一同步实现 `sync.mjs` + 三个 host adapter"的入口 |
| **OpenRouter 目前不是价格来源** | ✅ **属实，且比描述的更精确**：`sync.mjs` **已经**联网拉了 OpenRouter（`https://openrouter.ai/api/v1/models`）与 `models.dev`（`https://models.dev/api.json`），但它俩的 `pricing` / `cost` 字段**被完全丢弃**，只用来补 context/effort/modalities。所以"缺的不是拉取，是**采集与落盘价格**"。 |
| magpie 更新 | 🔎 补充事实：内核是**单个二进制** `~/.agents/crosery/magpie-console/bin/magpie-kernel`（21MB），版本内嵌为 `crosery-<rev7>`（`deploy/magpie/build.sh` 的 `-X main.version=`）；上游检测与契约校验**已存在**于 `scripts/magpie-upstream.mjs`（`check`/`verify`/`publishCandidate`）。本机已有手工备份先例 `magpie-kernel.before-api-contract-20260930`。 |

---

## 2. 双源价格（①）：采集在共享侧，落地在本仓库薄 adapter

### 2.1 共享侧（补丁）：把两个来源的价格采下来，各自带时间戳

- OpenRouter：`pricing.prompt / completion / input_cache_read / input_cache_write`（**每 token** 的美元字符串）→ ×1e6 归一到 **USD / 百万 token**；
- models.dev：`cost.input / output / cache_read / cache_write`（本来就是每百万）→ 直接采；
- 公开目录缓存版本 `1 → 2`（旧缓存没有价格，必须重取；v1 缓存会被忽略后重新拉取）；
- 产物新增（**加法，向后兼容**）：
  ```json
  "pricing": {
    "sources": { "openrouter": {"ok":true,"fetchedAt":…,"entries":456},
                 "models.dev": {"ok":true,"fetchedAt":…,"entries":214} },
    "rows": [ { "id":"<归一化 id>", "source":"openrouter", "sourceId":"anthropic/…", "prices": {"openrouter": {"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75,"unit":"usd-per-million-tokens"}} } ]
  }
  ```
- `--dump-pricing`：只读打印（不写产物），用于验收与排障。

### 2.2 真实调用实测（含时间戳，**只读干跑**）

```
$ date -u +"%Y-%m-%dT%H:%M:%SZ"; node /tmp/sync.mjs --dump-pricing     # 补丁版，--apply 未执行
开始 2026-10-01T13:01:21Z
网关      : https://ai.crosery.com/v1            网关模型 52 个
公开目录  : 705 条（已刷新）
价格来源  : {"openrouter":{"ok":true,"fetchedAt":1790859683478,"entries":456},
             "models.dev":{"ok":true,"fetchedAt":1790859684909,"entries":214}}
价格条目  : 670 行（两个来源合计）
  openrouter  aion-3.0          {"input":3,"output":6,"cacheRead":0.75,"unit":"usd-per-million-tokens"}
  models.dev  alibaba:kimi-k3   {"input":3,"output":15,"cacheRead":0.3,"unit":"usd-per-million-tokens"}
  models.dev  alibaba:qwen-flash{"input":0.05,"output":0.4,"unit":"usd-per-million-tokens"}
干跑：未写盘。加 --apply 落地。
```

**没有副作用**：`--apply` 未执行；共享缓存 `cache/public-catalog.json` 仍是 `version: 1`（复核过）。

### 2.3 本仓库薄 adapter（不联网）

| 文件 | 作用 |
| --- | --- |
| `server/pricing.ts` | 新增来源价格表：`applySharedPricing()` / `getPricingSources(model)` / `pricingSourceStatus()` / `pricingSourceModelIds()`。两个来源**各自保存**（不合并、不取其一），每项带该来源 `fetchedAt`；**缺失就是 `undefined`** |
| `server/modelSync.ts` | `loadSharedPricing()`：读共享产物的 `pricing` 段灌进上面的表；老产物/缺文件/来源失败 ⇒ 返回 `degraded` 原因（**降级可见**） |
| `server/modelCatalog.ts` | 懒加载（TTL 10 分钟）+ 每个模型带 `pricingSources` / `availableOnGateway` / `unpriced`；`mergePricingSourceModels()` 做**并集**（仅在"不限可见范围"的调用上做——按 Key 的视图保持范围不变，避免越权展示） |

降级语义（三条硬规则，测试逐条钉住）：
1. 某来源 `ok:false` ⇒ 响应里能读到 `error` 原文；该来源**缺席**而不是补 0；
2. 产物缺失/老版本/为空 ⇒ `degraded` 列出 `shared-pricing-missing` / `shared-pricing-empty`；
3. **不拿旧值冒充新值**：灌入空快照后，上一次的价格会被清掉（测试断言）——"上次的数字"必须由展示层标注为陈旧，而不是冒充本次结果。

---

## 3. 模型总览含"所有模型"（②）

- 并集 = 网关可用 ∪ 目录已知 ∪ 两个价格来源出现过的；
- 每条带：`providers`、`context_length`/`max_completion_tokens`、`availableOnGateway`（价格来源里有但网关没有 ⇒ `false`，UI 标"仅目录收录"）、两个来源各自的输入/输出/缓存读/缓存写 + 抓取时间；
- **缺价格写「未收录」**：`unpriced: true` 且**不带任何 0 值字段**（测试逐字段断言 `> 0` 或缺席）——0 与"未收录"是两件事，前者是免费。

---

## 4. 自动更新（③ 模型 / ④ magpie）

### 4.1 模型（③）：扩展既有 `modelSync`，不另起一套

- **唯一的联网同步**仍是共享 `sync.mjs`（它已有：网关失败不写产物、收缩保护、迟滞、临时文件 + `rename` 原子替换 + 每次备份 `catalog.bak-<ts>`）；
- 本仓库侧只做：读产物（薄 adapter）+ 懒加载 + 展示字段；
- **幂等**：`applySharedPricing()` 对同一份快照重复调用结果一致（测试）；
- **可观测**：`pricingSourceStatus()` 给出每个来源的 `ok/fetchedAt/entries/error` + `loadedAt` + `degraded`；
  失败**不影响目录本身**（`refreshSharedPricingIfStale()` 里 catch，目录照常返回）。

### 4.2 magpie（④）：`scripts/magpie-update.mjs`（编排 + 安全闸门）

```
node scripts/magpie-update.mjs status   [--root DIR]                      # 只读
node scripts/magpie-update.mjs check    [--root DIR] --from DIR|URL       # 只读（只写状态 JSON）
node scripts/magpie-update.mjs rehearse [--root DIR] --from DIR|URL       # 临时目录里跑完整流程
node scripts/magpie-update.mjs apply --confirm-apply [--root DIR] --from DIR|URL | --from-build CHECKOUT
```

**状态机与时序**（实测行为，不是设想）：

```
status ──▶ check ──(版本相同)──▶ 幂等退出 0，不写产物、不产生备份
                └─(有新版本)─▶ download/构建 到临时目录
                                   │ sha256 不符 ⇒ 立即拒绝（旧文件**没被碰过**）→ failed-before-swap
                                   ▼
                               verify（sha256 + 版本回读）
                                   ▼
                               backup（<binary>.before-<当前版本>-<ts>）
                                   ▼
                               swap（写入 .incoming-<pid> → rename 原子替换）
                                   ▼
                               verifyPostSwap（替换后再读一次）
                                   ├─ 通过 ⇒ updated
                                   └─ 失败 ⇒ **回滚**：把备份写回目标 → rolled-back（非 0 退出）
```

**安全边界**（用户明确要求）：默认只读；`apply` **必须** `--confirm-apply`，否则退出码 2 且零改动；
`rehearse` 全程在 `mkdtemp` 临时 root 里；脚本**不碰 launchd、不重启服务**。

**实测证据**（10 条用例，全绿，均为临时目录 + 本地"发布源"夹具，不联网）：

| 用例 | 结果 |
| --- | --- |
| status / check 只读（产物逐字节未动，只更新状态里的检查时间） | ✔ |
| `apply` 缺 `--confirm-apply` → 退出码 2 且零改动 | ✔ |
| 幂等：同版本 apply 不产生备份、产物保持原字节 | ✔ |
| 全链路：下载 → 校验 → 备份 → 原子替换（备份 = 旧版本，状态跟上新版本） | ✔ |
| 发布物 sha256 不符 → 旧版本**逐字节完好**、无半成品、状态记 `failed-before-swap` | ✔ |
| 发布源拿不到（模拟网络失败）→ 旧版本零改动 | ✔ |
| `rehearse` → 真实 root 一字节未动，临时 root 里换成新版本 | ✔ |
| 状态 JSON 六个字段齐全（给服务端适配器用） | ✔ |
| **替换后校验失败 → 真回滚**（注入后置校验失败；备份被放回、目标逐字节恢复、无 `.incoming-` 残留） | ✔ |

**语义级负向验证**（去掉校验）：
```
临时移除「下载阶段 sha256 校验」+「替换前校验」+「后置校验的默认实现」
→ ✖ 校验失败必须回滚：sha256 不匹配时旧版本原样保留   （其余 9 条仍绿）
还原后 scripts/magpie-update.mjs shasum = add8429d41… 与基线**逐字节相同** → 10 条全绿
```

### 4.3 真实内核替换：**没有做**（按安全要求）

- `apply` 的真实路径需要：干净的上游 checkout + Go 工具链 + `deploy/magpie/build.sh`。

  我**没有**执行真实替换（用户要求"不要未经确认就替换本机正在跑的内核"），**也没有**验证真实构建链路
  （Go/上游 checkout 未在本轮准备）——这属于"未验证清单"（§6）。
- 生产用真实发布源时，`check` 可直接复用既有的 `node scripts/magpie-upstream.mjs check`（上游 revision 检测，
  已存在于仓库），本脚本的 `--from-build` 与之衔接。

---

## 5. UI（⑤）：两个新组件 + 挂载点（排版由 Lead 收口）

| 组件 | 建议挂载点 |
| --- | --- |
| `src/components/ModelPricingSources.vue` | **模型总览**（`src/pages/ModelsPage.vue`）的模型行/详情处：props 直接吃 `GET /api/public/model-catalog` 的 `models[]` 条目（含 `pricingSources` / `availableOnGateway` / `unpriced`），并排显示两个来源 + 各自抓取时间 + 「未收录」，来源失败时显示降级横幅 |
| `src/components/MagpieUpdatePanel.vue` | **系统维护 / RTK 设置**（Lead 正在改 `RtkPage.vue`，我没有动它）：props `status` 吃 `scripts/magpie-update.mjs status --json` 的输出；三个动作 `check` / `rehearse` / `apply`，"更新内核"需要**勾选确认**后才可点 |

我**没有**改 `src/pages/RtkPage.vue` 与 `src/styles/**`，也没有改任何现有页面（挂载由 Lead 收口）。

---

## 6. 未验证清单 / 残余（如实列出）

1. **共享侧补丁尚未落盘**（我的沙箱不允许写 `~/.agents/crosery/`）⇒ 需要 Lead/用户跑一次
   `bash scripts/apply-shared-sync-pricing.sh`；在此之前，本仓库 adapter 会如实报
   `shared-pricing-missing`（**这就是"降级可见"的现场**，不是 bug）。
   同理，`--apply` 落产物那一步**没有执行**（会改共享产物 → 属于真实状态变更，需明确批准）。
2. **真实 magpie 构建/替换链路未验证**（缺 Go 工具链与干净 checkout）：本轮只验证了状态机、校验、
   备份、原子替换与回滚；真实构建 + 真实二进制的"内嵌版本回读"是按 `deploy/magpie/build.sh` 的实现契约写的，
   没有实际跑通。
3. **服务端没有新增路由**（写范围不含 `server/index.ts`）：因此 `MagpieUpdatePanel` 的 `status` 需要
   Lead 决定由哪条路由下发（或在系统维护页由前端调后端已有入口）；模型价格字段已经通过**既有**的
   模型目录接口（`/api/public/model-catalog`）自动带出，不需要新路由。
4. **`npm test` 有 1 条与本次改动无关的失败**：`路由表与侧栏导航一一对应（差集为空）` →
   `没有从 ConsoleNav.vue 解析出导航项，解析逻辑需要更新`。该用例只解析前端 `.vue` 源文件，
   与本轮的 server/scripts 改动无关；工作区里另有 5 个 `src/pages/*.vue` 的**他人未提交改动**，
   应由正在改前端的同学处理。**我自己的 14 条新用例全绿**（`server/modelPricingSources.test.ts` 4 条 +
   `scripts/magpie-update.test.mjs` 10 条）。
5. `node --test`/`npm test`/`npm run test:magpie`/`npx tsc -b`/`npm run build`/`npm run lint` 中：
   **除上面那条无关失败外全部 exit 0**（test:magpie 107 通过；tsc/build/lint 0）。
