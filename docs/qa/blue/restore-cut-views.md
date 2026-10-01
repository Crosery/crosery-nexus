# 恢复被砍的页面与展示（task-77）

日期：2026-10-01 · 交付：**`凭据导入` 页整体恢复并验证**；逐页"旧有新无"对照表 + 渲染侧清单；两个**阻塞项**上报（见 §5，其中一个是 Lead 正在改的文件）。

---

## 1. 已恢复：`凭据导入` 页（旧 React `CredentialUploadPage.tsx` 整页被砍）

**旧实现做了什么**（`git show eb5a026:src/pages/CredentialUploadPage.tsx`，109 行）：选择 `.json` / `.zip`（单个 JSON 或包含多个 JSON 的 ZIP）→ 前端校验扩展名与体积 → `POST /api/credentials/upload`（`FormData` 字段 `file`）→ 展示逐条结果（已写入 / 已存在 / 失败 + 原因）与成功/跳过/失败计数 → 通知父级刷新凭据池。

**服务端契约（只读确认，未改 server）**：`server/index.ts:353` 的 `POST /api/credentials/upload`，返回 `{ traceId, total, uploaded, skipped, failed, items[] }`，部分失败用 **207**；`items[] = { name, label, ok, skipped?, code?, message? }`（`server/credentialUploadMerge.ts`）。前端 `src/api.ts:79 uploadCredentials()` **仍在**（当初只砍了页面，没砍 API）。上限来自 `bootstrap.credentialUploadLimits`。

**新页面** `src/pages/CredentialUploadPage.vue` + 路由 **`/credentials`**（选它而不是 `/credentials-upload`：更短、与 `/api/credentials` 同词；归入「接入管理」组——导航入口由 Lead 在 `ConsoleNav.vue` 加，我未动该文件）。

**功能与信息对照（一个不少）**：

| 旧能力 | 新实现 |
| --- | --- |
| `.json` / `.zip`，点击选择 | 同 + **拖拽**（`dragover/drop`），`accept` 与旧一致 |
| 扩展名校验 → 「只允许上传 .json 或 .zip 文件」 | 同，且**带上文件名与恢复方式**：「「qa-bad.txt」不是支持的格式：只接受 .json 或 .zip。请重新选择凭据包。」 |
| 体积校验（超限报错） | 同，报出**实际大小与上限**：「有 X，超过单文件上限 64 MB。请压缩或拆分后再上传。」 |
| 上限信息一句话 | 改为**可扫读标签**：`.json / .zip`、`单文件 ≤ 64 MB`、`最多 500 个条目`（取自 bootstrap 真实值） |
| 上传中 loading、按钮禁用 | 同（`:loading` + `:disabled`） |
| 逐条结果：文件名 + 账号标识 + 状态 | 同（标签 已写入 / 已存在 / 失败 + `message`/`code`） |
| 成功/跳过/失败计数 | 同（三项独立数值块） |
| 「不返回 token」提示 | 同（结果区副标题，**短句**而非整段加粗） |
| 上传后刷新凭据池 | 改为 toast 成功反馈 + 页头「查看上游账号池」直达 |
| 失败原因 | 新增 `Trace ID <code>` 脚注，直接指向排障入口 |

**渲染验证（截图 + DOM 断言，均已落盘）**：

| 状态 | 证据 |
| --- | --- |
| 初始 | `h1=凭据导入`；两个分区「选择凭据包 / 上传结果」；三个上限标签；拖拽区文案；空态「还没有上传记录」；`input[type=file]` 存在；上传按钮 **disabled** → `docs/qa/blue/shots/credentials-empty.png` |
| 选到不支持的扩展名 | `[role=alert]` = 「「qa-bad.txt」不是支持的格式：只接受 .json 或 .zip。请重新选择凭据包。」 → `shots/credentials-invalid.png` |
| 选到合法 json | 拖拽区显示 `qa-cred.json · 42 B · application/json`，错误消失，上传按钮 **enabled** → `shots/credentials-picked.png` |

**未做真实上传**：该端点会**写入生产 CPA 凭据**，按取证纪律不执行（只验证到"可提交"状态）；上传成功/部分失败/207 分支与 `items` 渲染由服务端契约与类型约束保证，未做端到端触发。

## 2. 逐页"旧有新无"对照

**页面清单：已 1:1 对齐**（旧 13 个 React 页 → 新 13 个对应 Vue 页 + 3 个新增：`AbLabPage` / `DocsPage` / `RtkPage`）。唯一**整页被砍**的就是 `CredentialUploadPage`（本轮恢复）。

**标题/标签项数对比**（旧源码提取 vs 新渲染提取，中文标题为主）：

| 页面 | 旧项数 | 新项数 | 结论 |
| --- | --- | --- | --- |
| Dashboard | 8 | 19 | 新页更细 |
| Keys | 15 | 44 | 新页更细 |
| Channels | 8 | 28 | 新页更细 |
| OAuth | 2 | 28 | 新页更细 |
| Analytics | 12 | 22 | 新页更细 |
| Usage | 20 | 28 | 新页更细 |
| Cache | 19 | 26 | 新页更细 |
| Models | 16 | 35 | 新页更细 |
| Charts | 12 | 12 | 需渲染确认（见下） |
| Monitor | 6 | 4 | **需渲染确认** |
| Help | 27 | 20 | 内容移入 `/docs`（独立页），非丢失 |
| Login | 3 | 5 | 一致/更细 |

**逐条核实过我最初的"旧有新无"候选**（先用正则从旧源码提取、再到新页面里验证），结论是**绝大多数是改名或已由更好的形式呈现**，例如：

| 旧有新无候选 | 核实结果 |
| --- | --- |
| Cache：`区间总命中率` / `区间总成本` / `区间总成本` | **已存在**（新页同名展示） |
| Monitor：`本窗口各 Key 消耗占比` | 新页有「占比」（`quotaShare` 数据仍在） |
| Analytics：`API Key 使用排行` / `请求明细` / `调用客户端` / `平均延迟` | **已存在**（排行、请求明细、调用客户端均在） |
| Usage：`热力图` / `token 分布` / `模型明细` / `每日强度` | **已存在** |
| Keys：`总并发策略` / `额度限制` / `记录使用方` 等 12 项 | **已存在**（新页项数 44 > 旧 15） |
| Channels：`上游渠道` / `出口代理` / `删除渠道` | **已存在** |
| Help 的 24 项 | 安装/接入/客户端代码块移入独立 `/docs` 页（`DocsPage.vue`），非丢失 |

**尚需"渲染确认"的两页（未完成项，见 §4）**：`ChartsPage`（旧横排四块「Token 消耗 / 响应延迟 / 失败构成 / 渠道分布 / 请求与错误趋势」是否被合并为 tab，需看图判断）与 `MonitorPage`（旧「上游账号分组 / 暂未读取到账号」是否仍在）。本轮的渲染清单脚本已抓到两页的 `h2` 列表，但我没有足够时间把两边逐块并排核对完。

## 3. 回归

| 扫描器 | 结果 |
| --- | --- |
| `qa-smoke`（已纳入 `/credentials`） | **exit 0**：14 条路由，`{"route":"/credentials","title":"凭据导入","errors":0,"failedRequests":0}` |
| `qa-viewports` | **exit 0**：112 组合，`failing 0`、`silentlyTruncatedTotal 0` |
| `qa-contrast` | **exit 1（78 项，全部同一个类，且不是本页）** → 见 §5 |
| `qa-a11y` | 未重跑（预算用尽）；我改动的页面与 task-72 的焦点环/landmark 规则无关，风险低，但**未验证** |

`tsc -b` / `build`：**被其它队友的在途改动阻塞**（`server/modelCatalog.ts`、`server/modelPricingSources.test.ts` 报错），我用 `npx vite build`（exit 0）产出 dist 完成了页面验证；我自己的文件在树干净时 `tsc -b` 通过（task-72 时实测 0 error）。

## 4. 未完成 / 未验证清单（如实）

1. **ChartsPage / MonitorPage 的逐块并排核对**未做完（§2 末），需要下一轮用"渲染侧旧新截图并排"的方式确认是否有被合并的展示块。
2. **真实上传路径未触发**（会写生产凭据），207 部分失败分支未端到端验证。
3. **`qa-a11y` 未在本轮重跑**。
4. **导航分组标题**（用户说的"tab 分类没了"）由 Lead 在 `ConsoleNav.vue` 修复；我未动该文件，也**未**核对渲染结果（等 Lead 通知后再加/看）。
5. 本页**未做**移动端逐断点人工核对（`qa-viewports` 的 112 组合已覆盖无静默截断）。

## 5. 两个阻塞项（需要 Lead / 队友处理，不在我写范围）

1. **`qa-contrast` 78 项失败 = 同一个类 `tx-bui-sidebar-nav__group-label`**（侧边栏分组标题：总览/接入管理/用量分析/运行监控/帮助），颜色 `rgb(111,118,153)` on white = **4.44:1**，要求 4.5:1，**差 0.06**。13 条路由 × 6 个标题。这是 **Lead 正在改的 `ConsoleNav.vue`** 引入/暴露的（分组标题渲染出来后才被扫到），我未动该文件。**建议**：把分组标题颜色换到 ≥4.5:1 的 token（例如 `--tx-text-color-secondary` 的更深一档），改一行即可；或把分组标题字号提到 ≥18.66px 走大字号 3:1 档（不推荐，视觉会变重）。
2. **`tsc -b` / `npm run build` 当前是红的**（不是我的文件）：`server/modelCatalog.ts(7,26)` 与 `server/modelPricingSources.test.ts(54,48)` 报错，看起来是队友在途的改动（task-66/68 之后的定价源重构）。我不改 `server/**`，请对应负责人收口后再跑一次全量构建。

---

# 附：第三十五轮收尾（Lead 解除两个阻塞后）

## A. 逐块并排核对：找到并恢复了**第二处真实被砍**

**ChartsPage：旧有「Token 消耗（每小时 Token 总量）」→ 新缺 → 已恢复。**
- 证据：旧 `ChartsPage.tsx:69` 的 `<h2>Token 消耗</h2><p>每小时 Token 总量</p>`；新 `ChartsPage.vue` 里 `grep -nE "token|Token"` **零命中**（整块被砍）。
- 关键：**后端一直在返回** `trend[].tokens`（`server/usageReports.ts:112-123` 构造 `{ bucket, requests, tokens, errors }`），所以只需客户端恢复 —— **不需要改 server**。
- 恢复内容（沿用页面既有的 inline-SVG 折线口径，未引入新依赖/魔法数字）：`Token 消耗` 卡片（与请求趋势同 viewBox、同 stroke），并把 **Token 总量** 加入统计行。
- 验证（渲染）：`/charts` 卡片序 = `请求趋势 → Token 消耗 → 模型用量 Top 8 → 渠道分组用量 Top 8 → 最慢的上游（按 P95）→ 状态码与错误类别`；统计 = `请求总量 60 / 错误数 23 / 错误率 38.3% / **Token 总量 4375** / 时间桶 4`；Token 折线 path 非空（51 字符）→ `shots/charts-token-restored.png`。

**MonitorPage：核对结论是"没有丢块"，只是命名升级。**
| 旧 | 新 | 结论 |
| --- | --- | --- |
| 账号监控（页标题） | 页标题「上游账号与额度监控」 | 升级 ✓ |
| 上游账号分组 | 按渠道类型分组，每组 `<h2>` = 渠道名 | ✓（本轮环境无账号，只看到空态，分组渲染**未在有数据环境验证**）|
| 暂未读取到账号 | 空态「暂未接入上游监控账号」 | ✓ |

## B. 间距：删掉 5 个页面的 gap 覆盖（共享 `.page-stack` = 28px 生效）

删除 `.analytics-page` / `.cache-page` / `.help-page` / `.monitor-page` / `.usage-page` 里的 `gap: 16px`
（RtkPage 由 Lead 已改；ModelsPage 本就没有覆盖）。保留注释说明"别再设 gap"，避免后人加回来。
Dashboard / Keys / Channels 用的是共享 `.page`（16px）且**没有** scoped `gap` 覆盖 —— 属统一值，无"外层比内层挤"的问题，未改动。

**实测间距（渲染）**：`/analytics /cache /usage /monitor /models /rtk` 的 `.page-stack` 计算 `row-gap` 全部 = **28px**，
实测相邻块间距 28px（首个块与页头之间 32px = 页头自带下边距 + 28px 的视觉结果）。

## C. 导航改动核对（Lead 的 `10cf65e`）

| 项 | 实测 |
| --- | --- |
| 分组标题渲染 | 侧边栏出现 6 个分组标题：`总览 / 接入管理 / 用量分析 / 运行监控 / 帮助 / 实验` |
| 分组标题对比度 | 颜色不再是 tuffex 默认 `rgb(111,118,153)`（4.44:1）；`qa-contrast` 全绿（见 D） |
| `/credentials` 入口 | 侧边栏可见「凭据导入」；`/credentials` H1 = 「凭据导入」✓ |
| 面包屑 | `/credentials` 面包屑不再出现原始路由片段（Lead 的 `src/lib/nav.ts` 单一真源） |

## D. 回归（本轮全部重跑）

| 扫描器 | 结果 |
| --- | --- |
| `qa-a11y`（路由含 `/credentials`） | **exit 0，25/25 通过** |
| `qa-contrast`（路由含 `/credentials`） | **exit 0，`failing 0`、`renderFailures 0`** |
| `qa-smoke` | **exit 0**（14 路由，`/credentials` 无错误/无失败请求） |
| `qa-viewports` | **exit 0**（112 组合，0 失败、0 静默截断） |

`npx vite build` = 0；`tsc -b` 仍受队友在途改动（`server/modelCatalog.ts` / `server/modelPricingSources.test.ts`）阻塞，**非前端问题**。

## E. 仍未完成

1. **Monitor 的分组渲染**未在有账号的环境下验证（本轮只有空态）。
2. **真实凭据上传**（写生产 CPA）未触发，207 分支未端到端验证。
3. `ModelsPage` 之外的其余页面的"逐字段"深核对（本轮做了标题/卡片/统计块的层级核对）。
4. Dashboard/Keys/Channels 依旧用共享 `.page`（16px）而非 `page-stack`（28px）——**是否统一到 28px 需要设计决策**，我未擅自改动。
