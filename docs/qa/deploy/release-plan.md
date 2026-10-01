# 中转站生产控制台 发布方案（release-plan）

- **日期**：2026-10-01 ｜ **任务**：task-15 ｜ **执行**：deploy-reconciler ｜ **状态**：准备与本地演练完成，**未触碰生产**
- **目标 release 基底**：`/opt/crosery-api-console-current` → `20260928-reset-clears-cooldown`（下面简称 **BASE**）
- **发布源（本轮刷新）**：**`fabd4fe`（本地 HEAD）** —— 定义：以「组装时 `git rev-parse HEAD` 的提交」为发布源。本轮序列：`26554bd`（task-18 刷新点）→ `9a9b9db`/`527bb47`（测试夹具 + 本轮文档）→ `e52617a`（删除 25 个 React 死文件）→ **`fabd4fe`（删除死树残留 `src/App.css`、`server/pageMotionVisibility.test.ts`，当前 HEAD）**。上机前请再用 `git rev-parse HEAD` 复核；HEAD 一动就重跑组装（§A2 命令）。
- **配套**：[assemble-release.mjs](<docs/qa/deploy/assemble-release.mjs>)（组装+校验）、[release-runbook.md](<docs/qa/deploy/release-runbook.md>)（上机步骤与回退）
- **发布不做删除**（Lead 决定）：release 里 `src/**/*.tsx` 沿用 BASE 版本，本地对死树的删除不同步进 release，见 §4.4。
- **本方案遵守** `deploy/edge/README.md:37-44`：**以 BASE 复制为基底再叠加**，不用本地树整体替换。

### 0.2.1 再刷新（React 移除后）：发布源 = \`8fa05fe\`

| 项 | \`526fdfc\` | **\`8fa05fe\`** |
| --- | --- | --- |
| 组装树 | 413 文件 / 7.19 MB，MANIFEST 412 | **414 文件 / 6.83 MB，MANIFEST 413** |
| 缺失生产文件 | 0 | **0** |
| dist | 77 文件 | **77 文件**（vite manifest 47，其中 \`.vue\` 18、\`.tsx\` **0**） |
| 结果 | PASS | **PASS（1 条警告：本地 node v26 vs engines）** |

体积下降来自 **React 全家桶彻底移除**（\`/docs\` 迁到 Vue：6 个直接依赖 + \`recharts\` + 其传递引入的 redux 系；\`npm ls react --all\` 为空）。发布包仍按 \`--frontend=vue\` 组装；**keep-prod 模式同样需要生产 dist 快照，上机前务必重跑**。

---

## 0.2 【第 10 轮刷新】发布源 = `526fdfc`（当初写此文时为 `fabd4fe`）

上机前**必须以组装时 `git rev-parse HEAD` 为准**（本文其余数字仍是 `fabd4fe` 时点）。本轮在**干净工作树**上重跑了 `--frontend=vue` 组装，结论：

| 项 | `fabd4fe`（本文原值） | **`526fdfc`（本轮）** |
| --- | --- | --- |
| 组装树 | 416 文件 / 7.10 MB，MANIFEST 413 | **413 文件 / 7.19 MB，MANIFEST 412** |
| 缺失生产文件 | 0 | **0** |
| 非 dist 新增 | 95 add + 36 replace | **334 add + 0 replace**（口径按本轮脚本；旧口径见 §1） |
| dist | 74 文件 | **77 文件**（vite manifest 46 条，`.tsx` 条目 **0**） |
| 结果 | PASS | **PASS（1 条警告：本地 node v26 vs engines `>=24 <25`）** |

- **keep-prod 模式本轮未重跑**：它需要**生产 dist 快照**（`--dist-from`），本轮手上只有 `vue` 模式的 dist；§1 里 keep-prod 的数字仍是 `fabd4fe` 时点。上机时若要选 B，请先用生产 dist 重跑一次组装再进入 §5。
- 本轮先把工作树弄干净才组装：先前一直存在的未跟踪文件 `public/tuffex-dashboard-preview.png`（**截图里含 owner 的 API Key 名称**，且位于会被静态托管的 `public/`）已移出到 `docs/qa/evidence/` 并提交——组装脚本本来就把它排除在 release 之外，但它会让「工作树必须干净」这条断言失败，而这条断言正是「发布内容必须能由某个 commit 复现」的保障。
- 本地已追加提交若干（RTK 跨进程锁与 fencing、排版收口、窄屏修复等）；**这些都会随本次发布一起上**，因此 §1 的「用户可见变化」还应对照 `docs/qa/STATUS.md` 的最新一节。

---

## 0. 结论（TL;DR）

1. 发布内容 = **BASE 全量文件** + **131 个本地非 dist 文件**（replace 36 / add 95）+ **可选的新 dist**（发布源 `fabd4fe`）。本地演练两种模式都通过校验：**0 个生产文件缺失**。
2. **前端要不要一起发，是产品决策**（§1）：本地这批工作把前端从 React 换成了 Vue/Tuffex，且**本地已无法再构建 React 控制台**（证据 §1.3）——所以「保留 React」等于冻结现有 UI、以后只能手改生产里的预构建 dist。
3. 服务端变更面很小且大部分**只在 magpie 模式下生效**：生产 `.env` 未设置 `GATEWAY_ENGINE`（=默认 `cpa`），所以 Magpie/RTK 代码路径在生产默认**休眠**；真正会在生产生效的只有 **① 额度重置清冷却（事故修复）② 凭据导入端点安全收口 ③ bootstrap 并发读 ④ 新增 `/api/rtk/*`、`/api/ab/preference` 端点**。
4. **schema 无变化**：`server/db.ts`、`server/quotaLedger.ts`、`server/usageRollup.ts` 与生产**逐字节相同**（§7.1）——生产 3.7GB 的 `console.db` 不会因这次发布重新迁移。
5. 本地演练发现并修掉了组装脚本自身 3 个 bug + 1 个误报（§6.3）——**这就是真跑的价值**；两处真实 WARN 是「本地用 Node v26.7.0 构建，生产 runtime 是 v24.20.0，且 `package.json engines` 声明 `>=24 <25`」。

---

## 1. 【必答】要不要把 Vue 前端一起发？（产品决策）

### 1.1 两个选项

| | **选项 A：全量发布（含 Vue）** | **选项 B：只发服务端（保留 React）** |
| --- | --- | --- |
| 组装命令 | `--frontend=vue` | `--frontend=keep-prod` |
| 组装树 | **416 文件 / 7.10 MB**；MANIFEST 413 条 | **342 文件 / 5.88 MB**；MANIFEST 339 条 |
| 非 dist 变更 | **replace 36 / add 95（共 131）** | **replace 31 / add 46（共 77）** |
| `dist/**` | 本地 Vue 构建 74 个文件**整体替换**生产的 49 个 | **保留生产原样 49 个文件**（不重建） |
| 用户可见变化 | 全站 UI 换 Vue/Tuffex；新增 RTK 页与 A/B 实验室；**「凭据导入」入口消失**（`92a0835` 有意下线，服务端端点仍在且有安全收口）；路由改为 history 模式（深度链接可用，回退已存在，见 §1.2） | UI 与今天完全一致（React 老界面，含「凭据导入」入口） |
| 服务端能力 | 安全收口 + 冷却清除 + bootstrap 并发 + RTK/AB 端点 + Magpie 代码（默认休眠） | 同上（完全一致） |
| 回退 | 同 B：`ln -sfn` 还原 BASE + `systemctl restart`（秒级，见 runbook） | 同 A |
| 主要风险 | UI 一次性替换（最大的用户可见面）；新 dist 由 Node 26 构建（§7.2） | 本地这批 UI 工作全部不上线；`cooldownCleared` 在前端无提示（React 老界面不消费该字段，功能本身仍生效） |

### 1.2 选项 A 的风险与回退（逐条）

| 风险 | 证据/评估 | 回退 |
| --- | --- | --- |
| 深链接 404 | **不成立**：`server/index.ts:1227-1230` 已有 `express.static(dist,{index:false})` + catch-all `sendFile(dist/index.html)`，Vue 的 `createWebHistory('/')` 能被兜住（`no-cache` 只作用于入口 HTML） | — |
| 浏览器缓存旧 bundle | 入口 HTML 走 `no-cache`，asset 带内容哈希 + `immutable` 1h；新 dist 的 chunk 名全部变化，不会命中旧缓存 | 强刷即可 |
| 登录/会话 | Vue `LoginPage.vue` 走同一个 `/api/login`，服务端未改认证逻辑 | 无 |
| 凭据导入入口消失 | `92a0835` 有意下线；如需保留必须由产品确认（服务端 `/api/credentials/upload` 仍在且已收口） | 回退到 BASE |
| UI 行为回归 | 本地跑了 UI 轮次验收（`docs/qa/blue/**`、red-team 记录），但**未在生产数据/流量上验证** | `ln -sfn` 还原 + restart |
| magpie/RTK 页面在 CPA 模式下显示「未配置」 | 数据层诚实（task-8 §3）：`relay:not_configured`、`kernel:gateway_engine_not_magpie` | 无（预期行为） |

### 1.3 关键工程事实：**保留 React = 冻结 UI**

- `vite.config.ts` 的 React 插件只作用于 docs：`react({ include: /docs.*\.(jsx|tsx)$/ })`，`index.html` 的入口是 `/src/main.ts`（Vue）。
- 因此**本地树已无法构建出生产在用的那套 React 控制台**；`--frontend=keep-prod` 之所以可行，唯一原因是**沿用生产 release 里那份预构建 dist**，一旦需要改一行 React UI，就只能手改生产里的 minified 产物。
- 结论：**从本次发布起，"继续用 React" 等于把前端锁死在 2026-09-28 的产物上**。

### 1.4 建议（工程视角，最终由用户定）

**推荐选项 A（全量）**，理由是：① 这批工作的主体就是新控制台，只发服务端等于把 UI 替换推迟到下一次、再走一遍同样的流程；② 回退是原子的、秒级的（保留 BASE 目录 + symlink 还原），UI 出问题的代价可控；③ 选项 B 会让前端进入"不可再构建"的冻结态（§1.3）。
**若用户只想先拿功能修复**（冷却清除 + 安全收口），用 `--frontend=keep-prod` 一条命令即可，两个选项的组装物都已通过校验（§6）。

> **决策标注：这是产品决策，需要用户明确选择 A 或 B；本文与 runbook 都按"A 为默认、B 为备选"给出。**

---

## 2. 发布内容总览

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| BASE 原样保留 | 221 个本地跟踪文件与生产逐字节相同（不复制、不覆盖） | 组装脚本按哈希判定，动作标 `keep-prod` |
| 生产侧文件被替换 | 36（vue 模式）/ 31（keep-prod） | 见 §3 表 A |
| 生产没有的新文件 | 95（vue）/ 46（keep-prod） | 同上 |
| V1「内容变化」（含 dist 同名路径） | 39（vue）/ 31（keep-prod） | dist 的 `favicon.ico`、`icon-*.png`、`docs.html` 等在两版 dist 中同名不同内容 |
| `dist/**` | 74（vue，整体替换）/ 49（keep-prod，原样） | 见 §4 |
| 预期缺失（可接受） | 5 = `.cache/*.tsbuildinfo` ×3 + `._.DS_Store` ×2 类 | 构建元数据与 AppleDouble，不参与运行 |
| 生产文件缺失 | **0** | 校验 V1 通过 |
| **删除动作** | **0（发布不做删除）** | Lead 2026-10-01 决定：release 沿用 BASE 版本，见 §4.4 |

---

## 3. 逐文件清单（表 A）

> 生成方式：`/tmp/cac-deploy-recon/clean-repo`（本地 HEAD `0e27b9e` 的干净克隆）与 `prod-release-snapshot`（BASE 的只读快照）逐文件 sha256 对比；`来源 commit` = `git log -1 -- <path>`。
> 完整 64 位哈希见 `docs/qa/deploy/evidence/assembly-report-vue.md` 的逐文件表；下表为 16 位前缀。

### 3.0 相对上一版草稿的 delta（`26554bd` → `fabd4fe`）

上一版草稿发布于 task-18（发布源 `26554bd`，115 个非 dist 文件）。此后本地推进了 4 个提交，清单与哈希变化如下（**净 +16 个文件**）：

| 变化 | 数量 | 明细 |
| --- | --- | --- |
| **新进入清单** | **+21** | task-18 给 22 个测试文件加了 `import './testDataDir.js'`，其中 21 个从「与生产逐字节相同」变成 `replace`（`server/antigravityQuota.test.ts`、`cacheAnalytics`、`cacheLiveHistory`、`channelView`、`claudeQuotaCache`、`currentChannels`、`groups`、`keyChannelAccess`、`keyModelAccess`、`liveStream`、`magpieControl`、`magpieEngine`、`magpieMigration`、`magpieOAuth`、`modelCatalog`、`modelIndex`、`modelSync`、`oauthAndVersion`、`oauthGroupResilience`、`reportPageLoads`、`reportingGroups`） |
| **移出清单** | **−5** | `e52617a`/`fabd4fe` 删掉且**本地曾改过**的文件：`src/App.css`、`src/App.tsx`、`src/components/VersionWidget.tsx`、`src/pages/DashboardPage.tsx`、`src/pages/ModelsPage.tsx` —— 删除后不再被本地覆盖，release 里回落到 **BASE 版本**（即 §4.4 的「发布不做删除」决定） |
| **清单内哈希变化** | **6** | `server/magpie{Control,Engine,Migration,OAuth}.test.ts`、`server/modelSync.test.ts`（同上的 import）、`src/pages/ModelsPage.vue`（`e0ac1ec` 之后的又一次 UI 调整） |
| **合计** | **115 → 131** | `replace` 21 → 36；`add` 94 → 95；`keep-prod` 221 → 179 |

配套产物变化：`dist` 树哈希 `3419fe9f…` → **`5b69bbf7…`**（仍是 74 个文件）；`keep-prod` 模式保留生产 dist（`655bec5e…` 不变）。
校验结论：**两模式依旧 PASS、缺失生产文件 = 0**（V1/V2/V4/V5 PASS，V3 同一对已知 WARN），**没有放宽任何规则**。
另外：`fabd4fe` 后 `vite manifest` 里 `.tsx` 条目为 **0**（死树清理完成），`.vue` 条目 18。

### 3.1 逐文件清单（发布源 `fabd4fe`）

## 表 A：发布内容逐文件清单（vue 模式，非 dist，发布源 HEAD=fabd4fe）

### A.server（43 个）

| 文件 | 动作 | 本地 sha256 | 生产 sha256 | 来源 commit | 说明 |
| --- | --- | --- | --- | --- | --- |
| `server/abLab.ts` | add | `111357b3ad2be12e…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `server/analyticsNavigationFallback.test.ts` | replace | `8e87d2bcbb4d3da8…` | `411e8a529b0d2dae…` | `e52617a` | chore(console): 删除 25 个无人引用的 React 死文件，测试改为断言活代码 |
| `server/antigravityQuota.test.ts` | replace | `44de2215884703af…` | `0162edd7827a86ba…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/cacheAnalytics.test.ts` | replace | `6f5151dc3bf0041a…` | `556b3ff49ffdf238…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/cacheLiveHistory.test.ts` | replace | `95c7cad7df211478…` | `5ab8f7f638ab09d9…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/channelView.test.ts` | replace | `6719f1d8fd8baa15…` | `c92163cf69a1ed2b…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/claudeQuotaCache.test.ts` | replace | `207b6eec6c104b12…` | `8946efb08b6f4d7f…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/config.ts` | replace | `66f5760e727e6ef8…` | `77cdbf772bcaed66…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `server/cpa.ts` | replace | `cd3ac927d23aeb61…` | `bd97f7ed62279405…` | `c91b592` | fix(server): merge production cooldown patch and honest rtk/oauth connection status |
| `server/currentChannels.test.ts` | replace | `6bf797b02237e0ee…` | `7ed4cb7b11967b83…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/gatewayStatus.test.ts` | replace | `5f5dc4a37868b39b…` | `b92fd0198f58270c…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `server/groups.test.ts` | replace | `c94f1633e0453872…` | `0e4e9717f4788593…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/index.ts` | replace | `e64bb0ad13497977…` | `6d070bcde589beb5…` | `f653bef` | fix(rtk): reconcile cross-agent hook writes and make failure paths recoverable |
| `server/keyChannelAccess.test.ts` | replace | `7b658726830f5fb6…` | `1aa76dd9ebc6d235…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/keyModelAccess.test.ts` | replace | `2301ea81133cca23…` | `d67f09a24f728fc6…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/liveStream.test.ts` | replace | `209860b4eb27bf30…` | `d96bf9c640a07a53…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/magpieControl.test.ts` | add | `c662efb31e0bd0b5…` | — | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/magpieControl.ts` | add | `974d0a392a0b554f…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/magpieEngine.test.ts` | add | `d01cd41969adade6…` | — | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/magpieEngine.ts` | add | `a82a2607ad512379…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `server/magpieMigration.test.ts` | add | `2b2fae02fb29d47d…` | — | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/magpieMigration.ts` | add | `87847d283ebf18b2…` | — | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `server/magpieOAuth.test.ts` | add | `01be9f9e6add54f4…` | — | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/magpieOAuth.ts` | add | `ec6b04d55e13391c…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/magpieRuntime.ts` | add | `5eec1ed5edfa167a…` | — | `92a0835` | feat(ui): remove credentials upload from navigation and harden runtime channel resolution |
| `server/magpieUpstream.test.ts` | add | `f5861e3c9121e313…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `server/magpieUpstream.ts` | add | `e249ed65cc1d9765…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/modelCatalog.test.ts` | replace | `9656e1fd5989e465…` | `e812f06e631b78cc…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/modelCatalog.ts` | replace | `51b579e4fdd25c72…` | `d4f87beca5437777…` | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/modelIndex.test.ts` | replace | `fc48934dae1ea399…` | `b64d4f9d34828f3f…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/modelSync.test.ts` | add | `28c33d1bc5c618b1…` | — | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/modelSync.ts` | add | `8df6e0551a9132ed…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/oauthAndVersion.test.ts` | replace | `1f0f210bf00a4e67…` | `fb79e45f3f044b64…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/oauthGroupResilience.test.ts` | replace | `1d5ca0d4b0dafe2d…` | `e9e67abf2cc31627…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/reportPageFrontend.test.ts` | replace | `c8fe759c7a4856a2…` | `a373e24e9fe7dd55…` | `e52617a` | chore(console): 删除 25 个无人引用的 React 死文件，测试改为断言活代码 |
| `server/reportPageLoads.test.ts` | replace | `e290afdcf88a9245…` | `5cd24591dd6919ce…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/reportRouteWiring.test.ts` | replace | `163848739b104331…` | `503682fc2362b2c1…` | `e52617a` | chore(console): 删除 25 个无人引用的 React 死文件，测试改为断言活代码 |
| `server/reportingGroups.test.ts` | replace | `b9c4c55db67cc36a…` | `b646da46af40ec42…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/rtkPlane.ts` | add | `94b19d02d95e4493…` | — | `f653bef` | fix(rtk): reconcile cross-agent hook writes and make failure paths recoverable |
| `server/rtkService.test.ts` | add | `d52fad22169bc5ca…` | — | `9e78045` | fix(rtk): serialize local hook writes and stop cross-request clobbering |
| `server/rtkService.ts` | add | `2d1d039ab9437e59…` | — | `9e78045` | fix(rtk): serialize local hook writes and stop cross-request clobbering |
| `server/testDataDir.ts` | add | `2cb6077a8987d9af…` | — | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |
| `server/usageDetails.test.ts` | replace | `09db903b5169ac74…` | `94379992c260d85c…` | `9a9b9db` | test(server): isolate DATA_DIR per test process and refresh the relay release plan |

### A.packages（2 个）

| 文件 | 动作 | 本地 sha256 | 生产 sha256 | 来源 commit | 说明 |
| --- | --- | --- | --- | --- | --- |
| `packages/contracts/magpie-upstream.generated.ts` | add | `1af18692eeef76d6…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `packages/contracts/magpie-upstream.ts` | add | `438eb6e44b811eba…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |

### A.frontend（54 个）

| 文件 | 动作 | 本地 sha256 | 生产 sha256 | 来源 commit | 说明 |
| --- | --- | --- | --- | --- | --- |
| `index.html` | replace | `84463748f75abca8…` | `cbaebd60a21b9086…` | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/App.vue` | add | `8ee2b3d7ea0c32b8…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/ab/flows.ts` | add | `2ff6305ade41f03a…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/labState.ts` | add | `33d80d748637b2cd…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/preference.ts` | add | `fe9b0c086e536ae1…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/readOnlyGate.ts` | add | `99d31b006b9d1d86…` | — | `9df1c04` | fix(qa): gate the lab read-only across api, fetch and XHR without blocking votes |
| `src/ab/registry.ts` | add | `9f757cb717bac6fb…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/variants/legacy/DashboardPage.legacy.vue` | add | `d98e83ded8187317…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/variants/legacy/HelpPage.legacy.vue` | add | `750c2edb312b6cef…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/variants/legacy/KeysPage.legacy.vue` | add | `39d601c36f093839…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/variants/legacy/OAuthPage.legacy.vue` | add | `c6b6a72fa3ebb67b…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/api.ts` | replace | `d9333809675a39d4…` | `7e5b1b993b0e1014…` | `c91b592` | fix(server): merge production cooldown patch and honest rtk/oauth connection status |
| `src/components/ConfirmHost.vue` | add | `3bc77b7f1d6dc3ba…` | — | `ccee64e` | fix(console): keep confirm dialogs closable and surface un-cleared cooldowns |
| `src/components/ConsoleNav.vue` | add | `9314cab5829b13fd…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/components/ConsoleShell.vue` | add | `1604d9e86545b56c…` | — | `ccee64e` | fix(console): keep confirm dialogs closable and surface un-cleared cooldowns |
| `src/components/EmptyState.vue` | add | `5a7dfe18159ff0f4…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/components/ErrorPanel.vue` | add | `c87697151c57124e…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/components/LoadingBlock.vue` | add | `b7ecb1cb93897603…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/components/PageHeader.vue` | add | `f1d936c18335131f…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/components/RequestDetail.vue` | add | `6f775f2cd51a2135…` | — | `7b71f6d` | feat(ui): migrate data and monitor pages to vue 3 and tuffex |
| `src/components/RtkBoard.vue` | add | `3ac36bab330ef08e…` | — | `9e78045` | fix(rtk): serialize local hook writes and stop cross-request clobbering |
| `src/components/VersionWidget.vue` | add | `fe7eb9a9c4ebaab1…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/env.d.ts` | add | `53e97f03f7ace951…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/gatewayStatus.ts` | replace | `d8dc7050850fdd90…` | `a9435f81748fb301…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `src/lib/breadcrumbs.ts` | add | `68bf3508bcc87ce0…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/confirm.ts` | add | `0e48845bbe992ab5…` | — | `ccee64e` | fix(console): keep confirm dialogs closable and surface un-cleared cooldowns |
| `src/lib/errors.ts` | add | `1764ace314df5cd6…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/focus.ts` | add | `b4fd0e763fe9f521…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/format.ts` | add | `51550fac4126cd7a…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/icons.ts` | add | `f1160a1b2dfff230…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/lib/listState.ts` | add | `e4609b9d1e2c5449…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/resource.ts` | add | `c37db61cc2893352…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/viewport.ts` | add | `ad01626b02c892bc…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/main.ts` | add | `4852c7a26490ffcd…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/pages/AbLabPage.vue` | add | `7a4a7c40f52c795c…` | — | `9df1c04` | fix(qa): gate the lab read-only across api, fetch and XHR without blocking votes |
| `src/pages/AnalyticsPage.vue` | add | `c1b286acd95efafa…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/CachePage.vue` | add | `b1ef27b19217f74f…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/ChannelsPage.vue` | add | `49c23e73d2683fd1…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/ChartsPage.vue` | add | `75f72618696242c7…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/DashboardPage.vue` | add | `ea3d4f37811a0c63…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/HelpPage.vue` | add | `b28f1aa08ed55c29…` | — | `0e27b9e` | docs(rtk): say that a hook change needs a client restart before it takes effect |
| `src/pages/KeysPage.vue` | add | `33644af6b3f697e2…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/LoginPage.vue` | add | `8c25e66626fad378…` | — | `281c30e` | fix(auth): fix login navigation guard and purge emojis across auth views |
| `src/pages/ModelsPage.vue` | add | `860663072834ddca…` | — | `e52617a` | chore(console): 删除 25 个无人引用的 React 死文件，测试改为断言活代码 |
| `src/pages/MonitorPage.vue` | add | `9319809044fa1780…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/OAuthPage.vue` | add | `c106c0be5395af24…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/RtkPage.vue` | add | `3a214a0a504422aa…` | — | `3118990` | fix(rtk): protect in-flight backups and make OFF verification symmetric |
| `src/pages/UsagePage.vue` | add | `e3e8b7bb1a2442d2…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/router.ts` | add | `cf6df21d1353b619…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/styles/layout.css` | add | `21604277e5f8db32…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/styles/theme.css` | add | `c0faf6b9ea7002b2…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/types.ts` | replace | `2ee08a2ce25c436e…` | `94262fb670c47f66…` | `9e78045` | fix(rtk): serialize local hook writes and stop cross-request clobbering |
| `uno.config.ts` | add | `eb0a11117187bfcb…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `vite.config.ts` | replace | `0d082af13221f81b…` | `cfb852aedcaeaf7f…` | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |

### A.ops（24 个）

| 文件 | 动作 | 本地 sha256 | 生产 sha256 | 来源 commit | 说明 |
| --- | --- | --- | --- | --- | --- |
| `deploy/magpie/CONSOLE-KERNEL.md` | add | `b0708e02fd722b8a…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `deploy/magpie/README.md` | add | `d3cfc5ccf6c14eaa…` | — | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `deploy/magpie/UPSTREAM.md` | add | `a28a1dd58f207da1…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `deploy/magpie/build.sh` | add | `680ff2892d9f1fe2…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `deploy/magpie/kernel/main.go` | add | `febb89ec360db699…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `deploy/magpie/local.mjs` | add | `fc9332f51251cd17…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `deploy/magpie/upstream/API.md` | add | `0a4e389cd736753c…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `deploy/magpie/upstream/LICENSE` | add | `79d2c8444715d4bc…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `deploy/magpie/upstream/api.json` | add | `3b84a81c0a5dd723…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/ab-report.mjs` | add | `38f5de98b70ec7b3…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `scripts/build-magpie-kernel.mjs` | add | `5160b7de1adaff03…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/magpie-api/main.go` | add | `366bd7e9b4bbee91…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/magpie-api/main_test.go` | add | `f703f90cabeecb9e…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/magpie-console-password.mjs` | add | `a316d9d1046761fd…` | — | `d85128c` | fix(console): isolate local login password in Keychain |
| `scripts/magpie-console-password.test.mjs` | add | `1fa1ef114d6c40d9…` | — | `d85128c` | fix(console): isolate local login password in Keychain |
| `scripts/magpie-console-smoke.mjs` | add | `30671e4ad9799ad9…` | — | `d85128c` | fix(console): isolate local login password in Keychain |
| `scripts/magpie-console.mjs` | add | `9e7d03379d31e0f2…` | — | `281c30e` | fix(auth): fix login navigation guard and purge emojis across auth views |
| `scripts/magpie-local.mjs` | add | `20e8652601a96ee6…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `scripts/magpie-local.test.mjs` | add | `5a92de446579cdfc…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `scripts/magpie-service.mjs` | add | `86709ec221f5fc12…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `scripts/magpie-smoke.mjs` | add | `7639ca93a5b7a2ea…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `scripts/magpie-upstream.mjs` | add | `8d48120b273d2bec…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/magpie-upstream.test.mjs` | add | `6396a09c7501b5cd…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/tuffex-icon-classes.mjs` | add | `9307d3f1550ea05c…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |

### A.root（8 个）

| 文件 | 动作 | 本地 sha256 | 生产 sha256 | 来源 commit | 说明 |
| --- | --- | --- | --- | --- | --- |
| `.env.example` | replace | `56b919d5aeecd016…` | `01b54bc765cb9577…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `.gitignore` | replace | `50833712bbb06895…` | `4f82f9b1ddee7403…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `MANIFEST.sha256` | add | `a7d4576f2b853d62…` | — | `eb5a026` | feat: align OAuth page and callback handling with CPA official management panel |
| `README.md` | replace | `b8f7f0654d8416eb…` | `eb6307713ac7322d…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `RELEASE.json` | replace | `f0ec481579cddeea…` | `8b49a789b224a4d6…` | `eb5a026` | feat: align OAuth page and callback handling with CPA official management panel |
| `docs/research/magpie-cpa-integration.md` | add | `0ddc3c64f2e3fe3d…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `package-lock.json` | replace | `38617c801a822441…` | `ff7c7f87525c92d2…` | `1eafa6b` | chore: add vue, tuffex and unocss dependencies |
| `package.json` | replace | `a5ef38f7978965ea…` | `7daf307f5b4b7a09…` | `1eafa6b` | chore: add vue, tuffex and unocss dependencies |

合计：131 个非 dist 文件；其中 replace 36 / add 95

### 3.1 逐文件清单（发布源 `26554bd`）

## 表 A：发布内容逐文件清单（vue 模式，非 dist，发布源 HEAD=26554bd）

### A.server（22 个）

| 文件 | 动作 | 本地 sha256 | 生产 sha256 | 来源 commit | 说明 |
| --- | --- | --- | --- | --- | --- |
| `server/abLab.ts` | add | `111357b3ad2be12e…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `server/config.ts` | replace | `66f5760e727e6ef8…` | `77cdbf772bcaed66…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `server/cpa.ts` | replace | `cd3ac927d23aeb61…` | `bd97f7ed62279405…` | `c91b592` | fix(server): merge production cooldown patch and honest rtk/oauth connection status |
| `server/gatewayStatus.test.ts` | replace | `5f5dc4a37868b39b…` | `b92fd0198f58270c…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `server/index.ts` | replace | `e64bb0ad13497977…` | `6d070bcde589beb5…` | `f653bef` | fix(rtk): reconcile cross-agent hook writes and make failure paths recoverable |
| `server/magpieControl.test.ts` | add | `123b9c1b850d198d…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/magpieControl.ts` | add | `974d0a392a0b554f…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/magpieEngine.test.ts` | add | `952bb46c0207d44c…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `server/magpieEngine.ts` | add | `a82a2607ad512379…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `server/magpieMigration.test.ts` | add | `8786f8418e9743dc…` | — | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `server/magpieMigration.ts` | add | `87847d283ebf18b2…` | — | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `server/magpieOAuth.test.ts` | add | `f0bf64b7c4799fc3…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/magpieOAuth.ts` | add | `ec6b04d55e13391c…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/magpieRuntime.ts` | add | `5eec1ed5edfa167a…` | — | `92a0835` | feat(ui): remove credentials upload from navigation and harden runtime channel resolution |
| `server/magpieUpstream.test.ts` | add | `f5861e3c9121e313…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `server/magpieUpstream.ts` | add | `e249ed65cc1d9765…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/modelCatalog.ts` | replace | `51b579e4fdd25c72…` | `d4f87beca5437777…` | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/modelSync.test.ts` | add | `add8593e141cd2a0…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/modelSync.ts` | add | `8df6e0551a9132ed…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `server/rtkPlane.ts` | add | `94b19d02d95e4493…` | — | `f653bef` | fix(rtk): reconcile cross-agent hook writes and make failure paths recoverable |
| `server/rtkService.test.ts` | add | `d52fad22169bc5ca…` | — | `9e78045` | fix(rtk): serialize local hook writes and stop cross-request clobbering |
| `server/rtkService.ts` | add | `2d1d039ab9437e59…` | — | `9e78045` | fix(rtk): serialize local hook writes and stop cross-request clobbering |

### A.packages（2 个）

| 文件 | 动作 | 本地 sha256 | 生产 sha256 | 来源 commit | 说明 |
| --- | --- | --- | --- | --- | --- |
| `packages/contracts/magpie-upstream.generated.ts` | add | `1af18692eeef76d6…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `packages/contracts/magpie-upstream.ts` | add | `438eb6e44b811eba…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |

### A.frontend（59 个）

| 文件 | 动作 | 本地 sha256 | 生产 sha256 | 来源 commit | 说明 |
| --- | --- | --- | --- | --- | --- |
| `index.html` | replace | `84463748f75abca8…` | `cbaebd60a21b9086…` | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/App.css` | replace | `7579fc9fa72e82b0…` | `8a690b2a9505ee4f…` | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `src/App.tsx` | replace | `b66ab3dd0bf1c5c2…` | `cf8cff86c20935a6…` | `92a0835` | feat(ui): remove credentials upload from navigation and harden runtime channel resolution |
| `src/App.vue` | add | `8ee2b3d7ea0c32b8…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/ab/flows.ts` | add | `2ff6305ade41f03a…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/labState.ts` | add | `33d80d748637b2cd…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/preference.ts` | add | `fe9b0c086e536ae1…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/readOnlyGate.ts` | add | `99d31b006b9d1d86…` | — | `9df1c04` | fix(qa): gate the lab read-only across api, fetch and XHR without blocking votes |
| `src/ab/registry.ts` | add | `9f757cb717bac6fb…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/variants/legacy/DashboardPage.legacy.vue` | add | `d98e83ded8187317…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/variants/legacy/HelpPage.legacy.vue` | add | `750c2edb312b6cef…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/variants/legacy/KeysPage.legacy.vue` | add | `39d601c36f093839…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/ab/variants/legacy/OAuthPage.legacy.vue` | add | `c6b6a72fa3ebb67b…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/api.ts` | replace | `d9333809675a39d4…` | `7e5b1b993b0e1014…` | `c91b592` | fix(server): merge production cooldown patch and honest rtk/oauth connection status |
| `src/components/ConfirmHost.vue` | add | `3bc77b7f1d6dc3ba…` | — | `ccee64e` | fix(console): keep confirm dialogs closable and surface un-cleared cooldowns |
| `src/components/ConsoleNav.vue` | add | `9314cab5829b13fd…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/components/ConsoleShell.vue` | add | `1604d9e86545b56c…` | — | `ccee64e` | fix(console): keep confirm dialogs closable and surface un-cleared cooldowns |
| `src/components/EmptyState.vue` | add | `5a7dfe18159ff0f4…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/components/ErrorPanel.vue` | add | `c87697151c57124e…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/components/LoadingBlock.vue` | add | `b7ecb1cb93897603…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/components/PageHeader.vue` | add | `f1d936c18335131f…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/components/RequestDetail.vue` | add | `6f775f2cd51a2135…` | — | `7b71f6d` | feat(ui): migrate data and monitor pages to vue 3 and tuffex |
| `src/components/RtkBoard.vue` | add | `3ac36bab330ef08e…` | — | `9e78045` | fix(rtk): serialize local hook writes and stop cross-request clobbering |
| `src/components/VersionWidget.tsx` | replace | `ae82637f324ff95a…` | `211d11d8d62ff0ed…` | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `src/components/VersionWidget.vue` | add | `fe7eb9a9c4ebaab1…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/env.d.ts` | add | `53e97f03f7ace951…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/gatewayStatus.ts` | replace | `d8dc7050850fdd90…` | `a9435f81748fb301…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `src/lib/breadcrumbs.ts` | add | `68bf3508bcc87ce0…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/confirm.ts` | add | `0e48845bbe992ab5…` | — | `ccee64e` | fix(console): keep confirm dialogs closable and surface un-cleared cooldowns |
| `src/lib/errors.ts` | add | `1764ace314df5cd6…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/focus.ts` | add | `b4fd0e763fe9f521…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/format.ts` | add | `51550fac4126cd7a…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/icons.ts` | add | `f1160a1b2dfff230…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/lib/listState.ts` | add | `e4609b9d1e2c5449…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/resource.ts` | add | `c37db61cc2893352…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/lib/viewport.ts` | add | `ad01626b02c892bc…` | — | `7593622` | feat(console): 按 TUF 交互原语重构 UI（URL 状态/统一确认/三态/响应式） |
| `src/main.ts` | add | `4852c7a26490ffcd…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/pages/AbLabPage.vue` | add | `7a4a7c40f52c795c…` | — | `9df1c04` | fix(qa): gate the lab read-only across api, fetch and XHR without blocking votes |
| `src/pages/AnalyticsPage.vue` | add | `c1b286acd95efafa…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/CachePage.vue` | add | `b1ef27b19217f74f…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/ChannelsPage.vue` | add | `49c23e73d2683fd1…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/ChartsPage.vue` | add | `75f72618696242c7…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/DashboardPage.tsx` | replace | `b293a278be6f2185…` | `9822b49060d9831e…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `src/pages/DashboardPage.vue` | add | `ea3d4f37811a0c63…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/HelpPage.vue` | add | `b28f1aa08ed55c29…` | — | `0e27b9e` | docs(rtk): say that a hook change needs a client restart before it takes effect |
| `src/pages/KeysPage.vue` | add | `33644af6b3f697e2…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/LoginPage.vue` | add | `8c25e66626fad378…` | — | `281c30e` | fix(auth): fix login navigation guard and purge emojis across auth views |
| `src/pages/ModelsPage.tsx` | replace | `b6950bebe329bba2…` | `e29c6d44a1f5ffd2…` | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `src/pages/ModelsPage.vue` | add | `8c332cae0a7c1681…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/MonitorPage.vue` | add | `9319809044fa1780…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/OAuthPage.vue` | add | `c106c0be5395af24…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/pages/RtkPage.vue` | add | `3a214a0a504422aa…` | — | `3118990` | fix(rtk): protect in-flight backups and make OFF verification symmetric |
| `src/pages/UsagePage.vue` | add | `e3e8b7bb1a2442d2…` | — | `e0ac1ec` | feat(console): /models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限 |
| `src/router.ts` | add | `cf6df21d1353b619…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `src/styles/layout.css` | add | `21604277e5f8db32…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/styles/theme.css` | add | `c0faf6b9ea7002b2…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `src/types.ts` | replace | `2ee08a2ce25c436e…` | `94262fb670c47f66…` | `9e78045` | fix(rtk): serialize local hook writes and stop cross-request clobbering |
| `uno.config.ts` | add | `eb0a11117187bfcb…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |
| `vite.config.ts` | replace | `0d082af13221f81b…` | `cfb852aedcaeaf7f…` | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |

### A.ops（24 个）

| 文件 | 动作 | 本地 sha256 | 生产 sha256 | 来源 commit | 说明 |
| --- | --- | --- | --- | --- | --- |
| `deploy/magpie/CONSOLE-KERNEL.md` | add | `b0708e02fd722b8a…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `deploy/magpie/README.md` | add | `d3cfc5ccf6c14eaa…` | — | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `deploy/magpie/UPSTREAM.md` | add | `a28a1dd58f207da1…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `deploy/magpie/build.sh` | add | `680ff2892d9f1fe2…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `deploy/magpie/kernel/main.go` | add | `febb89ec360db699…` | — | `7e1c8ce` | feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk |
| `deploy/magpie/local.mjs` | add | `fc9332f51251cd17…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `deploy/magpie/upstream/API.md` | add | `0a4e389cd736753c…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `deploy/magpie/upstream/LICENSE` | add | `79d2c8444715d4bc…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `deploy/magpie/upstream/api.json` | add | `3b84a81c0a5dd723…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/ab-report.mjs` | add | `38f5de98b70ec7b3…` | — | `50a8639` | feat(qa): add the /ab comparison lab with real-user preference capture |
| `scripts/build-magpie-kernel.mjs` | add | `5160b7de1adaff03…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/magpie-api/main.go` | add | `366bd7e9b4bbee91…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/magpie-api/main_test.go` | add | `f703f90cabeecb9e…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/magpie-console-password.mjs` | add | `a316d9d1046761fd…` | — | `d85128c` | fix(console): isolate local login password in Keychain |
| `scripts/magpie-console-password.test.mjs` | add | `1fa1ef114d6c40d9…` | — | `d85128c` | fix(console): isolate local login password in Keychain |
| `scripts/magpie-console-smoke.mjs` | add | `30671e4ad9799ad9…` | — | `d85128c` | fix(console): isolate local login password in Keychain |
| `scripts/magpie-console.mjs` | add | `9e7d03379d31e0f2…` | — | `281c30e` | fix(auth): fix login navigation guard and purge emojis across auth views |
| `scripts/magpie-local.mjs` | add | `20e8652601a96ee6…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `scripts/magpie-local.test.mjs` | add | `5a92de446579cdfc…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `scripts/magpie-service.mjs` | add | `86709ec221f5fc12…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `scripts/magpie-smoke.mjs` | add | `7639ca93a5b7a2ea…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `scripts/magpie-upstream.mjs` | add | `8d48120b273d2bec…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/magpie-upstream.test.mjs` | add | `6396a09c7501b5cd…` | — | `f30da5e` | feat(magpie): generate and track upstream API contracts |
| `scripts/tuffex-icon-classes.mjs` | add | `9307d3f1550ea05c…` | — | `600a5ca` | feat(core): setup Tuffex design system, ConsoleShell, ConsoleNav and router |

### A.root（8 个）

| 文件 | 动作 | 本地 sha256 | 生产 sha256 | 来源 commit | 说明 |
| --- | --- | --- | --- | --- | --- |
| `.env.example` | replace | `56b919d5aeecd016…` | `01b54bc765cb9577…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `.gitignore` | replace | `50833712bbb06895…` | `4f82f9b1ddee7403…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `MANIFEST.sha256` | add | `a7d4576f2b853d62…` | — | `eb5a026` | feat: align OAuth page and callback handling with CPA official management panel |
| `README.md` | replace | `b8f7f0654d8416eb…` | `eb6307713ac7322d…` | `f60a828` | feat(console): integrate headless Magpie inference kernel |
| `RELEASE.json` | replace | `f0ec481579cddeea…` | `8b49a789b224a4d6…` | `eb5a026` | feat: align OAuth page and callback handling with CPA official management panel |
| `docs/research/magpie-cpa-integration.md` | add | `0ddc3c64f2e3fe3d…` | — | `cddf0d2` | feat(magpie): add isolated CPA integration and local migration |
| `package-lock.json` | replace | `38617c801a822441…` | `ff7c7f87525c92d2…` | `1eafa6b` | chore: add vue, tuffex and unocss dependencies |
| `package.json` | replace | `a5ef38f7978965ea…` | `7daf307f5b4b7a09…` | `1eafa6b` | chore: add vue, tuffex and unocss dependencies |

合计：115 个非 dist 文件；其中 replace 21 / add 94

## 4. `dist/**`、`MANIFEST.sha256`、`RELEASE.json` 的重新生成规则

### 4.1 `dist/**`

1. **必须重新构建**（不要手工拼），命令：在干净检出里 `npm run build`（= `tsc -b && vite build`，见 `package.json`）。
2. **构建所用 Node 必须对齐生产**：生产 runtime 是 `/opt/crosery-node-current` = **v24.20.0**（`package.json engines` = `>=24 <25`）。两种合规做法：
   - **模式 V（最高保真）**：在 VPS 的新 release 目录内用 pinned Node 构建（该 release 的 `node_modules` 已含 `vite`/`tsc`，但**不含** Vue 相关依赖 → 需要 `npm ci` 拉取，属生产变更、需批准，见 runbook §2.3）；
   - **模式 L（本次演练）**：本地构建后随 release 上传。**已知偏差**：本地 Node 是 v26.7.0（超出 engines 声明），打包结果与 v24 构建**未做逐字节比对**（未验证）。
3. `dist` 与源码一致性由组装脚本 V2 校验：入口 HTML 引用完整性 + `.vite/manifest.json` 含 `index.html` 与 `.vue` 页面 + **dist 必须比源码新**（mtime 比对）。
4. `dist/index.html` 已 `no-cache`，`assets/**` 带内容哈希 —— 替换 dist 不需要额外清缓存动作。

### 4.2 `MANIFEST.sha256`

- **覆盖规则（与生产实测一致）**：release 目录下**除 `node_modules/**`、`.DS_Store`、`MANIFEST.sha256` 自身之外的全部文件**。当前 BASE 的 MANIFEST 共 299 条 = 非构建文件 246 + `dist/**` 49 + `.cache/*.tsbuildinfo` 3 + `._.DS_Store` 1。
- 生成命令（组装脚本已内置，等价于）：
  ```bash
  cd <release-dir> && find . -type f -not -path './node_modules/*' -not -name '.DS_Store' -not -name 'MANIFEST.sha256' \
    | LC_ALL=C sort | while IFS= read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done > MANIFEST.sha256
  ```
- **顺序坑（本次演练踩到）**：必须**先写 `RELEASE.json` 再生成 `MANIFEST.sha256`**，否则 MANIFEST 里记的是上一版 RELEASE.json 的哈希（组装脚本已修，见 §6.3）。
- `.gitignore` 注意：`dist`、`build/`、`*.log`、`*.tar.gz`、`.cache/`、`data/`、`.env*` 都被忽略。`dist` 与 `build/` 虽然不入 git，但**必须出现在 release 里**（用 `cp`/`rsync` 显式带上，不要用 `git archive` 直接当 release）。

### 4.4 显式删除语义（**刷新期新发现**：React 死树正在被删除）

- **组装脚本只叠加、不删除**：它先复制 BASE 全量，再把本地跟踪文件覆盖上去。因此「本地删掉某文件」**不会**让该文件从 release 消失——它会以 **BASE 的版本**留在 release 里。
- 现场情况（2026-10-01 已由 blue-ui `e52617a` 与 Lead `fabd4fe` **提交**）：**27 个死树文件已删除**（`src/App.tsx`、`src/main.tsx`、`src/components/*.tsx` ×11、`src/pages/*.tsx` ×13）。逐字节比对 BASE：**21 个与生产完全相同**，**4 个本地曾改过**（`src/App.tsx`、`src/components/VersionWidget.tsx`、`src/pages/DashboardPage.tsx`、`src/pages/ModelsPage.tsx`——正好是本文表 A 里的 `replace` 项）。
- **影响（已发生，见 §3.0）**：这 5 个文件（4 个本地改过的 + `src/App.css`）不再被本地覆盖 → release 保留 **BASE（生产）版本**，已从表 A 移出；这 4 个文件的本地 React 侧改动**静默消失**（它们是死代码，功能无影响，但属"计划外内容变化"，必须记录）。
- **决定（Lead，2026-10-01）：选项 1 —— 发布不做删除**（原两个选项中的「接受保留」）：
  1. **release 中 `src/**/*.tsx` 一律沿用 BASE 版本**（除 `src/docs.tsx`、`src/docs-entry.tsx` 这两项 docs 入口——它们仍在构建图里）。即：21 个与生产逐字节相同的 React 源原样保留，4 个本地曾改过的（`src/App.tsx`、`src/components/VersionWidget.tsx`、`src/pages/DashboardPage.tsx`、`src/pages/ModelsPage.tsx`）在 release 里用 **BASE 版本**，本地版本不发布。
  2. 理由：这些文件在 release 里是**死的**（`index.html` 只引 `/src/main.ts`，`docs.html` 只引 `docs-entry.tsx`），保留 BASE 版零风险；而为发布引入"删除步"要额外维护删除清单与回退，复杂度更高。
  3. **本地删除只影响本地仓库与后续构建**（`npm run build` 不再产出 → 也不需要产出这些文件），不影响已组装的 release 内容。
  4. **若将来要把删除同步进 release**：需**单独设计**删除清单（25 条路径逐一列出）、在 MANIFEST 重新生成**之前**执行、并给出回退（从 BASE 再 `cp -a` 覆盖回来即可）；本轮不做，也不在 runbook 里预留。
- **`dist` 不受影响**（React `.tsx` 不参与 Vue 构建），`--frontend=keep-prod` 也不受影响（该模式本来就保留 BASE 的 React 源与 dist）。

### 4.3 `RELEASE.json`

按生产既有格式（对照 BASE 的 17 行）填写：`releaseId` / `createdAt` / `baseRelease` / `sourceRepository` / `source` / `changes`。组装脚本已产出草稿，其中 `changes` = 变更文件清单 + `dist/**` + `MANIFEST.sha256` + `RELEASE.json`，并额外写入 `provenance`（本地 commit、前端模式、构建 Node、dist 树哈希、脏文件），便于事后对账——**`provenance` 是本地新增字段，生产既有 release 没有，如要保持格式完全一致可在最终发布前删除该字段**（需 Lead 定）。

---

## 5. 组装脚本做哪些校验

`node docs/qa/deploy/assemble-release.mjs --prod-snapshot=<BASE快照> --repo=<本地树> --dist-from=<本地dist> --out=<临时目录> --release-id=<id> --frontend=vue|keep-prod --expect-node=v24.20.0`

| 校验 | 内容 | 失败即 |
| --- | --- | --- |
| **V1** | 组装树不缺失任何生产侧文件（逐条对比 BASE `MANIFEST.sha256`），列出缺失/替换/新增；`dist/**` 在 vue 模式下按「整体替换」单独统计 | FAIL |
| **V2** | dist 与源码一致：`index.html` 引用资源存在、`.vite/manifest.json` 含入口与 `.vue` 页面、**dist 比源码新**（mtime） | FAIL |
| **V3** | Node 版本：本地构建 node / 生产 runtime / `package.json engines` 三方对照（`--strict-node` 时不一致直接 FAIL） | WARN/FAIL |
| **V4** | MANIFEST 自洽：逐条重算 sha256 比对 | FAIL |
| **V5** | 禁运清单：`docs/qa/**`、`.env`（`.env.example` 除外）、`data/**`、`node_modules/**`、`*.log`、`*.tar.gz`、`.git/**` 不得进入 | FAIL |
| 安全闸 | `--out` 若落在 `/opt`、仓库内或非临时目录 → **拒绝执行**；工作区不干净且未加 `--allow-dirty` → 拒绝执行 | 拒绝 |

---

## 6. 本地演练记录（真跑）

### 6.1 命令

```bash
# 1) 生产 release 只读快照（不含 node_modules；VPS 只读）
ssh -o ControlMaster=no -o ControlPath=none cpa-vps \
  'cd /opt/crosery-api-console-current && tar -cf - --exclude=./node_modules --exclude=./.cache .' \
  | tar -xf - -C /tmp/cac-deploy-recon/prod-release-snapshot

# 2) 干净检出（避免把他人未提交改动打进 release），并复用工作区 node_modules 构建 dist
git clone --no-hardlinks <repo> /tmp/cac-deploy-recon/clean-repo
ln -sfn <repo>/node_modules /tmp/cac-deploy-recon/clean-repo/node_modules
cd /tmp/cac-deploy-recon/clean-repo && npm run build          # tsc -b && vite build

# 3) 组装 + 校验（选项 A / vue）
node docs/qa/deploy/assemble-release.mjs \
  --prod-snapshot=/tmp/cac-deploy-recon/prod-release-snapshot \
  --repo=/tmp/cac-deploy-recon/clean-repo \
  --dist-from=/tmp/cac-deploy-recon/clean-repo/dist \
  --out=/tmp/cac-deploy-recon/release-20261001-tuffex-rtk \
  --release-id=20261001-tuffex-rtk --frontend=vue --expect-node=v24.20.0

# 4) 组装 + 校验（选项 B / keep-prod）
node docs/qa/deploy/assemble-release.mjs \
  --prod-snapshot=/tmp/cac-deploy-recon/prod-release-snapshot \
  --repo=/tmp/cac-deploy-recon/clean-repo \
  --out=/tmp/cac-deploy-recon/release-keep-react \
  --release-id=20261001-server-only --frontend=keep-prod --expect-node=v24.20.0
```

### 6.2 输出（原样）

**选项 A（`--frontend=vue`）**

```
组装目录: /tmp/cac-deploy-recon/release-20261001-tuffex-rtk
releaseId: 20261001-tuffex-rtk | mode: vue | HEAD: fabd4fe
文件 416 个 / 7.10 MB | MANIFEST 413 条 | dist 74 个 (tree 5b69bbf75fbedd47…)
本地动作: replace=36 keep-prod=179 add=95
V1 缺失生产文件: 0 | 预期缺失: 5 | 替换: 39 | 新增: 96
V3 node: local=v26.7.0 prod=v24.20.0 engines=>=24 <25 -> WARN
⚠ V3 本地构建 node v26.7.0 ≠ 生产 runtime v24.20.0：dist 由非生产版本构建，建议改为在生产 release 目录内用 /opt/crosery-node-current 构建（runbook 模式 V），或至少保留本次 WARN 作为已知风险
⚠ V3 本地 node v26.7.0 不满足 engines >=24 <25（生产 node 满足）
结果: PASS（含 2 条警告）
报告: /tmp/cac-deploy-recon/release-20261001-tuffex-rtk/assembly-report.md
```

**选项 B（`--frontend=keep-prod`）**

```
组装目录: /tmp/cac-deploy-recon/release-keep-react
releaseId: 20261001-server-only | mode: keep-prod | HEAD: fabd4fe
文件 342 个 / 5.88 MB | MANIFEST 339 条 | dist 49 个 (tree 655bec5e91a5acc6…)
本地动作: replace=31 keep-prod=159 add=46
V1 缺失生产文件: 0 | 预期缺失: 5 | 替换: 31 | 新增: 47
V3 node: local=v26.7.0 prod=v24.20.0 engines=>=24 <25 -> WARN
结果: PASS（含 2 条警告）
```

> 组装树不含 `node_modules`（本地快照没有那份 197MB 依赖）。**真实上机时基底用 `cp -a` 从 BASE 复制（含 node_modules）**，再 rsync 覆盖组装物，见 runbook §2。

### 6.3 演练中脚本被真实发现并修掉的问题（诚实记录）

| # | 症状 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | V1 报「缺失 38 个生产文件」，全是 `dist/assets/*` 旧 chunk | vue 模式下 dist 是**整体替换**，脚本却按"缺失"计 | 已修：`dist/**` 在 vue 模式单列为「替换」 |
| 2 | V4 报 `MANIFEST 自洽失败：RELEASE.json` | 生成顺序错了：先算 MANIFEST 再写 RELEASE.json | 已修：先写 RELEASE.json 再生成 MANIFEST |
| 3 | V5 报 `禁运文件 .env.example` | 禁运正则 `^\.env` 误伤 `.env.example`（生产本就带它） | 已修：只禁 `.env` / `.env.*`（放行 `.env.example`） |
| 4 | V2 报「dist 比源码旧 44s」 | 首轮演练时其他成员又提交/改动了 `src/**`（HEAD 已推进到 `0e27b9e`），旧 dist 过期 | **真实告警，不是 bug**：改为在干净检出里重新构建后通过 |
| 5 | 组装报告的动作计数（113）与逐文件表（115）对不上 | 禁运正则 `/^\.git/` 误伤 `.gitignore`、`/^\.env/` 误伤 `.env.example`，两个本该发布的文件被静默跳过（组装树会保留生产旧版） | 已修：改为 `/^\.git\//`、`/^\.env$/` + `/^\.env\.(?!example$)/`；修正后 replace 21 + add 94 = 115，与逐文件表一致 |

### 6.4 未验证项（不许脑补）

- 本地 Node v26.7.0 构建的 dist 与生产 v24.20.0 构建的 dist **未做逐字节比对**（模式 L 的已知偏差）。
- 生产 3.7GB `console.db` 在新代码下的启动耗时**未实测**（未碰生产 SQLite）。缓解：`server/db.ts` 等 schema 文件与生产逐字节相同（§7.1）。
- 第二实例健康检查在 VPS 上的端口/`DATA_DIR` 可用性**未实测**（本地未连生产执行）。
- `npm ci` 在生产主机上的网络可达性**未验证**（模式 V 才需要）。

---

## 7. 放行前风险判定（写死等级）

### 7.1 schema / 迁移风险：**P3 无风险（已验证）**

- `server/db.ts`、`server/quotaLedger.ts`、`server/usageRollup.ts`、`server/sqliteReadWorker.ts` 与生产 release **逐字节相同**（不在 §3 表 A 的 115 个变更文件里）→ 生产 3.7 GB `console.db` **不会因本次发布触发任何新的建表/迁移**。
- 启动期无条件执行的 `startModelCatalogWatcher()`（`server/modelSync.ts:282-310`）全程 try/catch，只读 `$HOME/.agents/crosery/catalog.json`（单元内 `HOME=/tmp` + `PrivateTmp`）→ 不构成首启失败源。
- 新 release 以 `tsx server/index.ts` 启动，`cdc` 依赖 `node_modules` 里已有的 `tsx`/`express`/`busboy`/`cookie-parser`/`yauzl`/`adm-zip`（新 server 代码只新增相对导入）→ 不需要在 VPS 上 `npm ci` 才能启动。

### 7.2 构建 Node（本地 v26.7.0）vs 生产 runtime（v24.20.0）：**P2 可接受，不需要模式 V**

| 事实 | 值 |
| --- | --- |
| 本地构建 Node | `v26.7.0` |
| 生产 runtime | `/opt/crosery-node-current` = `v24.20.0` |
| `package.json engines.node` | `>=24 <25` |

**为什么判为 P2（可接受）**：

1. 构建 Node 只影响**构建期工具链**；产物是浏览器执行的 JS/CSS，发布物的**运行**仍在 pinned Node 24 上。
2. `deploy/edge/README.md:15-18` 要求的「verified with the pinned Node runtime」是**用 pinned runtime 验证这个 release**——runbook §4 的第二实例正是 `env -i PATH=/opt/crosery-node-current/bin:…`（Node 24）启动新 release，满足该条。
3. `MANIFEST.sha256` 由产物自身逐文件生成、自洽，**不要求跨主机可复现构建**；`engines` 约束的是运行环境，生产满足，被违反的只是本地构建机。

**升级为 P1（必须走模式 V）的条件**：① 需要跨主机逐字节可复现的构建；② 出现只在 v26 构建产物中才会复现的异常（当前未观察到）；③ 把 `npm ci`/构建搬到 VPS 上时**没有**用 `/opt/crosery-node-current/bin/npm`。

### 7.3 模式 V（在 VPS 上用 pinned Node 构建）测算 —— **只测算，未执行**

| 项 | 实测 / 估算 | 依据（全部只读） |
| --- | --- | --- |
| registry 可达性 | **可达**：HTTP 200，connect 8 ms，total 50 ms | VPS 上 `curl -sS -o /dev/null -w … https://registry.npmjs.org/` |
| 单流吞吐 | **≈1.2 MB/s**（630 KB / 0.53 s） | 把 `vue-3.5.13.tgz` 下到 `/dev/null`，未落盘 |
| 现有 npm 缓存 | 60 MB（`/root/.npm`，registry 已是官方源） | `du -sh /root/.npm` |
| 依赖规模 | lock **588** 条（生产 253 条 → **新增 335 个包**） | 两侧 `package-lock.json` 对比 |
| 预计下载量 | **约 140–190 MB**（解包体积 588 包 ≈ 460 MB × 30–35% 压缩比） | **估算，未验证** |
| 预计 `npm ci` | **约 2–6 分钟**（并行抓取通常快于单流实测；60 MB 缓存可再省一点） | 估算 |
| 预计 `npm run build` | **约 1–3 分钟**（VPS 4 核；本地参考：2084 modules / vite 0.6 s + tsc） | 估算 |
| 磁盘 | 解包后 `node_modules` 约 400–500 MB（现 197 MB）；`/` 余 9.3 GB | `du`/`df` |
| **内存（唯一实质风险）** | 可用仅 **1366 MB**（`free -m`），`tsc -b` + `vite build` 峰值可能 >1 GB → **存在 OOM 可能**；失败只影响新目录（线上无感），可重试或加 `NODE_OPTIONS=--max-old-space-size=1024` | `free -m` |
| 结论 | 模式 V **可行但非必要**；若采用，预算 **额外 5–10 分钟 + 一次网络依赖 + OOM 重试** | — |

### 7.4 发布前必须复述的三条回退触发线（切换前由 Lead 复述确认）

1. `NRestarts` 增长（`systemctl show -p NRestarts` 超过切换前记录值）；
2. `GET http://127.0.0.1:8787/api/session` ≠ `200`；
3. `curl -s http://127.0.0.1:8787/ | grep -c 'id="app"'` = `0`（新前端没生效）。

任一条命中 → 立即执行 runbook §5 回退（`ln -s BASE` + `mv -T` + `systemctl restart`，约 10 秒）。

### 0.2.2 第三次刷新（三条高危修复 + 压缩层之后）：发布源 = \`e773919\` 之后的提交

| 项 | \`8fa05fe\` | **本轮 \`20261001-r4\`** |
| --- | --- | --- |
| 组装树 | 414 文件 / 6.83 MB，MANIFEST 413 | **429 文件 / 7.06 MB，MANIFEST 428** |
| 缺失生产文件 | 0 | **0** |
| dist | 77 文件 | **77 文件**（vite manifest 47，\`.vue\` 18、\`.tsx\` **0**） |
| 结果 | PASS | **PASS（1 条警告：本地 node v26 vs engines）** |

**并在发布包上做了启动演练 + 安全回归**（同一套隔离手法，端口 18911）：\`/\`、\`/docs\`、深链接全部 **200**；压缩从打包产物里生效（gzip **94,463** / br **78,047**）；登录 200；**越界凭据删 → 400 \`credential_name_invalid\`**；**未认证 \`/api/bootstrap\` → 401**（默认拒绝）。

### 0.3 最终验收（第 24 轮，HEAD \`fb05b52\`）：发布包 \`20261001-r5\`

| 项 | 结果 |
| --- | --- |
| 组装树 | **431 文件 / 7.11 MB，MANIFEST 430**，缺失生产文件 **0**，**PASS**（1 条既有警告：本地 node v26 vs engines） |
| 启动演练（隔离端口 18921，临时 HOME/DATA_DIR） | \`/\`、\`/docs\`、\`/rtk\`、深链接全部 **200** |
| 默认拒绝 | 未认证 \`/api/usage-overview\` → **401**；\`/api/session\` → **200**（白名单） |
| 压缩（从**打包产物**加载） | identity **640,500** / gzip **94,463** / br **78,047** |
| 三类穿越回归 | 凭据名 → **400 \`credential_name_invalid\`**｜rollback → **400 备份 id 不合法**｜provider → **400 不支持的 OAuth 提供商（列出可选值）** |
| 全量测试 | **677 / 676 pass / 0 fail / 1 skipped**，exit 0 |
| 红队收口审计 | 8 条主张独立成立、无回归（\`docs/qa/red-team/closeout-verification.md\`） |

**结论：发布包在当前 HEAD 上组装、启动、鉴权、压缩与三条高危回归全部通过。**

### 0.4 最终验收（第 29 轮，HEAD \`89c5104\`）：发布包 \`20261001-r6\`

| 项 | 结果 |
| --- | --- |
| 组装树 | **434 文件 / 7.18 MB，MANIFEST 433**，缺失生产文件 **0**，**PASS** |
| 启动（隔离 18931 + 临时 HOME/DATA_DIR） | \`/\`、\`/docs\`、\`/rtk\`、深链接 **200** |
| 鉴权 | 未认证 \`/api/usage-overview\` → **401**；\`/api/session\` → **200** |
| 压缩（打包产物） | identity **640,993** / gzip **94,584** / br **78,160** |
| 三条穿越回归 | 凭据名 **400**、provider **400**（列出可选值）、rollback 400 |
| 新能力 | \`/api/cache-live/status\` → \`{clients:0,limit:16}\`（SSE 上限已生效） |
| 全量测试（干净 HEAD 副本） | **692 / 689 pass / 0 fail / 3 skipped** |
| 四个扫描器 | 冒烟 13 路由 0 错误｜对比度 0 不达标｜响应式 112 组合 0 失败｜**可访问性 25 项 0 失败** |

**结论：发布包在当前 HEAD 上组装、启动、鉴权、压缩、穿越回归与新加的 SSE 上限全部通过，可直接按 runbook §1–§5 执行。**
