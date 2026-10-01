# 中转站生产 release ⟷ 本地仓库 双向漂移盘点（Phase 1，只读）

- **日期**：2026-10-01 ｜ **任务**：task-6 ｜ **执行**：deploy-reconciler ｜ **状态**：Phase 1 完成（未做任何生产写入，§6.1 自证）
- **生产主机**：`cpa-vps`（SSH 别名，见本机 `~/.ssh/config`）｜ 服务 `crosery-api-console.service`（`active`，MainPID 1476015，`ExecMainStartTimestamp=Mon 2026-09-28 00:00:23 EDT`，`NRestarts=0`）
- **生产 release**：`/opt/crosery-api-console-current → /opt/crosery-api-console-releases/20260928-reset-clears-cooldown`（release 内**无 `.git`**；运行进程 `cwd` 已解析到该 release 目录，见 CMD-9）
- **本地**：`/Users/crosery/work_file/crosery-api-console` @ `281c30e`（工作区另有他人未提交改动，见 §3.3）
- **工具与证据**：[divergence-scan.py](<docs/qa/deploy/divergence-scan.py>)、`docs/qa/deploy/evidence/`（原始 manifest、分类 TSV、本地测试日志、release 链 manifest 压缩包）

---

## 0. 结论（结论在前）

**生产 release 与本地仓库是「双向分叉」，不是「本地单方面领先」。** 生产侧有 **15 个源码/测试文件**带着本地完全没有的补丁（其中 3 个文件两边都改过，必须人工合并），本地侧有 **82 个文件**的新工作生产完全没有。生产 release 链从 `20260831T195446Z-low-latency-v2` 到当前共 **26 个 release 目录（25 个带 `MANIFEST.sha256`/`RELEASE.json`）**，每个 `RELEASE.json` 都写 `sourceRepository: /opt/crosery-api-console`，而那个目录停在本地 commit **`662a504`**：它缺 87 个 release 文件、有 66 个文件是打补丁前的旧版本、且**不含任何一个生产补丁**。它**不是**当前生产内容，不能当发布基线（这正是 `deploy/edge/README.md:37-44` 的警告）。

| 分类 | 数量 | 含义 |
| --- | --- | --- |
| `SAME` | 210 | 两侧逐字节一致 |
| **`P`** | **12** | 仅生产侧改动 → 生产补丁，必须回移 |
| **`P-ONLY`** | **3** | 生产有、本地没有该路径 |
| **`C`** | **3** | 两侧都改过 → 必须人工合并 |
| `C-NOBASE` | 1 | `MANIFEST.sha256`（两侧各自生成，无共同基线） |
| **`L`** | **17** | 仅本地侧改动 |
| **`L-ONLY`** | **65** | 本地新增（生产完全没有） |

- 路径总数 311 = 生产一侧 246（已排除 `node_modules/`、`dist/`、`.cache/`、`*.tsbuildinfo`、`.DS_Store`、`._.DS_Store`）+ 本地独有 65。
- 分类口径：先取「生产 release 链」与「本地 git 全部提交」两侧的内容历史，取最近一次两侧相同的内容作为共同基线；只有生产变 = `P`，只有本地变 = `L`，两边都变 = `C`。方法见 CMD-4 / CMD-5。
- **生产 release 里有 19 个文件的内容在本地任何提交中都不存在**（15 个源码/测试 + 2 个编译产物 + `RELEASE.json` + `MANIFEST.sha256`），明细见 §8.2。

---

## 1. `P` — 必须回移的生产补丁（15 个源码/测试文件）

按生产侧最后变更的 release 归组。每个文件的哈希/行数证据见 §8.1，逐文件 diff 用 CMD-6 复现。

### 1.1 `20260928-reset-clears-cooldown`（2026-09-27 事故修复，最高优先）

| 文件 | 生产侧改动 | 分类 |
| --- | --- | --- |
| `server/cpa.ts` | 新增 `setAuthFileCoolingDisabled()` / `clearAuthFileCooldown()`：CPA 无清冷却端点，用 `disable_cooling true→false` 当场清空该凭据既有冷却 | `C` |
| `server/index.ts` | `reset-codex-quota` / `reset-claude-quota` 成功后调用清冷却，响应新增 `cooldownCleared`，审计写 `cooldown-cleared` / `cooldown-clear-failed` | `C` |
| `server/cooldownClear.test.ts` | **本地不存在的 48 行新测试文件** | `P-ONLY` |
| `src/api.ts` | `resetCodexQuota` / `resetClaudeQuota` 返回类型加 `cooldownCleared: boolean` | `C` |
| `src/pages/MonitorPage.tsx` | 重置结果按 `cooldownCleared` 分别提示「已重置并清除网关侧冷却」/「额度已重置，但网关冷却未清除」 | `P` |

**不修的后果**：2026-09-27「额度明明重置了却用不了」事故回归（`RELEASE.json` 记录该次冷却挂了 5.6 天），而且**回归后不会有任何测试报错**——本地根本没有 `cooldownClear.test.ts`。

### 1.2 `20260926-fix-failing-tests-upload-guard`（安全收口 + 测试修复）

| 文件 | 生产侧改动 | 分类 |
| --- | --- | --- |
| `server/credentialUpload.ts` | +58 行：xAI/Grok/Antigravity 凭据文件里的 `token_endpoint` / `base_url` 必须是官方 https 域名（`x.ai`、`googleapis.com`，含子域、拒绝 `notx.ai` 相似域），类型不符按伪造拒绝；xAI 必须同时有 `access_token`+`refresh_token` | `P` |
| `server/credentialUpload.test.ts` | +28 行，覆盖 null/相似域/缺 refresh_token | `P` |
| `server/keyModelAccess.ts` | 新增 `DEFAULT_OPEN_MODEL_PREFIXES = ['gpt-image-']` 与 `defaultOpenModels(groups)`：默认开放项**只取实时目录里真实存在**的型号，取不到时如实降级 `DENY_ALL`（2026-08-20 事故约束） | `P` |
| `server/keyModelAccess.test.ts` | +29 行 | `P` |
| `server/keyPoolReconcile.test.ts` | 撤权后只应剩 `codex` + 默认开放渠道，显式断言 `mox-aigw` 消失 | `P` |
| `server/cacheStats.test.ts` | 钉住日期 `2026-08-10`、区分 272K 长上下文阶梯价内外 | `P` |
| `server/liveStream.test.ts` | 同上，夹具改为 20 万输入走基础价 | `P` |
| `server/modelIndex.test.ts` | 只断言计价字段，不再深比价格段 `from/until/note` | `P` |
| `server/index.ts` | 另含该 release 的改动：`getCpaVersion()` 并入 bootstrap 的 `Promise.allSettled` 并发读，网关故障时不再多等两轮超时 | `C` |

**不修的后果（两条）**：
1. **本地当前正在跑的这套代码就是没收口的版本。** 生产 09-26 修的是「09-25 通用导入放开了渠道类型、但没收回端点」——伪造的 xAI/Antigravity 凭据文件可以把 token 与用户请求指向任意域名。本地 `server/credentialUpload.ts` 仍是 09-25 版本（§8.1 的哈希证据）。
2. 本地 7 个测试文件在 `281c30e` 上是**红的**（§5.1 第 7 条实测），生产这三个 release 正是修复/更新它们的那批改动。

### 1.3 `20260926-default-open-gpt-image`（其余部分）

| 文件 | 生产侧改动 | 分类 |
| --- | --- | --- |
| `server/keyChannelAccess.ts` | `DEFAULT_OPEN_CHANNELS` 从 `['claude']` 扩到 `['claude', 'codex']`，并写明「刻意写死、不按 gpt-image 反推渠道」的理由 | `P` |
| `server/keyChannelAccess.test.ts` | 4 处 hunk：期望值随默认开放渠道更新，新增「没勾 codex 的 Key 也能进 codex 渠道」 | `P` |

### 1.4 非代码的 `P`（不要手工回移）

| 文件 | 说明 |
| --- | --- |
| `RELEASE.json` | 生产侧是本次 release 的变更记录（17 行）；本地同名文件是 `20260925-oauth-official-oauth-page-aligned` 那次 release 的记录（20 行）。属于发布元数据，**不是代码补丁**，Phase 2 必须重新生成 |
| `build/packages/contracts/index.js`、`index.js.map` | 生产侧 20260901 起未变过的编译产物（本地 `.gitignore:17` 忽略 `build/`）。属于生成物，**不要回移**，由 `npm run build` 重新产出 |
| `MANIFEST.sha256` | `C-NOBASE`：两侧各自生成，无共同基线，必须重新生成 |

---

## 2. `C` — 必须人工合并的冲突（3 个文件，逐点）

三个文件都是「生产补丁 + 本地新架构」正面相遇，**不能整文件覆盖任何一侧**。逐点如下（完整 diff 用 CMD-6 复现）。

### 2.1 `server/cpa.ts`（生产 637 行 ｜ 本地 652 行）

| 冲突点 | 生产侧 | 本地侧 | 合并判据 |
| --- | --- | --- | --- |
| `cpaRequest<T>()` 开头 | 无 | 新增 magpie 分支：`gatewayEngine==='magpie' && magpieControlPlane==='local'` 时走 `magpieManagementRequest()` | **保留本地**；生产补丁的 `setAuthFileCoolingDisabled` 走同一个 `cpaRequest`，magpie 模式下要确认清冷却对 magpie 控制面是否可达（**未验证**，需 Phase 2 判定） |
| `uploadAuthFile()` | 无 | 同上 magpie 本地保存分支 | 保留本地 |
| `CompatChannel['api-key-entries']` 元素类型 | 收窄为 `{ 'api-key'?: string }`（去掉 `proxy-url`） | 保留 `{ 'api-key'?: string; 'proxy-url'?: string }` | **必须人工判定**：生产在 20260928 顺手收窄，本地还有 `proxy-url` 用法；若 CPA 不再回传该字段，本地读到的永远是空，属潜在死代码/功能失效 |
| `CpaVersionInfo` | 无 `engine` / `upstream` / `rtk` 字段 | 新增 `engine`、`upstream`、`rtk` | 保留本地 |
| `getCpaVersion()` | 保留 CPA 原路径 + 缓存 60s | 新增 magpie 分支（读 `/internal/health` 的 kernel revision、`readMagpieUpstreamStatus`、RTK 状态） | 保留本地；生产的缓存分支需与 magpie 分支并存 |
| **生产独有（无冲突）** | 新增 `setAuthFileCoolingDisabled()` + `clearAuthFileCooldown()` 及注释 | — | **必须整段回移** |

### 2.2 `server/index.ts`（生产 1146 行 ｜ 本地 1182 行）

| 冲突点 | 生产侧 | 本地侧 | 合并判据 |
| --- | --- | --- | --- |
| `./cpa.js` 导入行 | 加 `clearAuthFileCooldown` | 同一行已被本地改写 | 两侧都要，冲突在**同一行**，必须手工合并 |
| `/api/bootstrap` 控制面并发读 | `getCpaVersion()` 移进 `Promise.allSettled`，用 `cpaVersionResult`（网关故障少等两轮超时） | 未改 | **回移生产**；本地若在 bootstrap 里加了 magpie 相关读取，需要一起排进同一个并发组 |
| `reset-codex-quota` / `reset-claude-quota` | 成功路径 `try { await clearAuthFileCooldown(...) }` + `cooldownCleared` 响应 + 审计标签 | 未改 | **回移生产** |
| `POST /api/models/sync`、`GET /api/rtk/status`、`POST /api/rtk/toggle` | 无 | 本地新增三个路由 | 保留本地（生产侧没有这些端点） |
| 启动段 `startModelCatalogWatcher()` / `startMagpieServer()` | 无 | 本地新增 | 保留本地 |

> 结论：`server/index.ts` 的两侧改动**位置基本不重叠，但导入行冲突**，人工合并工作量约 5 分钟，风险低。

### 2.3 `src/api.ts`（生产 88 行 ｜ 本地 94 行）

| 冲突点 | 生产侧 | 本地侧 | 合并判据 |
| --- | --- | --- | --- |
| 顶部 import | 去掉 `ModelSyncResult` / `RTKStatusResponse` | 加 `ModelSyncResult` / `RTKStatusResponse` | 保留本地 |
| `resetCodexQuota` / `resetClaudeQuota` | 返回类型加 `cooldownCleared: boolean` | 未改 | **回移生产**（这是本地 Vue 版 `MonitorPage.vue` 也要消费的契约） |
| `syncUpstreamModels` / `getRTKStatus` / `toggleRTK` | 无 | 本地新增 | 保留本地 |

### 2.4 `C-NOBASE`：`MANIFEST.sha256`

生产 299 行（含 `dist/` 49 条、`.cache/` 3 条、`._.DS_Store` 1 条）｜ 本地 295 行。两侧各自生成，无共同基线，Phase 2 重新生成即可。**已交叉验证生产 MANIFEST 与真实文件 100% 一致**（含 `dist/` 49/49，见 CMD-8），说明生产发布流程的校验是有效的。

---

## 3. `L` — 本地领先（生产完全没有）

### 3.1 本地新增文件（65 个 `L-ONLY`）

| 主题 | 文件 | 首个本地提交 |
| --- | --- | --- |
| Vue 3 + Tuffex 重写（17 个 `.vue` + 路由/样式/uno） | `src/**/*.vue`、`src/router.ts`、`src/main.ts`、`src/env.d.ts`、`src/styles/{theme,layout}.css`、`uno.config.ts` | `600a5ca` / `7b71f6d` / `12f7699` |
| Magpie 内核适配 | `server/magpie{Control,Engine,Migration,OAuth,Runtime,Upstream}.ts` + 测试、`deploy/magpie/**`、`scripts/magpie*.mjs`、`packages/contracts/magpie-upstream*` | `cddf0d2`…`7e1c8ce` |
| RTK | `server/rtkService.ts`（337 行）、`server/rtkService.test.ts` | `7e1c8ce` |
| 动态模型同步 | `server/modelSync.ts`（311 行）+ 测试 | `7e1c8ce` |
| 文档 | `deploy/magpie/{README,CONSOLE-KERNEL,UPSTREAM}.md`、`deploy/magpie/upstream/{API.md,api.json}`、`docs/research/magpie-cpa-integration.md` | `cddf0d2`…`f30da5e` |

### 3.2 两侧都有但只有本地改过（17 个 `L`）

`.env.example`、`.gitignore`、`README.md`、`index.html`、`package.json`、`package-lock.json`、`vite.config.ts`、`server/config.ts`、`server/gatewayStatus.test.ts`、`server/modelCatalog.ts`、`src/gatewayStatus.ts`、`src/App.css`、`src/App.tsx`、`src/components/VersionWidget.tsx`、`src/pages/DashboardPage.tsx`、`src/pages/ModelsPage.tsx`、`src/types.ts`。

### 3.3 结构性事实（决定 Phase 2 的形态）

- 生产是 **100% React**：`src/**` = 27 个 `.tsx`、6 个 `.ts`、4 个 `.css`、3 个图片，**0 个 `.vue`**；生产 release 的 `dist/` 是这份 React 源码的构建产物（`index.html` 入口为 `/assets/console-CLfpNprV.js`）。`server/index.ts` 里 `rtk` 出现 **0 次**，`server/` 下 **0 个文件**含 `rtk`，无 `server/rtkService.ts`，无 `deploy/magpie/**`，无 `apps/`、`packages/contracts/*.ts`（只有 1 个 20260901 的编译产物）。
- 本地同时保留 React 与 Vue 两套 `src/`（27 个 `.tsx` 仍被跟踪，`package.json` 同时有 `react`/`lucide-react`/`recharts` 与 `vue`/`@talex-touch/tuffex`/`unocss`）；生产 release 的 `dist/` 里**有 `CredentialUploadPage-OYYhWGrF.js`**，而本地已在 `92a0835` 有意下线「凭据导入」入口。
- 本地领先的提交：相对本地冻结点 `662a504` 是 **19 个提交**（`git rev-list --count 662a504..HEAD`）；但真正的分叉点在 **`eb5a026`（2026-09-26，对齐 CPA 官方 OAuth 面板）**——它与生产 release `20260925-official-oauth-page-aligned` 相似度最高（295 个文件里 241 个逐字节相同）。`eb5a026..HEAD` 是 **15 个提交**，主题是 Magpie/RTK/模型同步/Vue 重写。
- 工作区当前还有他人未提交改动（`server/index.ts`、`server/rtkService.ts`、`src/App.vue`、`src/pages/*.vue`、`src/lib/**` 等），**本报告的所有本地哈希都取 `git archive HEAD`（不包含工作区改动）**。

---

## 4. 风险排序

| # | 风险 | 触发条件 | 证据 | 现有缓解 |
| --- | --- | --- | --- | --- |
| **R1** | **凭据导入端点收口缺失（安全）** —— 09-25 的通用导入没有校验 `token_endpoint`/`base_url` 域名，伪造的 xAI/Antigravity 凭据可把 token 与请求转发到任意域名 | **本地当前运行的就是这个版本**（不只发布风险）；生产已修 | §1.2、§8.1（`server/credentialUpload.ts` 本地 `2be546b3fbb8` vs 生产 `5c9b74b060eb`） | 端点需管理员登录；`data/auth-files/` 无真实生产 token（交接文档 §3.3） |
| **R2** | **冷却清除修复缺失（可用性事故回归）** —— 「重置了但用不了」会持续到原重置点（上次 5.6 天） | 任何用本地代码重建的发布上线后 | §1.1（`cooldownClear.test.ts` 本地不存在） | 无 |
| **R3** | **发布基线错误** —— 所有 `RELEASE.json` 记 `sourceRepository=/opt/crosery-api-console`，而该目录停在 `662a504`、缺 87 个文件、不含任何生产补丁 | Phase 2 若按 `RELEASE.json` 记录的方式重建 | §8.5（`server/cpa.ts` mutable=`f9ebc7901b86`=662a504 版本，生产=`bd97f7ed6227`） | `deploy/edge/README.md:37-44` 已写明「从当前 release 目录复制」 |
| **R4** | **本地测试门禁是红的** —— `281c30e` 上 7 个 P 类测试文件全部失败（实测 16 个用例名） | 本地 `npm test` 无法作为发布门禁；谁把它当门禁就会误判 | §5.1 第 7 条（`evidence/local-head-tests.log`） | 无 |
| **R5** | **一次性 UI 栈替换** —— 从本地发版 = Vue/Tuffex 全量替换生产 React 界面，同时按 `92a0835` 下线凭据导入入口（生产仍在用） | 发布新 release | §3.3、`evidence/release-chain-manifests.tar.gz`（生产 MANIFEST 的 `dist/` 段含 `CredentialUploadPage-OYYhWGrF.js`） | 需要产品/用户明确接受 |
| **R6** | **发布产物与校验** —— 生产 `dist/`（49 文件）与 `MANIFEST.sha256` 严格一致，且校验发生在切 symlink 之前 | Phase 2 若只搬源码不重建 `dist`/MANIFEST | §5.1 已验证第 3 条（CMD-8） | `deploy/edge/README.md:15-18` |
| **R7** | **元数据/产物噪音** —— `RELEASE.json`、`MANIFEST.sha256`、`build/packages/contracts/*.js` 混在 diff 里，容易把「生成物差异」误当补丁 | 人工审阅 Phase 2 的 patch | §1.4 | 本报告已把它们单列 |

---

## 5. 已验证 / 未验证

### 5.1 已验证（可复现）

1. 生产 `current` 指向 `20260928-reset-clears-cooldown`，release 内无 `.git`；运行进程 `cwd` 即该 release 目录（CMD-9）。
2. 生产 `server/index.ts` 中 `rtk` 出现 **0 次**；`server/` 目录下 **0 个文件**出现 `rtk`；无 `server/rtkService.ts`、无 `deploy/magpie/**`（CMD-10）。
3. 生产 `MANIFEST.sha256` 与真实文件**逐条一致**：非 `dist` 部分无一条不匹配，`dist/` 49/49 一致、无多余无缺失（CMD-8）。
4. 生产 release 链 25 个 `MANIFEST.sha256` 逐 release 比对出每个文件的变更历史（CMD-5；`evidence/prod-release-file-history.tsv`）。
5. 三方分类 311 条路径全部有哈希与行数（`evidence/classification.tsv`）；生产 release 里 19 个文件的内容**不在本地任何提交**中（CMD-4）。
6. `/opt/crosery-api-console`（mutable checkout）`git HEAD = 662a5047fb577680d10794e7c788d5ffe254eb08`，与本地 `662a504` 同 SHA；其工作树 161 个相关文件中 66 个与当前 release 不同、87 个 release 文件缺失（CMD-11、§8.5）。
7. 本地 `HEAD` 上 7 个 P 类测试文件**全部失败**（`evidence/local-head-tests.log`，CMD-7）：`cacheStats`(1)、`liveStream`(1)、`modelIndex`(1)、`keyPoolReconcile`(2)、`keyModelAccess`(3)、`keyChannelAccess`(6)、`credentialUpload`(2) 共 16 个用例名。
8. 生产 base 快照 `662a504` 的 52 个跟踪文件中，23 个至今逐字节未变、29 个被打过补丁、0 个被删——证明 release 链是从该快照出发后被持续打补丁（CMD-4）。

### 5.2 未验证（不许脑补）

| 项 | 原因 |
| --- | --- |
| **生产侧这批补丁的测试是否通过** | `RELEASE.json` 声称「修复全部 12 个 server 测试失败」，但**没有在生产执行任何测试**（会碰到 `/opt/crosery-api-console/data` 的 SQLite，本任务硬禁令）。仅生产 release 的文字记录，**未验证** |
| 本地完整 `npm test` 的结果 | 只单独跑了 7 个 P 类测试文件（隔离副本），完整套件会与并行构建/测试互踩，**未跑** |
| `disable_cooling` 清冷却在 **magpie 本地控制面**下是否可用 | 本地 `cpaRequest()` 在 magpie 模式走 `magpieManagementRequest()`，生产补丁未覆盖该分支；需要 Phase 2 判定（§2.1） |
| 生产对外暴露面（nginx / 公网端口 / 是否仅内网可达）与凭据导入端点是否可被外网访问 | 未探测任何生产 API、未做端口或路径扫描（禁令禁止 POST，本次也未做主动探测）；只确认服务在本机 `active` |
| `build/packages/contracts/index.js` 是否被运行期加载 | 只验证存在与哈希；生产 `start` 是 `tsx server/index.ts`，未见引用该产物 |
| 本地工作区（未提交改动）的相对完整状态 | 其他成员正在改，本报告只对 `HEAD` 负责 |
| 生产 `/opt/crosery-api-console/rotate_key.mjs`（root 所有，2026-09-16，本地未跟踪） | 可能含凭据相关内容，**未读取、未纳入本报告**；仅登记存在性，建议 Lead 单独确认归属 |

---

## 6. 复现命令

所有生产命令都带 `-o ControlMaster=no -o ControlPath=none`。下面每条**只读**（`find`/`ls`/`cat`/`wc`/`sha256sum`/`grep`/`readlink`/`systemctl show|cat|is-active`/`git log|rev-parse|for-each-ref`/`tar -cf -` 到 stdout）。

| ID | 用途 | 命令 |
| --- | --- | --- |
| CMD-1 | 生产 release 文件清单 + sha256 + 行数 | `ssh -o ControlMaster=no -o ControlPath=none cpa-vps 'cd /opt/crosery-api-console-current && find . -type f -not -path "./node_modules/*" -not -path "./dist/*" -not -path "./.cache/*" -not -name "*.tsbuildinfo" -not -name ".DS_Store" -not -name "._.DS_Store" -printf "%p\n" \| LC_ALL=C sort \| while IFS= read -r f; do printf "%s\t%s\t%s\n" "$(sha256sum "$f" \| cut -c1-64)" "$(wc -l < "$f")" "$f"; done'` |
| CMD-2 | 本地 HEAD 同款清单（不碰工作区） | `git archive HEAD \| tar -x -C "$TMP/head" && cd "$TMP/head" && … shasum -a 256 …`（同上 find 管道，`sha256sum`→`shasum -a 256`） |
| CMD-3 | 本地 frozen 快照 `662a504` 同款清单 | `git archive 662a504 \| tar -x -C "$TMP/base" && …` |
| CMD-4 | 三方分类 + 「生产内容是否在本地任何提交出现过」 | `python3 docs/qa/deploy/divergence-scan.py "$TMP" "$REPO"`（输入见脚本 docstring；输出 `classification.tsv` / `analysis.json`） |
| CMD-5 | 抓全部 release 链的 MANIFEST/RELEASE 记录 | `ssh … cpa-vps 'cd /opt/crosery-api-console-releases && tar -cf - */MANIFEST.sha256 */RELEASE.json' \| tar -xf -` |
| CMD-6 | 单文件逐行 diff（本地 vs 生产） | `diff -u "$TMP/head/<path>" "$TMP/prod/<path>"`，`$TMP/prod` 用 `ssh … 'cd /opt/crosery-api-console-current && tar -cf - <paths>' \| tar -xf - -C "$TMP/prod"` |
| CMD-7 | 本地 HEAD 上跑 P 类测试（隔离副本，只读工作区） | `ln -sfn "$REPO/node_modules" "$TMP/head/node_modules" && cd "$TMP/head" && HOME="$TMP/fakehome" node --test --import tsx server/<name>.test.ts` |
| CMD-8 | 生产 `dist/` 与 MANIFEST 一致性 | `ssh … 'cd /opt/crosery-api-console-current && find dist -type f \| sort \| while IFS= read -r f; do printf "%s  %s\n" "$(sha256sum "$f" \| cut -c1-64)" "$f"; done'` → 与 `MANIFEST.sha256` 的 `dist/` 段比对 |
| CMD-9 | 运行进程确认（只读 `/proc`，**不读 `environ`**） | `ssh … 'mp=$(systemctl show crosery-api-console.service -p MainPID --value); readlink /proc/$mp/cwd; readlink /proc/$mp/exe; tr "\0" " " < /proc/$mp/cmdline'` |
| CMD-10 | 生产 RTK 缺席确认 | `ssh … 'cd /opt/crosery-api-console-current && grep -ric rtk server/ \| wc -l; ls server/rtkService.ts'` |
| CMD-11 | mutable checkout 状态（只读 git） | `ssh … 'git -C /opt/crosery-api-console log --oneline -3; git -C /opt/crosery-api-console rev-parse HEAD'` + 对其工作树做 CMD-1 同款哈希（排除 `.env*`、`data/`、`node_modules/`、`dist*`、`.git/`） |

### 6.1 零写入自证（含一条自我披露）

- 本会话在生产主机上执行的命令**全部为只读**：`ls、cat、head、wc、find、grep、sha256sum、readlink、systemctl is-active/show/cat、ps、git log/rev-parse/for-each-ref/remote -v、tar -cf -（写 stdout）`。
- **未做**：未改 `/opt/crosery-api-console-current` 或任何符号链接；未启停/重启 `crosery-api-console.service` 或任何 systemd 单元；未写 `/opt/crosery-api-console/data`、未碰 SQLite；未读写 `.env`；未删除或移动任何远端文件；未向生产 API 发任何请求（无 GET/POST 到 8791）。
- **⚠️ 自我披露（唯一一次越界）**：会话早期执行清单统计时，曾在生产机 `/tmp` 落过一个临时文件 `/tmp/prod-files.txt`（内容只是一份 `find` 出来的**文件路径清单**，246 行，不含任何文件内容或凭据）：
  `ssh … cpa-vps 'cd /opt/crosery-api-console-current && find … > /tmp/prod-files.txt'`。它**不在** `/opt` 下、不参与服务运行；按禁令「不删除任何远端文件」，我没有删除它，特此登记待 Lead 处置。
- 本地只写了两个位置：`docs/qa/deploy/**`（交付物与证据）与 `/tmp/cac-deploy-recon/**`（工作目录、HEAD 导出副本、测试日志）。

---

## 7. Phase 2 建议顺序（等 Lead 放行，本任务未开始）

1. **先做 R1/R2 的最小回移（不改前端）**：`server/cpa.ts`（清冷却函数）、`server/index.ts`（两个 reset 端点 + cooldownCleared）、`server/cooldownClear.test.ts`、`src/api.ts`（类型）。这是唯一带**事故回归**性质的补丁，且与前端的 Vue/React 之争无关。
2. **再做安全收口**：`server/credentialUpload.ts` + 其测试（xAI/Antigravity 端点校验）。回移后本地运行的 8791 才和生产同安全等级。
3. **再做默认开放模型族**：`keyModelAccess.ts` / `keyChannelAccess.ts` + 4 个测试文件。注意 `defaultOpenModels()` 依赖 `ConsoleGroup` 类型（本地 `src/types.ts` 已改），需重新对类型。
4. **最后做测试加固**：`cacheStats.test.ts` / `liveStream.test.ts` / `modelIndex.test.ts`（钉日期与阶梯价断言）——它们是让 R4 变绿的关键；改完必须实跑 `npm test`（取 `/tmp/cac-build.lock`）。
5. **新 release 内容**：**从当前生产 release 目录复制**（`deploy/edge/README.md:37-44`），只把经审阅的补丁叠加进去；不要用本地树整体替换。本地 Vue 重写是否进这个 release，是产品决策（R5）。
6. **发布脚本与回退**：必须在 staging 上验证「`MANIFEST.sha256` 校验 → 切 `crosery-api-console-current` 前先跑 pinned Node 的验证 → 保留旧 symlink 目标用于回退」，并明确 SQLite 备份边界（`deploy/edge/README.md:20-35`）。**切换 symlink / 重启生产服务需要用户另行明确批准，不在 task-6 范围。**
7. **零写入纪律延续**：Phase 2 若需要在生产上落地任何东西，先由 Lead 与用户确认授权边界。

---

## 8. 逐文件证据表

> 生成来源：`docs/qa/deploy/evidence/*`（CMD-1…CMD-5）。`sha256` 为完整 64 位十六进制；`HEAD` 指本地 `281c30e`，`PROD` 指生产 release `20260928-reset-clears-cooldown`；`BASE` 指本地 `662a504`（生产 release 链的起点快照）。行数用 `wc -l`（二进制/无换行文件可能为 0）。机器可读版本：`evidence/classification.tsv`（311 行，全部路径）、`evidence/mutable-vs-release.tsv`（248 行，第三方副本对照）、`evidence/prod-release-file-history.tsv`（每个文件在每个 release 的哈希变化）。

### 8.1 必须回移的补丁（`P` / `P-ONLY` / `C`，15 个源码测试文件 + 元数据）

| 路径 | 分类 | PROD sha256 | PROD 行 | HEAD sha256 | HEAD 行 | 生产最后变更 | 本地最后变更 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `server/cpa.ts` | C | `bd97f7ed622794053ca94135a8b19bcd16da4b6bd29416db140b93155f9eabeb` | 637 | `bad2b27b319e3553954c8c6143e9bb4025b35b6868d8b48d4eb8dbcc6645a528` | 652 | 20260928-reset-clears-cooldown | 7e1c8ce |
| `server/index.ts` | C | `6d070bcde589beb514da5a82f63305a83cd6c88a6eb9c7b08f1fa648bdf55425` | 1146 | `b80a4923c3764a20f5a908ea6958c583c3a66eef4d00e88347006aa5b0e20721` | 1182 | 20260928-reset-clears-cooldown | 7e1c8ce |
| `src/api.ts` | C | `7e5b1b993b0e1014f6bd9c77ab702b1f113d4f5e8a0ee7fcc83c0e66d3312883` | 88 | `c773cc498febaa1118300aa6af725b47df47791cfb2aec1eb2da274750ca8a12` | 94 | 20260928-reset-clears-cooldown | 7e1c8ce |
| `server/cooldownClear.test.ts` | P-ONLY | `cb60cff75b395c4cbc0bd1027626161988574557ee6a635b01c2c6362b1cb671` | 48 | `—` | — | 20260928-reset-clears-cooldown | — |
| `src/pages/MonitorPage.tsx` | P | `024c3d55a3c23a107c9c19a8ea1d87c81a75b22817339188d6956c73e36d27b0` | 209 | `698147a995e7ae5aa96bac76c1d4726c13f709306013daf07874deeebf15a87b` | 206 | 20260928-reset-clears-cooldown | 2b96f37 |
| `server/credentialUpload.ts` | P | `5c9b74b060eb79878ed67d4f237bae6231b8fb8475487ec80ae37d9ad7e3a35c` | 167 | `2be546b3fbb88a19a5fe60ea3b82f42afb07ad3decc640d83d712121c0cfde40` | 110 | 20260926-fix-failing-tests-upload-guard | eb5a026 |
| `server/credentialUpload.test.ts` | P | `27d1ea80de2b66db41e575d1c13e644cec0bb5231437f8990c4d1f9ab5362711` | 129 | `835eb3c2ce12c39b9e65f765456aae73a5aea18a55a731e0d5478c7cbb97829f` | 103 | 20260926-fix-failing-tests-upload-guard | 2b96f37 |
| `server/keyModelAccess.ts` | P | `a1b08bce500000c551de46bc94d4cfa1ad442cc7b830c1b44ca380a78467ac8a` | 83 | `b94fe7f4ee0cb00ee7e5ccca1506beffd89a5a4e9f059d753fbac5b20151e4a6` | 60 | 20260926-fix-failing-tests-upload-guard | 2b96f37 |
| `server/keyModelAccess.test.ts` | P | `d67f09a24f728fc6572c3cd092e54afd2de16f268471147657bd64d2dfb3d614` | 65 | `3e020dd321299c4c436f5231b3729a2ae3aef5cc9754ea0962b8b81a7f60392f` | 42 | 20260926-fix-failing-tests-upload-guard | 2b96f37 |
| `server/keyPoolReconcile.test.ts` | P | `4b3d3487a6df8def943890a5c8afe467734e08a9b7929f9d2e917cccf8aa9150` | 80 | `a79ba694ee5ca57ad4da3907d62d8294778fb42b790d267c0d6f3267eba8213b` | 75 | 20260926-fix-failing-tests-upload-guard | 2b96f37 |
| `server/cacheStats.test.ts` | P | `b56f7106b7b2eeec4935c1fcd0139711248877f26318cb03fb23c8c623afed7a` | 117 | `62f2ce8f3591a470039a7e4f441681cfa4fea779f05a05ef28233545710f6d66` | 108 | 20260926-fix-failing-tests-upload-guard | 2b96f37 |
| `server/liveStream.test.ts` | P | `d96bf9c640a07a53dddd858de51fd684c78b00b62904b9816a2fbb1c8f526414` | 282 | `4f34c2cf87799b7dfee9fb77ae31fe919b598c61052a806d9443f23123e42ccf` | 281 | 20260926-fix-failing-tests-upload-guard | 2b96f37 |
| `server/modelIndex.test.ts` | P | `b64d4f9d34828f3ff4280541f36910c4cb09d34e151078b3f49c834b43dbd805` | 96 | `922f9ea9a0391095094ccbd65aa51771711c785ad420f3b3980a65101367f034` | 92 | 20260926-fix-failing-tests-upload-guard | 2b96f37 |
| `server/keyChannelAccess.ts` | P | `e13a1c640b01ee9eec90ef1af8367b49dc22301471d012449b296a3e952aa6c4` | 69 | `b79db39644d92e181acb6d033d193ec5c9331fa7a2990f6ea85a91b992e6bd6e` | 64 | 20260926-default-open-gpt-image | 2b96f37 |
| `server/keyChannelAccess.test.ts` | P | `1aa76dd9ebc6d235555fca0fe9c92abe9157de279bd51d1a3ef4476e37c1723c` | 87 | `3a7575e56877a21e04b892630ddb2b4584924c7499f28cf491db401005419b9e` | 81 | 20260926-default-open-gpt-image | 2b96f37 |
| `RELEASE.json` | P | `8b49a789b224a4d678706c7893f09b4593ce95e663dff1e96aba5f2b47bde3d1` | 17 | `f0ec481579cddeea6ad5ac720a7e988d6c04df698ac95ad03534c96a77736506` | 20 | 20260928-reset-clears-cooldown | eb5a026 |
| `build/packages/contracts/index.js` | P-ONLY | `dcb2bdc3df76fa6eb3463637e7faff48eca535f2be263883dfa9b479c7b04b3a` | 211 | `—` | — | 20260901T155553Z-antigravity-monitor | — |
| `build/packages/contracts/index.js.map` | P-ONLY | `7cdbf073979f174239b38fe5cd96f735089a9e2d1656954695684740a7e831ce` | 0 | `—` | — | 20260901T155553Z-antigravity-monitor | — |

### 8.2 生产 release 里内容**从未出现在本地任何提交**的文件（19 个）

| 路径 | 分类 | PROD sha256 | PROD 行 | 生产引入 release | 性质 |
| --- | --- | --- | --- | --- | --- |
| `MANIFEST.sha256` | C-NOBASE | `138c888a97c6fda9f638b24df58c0b9d9dff0c568c88a9d121e4a8b508008204` | 299 | — | 发布元数据 |
| `RELEASE.json` | P | `8b49a789b224a4d678706c7893f09b4593ce95e663dff1e96aba5f2b47bde3d1` | 17 | 20260928-reset-clears-cooldown | 发布元数据 |
| `build/packages/contracts/index.js` | P-ONLY | `dcb2bdc3df76fa6eb3463637e7faff48eca535f2be263883dfa9b479c7b04b3a` | 211 | 20260901T155553Z-antigravity-monitor | 编译产物（生成物） |
| `build/packages/contracts/index.js.map` | P-ONLY | `7cdbf073979f174239b38fe5cd96f735089a9e2d1656954695684740a7e831ce` | 0 | 20260901T155553Z-antigravity-monitor | 编译产物（生成物） |
| `server/cacheStats.test.ts` | P | `b56f7106b7b2eeec4935c1fcd0139711248877f26318cb03fb23c8c623afed7a` | 117 | 20260926-fix-failing-tests-upload-guard | 测试 |
| `server/cooldownClear.test.ts` | P-ONLY | `cb60cff75b395c4cbc0bd1027626161988574557ee6a635b01c2c6362b1cb671` | 48 | 20260928-reset-clears-cooldown | 新增测试（本地无此文件） |
| `server/cpa.ts` | C | `bd97f7ed622794053ca94135a8b19bcd16da4b6bd29416db140b93155f9eabeb` | 637 | 20260928-reset-clears-cooldown | 源码补丁（C） |
| `server/credentialUpload.test.ts` | P | `27d1ea80de2b66db41e575d1c13e644cec0bb5231437f8990c4d1f9ab5362711` | 129 | 20260926-fix-failing-tests-upload-guard | 测试 |
| `server/credentialUpload.ts` | P | `5c9b74b060eb79878ed67d4f237bae6231b8fb8475487ec80ae37d9ad7e3a35c` | 167 | 20260926-fix-failing-tests-upload-guard | 安全补丁 |
| `server/index.ts` | C | `6d070bcde589beb514da5a82f63305a83cd6c88a6eb9c7b08f1fa648bdf55425` | 1146 | 20260928-reset-clears-cooldown | 源码补丁（C） |
| `server/keyChannelAccess.test.ts` | P | `1aa76dd9ebc6d235555fca0fe9c92abe9157de279bd51d1a3ef4476e37c1723c` | 87 | 20260926-default-open-gpt-image | 测试 |
| `server/keyChannelAccess.ts` | P | `e13a1c640b01ee9eec90ef1af8367b49dc22301471d012449b296a3e952aa6c4` | 69 | 20260926-default-open-gpt-image | 行为补丁 |
| `server/keyModelAccess.test.ts` | P | `d67f09a24f728fc6572c3cd092e54afd2de16f268471147657bd64d2dfb3d614` | 65 | 20260926-fix-failing-tests-upload-guard | 测试 |
| `server/keyModelAccess.ts` | P | `a1b08bce500000c551de46bc94d4cfa1ad442cc7b830c1b44ca380a78467ac8a` | 83 | 20260926-fix-failing-tests-upload-guard | 行为补丁 |
| `server/keyPoolReconcile.test.ts` | P | `4b3d3487a6df8def943890a5c8afe467734e08a9b7929f9d2e917cccf8aa9150` | 80 | 20260926-fix-failing-tests-upload-guard | 测试 |
| `server/liveStream.test.ts` | P | `d96bf9c640a07a53dddd858de51fd684c78b00b62904b9816a2fbb1c8f526414` | 282 | 20260926-fix-failing-tests-upload-guard | 测试 |
| `server/modelIndex.test.ts` | P | `b64d4f9d34828f3ff4280541f36910c4cb09d34e151078b3f49c834b43dbd805` | 96 | 20260926-fix-failing-tests-upload-guard | 测试 |
| `src/api.ts` | C | `7e5b1b993b0e1014f6bd9c77ab702b1f113d4f5e8a0ee7fcc83c0e66d3312883` | 88 | 20260928-reset-clears-cooldown | 源码补丁（C） |
| `src/pages/MonitorPage.tsx` | P | `024c3d55a3c23a107c9c19a8ea1d87c81a75b22817339188d6956c73e36d27b0` | 209 | 20260928-reset-clears-cooldown | 源码补丁（React 页，本地对应 .vue） |

### 8.3 本地领先清单（`L` 17 + `L-ONLY` 65）

| 路径 | 分类 | PROD sha256 | PROD 行 | HEAD sha256 | HEAD 行 | 生产最后变更 | 本地最后变更 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `.env.example` | L | `01b54bc765cb95774686c870752b782070cf10672f877bed64ee060aff31eae2` | 32 | `56b919d5aeecd01640b50d8b22b6d79d2c873f458b2976a83ac07164eadfda9d` | 41 | 20260925-oauth-modes-ui-refine | f60a828 |
| `.gitignore` | L | `4f82f9b1ddee740309f14d29f88ea035bea11766b8c9cff3a738acf268bf887c` | 30 | `50833712bbb06895604e7a03c7b50dc9941c78867f1a5c94e2ecf695e2d0729d` | 31 | 20260925-oauth-modes-ui-refine | f60a828 |
| `README.md` | L | `eb6307713ac7322df6fb2529e33c5a12eeaee520117c6d452c88c43a6a2ee873` | 149 | `b8f7f0654d8416eb90e7178ca15de59126f26daf1a9e058aba477c0b0758a186` | 157 | 20260925-oauth-modes-ui-refine | f60a828 |
| `deploy/magpie/CONSOLE-KERNEL.md` | L-ONLY | `—` | — | `b0708e02fd722b8a3099b425890e4c802cdfa274d8587550ebe347e1b7b752c0` | 265 | — | f30da5e |
| `deploy/magpie/README.md` | L-ONLY | `—` | — | `d3cfc5ccf6c14eaa38555b6120f00cf9610b555bb0139b9bb4010224a3bd4d79` | 193 | — | f60a828 |
| `deploy/magpie/UPSTREAM.md` | L-ONLY | `—` | — | `a28a1dd58f207da11709cdfefe7850e6d07636c7963a710629317ae573d29fc0` | 219 | — | f30da5e |
| `deploy/magpie/build.sh` | L-ONLY | `—` | — | `680ff2892d9f1fe287b0f8b9ed4baef543251b5bc4ef16fe2e7f335d47538eb0` | 22 | — | cddf0d2 |
| `deploy/magpie/kernel/main.go` | L-ONLY | `—` | — | `febb89ec360db6995ef8e341b3effb870f750ce9950e83078217d2b17215d173` | 172 | — | 7e1c8ce |
| `deploy/magpie/local.mjs` | L-ONLY | `—` | — | `fc9332f51251cd17b5745b19798a5c5b1330c51aae8aaa9f391e55d45ce12127` | 376 | — | f30da5e |
| `deploy/magpie/upstream/API.md` | L-ONLY | `—` | — | `0a4e389cd736753c59a1b3a758e6885626e67fd83b72a3827513857f618fa921` | 129 | — | f30da5e |
| `deploy/magpie/upstream/LICENSE` | L-ONLY | `—` | — | `79d2c8444715d4bc453ec4f8a0aaf2051a4c1ee5ac08f5bd2e5848aef87c7572` | 21 | — | f30da5e |
| `deploy/magpie/upstream/api.json` | L-ONLY | `—` | — | `3b84a81c0a5dd72375a220ac9a1022a8c6a2c5df0624c7cba7b6e7acceb27469` | 18113 | — | f30da5e |
| `docs/research/magpie-cpa-integration.md` | L-ONLY | `—` | — | `0ddc3c64f2e3fe3d01a977ceaf6dd8aa228df14f22d9ac05eeb541b7e7e88a23` | 134 | — | cddf0d2 |
| `index.html` | L | `cbaebd60a21b9086e731bfb072107af47e3f8cef412c28f53764a9ea9cc2f60a` | 16 | `84463748f75abca876e0f638a1ee090588527d5f341bfc24f9432321e5b67e35` | 16 | 20260831T195446Z-low-latency-v2 | bb99996 |
| `package-lock.json` | L | `ff7c7f87525c92d24e3a65ba92f2767116b56b2b6625365a0db0295351fabf52` | 3655 | `38617c801a82244195f757b56185d376df40e88d0821c3d4a02cd4be924e42c9` | 7542 | 20260925-crapi-docs-btn-compact | 1eafa6b |
| `package.json` | L | `7daf307f5b4b7a09753f9fc561deaa25f3d0073396c55a7837a7441d1ad9c403` | 68 | `a5ef38f7978965eab58b9d0336dc5c640e081c1be41ef848e22c03b04dba5b57` | 82 | 20260831T195446Z-low-latency-v2 | 1eafa6b |
| `packages/contracts/magpie-upstream.generated.ts` | L-ONLY | `—` | — | `1af18692eeef76d65f8ea97c14be357f72965c379d7da5f54668d2a2026b90ee` | 3941 | — | f30da5e |
| `packages/contracts/magpie-upstream.ts` | L-ONLY | `—` | — | `438eb6e44b811eba2054dbd5753d6e258241951054750dd4fcd7baac1c8c6d3b` | 21 | — | 7e1c8ce |
| `scripts/build-magpie-kernel.mjs` | L-ONLY | `—` | — | `5160b7de1adaff03173675a6ce7c3d29e2429328819d45d023525fd13d3af729` | 91 | — | f30da5e |
| `scripts/magpie-api/main.go` | L-ONLY | `—` | — | `366bd7e9b4bbee918d9bedb844ce41663f61603ed14c6e26a35e8edf8bf29288` | 469 | — | f30da5e |
| `scripts/magpie-api/main_test.go` | L-ONLY | `—` | — | `f703f90cabeecb9ecd1eeb4bee8cb0957511214565851b5bf65416712de52294` | 163 | — | f30da5e |
| `scripts/magpie-console-password.mjs` | L-ONLY | `—` | — | `a316d9d1046761fd21f97967c6d7849b1ea2f3b28bd539b6167962e9a1b3bfda` | 29 | — | d85128c |
| `scripts/magpie-console-password.test.mjs` | L-ONLY | `—` | — | `1fa1ef114d6c40d97abd844871a8ad4518c9cff3066cebd21014cd09b91d77c7` | 71 | — | d85128c |
| `scripts/magpie-console-smoke.mjs` | L-ONLY | `—` | — | `30671e4ad9799ad9445b446c1054b292bf20a7f1b76df4944f9047ada2dbaa99` | 70 | — | d85128c |
| `scripts/magpie-console.mjs` | L-ONLY | `—` | — | `9e7d03379d31e0f24df98dfecd4c4b80e5ef552827dbe23b564a52acfeea54f3` | 157 | — | 281c30e |
| `scripts/magpie-local.mjs` | L-ONLY | `—` | — | `20e8652601a96ee63ff51ca1bcbc83dcd9d898a09582e4318943fb306aa451b8` | 21 | — | cddf0d2 |
| `scripts/magpie-local.test.mjs` | L-ONLY | `—` | — | `5a92de446579cdfc2aabe39614d190ef6d63dddfa03df8043f12dea186069c54` | 223 | — | cddf0d2 |
| `scripts/magpie-service.mjs` | L-ONLY | `—` | — | `86709ec221f5fc12f2beb86f693d46a4c0842c3be5a73d351f916027a67ef0f1` | 44 | — | cddf0d2 |
| `scripts/magpie-smoke.mjs` | L-ONLY | `—` | — | `7639ca93a5b7a2ea1fc78c2821e1953c6c4f8dd646bdc9987eedb0e4c70d882b` | 74 | — | cddf0d2 |
| `scripts/magpie-upstream.mjs` | L-ONLY | `—` | — | `8d48120b273d2bec5d5299beedc37b7dd9cb7a148da2ff4db2b69862fe6130ca` | 342 | — | f30da5e |
| `scripts/magpie-upstream.test.mjs` | L-ONLY | `—` | — | `6396a09c7501b5cda052f49cfbc94736f9dd573a8031e266dc130a2e58897085` | 109 | — | f30da5e |
| `scripts/tuffex-icon-classes.mjs` | L-ONLY | `—` | — | `9307d3f1550ea05c1123b7ebabf6a9780bd0c6191c50759af5031cb4abb046fb` | 48 | — | 600a5ca |
| `server/config.ts` | L | `77cdbf772bcaed66868d762a4cdc4c52dec3bcccd4a217e6aa365bd80f92b774` | 133 | `66f5760e727e6ef877f164b0ba7e34c2270f4ca9244f32965c680f99099de6dd` | 141 | 20260910-native-search | f60a828 |
| `server/gatewayStatus.test.ts` | L | `b92fd0198f58270cedad692faa7c9bf3ab518cb122fe1a95263acacd2cd1dbb1` | 25 | `5f5dc4a37868b39b49d70306a1a7a944ce7c45ca01e38add1c12ffabc7e078f7` | 30 | 20260831T195446Z-low-latency-v2 | f60a828 |
| `server/magpieControl.test.ts` | L-ONLY | `—` | — | `123b9c1b850d198d489369f31821ee5c6e93acf8da0b7ca6e381d7a825fc1147` | 66 | — | 7e1c8ce |
| `server/magpieControl.ts` | L-ONLY | `—` | — | `974d0a392a0b554f019e8f2f3abfb52e00f810b3e07b5e6b66a15d33524274b4` | 343 | — | 7e1c8ce |
| `server/magpieEngine.test.ts` | L-ONLY | `—` | — | `952bb46c0207d44c731b5876b9b255dd1aee49db285e2e9dbe2c206b32b08498` | 178 | — | f30da5e |
| `server/magpieEngine.ts` | L-ONLY | `—` | — | `a82a2607ad5123792189a5f709e7c6d56ce1c98fba53968ac8630ecf6cbca9cf` | 339 | — | f30da5e |
| `server/magpieMigration.test.ts` | L-ONLY | `—` | — | `8786f8418e9743dc4637d07d127a6e1b3fc17a63ede0f4ac54399b287c1a0e71` | 29 | — | f60a828 |
| `server/magpieMigration.ts` | L-ONLY | `—` | — | `87847d283ebf18b217e399f1bf117fbb6265d89486196c7c7283517bd60fb515` | 57 | — | f60a828 |
| `server/magpieOAuth.test.ts` | L-ONLY | `—` | — | `f0bf64b7c4799fc39218ae6796feeb10a2fb33200c1d6a05460f3d26ac80522c` | 57 | — | 7e1c8ce |
| `server/magpieOAuth.ts` | L-ONLY | `—` | — | `ec6b04d55e13391cd8463f7e52df00f3121e054bae7901ba6c1ebe8b16d22d3b` | 208 | — | 7e1c8ce |
| `server/magpieRuntime.ts` | L-ONLY | `—` | — | `5eec1ed5edfa167a1708c41458ae4d14ce9d2f68c3685238d5bc79d4c96b0626` | 127 | — | 92a0835 |
| `server/magpieUpstream.test.ts` | L-ONLY | `—` | — | `f5861e3c9121e31399c70c6ab065848f177fde11d72995aeb454e9060c0ceb93` | 65 | — | f30da5e |
| `server/magpieUpstream.ts` | L-ONLY | `—` | — | `e249ed65cc1d97653d664c9c8bccea882743d6082364625550349082ad2d506d` | 58 | — | 7e1c8ce |
| `server/modelCatalog.ts` | L | `d4f87beca5437777d34c6c897f2d73fa18b7a0b43cfd54f3b30d2500b5812ee3` | 387 | `51b579e4fdd25c72ee1dbbaacc7dd940f47d5b134fab7db4e5951574b1093071` | 435 | 20260923-quota-hint-truth | 7e1c8ce |
| `server/modelSync.test.ts` | L-ONLY | `—` | — | `add8593e141cd2a0780de4d3f8df71683549307c8b48fddfe93a08e0aa12abea` | 26 | — | 7e1c8ce |
| `server/modelSync.ts` | L-ONLY | `—` | — | `8df6e0551a9132edc0043a5540fc45950ae800596dc1c72582d375cd65442cb9` | 311 | — | 7e1c8ce |
| `server/rtkService.test.ts` | L-ONLY | `—` | — | `f8736a836552bacadb3fd9e501399b2a0c6c862aa094e1bc202a9e2ce1c4e626` | 33 | — | 7e1c8ce |
| `server/rtkService.ts` | L-ONLY | `—` | — | `9792bd59ad9500dcd849741949eff7cab565f516756b3d99120037deafc7acb4` | 337 | — | 7e1c8ce |
| `src/App.css` | L | `8a690b2a9505ee4f3a20e974f7ca5e46301538608ffec1a1fd13324aeea4fba1` | 360 | `7579fc9fa72e82b0dbfd6a80e60f81ea5aba00f53e4bb82bcc4a5f6f3a381340` | 375 | 20260925-official-oauth-page-aligned | f30da5e |
| `src/App.tsx` | L | `cf8cff86c20935a69d8fe33ddac0d5ef89c7fe4edd5678a3d80d6154e900289f` | 413 | `b66ab3dd0bf1c5c2844577c5d88f84f9c26d75f51953902082e854202036c7dd` | 410 | 20260925-official-oauth-page-aligned | 92a0835 |
| `src/App.vue` | L-ONLY | `—` | — | `c3760886ffd5d78db88cb2b837a7a1d6462094d60b0d24b5883e812e9700f6e7` | 9 | — | 600a5ca |
| `src/components/ConsoleNav.vue` | L-ONLY | `—` | — | `b7293410f4b4934f701df4e1998bc579e1c42237e0b3328d0bad537e6d45f536` | 220 | — | 600a5ca |
| `src/components/ConsoleShell.vue` | L-ONLY | `—` | — | `9e789c617c7f9a0666ffcf31ce37e4e077506a25ee71e08693caab9c7c91f097` | 166 | — | 281c30e |
| `src/components/RequestDetail.vue` | L-ONLY | `—` | — | `6f775f2cd51a21356ee58ad0e938ab4bad3282d73c891354ac59904d9074f279` | 184 | — | 7b71f6d |
| `src/components/VersionWidget.tsx` | L | `211d11d8d62ff0edd39ae17ca4a0d420c336691b33b2db552ddb77d5c69be5e5` | 167 | `ae82637f324ff95a9bc3230a79152f8858066bf87f87b1d6483fe151b6271d79` | 272 | 20260925-crapi-docs-btn-compact | 7e1c8ce |
| `src/components/VersionWidget.vue` | L-ONLY | `—` | — | `e7ec2f2b6b6f580d2e2502805068f6afd677414629f448c8fe776d04a8f4dad1` | 425 | — | 600a5ca |
| `src/env.d.ts` | L-ONLY | `—` | — | `53e97f03f7ace9516989f122b587c11f62ed5fc542302fbe817708d47e786a38` | 9 | — | 600a5ca |
| `src/gatewayStatus.ts` | L | `a9435f81748fb3012f6292337894b0806f2578689458e15b320ae5af11f8362c` | 20 | `d8dc7050850fdd904d3dcb907059ee7f148ceb5c8cb8241137226b59838e3b86` | 25 | 20260831T195446Z-low-latency-v2 | f60a828 |
| `src/lib/icons.ts` | L-ONLY | `—` | — | `f1160a1b2dfff2301d327d9d449ed24d4c7cded4048a7b4bc4eb46227065dbdb` | 32 | — | 600a5ca |
| `src/main.ts` | L-ONLY | `—` | — | `4852c7a26490ffcd59fa3976b6f655e62d977747c8d7aa44f776722c6b15b93b` | 9 | — | 600a5ca |
| `src/pages/AnalyticsPage.vue` | L-ONLY | `—` | — | `9ed5669dd36b7aeaf9ddb88d4ee6c6b41b0c33757796545b34c4d17d11b47e86` | 418 | — | 3095ac4 |
| `src/pages/CachePage.vue` | L-ONLY | `—` | — | `42e1c02cc383f9bdae25ce84f7ec90d0ac6cd92b2eb6a26365b802133ec16e64` | 433 | — | 3095ac4 |
| `src/pages/ChannelsPage.vue` | L-ONLY | `—` | — | `3717ac322165a781417489fc139067dceda3cf082280d9f81ba617b44089509c` | 665 | — | 0e6f7eb |
| `src/pages/ChartsPage.vue` | L-ONLY | `—` | — | `9b55bcd01dda91c0a41421f9d76c9666035c96f0110e2fda830c590853258013` | 18 | — | 600a5ca |
| `src/pages/DashboardPage.tsx` | L | `9822b49060d9831e61e8c7401c2fcac0a8fe6d4ef5cf73c5b7c8f22e776e0899` | 51 | `b293a278be6f21855f54ff576e6727d2d977e5f06f224a48505bb64309c2fb4d` | 51 | 20260831T195446Z-low-latency-v2 | f60a828 |
| `src/pages/DashboardPage.vue` | L-ONLY | `—` | — | `19f5cc0121f64538db37adbb9eb6a3b007fb8773746680010fe871232b4b6862` | 493 | — | 0e6f7eb |
| `src/pages/HelpPage.vue` | L-ONLY | `—` | — | `316c8092f542aa5f6fcc9ed0332b448f9b1777e97607f90f30da4bcd7463d699` | 438 | — | 3095ac4 |
| `src/pages/KeysPage.vue` | L-ONLY | `—` | — | `46f5c3194d8a6e719b7204c8aa30ead6227e49d0b649e655443b0b595a725d80` | 974 | — | 0e6f7eb |
| `src/pages/LoginPage.vue` | L-ONLY | `—` | — | `8c25e66626fad378a9a112291d5b223962d46ee8ca03934d54479eab2f64bb91` | 180 | — | 281c30e |
| `src/pages/ModelsPage.tsx` | L | `e29c6d44a1f5ffd2bb895bf9fd6a51fa9a5e2109a60745ab6bf5160e05697387` | 191 | `b6950bebe329bba2349f438887460f861c1863a3841144e2d5993f0cb3584fe0` | 209 | 20260902T0735Z-console-ui-dropdown-cost | 7e1c8ce |
| `src/pages/ModelsPage.vue` | L-ONLY | `—` | — | `6b79ccd08d4a3d466415061d1f2ed72e32145b1eab5086c6f267b2241a02c253` | 514 | — | 3095ac4 |
| `src/pages/MonitorPage.vue` | L-ONLY | `—` | — | `819afb14cfff6129f175dac1662a84db5f7a779f3262c44e2bb59e873b2ee3be` | 499 | — | 3095ac4 |
| `src/pages/OAuthPage.vue` | L-ONLY | `—` | — | `3e989763a3d8c603afb80e13b370663a676205abc9e4136f81890e5cb13729b4` | 541 | — | 0e6f7eb |
| `src/pages/UsagePage.vue` | L-ONLY | `—` | — | `c162c535f37b6f748c997df86e5f9a6a91f02b5d250b3ccbbe1b25a9cf429b5d` | 461 | — | 3095ac4 |
| `src/router.ts` | L-ONLY | `—` | — | `c2bf447688b85c59a8de9fd6287965f1f25335113289f17e14f881d0b34f6d08` | 75 | — | 600a5ca |
| `src/styles/layout.css` | L-ONLY | `—` | — | `21604277e5f8db32c54f5f444617c240e89a9346ee9fe64b755e653dd9652f91` | 237 | — | 600a5ca |
| `src/styles/theme.css` | L-ONLY | `—` | — | `c0faf6b9ea7002b21466a097468a0bad9ca456cd91a71f8fd2d354ea34cc85bc` | 154 | — | 600a5ca |
| `src/types.ts` | L | `94262fb670c47f6616f3329390e620bc3f1f09a20144d27c307013a2eeff4963` | 500 | `a31cffd4e667e3308f861144a8929f26b228d86a185d46bc55665e18fd3cb104` | 568 | 20260925-crapi-docs-btn-compact | 7e1c8ce |
| `uno.config.ts` | L-ONLY | `—` | — | `eb0a11117187bfcbfffd8d8ae697427f7cd285ccc1d09703c6eeb9d00e63a713` | 33 | — | 600a5ca |
| `vite.config.ts` | L | `cfb852aedcaeaf7f0790bc2be6426fe4e3e288262039ad45a14ba9b37ca12ef0` | 18 | `0d082af13221f81b8545f8d773655c25492d007755a241f7470420c925fcfb8c` | 35 | 20260831T195446Z-low-latency-v2 | bb99996 |
### 8.4 附录：生产 release 全量文件清单（246 条，含逐文件 sha256）

| 路径 | 分类 | PROD sha256 | PROD 行 | HEAD sha256 | HEAD 行 |
| --- | --- | --- | --- | --- | --- |
| `.env.example` | L | `01b54bc765cb95774686c870752b782070cf10672f877bed64ee060aff31eae2` | 32 | `56b919d5aeecd01640b50d8b22b6d79d2c873f458b2976a83ac07164eadfda9d` | 41 |
| `.gitignore` | L | `4f82f9b1ddee740309f14d29f88ea035bea11766b8c9cff3a738acf268bf887c` | 30 | `50833712bbb06895604e7a03c7b50dc9941c78867f1a5c94e2ecf695e2d0729d` | 31 |
| `.oxlintrc.json` | SAME | `b4d344818a1e1bf43997e4744a9153c8eef770c98b58229cd86363dabb85ded4` | 8 | `b4d344818a1e1bf43997e4744a9153c8eef770c98b58229cd86363dabb85ded4` | 8 |
| `LICENSE` | SAME | `029e26db7aad8db1b0d5e9d66ce7737859441210fff21773c5b7526bce3c786b` | 21 | `029e26db7aad8db1b0d5e9d66ce7737859441210fff21773c5b7526bce3c786b` | 21 |
| `MANIFEST.sha256` | C-NOBASE | `138c888a97c6fda9f638b24df58c0b9d9dff0c568c88a9d121e4a8b508008204` | 299 | `a7d4576f2b853d6292c51cdbcf9401f3cccb79415605feb0459b60f9cc3457c5` | 295 |
| `README.md` | L | `eb6307713ac7322df6fb2529e33c5a12eeaee520117c6d452c88c43a6a2ee873` | 149 | `b8f7f0654d8416eb90e7178ca15de59126f26daf1a9e058aba477c0b0758a186` | 157 |
| `RELEASE.json` | P | `8b49a789b224a4d678706c7893f09b4593ce95e663dff1e96aba5f2b47bde3d1` | 17 | `f0ec481579cddeea6ad5ac720a7e988d6c04df698ac95ad03534c96a77736506` | 20 |
| `build/packages/contracts/index.js` | P-ONLY | `dcb2bdc3df76fa6eb3463637e7faff48eca535f2be263883dfa9b479c7b04b3a` | 211 | — | — |
| `build/packages/contracts/index.js.map` | P-ONLY | `7cdbf073979f174239b38fe5cd96f735089a9e2d1656954695684740a7e831ce` | 0 | — | — |
| `deploy/data-plane/BACKUP-RESTORE.md` | SAME | `e48908dde9f40690620d009a2d049b1be2bb4c2e7ea591115895ac6f5e6d54ce` | 46 | `e48908dde9f40690620d009a2d049b1be2bb4c2e7ea591115895ac6f5e6d54ce` | 46 |
| `deploy/data-plane/Dockerfile.data` | SAME | `576d79251dc081e34136706914cb0dc49669ceda9abbf3b4f6a66852d6274d2f` | 32 | `576d79251dc081e34136706914cb0dc49669ceda9abbf3b4f6a66852d6274d2f` | 32 |
| `deploy/data-plane/Dockerfile.data.dockerignore` | SAME | `1dea0359f33f190e7b123bc4e2fa4656884ea834680cbe46363fbb9272d5c40f` | 12 | `1dea0359f33f190e7b123bc4e2fa4656884ea834680cbe46363fbb9272d5c40f` | 12 |
| `deploy/data-plane/README.md` | SAME | `0f6d1971f32c6ba2145c1b5fe075901eea1a233dd14308a6f20a0a9531d6fc13` | 80 | `0f6d1971f32c6ba2145c1b5fe075901eea1a233dd14308a6f20a0a9531d6fc13` | 80 |
| `deploy/data-plane/compose.yaml` | SAME | `4bcc3003216dd4b2f78eb7fda922b68370589ffd237d43da623af0f87859e4c8` | 229 | `4bcc3003216dd4b2f78eb7fda922b68370589ffd237d43da623af0f87859e4c8` | 229 |
| `deploy/data-plane/cron.example` | SAME | `e7cfa2be763e22288e91418ba134ccabc9c173173c26acbe04d2e580a27a2648` | 6 | `e7cfa2be763e22288e91418ba134ccabc9c173173c26acbe04d2e580a27a2648` | 6 |
| `deploy/data-plane/data-plane.env.example` | SAME | `c4446e380cb127032cf40655f39df0a2a8dd52be6028eb9323b37cd355626ee8` | 56 | `c4446e380cb127032cf40655f39df0a2a8dd52be6028eb9323b37cd355626ee8` | 56 |
| `deploy/data-plane/initdb/10-runtime-roles.sh` | SAME | `45e364bdd91000f4dc6aca48f950efd2f82b3f102d0d07765d8fab5a780d88d3` | 55 | `45e364bdd91000f4dc6aca48f950efd2f82b3f102d0d07765d8fab5a780d88d3` | 55 |
| `deploy/data-plane/scripts/archive-wal.sh` | SAME | `589882e21e3748fa20e382bf375add32aea45679e306ffeb143dd626adc75f66` | 104 | `589882e21e3748fa20e382bf375add32aea45679e306ffeb143dd626adc75f66` | 104 |
| `deploy/data-plane/scripts/backup.sh` | SAME | `740793a5635dbe0b78f15d91de797ec01f013249d94bce4b284c7c4400af531b` | 84 | `740793a5635dbe0b78f15d91de797ec01f013249d94bce4b284c7c4400af531b` | 84 |
| `deploy/data-plane/scripts/postgres-entrypoint.sh` | SAME | `70e790d888ab63264d3a8c36509c26d9c49d5ca13170192c73e433bac6471163` | 61 | `70e790d888ab63264d3a8c36509c26d9c49d5ca13170192c73e433bac6471163` | 61 |
| `deploy/data-plane/scripts/wal-sync.sh` | SAME | `1ec2ea7d6483ae1a3c6b71f74fe7932882046302fee24ea1e66edd4761577a54` | 167 | `1ec2ea7d6483ae1a3c6b71f74fe7932882046302fee24ea1e66edd4761577a54` | 167 |
| `deploy/data-plane/scripts/webdav-base-job.sh` | SAME | `84d6005fefa0e22948f5651687abcadbf501cf53145646e8f5b9aa2d44387fb8` | 40 | `84d6005fefa0e22948f5651687abcadbf501cf53145646e8f5b9aa2d44387fb8` | 40 |
| `deploy/data-plane/scripts/webdav-base-upload.mjs` | SAME | `203f57de73bcb5c6ef024505d7506f78cdb2dac3c9a4834b49e83bfdcd86ca7b` | 102 | `203f57de73bcb5c6ef024505d7506f78cdb2dac3c9a4834b49e83bfdcd86ca7b` | 102 |
| `deploy/data-plane/scripts/webdav-restore-download.mjs` | SAME | `fc6caad0374da6432adcc60023197dfc92d8e5bbe363ce55b746517e5aefb27a` | 43 | `fc6caad0374da6432adcc60023197dfc92d8e5bbe363ce55b746517e5aefb27a` | 43 |
| `deploy/data-plane/scripts/webdav-wal-job.sh` | SAME | `c77e0cd7830256ee1411a0c2013eacc08f19c1313610bf1c6d9b5adb3b0f3819` | 18 | `c77e0cd7830256ee1411a0c2013eacc08f19c1313610bf1c6d9b5adb3b0f3819` | 18 |
| `deploy/data-plane/scripts/webdav-wal-upload.mjs` | SAME | `559e678d6dbc71705862f25ac4b25d5d1e8c8c9677acae039c8fbaa00d54e5c4` | 123 | `559e678d6dbc71705862f25ac4b25d5d1e8c8c9677acae039c8fbaa00d54e5c4` | 123 |
| `deploy/data-plane/scripts/with-file-secrets.sh` | SAME | `2474fd2c634b369913bd45b6e9646a776888dbd316bed84f8ebc6bd445383288` | 67 | `2474fd2c634b369913bd45b6e9646a776888dbd316bed84f8ebc6bd445383288` | 67 |
| `deploy/data-plane/systemd/crosery-cpe-backup.service` | SAME | `e8af723e4f91e302333498b183c4a087d2fe1feb512ce89def73c76b20b6ec7e` | 31 | `e8af723e4f91e302333498b183c4a087d2fe1feb512ce89def73c76b20b6ec7e` | 31 |
| `deploy/data-plane/systemd/crosery-cpe-backup.timer` | SAME | `2ee3136f376cc01d9773b86e77c027a4c7fd935720ec33a577398f8a0f5cdadc` | 12 | `2ee3136f376cc01d9773b86e77c027a4c7fd935720ec33a577398f8a0f5cdadc` | 12 |
| `deploy/data-plane/systemd/crosery-cpe-data.service` | SAME | `811c71acf9eefb89c8058f7ad68c6b30e486f4736f027268064470ab0c8ec995` | 49 | `811c71acf9eefb89c8058f7ad68c6b30e486f4736f027268064470ab0c8ec995` | 49 |
| `deploy/data-plane/systemd/crosery-cpe-wal-sync.service` | SAME | `44a9a5daf2e816c665e4319ac194bf641c6e44f46377b6cbfc571fa41ecacc39` | 30 | `44a9a5daf2e816c665e4319ac194bf641c6e44f46377b6cbfc571fa41ecacc39` | 30 |
| `deploy/data-plane/systemd/crosery-cpe-wal-sync.timer` | SAME | `83b054e95624e3f4ab83079e042e399b9a7b06ab7fcf576d34985c30dc5b8966` | 13 | `83b054e95624e3f4ab83079e042e399b9a7b06ab7fcf576d34985c30dc5b8966` | 13 |
| `deploy/data-plane/tailscale-grants.example.hujson` | SAME | `66133ce8f61486027179979c5f5ba2646a8dcecba69037d58c19ddafed46a828` | 25 | `66133ce8f61486027179979c5f5ba2646a8dcecba69037d58c19ddafed46a828` | 25 |
| `deploy/data-plane/tests/data-secrets.test.sh` | SAME | `e737a5926f44bedca8e43c1fee6a771a62cdc7d2f9733efa82cb32c4fd594891` | 45 | `e737a5926f44bedca8e43c1fee6a771a62cdc7d2f9733efa82cb32c4fd594891` | 45 |
| `deploy/data-plane/tests/postgres-secrets.test.sh` | SAME | `0b14610cf35a7461e93fc3de5da105282d3688d9cfec9eafc881734f9d62ce46` | 71 | `0b14610cf35a7461e93fc3de5da105282d3688d9cfec9eafc881734f9d62ce46` | 71 |
| `deploy/data-plane/tests/wal-archive.test.sh` | SAME | `46b4789a0fed6c91d92c583c5582a9265e7da3ce6e651d997274fb3fb58c05e0` | 173 | `46b4789a0fed6c91d92c583c5582a9265e7da3ce6e651d997274fb3fb58c05e0` | 173 |
| `deploy/edge/README.md` | SAME | `f0781bed0d5b69557ff9a81ef93c13dfff3f013d186e392e71320c22213174e0` | 60 | `f0781bed0d5b69557ff9a81ef93c13dfff3f013d186e392e71320c22213174e0` | 60 |
| `deploy/edge/systemd/crosery-api-console.service` | SAME | `04676d679f32ce864cead2bd7b0a88288f0ee1de02693f7fc98d0aed4d113277` | 48 | `04676d679f32ce864cead2bd7b0a88288f0ee1de02693f7fc98d0aed4d113277` | 48 |
| `deploy/nginx/ai-crsery-location-snippet.conf` | SAME | `1e06a90ee1c53a0e4321ccdbc62d7184b300680768bbd5126a019b86d2aed2de` | 6 | `1e06a90ee1c53a0e4321ccdbc62d7184b300680768bbd5126a019b86d2aed2de` | 6 |
| `deploy/nginx/console-compression.conf` | SAME | `17e71f27b385d4bf47f6c1bdb87038e1e00e116f9c0350989f5c64aef282f558` | 17 | `17e71f27b385d4bf47f6c1bdb87038e1e00e116f9c0350989f5c64aef282f558` | 17 |
| `deploy/nginx/crosery-console-unlimited.conf` | SAME | `dcf9082308616905f7f1a9193abb6bc3c9574833c83bc8749c23512ff2025153` | 1 | `dcf9082308616905f7f1a9193abb6bc3c9574833c83bc8749c23512ff2025153` | 1 |
| `deploy/nginx/ibuki-perip-limit.conf` | SAME | `2e89b19c745018a763e42e47a14df14fd0495833f91f6cbd44f8ddd708cee8f6` | 4 | `2e89b19c745018a763e42e47a14df14fd0495833f91f6cbd44f8ddd708cee8f6` | 4 |
| `deploy/systemd/crosery-console-backfill-cost.service` | SAME | `ba6c2aaa58f18c689ff04b9d5812e844223d6dd06f0b5667183fc9d16dedf796` | 35 | `ba6c2aaa58f18c689ff04b9d5812e844223d6dd06f0b5667183fc9d16dedf796` | 35 |
| `deploy/systemd/crosery-console-backfill-cost.timer` | SAME | `cc618efb662a4f570fcd394a17ed3eafb0efc08c10fc51c62dc18f9fe495e0e7` | 11 | `cc618efb662a4f570fcd394a17ed3eafb0efc08c10fc51c62dc18f9fe495e0e7` | 11 |
| `deploy/systemd/crosery-nginx-policy-sync.path` | SAME | `792ff4251b7bc5cad1b7d6b297b8b9002dd9f3023454d4babd5945c7426cb918` | 10 | `792ff4251b7bc5cad1b7d6b297b8b9002dd9f3023454d4babd5945c7426cb918` | 10 |
| `deploy/systemd/crosery-nginx-policy-sync.service` | SAME | `3903d040cdaee452ea995a34ef1cc1a7d26c7161597a511bc9954f5c35e9afcd` | 29 | `3903d040cdaee452ea995a34ef1cc1a7d26c7161597a511bc9954f5c35e9afcd` | 29 |
| `docs.html` | SAME | `454ac019dee8c1b28a81e41de4447f3efdec1825c3e4a480a909a70c3fb56533` | 17 | `454ac019dee8c1b28a81e41de4447f3efdec1825c3e4a480a909a70c3fb56533` | 17 |
| `docs/Crosery-API-Console-管理员使用说明.docx` | SAME | `825115ae1a01f90946cb7a9e3ce8e12f990e5412c3b5916841a6a8307dd67932` | 157 | `825115ae1a01f90946cb7a9e3ce8e12f990e5412c3b5916841a6a8307dd67932` | 157 |
| `index.html` | L | `cbaebd60a21b9086e731bfb072107af47e3f8cef412c28f53764a9ea9cc2f60a` | 16 | `84463748f75abca876e0f638a1ee090588527d5f341bfc24f9432321e5b67e35` | 16 |
| `package-lock.json` | L | `ff7c7f87525c92d24e3a65ba92f2767116b56b2b6625365a0db0295351fabf52` | 3655 | `38617c801a82244195f757b56185d376df40e88d0821c3d4a02cd4be924e42c9` | 7542 |
| `package.json` | L | `7daf307f5b4b7a09753f9fc561deaa25f3d0073396c55a7837a7441d1ad9c403` | 68 | `a5ef38f7978965eab58b9d0336dc5c640e081c1be41ef848e22c03b04dba5b57` | 82 |
| `packages/contracts/contracts.test.ts` | SAME | `d3a53cf5f454923498659b15aac692e7b0a9b1d4ee40ebcf46bb6402eb7d8ec7` | 104 | `d3a53cf5f454923498659b15aac692e7b0a9b1d4ee40ebcf46bb6402eb7d8ec7` | 104 |
| `packages/contracts/index.ts` | SAME | `b30c66606c9520ae5fda21b4f0f43daf6ac66c80055fe853715cb758c73986a7` | 302 | `b30c66606c9520ae5fda21b4f0f43daf6ac66c80055fe853715cb758c73986a7` | 302 |
| `packages/contracts/package.json` | SAME | `e339e104c55467fadfe98ebea642139236e36a24ca254208e17db0582b7e48e2` | 9 | `e339e104c55467fadfe98ebea642139236e36a24ca254208e17db0582b7e48e2` | 9 |
| `packages/contracts/tsconfig.json` | SAME | `b145dbd6a2f97db4fe310d0ca28999f9e50aaaf0c95cc942814db081bfec19b2` | 11 | `b145dbd6a2f97db4fe310d0ca28999f9e50aaaf0c95cc942814db081bfec19b2` | 11 |
| `public/apple-touch-icon.png` | SAME | `d5201d41a17c8db9bcb0e195ea6470a861b5c847686404051ea85de7a6c6d9cd` | 100 | `d5201d41a17c8db9bcb0e195ea6470a861b5c847686404051ea85de7a6c6d9cd` | 100 |
| `public/console-icon-source.png` | SAME | `32e68e88905956041287bf17a465f1575734e45778c5fa9f7c18edff5e893589` | 3614 | `32e68e88905956041287bf17a465f1575734e45778c5fa9f7c18edff5e893589` | 3614 |
| `public/favicon.ico` | SAME | `828ea816e4cd582ad293a5384d8aff2c124e8fae128eb8ec33e04fb2048648a2` | 0 | `828ea816e4cd582ad293a5384d8aff2c124e8fae128eb8ec33e04fb2048648a2` | 0 |
| `public/favicon.svg` | SAME | `61bc9a161de58248288e6905425d7180f0624c2865007b97d763fdac12043a66` | 0 | `61bc9a161de58248288e6905425d7180f0624c2865007b97d763fdac12043a66` | 0 |
| `public/icon-192.png` | SAME | `0a4cf1cb0d81e0e99ab1f8ceb157814bc42a32506f551ec27fa5c1f5749793ef` | 96 | `0a4cf1cb0d81e0e99ab1f8ceb157814bc42a32506f551ec27fa5c1f5749793ef` | 96 |
| `public/icon-512.png` | SAME | `781447e15db3e72d33a67eb03d3e075544723d0020aae2d7b844de65ec588022` | 815 | `781447e15db3e72d33a67eb03d3e075544723d0020aae2d7b844de65ec588022` | 815 |
| `public/icons.svg` | SAME | `b45fa506195cfcdef406ba9f0c77b36ddc1a7c224040926ec70abc2fdea7b93a` | 24 | `b45fa506195cfcdef406ba9f0c77b36ddc1a7c224040926ec70abc2fdea7b93a` | 24 |
| `scripts/backfill-cost.mjs` | SAME | `7fb53821c2bc400b4c71b6f086c45e2c80b63c514bb575077ba40cf53b1b385e` | 83 | `7fb53821c2bc400b4c71b6f086c45e2c80b63c514bb575077ba40cf53b1b385e` | 83 |
| `scripts/backfill-data-plane.mjs` | SAME | `bb9d9737ec55c0e7cd5e6f27bc7b25c086ac4605bc969c1ef95c732ef354c64c` | 736 | `bb9d9737ec55c0e7cd5e6f27bc7b25c086ac4605bc969c1ef95c732ef354c64c` | 736 |
| `scripts/backfill-data-plane.test.mjs` | SAME | `25d660fa1f067d21a6aeaa9ee5d9fe65e9455b67df188ed29a282c0f1386a2df` | 365 | `25d660fa1f067d21a6aeaa9ee5d9fe65e9455b67df188ed29a282c0f1386a2df` | 365 |
| `scripts/benchmark-api.mjs` | SAME | `8a97ea0f09b33ae672702fbc054241cc8a65a3d812f038ebb8aac3052d227d5c` | 63 | `8a97ea0f09b33ae672702fbc054241cc8a65a3d812f038ebb8aac3052d227d5c` | 63 |
| `scripts/build-pricing.mjs` | SAME | `5d24eadfe8fcf2baf0b98453cf59b0bc8908e80d1b29a78bbbfb56880a58ff6b` | 312 | `5d24eadfe8fcf2baf0b98453cf59b0bc8908e80d1b29a78bbbfb56880a58ff6b` | 312 |
| `scripts/check-bundle-budget.mjs` | SAME | `420a2ebdd5e99474a919b883c2ae5e1d07578a455d0dd490775629d2ad382cce` | 42 | `420a2ebdd5e99474a919b883c2ae5e1d07578a455d0dd490775629d2ad382cce` | 42 |
| `server/accountQuota.test.ts` | SAME | `49bcb5a530ea9b50396c561a326b3e68a84c80dc394ddc70e8c238c01710c23a` | 198 | `49bcb5a530ea9b50396c561a326b3e68a84c80dc394ddc70e8c238c01710c23a` | 198 |
| `server/accountQuota.ts` | SAME | `73532b3c51123dcb4c6c2fc50556aeb88e728d1c7b91403246b99daa17d3898a` | 279 | `73532b3c51123dcb4c6c2fc50556aeb88e728d1c7b91403246b99daa17d3898a` | 279 |
| `server/analyticsNavigationFallback.test.ts` | SAME | `411e8a529b0d2daedf002cc5096215df20ac438d3a10fca9af5b29de9b57ce89` | 23 | `411e8a529b0d2daedf002cc5096215df20ac438d3a10fca9af5b29de9b57ce89` | 23 |
| `server/antigravityQuota.test.ts` | SAME | `0162edd7827a86ba83f9c334347299285dea3f981b6f9f0434120a4d26823105` | 74 | `0162edd7827a86ba83f9c334347299285dea3f981b6f9f0434120a4d26823105` | 74 |
| `server/antigravityQuota.ts` | SAME | `6cafbc02a1b0b970a34bd8e56fa0e6bf7dfd005b23a02b3c0cbceeae303ff4da` | 151 | `6cafbc02a1b0b970a34bd8e56fa0e6bf7dfd005b23a02b3c0cbceeae303ff4da` | 151 |
| `server/auth.test.ts` | SAME | `cc52c9f602fb2f1d1cb2225c5c91f2ac1977f5c42378e967db85ccc27888dc81` | 12 | `cc52c9f602fb2f1d1cb2225c5c91f2ac1977f5c42378e967db85ccc27888dc81` | 12 |
| `server/auth.ts` | SAME | `3f7f0a2a00cc1319c3e862c98b58f6b1567ba44078cabcda65cbc7eadee3ce90` | 52 | `3f7f0a2a00cc1319c3e862c98b58f6b1567ba44078cabcda65cbc7eadee3ce90` | 52 |
| `server/cacheAnalytics.test.ts` | SAME | `556b3ff49ffdf2383de56fa5453064974770088ec7fbc6d661211cb712a35c87` | 144 | `556b3ff49ffdf2383de56fa5453064974770088ec7fbc6d661211cb712a35c87` | 144 |
| `server/cacheAnalytics.ts` | SAME | `ab8febcfb26eb3c2985e789bb9fb82c8b7c37a5efbe70ecf96f08f65397898e5` | 198 | `ab8febcfb26eb3c2985e789bb9fb82c8b7c37a5efbe70ecf96f08f65397898e5` | 198 |
| `server/cacheLiveHistory.test.ts` | SAME | `5ab8f7f638ab09d97c77bb5c718dafe298b9b63495a5dbd570383d886724e74e` | 84 | `5ab8f7f638ab09d97c77bb5c718dafe298b9b63495a5dbd570383d886724e74e` | 84 |
| `server/cacheLiveHistory.ts` | SAME | `4bf4370817b810d8892964504cf5acd6c67e19a4c029db937882fc62508c9bdc` | 115 | `4bf4370817b810d8892964504cf5acd6c67e19a4c029db937882fc62508c9bdc` | 115 |
| `server/cacheStats.test.ts` | P | `b56f7106b7b2eeec4935c1fcd0139711248877f26318cb03fb23c8c623afed7a` | 117 | `62f2ce8f3591a470039a7e4f441681cfa4fea779f05a05ef28233545710f6d66` | 108 |
| `server/cacheStats.ts` | SAME | `8840b20be1ac0be4c2d08accb6acb548089b72c418623606fddf29bdbce6d313` | 173 | `8840b20be1ac0be4c2d08accb6acb548089b72c418623606fddf29bdbce6d313` | 173 |
| `server/cacheTrend.test.ts` | SAME | `bf1022730d8d43c99e892e1f07d18adbc15f318ae0061c003f15db2d94a36dd8` | 120 | `bf1022730d8d43c99e892e1f07d18adbc15f318ae0061c003f15db2d94a36dd8` | 120 |
| `server/cacheTrend.ts` | SAME | `b983c3e5a4271e2fb0b952fd5d7c505e2e780b5ee0b0e0a5aff547e80549c534` | 126 | `b983c3e5a4271e2fb0b952fd5d7c505e2e780b5ee0b0e0a5aff547e80549c534` | 126 |
| `server/channelDiscovery.test.ts` | SAME | `9d27632bdd37f6fa211ce3e1b82c3db18b628025fe4fca93c32a389f4e8fb46c` | 43 | `9d27632bdd37f6fa211ce3e1b82c3db18b628025fe4fca93c32a389f4e8fb46c` | 43 |
| `server/channelDiscovery.ts` | SAME | `a34a33780080f420e9f49d31a93dfb77cafb3e1855bee369f66a223931d13881` | 88 | `a34a33780080f420e9f49d31a93dfb77cafb3e1855bee369f66a223931d13881` | 88 |
| `server/channelView.test.ts` | SAME | `c92163cf69a1ed2bae7a54c48d871fb3e364e32a66450cf82b904993c6242f25` | 118 | `c92163cf69a1ed2bae7a54c48d871fb3e364e32a66450cf82b904993c6242f25` | 118 |
| `server/channelView.ts` | SAME | `08378191ed1f0080bef2b56dca7451976fd8b24dda426b8d2c2b26ddd49a292c` | 69 | `08378191ed1f0080bef2b56dca7451976fd8b24dda426b8d2c2b26ddd49a292c` | 69 |
| `server/channels.ts` | SAME | `80df0acd7cf851498b3690528d83fcc457fd73c2b768c8a46127ef7216888e2f` | 477 | `80df0acd7cf851498b3690528d83fcc457fd73c2b768c8a46127ef7216888e2f` | 477 |
| `server/claudeQuotaCache.test.ts` | SAME | `8946efb08b6f4d7f95a9a56944fbaae5d46e047d59e7c18f51a1a0099736c371` | 140 | `8946efb08b6f4d7f95a9a56944fbaae5d46e047d59e7c18f51a1a0099736c371` | 140 |
| `server/claudeQuotaCache.ts` | SAME | `ae69b7a0fb67cf3a234f346ecbaeb9302c93489a8f7c7e7000c34f980295a9d6` | 213 | `ae69b7a0fb67cf3a234f346ecbaeb9302c93489a8f7c7e7000c34f980295a9d6` | 213 |
| `server/clientAgent.test.ts` | SAME | `1af7aa6355a5a80bc063196a099fe6a8c7716804d5410a989dc0e495112f7ac5` | 162 | `1af7aa6355a5a80bc063196a099fe6a8c7716804d5410a989dc0e495112f7ac5` | 162 |
| `server/clientAgent.ts` | SAME | `a21dca71702505c49e2b4699ef3cf4728e99aa7a954e2f7102500187cb622967` | 169 | `a21dca71702505c49e2b4699ef3cf4728e99aa7a954e2f7102500187cb622967` | 169 |
| `server/codexAccount.test.ts` | SAME | `ed4b7d52164089ab541d4655a31c4435a7b6848b3104f288953d444c4492a3f9` | 42 | `ed4b7d52164089ab541d4655a31c4435a7b6848b3104f288953d444c4492a3f9` | 42 |
| `server/codexAccount.ts` | SAME | `03bca397cee43c42c5e9525ce9667df99464307035f66d258bb393f7589c35d2` | 68 | `03bca397cee43c42c5e9525ce9667df99464307035f66d258bb393f7589c35d2` | 68 |
| `server/config.test.ts` | SAME | `a9c6ec17df91762e1a05f43688e35b3c878da27f64c26a152e08730a37d98704` | 73 | `a9c6ec17df91762e1a05f43688e35b3c878da27f64c26a152e08730a37d98704` | 73 |
| `server/config.ts` | L | `77cdbf772bcaed66868d762a4cdc4c52dec3bcccd4a217e6aa365bd80f92b774` | 133 | `66f5760e727e6ef877f164b0ba7e34c2270f4ca9244f32965c680f99099de6dd` | 141 |
| `server/cooldownClear.test.ts` | P-ONLY | `cb60cff75b395c4cbc0bd1027626161988574557ee6a635b01c2c6362b1cb671` | 48 | — | — |
| `server/cpa.test.ts` | SAME | `c6f250985591a61c92ac4c77095a781e060833019aed2992e0fe2e4b35f517bf` | 108 | `c6f250985591a61c92ac4c77095a781e060833019aed2992e0fe2e4b35f517bf` | 108 |
| `server/cpa.ts` | C | `bd97f7ed622794053ca94135a8b19bcd16da4b6bd29416db140b93155f9eabeb` | 637 | `bad2b27b319e3553954c8c6143e9bb4025b35b6868d8b48d4eb8dbcc6645a528` | 652 |
| `server/credentialUpload.test.ts` | P | `27d1ea80de2b66db41e575d1c13e644cec0bb5231437f8990c4d1f9ab5362711` | 129 | `835eb3c2ce12c39b9e65f765456aae73a5aea18a55a731e0d5478c7cbb97829f` | 103 |
| `server/credentialUpload.ts` | P | `5c9b74b060eb79878ed67d4f237bae6231b8fb8475487ec80ae37d9ad7e3a35c` | 167 | `2be546b3fbb88a19a5fe60ea3b82f42afb07ad3decc640d83d712121c0cfde40` | 110 |
| `server/credentialUploadBatch.test.ts` | SAME | `7183e5a08cddbca7482afdc2fe9aeaeb73d891c652206a7849e7bdc880f4e98a` | 57 | `7183e5a08cddbca7482afdc2fe9aeaeb73d891c652206a7849e7bdc880f4e98a` | 57 |
| `server/credentialUploadBatch.ts` | SAME | `06828e245f6db2229e6447ccee0c67e9350648b472bc095f2df97d729a3a3617` | 53 | `06828e245f6db2229e6447ccee0c67e9350648b472bc095f2df97d729a3a3617` | 53 |
| `server/credentialUploadMerge.test.ts` | SAME | `8537bba575bfa83f7ef4906d25a07fd12f147fe9364d945cf1323a9dab205904` | 19 | `8537bba575bfa83f7ef4906d25a07fd12f147fe9364d945cf1323a9dab205904` | 19 |
| `server/credentialUploadMerge.ts` | SAME | `88d7b75c73c2d88f3fcc4c7317c251ccf8af0a180e5243e5beb3c363df1ca087` | 24 | `88d7b75c73c2d88f3fcc4c7317c251ccf8af0a180e5243e5beb3c363df1ca087` | 24 |
| `server/credentials.test.ts` | SAME | `b0f151c41f458bc7cc014fd96ae46df4fdd32b5821cfd0179092bcbf0670cac3` | 90 | `b0f151c41f458bc7cc014fd96ae46df4fdd32b5821cfd0179092bcbf0670cac3` | 90 |
| `server/credentials.ts` | SAME | `0c9aa582b7159a34d74e2b24f9eb5fa5efbf5dd80c7dae966da02467d9957530` | 92 | `0c9aa582b7159a34d74e2b24f9eb5fa5efbf5dd80c7dae966da02467d9957530` | 92 |
| `server/currentChannels.test.ts` | SAME | `7ed4cb7b11967b837d26fba9a928da884ddae2490f37c631afb3dcdb4199f9f9` | 25 | `7ed4cb7b11967b837d26fba9a928da884ddae2490f37c631afb3dcdb4199f9f9` | 25 |
| `server/currentChannels.ts` | SAME | `0b5144a8a75c35826aec5b39efc5b9a236cbb27ce0fccde629d87423d644c6dd` | 56 | `0b5144a8a75c35826aec5b39efc5b9a236cbb27ce0fccde629d87423d644c6dd` | 56 |
| `server/dashboardSnapshot.test.ts` | SAME | `7bffc75d20697c4d4a45c368d52158b57e2e0f2c5f8cdb1744ceb7c225cb04b8` | 244 | `7bffc75d20697c4d4a45c368d52158b57e2e0f2c5f8cdb1744ceb7c225cb04b8` | 244 |
| `server/dashboardSnapshot.ts` | SAME | `7984158b99ca12a1fad183c03c1258ac82875146fb21a5080f381be0752e17b3` | 132 | `7984158b99ca12a1fad183c03c1258ac82875146fb21a5080f381be0752e17b3` | 132 |
| `server/dataPlane.test.ts` | SAME | `cf6afcb41f05563669459c2fe2838b4291df7131213e7bdf2ff235861012269f` | 626 | `cf6afcb41f05563669459c2fe2838b4291df7131213e7bdf2ff235861012269f` | 626 |
| `server/dataPlane.ts` | SAME | `995e3b667cd37e8db0c66cb701644bead7812299dc2d15a46ef236f346911851` | 504 | `995e3b667cd37e8db0c66cb701644bead7812299dc2d15a46ef236f346911851` | 504 |
| `server/db.ts` | SAME | `e2dd87e441702b41dd9e0227d8fa8a60e5e6863e8e2525ca9994a7cdc4161ef4` | 333 | `e2dd87e441702b41dd9e0227d8fa8a60e5e6863e8e2525ca9994a7cdc4161ef4` | 333 |
| `server/gatewayStatus.test.ts` | L | `b92fd0198f58270cedad692faa7c9bf3ab518cb122fe1a95263acacd2cd1dbb1` | 25 | `5f5dc4a37868b39b49d70306a1a7a944ce7c45ca01e38add1c12ffabc7e078f7` | 30 |
| `server/groups.test.ts` | SAME | `0e4e9717f4788593fd396d85599b4af5d2146fde42a82244b147b1d49385ac5c` | 78 | `0e4e9717f4788593fd396d85599b4af5d2146fde42a82244b147b1d49385ac5c` | 78 |
| `server/groups.ts` | SAME | `31b0fba921f552cefa4825b0b3d90ac02b758d23a04e3480c5dd2998f2a40f96` | 93 | `31b0fba921f552cefa4825b0b3d90ac02b758d23a04e3480c5dd2998f2a40f96` | 93 |
| `server/index.ts` | C | `6d070bcde589beb514da5a82f63305a83cd6c88a6eb9c7b08f1fa648bdf55425` | 1146 | `b80a4923c3764a20f5a908ea6958c583c3a66eef4d00e88347006aa5b0e20721` | 1182 |
| `server/keyChannelAccess.test.ts` | P | `1aa76dd9ebc6d235555fca0fe9c92abe9157de279bd51d1a3ef4476e37c1723c` | 87 | `3a7575e56877a21e04b892630ddb2b4584924c7499f28cf491db401005419b9e` | 81 |
| `server/keyChannelAccess.ts` | P | `e13a1c640b01ee9eec90ef1af8367b49dc22301471d012449b296a3e952aa6c4` | 69 | `b79db39644d92e181acb6d033d193ec5c9331fa7a2990f6ea85a91b992e6bd6e` | 64 |
| `server/keyModelAccess.test.ts` | P | `d67f09a24f728fc6572c3cd092e54afd2de16f268471147657bd64d2dfb3d614` | 65 | `3e020dd321299c4c436f5231b3729a2ae3aef5cc9754ea0962b8b81a7f60392f` | 42 |
| `server/keyModelAccess.ts` | P | `a1b08bce500000c551de46bc94d4cfa1ad442cc7b830c1b44ca380a78467ac8a` | 83 | `b94fe7f4ee0cb00ee7e5ccca1506beffd89a5a4e9f059d753fbac5b20151e4a6` | 60 |
| `server/keyNaming.test.ts` | SAME | `5acfec7d95c80675a9907fb1e4804f1c046daf88900452c208ace8ca382df28d` | 32 | `5acfec7d95c80675a9907fb1e4804f1c046daf88900452c208ace8ca382df28d` | 32 |
| `server/keyNaming.ts` | SAME | `5a321e480e46b45d7ed59f193c7c582ff803997c2280a9eb3c5bafe264f1b2be` | 39 | `5a321e480e46b45d7ed59f193c7c582ff803997c2280a9eb3c5bafe264f1b2be` | 39 |
| `server/keyPoolReconcile.test.ts` | P | `4b3d3487a6df8def943890a5c8afe467734e08a9b7929f9d2e917cccf8aa9150` | 80 | `a79ba694ee5ca57ad4da3907d62d8294778fb42b790d267c0d6f3267eba8213b` | 75 |
| `server/keySecrets.test.ts` | SAME | `9b9e12beb8dc0ecdebd82a98e6dc5db537308550de101a1abc7f0b18712b904e` | 14 | `9b9e12beb8dc0ecdebd82a98e6dc5db537308550de101a1abc7f0b18712b904e` | 14 |
| `server/keySecrets.ts` | SAME | `cce4bdd8eff3c316dfa93fcdf9a615052fea19b59dd4e6ba79a144172e8272c7` | 17 | `cce4bdd8eff3c316dfa93fcdf9a615052fea19b59dd4e6ba79a144172e8272c7` | 17 |
| `server/liveStream.test.ts` | P | `d96bf9c640a07a53dddd858de51fd684c78b00b62904b9816a2fbb1c8f526414` | 282 | `4f34c2cf87799b7dfee9fb77ae31fe919b598c61052a806d9443f23123e42ccf` | 281 |
| `server/liveStream.ts` | SAME | `b6fdfe65aec413626fb8a2d7c088fc8206e8647416f488b38ff5782432b0a688` | 243 | `b6fdfe65aec413626fb8a2d7c088fc8206e8647416f488b38ff5782432b0a688` | 243 |
| `server/managementCapability.ts` | SAME | `091cf1bf71fac007cc28891bc435a31acce67671d193b8947112ec7d0485d133` | 32 | `091cf1bf71fac007cc28891bc435a31acce67671d193b8947112ec7d0485d133` | 32 |
| `server/managementDegrade.test.ts` | SAME | `7892c9f5f2569e7a83353c51cbe024ac2d423709918436d3b7be45d399c3c6f6` | 170 | `7892c9f5f2569e7a83353c51cbe024ac2d423709918436d3b7be45d399c3c6f6` | 170 |
| `server/modelCatalog.test.ts` | SAME | `e812f06e631b78cc70fd80ba1ff1fbf7917b47ef995108e0b206179b91fcec4a` | 44 | `e812f06e631b78cc70fd80ba1ff1fbf7917b47ef995108e0b206179b91fcec4a` | 44 |
| `server/modelCatalog.ts` | L | `d4f87beca5437777d34c6c897f2d73fa18b7a0b43cfd54f3b30d2500b5812ee3` | 387 | `51b579e4fdd25c72ee1dbbaacc7dd940f47d5b134fab7db4e5951574b1093071` | 435 |
| `server/modelIdentity.ts` | SAME | `212977c1676ac8933e3043154ec79c3536fd2c7f5b08980a0ec44519b3d88192` | 40 | `212977c1676ac8933e3043154ec79c3536fd2c7f5b08980a0ec44519b3d88192` | 40 |
| `server/modelIndex.test.ts` | P | `b64d4f9d34828f3ff4280541f36910c4cb09d34e151078b3f49c834b43dbd805` | 96 | `922f9ea9a0391095094ccbd65aa51771711c785ad420f3b3980a65101367f034` | 92 |
| `server/modelIndex.ts` | SAME | `47716f08d79d3ffcffcadc49ba87412820dc9fe9bd56f3d219eb85970665c631` | 98 | `47716f08d79d3ffcffcadc49ba87412820dc9fe9bd56f3d219eb85970665c631` | 98 |
| `server/monitorQuotaShare.test.ts` | SAME | `f6dbb518fd1933cb348e3809f70793e44c026e87685f2604db6236feaa7cc640` | 185 | `f6dbb518fd1933cb348e3809f70793e44c026e87685f2604db6236feaa7cc640` | 185 |
| `server/monitorQuotaShare.ts` | SAME | `8cbae44d73923090d035325b69845165db91f69f0c54395624a650c9df231434` | 187 | `8cbae44d73923090d035325b69845165db91f69f0c54395624a650c9df231434` | 187 |
| `server/multipartUpload.test.ts` | SAME | `ac50f59b8abfd72265174d35ae458b264b7bc450604627993b72da9cf049313e` | 36 | `ac50f59b8abfd72265174d35ae458b264b7bc450604627993b72da9cf049313e` | 36 |
| `server/multipartUpload.ts` | SAME | `3e312a51211c3d6c27dcfac7795dbd0698df60fdf43b3b68d2426e7a89f5f216` | 55 | `3e312a51211c3d6c27dcfac7795dbd0698df60fdf43b3b68d2426e7a89f5f216` | 55 |
| `server/nativeResponses.ts` | SAME | `06069d3d739939166ff1d6c8adbbef5fd92e30907f05f246a37fd23f215912f6` | 317 | `06069d3d739939166ff1d6c8adbbef5fd92e30907f05f246a37fd23f215912f6` | 317 |
| `server/nginxCompression.test.ts` | SAME | `2a8fc01e6c4b437bdb6dbf1b2ec94d7252e82e2766ab8e853ba7dfe39320d106` | 13 | `2a8fc01e6c4b437bdb6dbf1b2ec94d7252e82e2766ab8e853ba7dfe39320d106` | 13 |
| `server/nginxUnlimitedApply.test.ts` | SAME | `6e276cd65bf486341454a6e435d86fe53627fd7992ec4159fa1326da3195b0a7` | 129 | `6e276cd65bf486341454a6e435d86fe53627fd7992ec4159fa1326da3195b0a7` | 129 |
| `server/nginxUnlimitedApply.ts` | SAME | `8ebf7959fa7f17bece7e876c84cd133a6c3fb6e9246625f790a6f32308ceb66f` | 205 | `8ebf7959fa7f17bece7e876c84cd133a6c3fb6e9246625f790a6f32308ceb66f` | 205 |
| `server/nginxUnlimitedApplyCli.ts` | SAME | `3d28e5ce46d7b773ffea184e296e7f829002b5f115c2cea860fbd18b81b93d02` | 46 | `3d28e5ce46d7b773ffea184e296e7f829002b5f115c2cea860fbd18b81b93d02` | 46 |
| `server/nginxUnlimitedDeploy.test.ts` | SAME | `28748863e117077d0c4c34d076222e503515dbbd72999ee4f4e066981ce81b3e` | 35 | `28748863e117077d0c4c34d076222e503515dbbd72999ee4f4e066981ce81b3e` | 35 |
| `server/nginxUnlimitedPolicy.test.ts` | SAME | `32952c946ea936adfaa3ee07e4d77c165ab8944dec4a971106e1ab20415928a6` | 94 | `32952c946ea936adfaa3ee07e4d77c165ab8944dec4a971106e1ab20415928a6` | 94 |
| `server/nginxUnlimitedPolicy.ts` | SAME | `47336a5479a3b422bd3c2e6c04d0500c960b8b828b32f9d9e560538347f80dc3` | 124 | `47336a5479a3b422bd3c2e6c04d0500c960b8b828b32f9d9e560538347f80dc3` | 124 |
| `server/nginxUnlimitedReconciler.test.ts` | SAME | `325ddc6eb30da5ce7cc822cbe6f5844727da54dd32010847c3b8896458f12c05` | 28 | `325ddc6eb30da5ce7cc822cbe6f5844727da54dd32010847c3b8896458f12c05` | 28 |
| `server/nginxUnlimitedReconciler.ts` | SAME | `75688b5b827a8804bc8841bd78ddf7547bc4fa38fc9ac584f13e73a7098becdc` | 23 | `75688b5b827a8804bc8841bd78ddf7547bc4fa38fc9ac584f13e73a7098becdc` | 23 |
| `server/nginxUnlimitedSync.test.ts` | SAME | `f40586e62ab1d8711c03e83d0f3d1a1bb2866d166dae2b0dd68becc075ab04d9` | 163 | `f40586e62ab1d8711c03e83d0f3d1a1bb2866d166dae2b0dd68becc075ab04d9` | 163 |
| `server/nginxUnlimitedSync.ts` | SAME | `d34350028263ca0de213d086deb6a8ffd23e51b6c2eb93b790166f74a6531780` | 113 | `d34350028263ca0de213d086deb6a8ffd23e51b6c2eb93b790166f74a6531780` | 113 |
| `server/oauthAndVersion.test.ts` | SAME | `fb79e45f3f044b647f3f1e7829c17fad7990940e8c29f7afdad2c9c5ee706f97` | 58 | `fb79e45f3f044b647f3f1e7829c17fad7990940e8c29f7afdad2c9c5ee706f97` | 58 |
| `server/oauthGroupResilience.test.ts` | SAME | `e9e67abf2cc31627cd5aea2a175709a1c0adeb51205dd8c20f13109db3f814d2` | 72 | `e9e67abf2cc31627cd5aea2a175709a1c0adeb51205dd8c20f13109db3f814d2` | 72 |
| `server/pageMotionVisibility.test.ts` | SAME | `4655833b1deeb9ca8ac84bef978d45693114f2c69c94453686a865b41f72bd8e` | 12 | `4655833b1deeb9ca8ac84bef978d45693114f2c69c94453686a865b41f72bd8e` | 12 |
| `server/policy.test.ts` | SAME | `2f0e7562dc0f18640d0b9efc607f6584daa87b379c919a1524929c6ab5edc14b` | 21 | `2f0e7562dc0f18640d0b9efc607f6584daa87b379c919a1524929c6ab5edc14b` | 21 |
| `server/policy.ts` | SAME | `ae1d1dc5bebe3f4453aab4e887a63672911cec9451f390ed7339fa495bb8b4af` | 21 | `ae1d1dc5bebe3f4453aab4e887a63672911cec9451f390ed7339fa495bb8b4af` | 21 |
| `server/pricing.data.json` | SAME | `db0f549fce0af2ecf19f919d77fb3be655f3e5f2ba47b888ea942b2d04449039` | 879 | `db0f549fce0af2ecf19f919d77fb3be655f3e5f2ba47b888ea942b2d04449039` | 879 |
| `server/pricing.test.ts` | SAME | `56ec72bfe18cf67f6ed5512efe5754f8747b45202c815ab207e8969e1ab2cd5f` | 111 | `56ec72bfe18cf67f6ed5512efe5754f8747b45202c815ab207e8969e1ab2cd5f` | 111 |
| `server/pricing.ts` | SAME | `d536e2ec29fde0d8b82938e3ad208a50da3f321b076f77ce80ea3070d504f93b` | 277 | `d536e2ec29fde0d8b82938e3ad208a50da3f321b076f77ce80ea3070d504f93b` | 277 |
| `server/proxyPresets.test.ts` | SAME | `9b901a93a6832c47ef5338fa9721880bb275853a4e5d19f362b65b19670f9171` | 43 | `9b901a93a6832c47ef5338fa9721880bb275853a4e5d19f362b65b19670f9171` | 43 |
| `server/proxyPresets.ts` | SAME | `4025a393449ab532703f1c10d44d00ddd0b3576361f4f8057e91340b587b2f5b` | 54 | `4025a393449ab532703f1c10d44d00ddd0b3576361f4f8057e91340b587b2f5b` | 54 |
| `server/publicUsage.test.ts` | SAME | `722d9c70ee6a5d0ff6b69c122e974cb36fa9f1468aed0a54a3c2ceb84d6d4ad7` | 22 | `722d9c70ee6a5d0ff6b69c122e974cb36fa9f1468aed0a54a3c2ceb84d6d4ad7` | 22 |
| `server/publicUsage.ts` | SAME | `d168ce619aaf5314c09da5d6f011b3bb47f6dbb74e4706f8ae3e3a9308ec77be` | 12 | `d168ce619aaf5314c09da5d6f011b3bb47f6dbb74e4706f8ae3e3a9308ec77be` | 12 |
| `server/quota.test.ts` | SAME | `0feee4862bdc2f32c7fd1e4cfdbd2df3a8540334fb3914b192331e920469126d` | 144 | `0feee4862bdc2f32c7fd1e4cfdbd2df3a8540334fb3914b192331e920469126d` | 144 |
| `server/quota.ts` | SAME | `a1f43f2d9ccb47b48cdaa09569ee2d808811f203a37e17c640a920790e11a380` | 154 | `a1f43f2d9ccb47b48cdaa09569ee2d808811f203a37e17c640a920790e11a380` | 154 |
| `server/quotaEnforcer.ts` | SAME | `312b8a55e9e37ec271342075b845d62328d24b918c6c7a999a762176aa78a1c3` | 231 | `312b8a55e9e37ec271342075b845d62328d24b918c6c7a999a762176aa78a1c3` | 231 |
| `server/quotaLedger.test.ts` | SAME | `90af559b1b56a2c461f402029cb140eb5dedc40b7419b872a24a0523e3a55451` | 131 | `90af559b1b56a2c461f402029cb140eb5dedc40b7419b872a24a0523e3a55451` | 131 |
| `server/quotaLedger.ts` | SAME | `eadeb292f475c7fdced1e2d887a0e2e4773f449b5f28a092ef2f3a106d84acc5` | 206 | `eadeb292f475c7fdced1e2d887a0e2e4773f449b5f28a092ef2f3a106d84acc5` | 206 |
| `server/reportPageFrontend.test.ts` | SAME | `a373e24e9fe7dd55552d7b77f0be61564704dd65fb2cd72c048cd1dfe0584531` | 67 | `a373e24e9fe7dd55552d7b77f0be61564704dd65fb2cd72c048cd1dfe0584531` | 67 |
| `server/reportPageLoads.test.ts` | SAME | `5cd24591dd6919ce0106fa881d5b177b72d56b3e1d55a3cb229e46cdb9d2154a` | 440 | `5cd24591dd6919ce0106fa881d5b177b72d56b3e1d55a3cb229e46cdb9d2154a` | 440 |
| `server/reportRouteWiring.test.ts` | SAME | `503682fc2362b2c15d0107767ec05c583630342577cc8af2269d88144c2a45fc` | 109 | `503682fc2362b2c15d0107767ec05c583630342577cc8af2269d88144c2a45fc` | 109 |
| `server/reportSnapshotCache.test.ts` | SAME | `2b8601caf4d510e5873d24d9a2809a4bca914a125668aa1803777c205016fb70` | 91 | `2b8601caf4d510e5873d24d9a2809a4bca914a125668aa1803777c205016fb70` | 91 |
| `server/reportSnapshotCache.ts` | SAME | `62ae986b65b90ab335baa2f7d5c5d3ff7d257ee77fad5fa2aa9cb614e1ad0cb0` | 95 | `62ae986b65b90ab335baa2f7d5c5d3ff7d257ee77fad5fa2aa9cb614e1ad0cb0` | 95 |
| `server/reportingGroups.test.ts` | SAME | `b646da46af40ec4263730b5a940db45278553bb1a0aa5b0033caa564fc16aa1f` | 23 | `b646da46af40ec4263730b5a940db45278553bb1a0aa5b0033caa564fc16aa1f` | 23 |
| `server/reportingGroups.ts` | SAME | `6ddce90549b099b5721ced5e58300b747bf914c5fdaa5f895c7904f2a4bac511` | 64 | `6ddce90549b099b5721ced5e58300b747bf914c5fdaa5f895c7904f2a4bac511` | 64 |
| `server/requestCoordinator.test.ts` | SAME | `4e5907ac058b3223adebd31d95c1cd63f6c0f4080fae293fe694494b4594a3cd` | 98 | `4e5907ac058b3223adebd31d95c1cd63f6c0f4080fae293fe694494b4594a3cd` | 98 |
| `server/requestCoordinator.ts` | SAME | `a94e7f670f869db5b30411a635da6eca0720e214e27e1b09cb8848f575e60fea` | 60 | `a94e7f670f869db5b30411a635da6eca0720e214e27e1b09cb8848f575e60fea` | 60 |
| `server/snapshotStore.test.ts` | SAME | `0515bc404b9f062f07846605908086f583352412ed51ab1fb99d2f8d5369b292` | 156 | `0515bc404b9f062f07846605908086f583352412ed51ab1fb99d2f8d5369b292` | 156 |
| `server/snapshotStore.ts` | SAME | `8794e2ae485878cb8688f0e35e2655772553bf320066d803cd7d091291e78722` | 161 | `8794e2ae485878cb8688f0e35e2655772553bf320066d803cd7d091291e78722` | 161 |
| `server/sqliteReadWorker.mjs` | SAME | `421cbd860570dc98777a24a5e64cdf80977f9918f23f58a0e1804c415aeaa2e4` | 77 | `421cbd860570dc98777a24a5e64cdf80977f9918f23f58a0e1804c415aeaa2e4` | 77 |
| `server/sqliteReadWorker.test.ts` | SAME | `8cfa344861b80466946b7601e090bc6537a720d89156237fc58340acc58d2f05` | 135 | `8cfa344861b80466946b7601e090bc6537a720d89156237fc58340acc58d2f05` | 135 |
| `server/sqliteReadWorker.ts` | SAME | `4eb93a14e4ba3d5946d34c2dd5fe43b32aaa8753a1b009e9fd9ba521d2a64f2e` | 123 | `4eb93a14e4ba3d5946d34c2dd5fe43b32aaa8753a1b009e9fd9ba521d2a64f2e` | 123 |
| `server/staticEntryCaching.test.ts` | SAME | `687cd9fc6d54aba2d8f90c817f3ee7eeb568ac5c004d8313033193ed88a21542` | 10 | `687cd9fc6d54aba2d8f90c817f3ee7eeb568ac5c004d8313033193ed88a21542` | 10 |
| `server/sync.ts` | SAME | `dd5e282313ef9320be1365679ad4b793eedcc873403ab7682a11aa7d5d94b052` | 457 | `dd5e282313ef9320be1365679ad4b793eedcc873403ab7682a11aa7d5d94b052` | 457 |
| `server/syncScheduler.test.ts` | SAME | `031da32bcee017f20ac220c2cc725fcc782fd8e88284c6800381a3d84106703c` | 199 | `031da32bcee017f20ac220c2cc725fcc782fd8e88284c6800381a3d84106703c` | 199 |
| `server/timeRange.test.ts` | SAME | `1b71007ee4f735fca00badeb80368450ea10912838313281682c1c53fd220eee` | 53 | `1b71007ee4f735fca00badeb80368450ea10912838313281682c1c53fd220eee` | 53 |
| `server/timeRange.ts` | SAME | `4d846e10252d6476d24e8f4635a1db8e4ff65f8dec4f0af806c803833df9ef8b` | 25 | `4d846e10252d6476d24e8f4635a1db8e4ff65f8dec4f0af806c803833df9ef8b` | 25 |
| `server/timeWindow.test.ts` | SAME | `c164ba079af26cc387a44b4df3d7f808a3f335a4ec6477b666bd42329fdc1bad` | 67 | `c164ba079af26cc387a44b4df3d7f808a3f335a4ec6477b666bd42329fdc1bad` | 67 |
| `server/tokenSql.ts` | SAME | `8c03cf525a0ffad11f7f1d938cf64e9c779beed6e1720f882ab0dd89713b34f7` | 24 | `8c03cf525a0ffad11f7f1d938cf64e9c779beed6e1720f882ab0dd89713b34f7` | 24 |
| `server/uploadGate.test.ts` | SAME | `304d5e31686c1db51877424c329be885b39e1715ce666415eb9580cd47a9b41f` | 16 | `304d5e31686c1db51877424c329be885b39e1715ce666415eb9580cd47a9b41f` | 16 |
| `server/uploadGate.ts` | SAME | `2ee7ecaa6fc17ccf77f550cb64585bda78bcffa8fb3916570bc316bb0e63f880` | 21 | `2ee7ecaa6fc17ccf77f550cb64585bda78bcffa8fb3916570bc316bb0e63f880` | 21 |
| `server/usageBreakdown.test.ts` | SAME | `0332e9dcd32e7ab865337d43be49c8899dfdb18546d5952f6ecf56c14a9447cd` | 69 | `0332e9dcd32e7ab865337d43be49c8899dfdb18546d5952f6ecf56c14a9447cd` | 69 |
| `server/usageBreakdown.ts` | SAME | `3cad15fa41541ed59c8afa484ed3b3ad516d4169bf2ff50f7c361e409fa067ac` | 145 | `3cad15fa41541ed59c8afa484ed3b3ad516d4169bf2ff50f7c361e409fa067ac` | 145 |
| `server/usageDetails.test.ts` | SAME | `94379992c260d85c6adf1cfd4d072fa436dc48387f0f6b2e6aa09e6cf87f0fbd` | 44 | `94379992c260d85c6adf1cfd4d072fa436dc48387f0f6b2e6aa09e6cf87f0fbd` | 44 |
| `server/usageDetails.ts` | SAME | `c5c26ed4399eadde5ec6c493701c428ce29ffac975ab8ecd2176a6019eb68136` | 78 | `c5c26ed4399eadde5ec6c493701c428ce29ffac975ab8ecd2176a6019eb68136` | 78 |
| `server/usageOverview.test.ts` | SAME | `b08e9d86a5ca413ecee634ed2e9ac4b0c5bcc6848cfb97c4f7eb2a58f6ebf47a` | 129 | `b08e9d86a5ca413ecee634ed2e9ac4b0c5bcc6848cfb97c4f7eb2a58f6ebf47a` | 129 |
| `server/usageOverview.ts` | SAME | `f2110d34576031a4569c6980e7b15e89d0f439c3cabac77aaf98591bd5b0121e` | 264 | `f2110d34576031a4569c6980e7b15e89d0f439c3cabac77aaf98591bd5b0121e` | 264 |
| `server/usageReports.ts` | SAME | `de42cd8eebc5ccdb5aa8577a04ff36c67f1a964f3b3b21aa786a3f6d62e19ca9` | 830 | `de42cd8eebc5ccdb5aa8577a04ff36c67f1a964f3b3b21aa786a3f6d62e19ca9` | 830 |
| `server/usageRollup.ts` | SAME | `f3daae696a072b875a23f7725f5c0517c32e406bb864656c1809e353d8da75b9` | 254 | `f3daae696a072b875a23f7725f5c0517c32e406bb864656c1809e353d8da75b9` | 254 |
| `server/zipEntries.ts` | SAME | `892d79c33610e94fdec35b71e0b37ac6920b943ca6ad0d4b539ec4a9186bbb92` | 92 | `892d79c33610e94fdec35b71e0b37ac6920b943ca6ad0d4b539ec4a9186bbb92` | 92 |
| `src/App.css` | L | `8a690b2a9505ee4f3a20e974f7ca5e46301538608ffec1a1fd13324aeea4fba1` | 360 | `7579fc9fa72e82b0dbfd6a80e60f81ea5aba00f53e4bb82bcc4a5f6f3a381340` | 375 |
| `src/App.tsx` | L | `cf8cff86c20935a69d8fe33ddac0d5ef89c7fe4edd5678a3d80d6154e900289f` | 413 | `b66ab3dd0bf1c5c2844577c5d88f84f9c26d75f51953902082e854202036c7dd` | 410 |
| `src/api.ts` | C | `7e5b1b993b0e1014f6bd9c77ab702b1f113d4f5e8a0ee7fcc83c0e66d3312883` | 88 | `c773cc498febaa1118300aa6af725b47df47791cfb2aec1eb2da274750ca8a12` | 94 |
| `src/assets/hero.png` | SAME | `881ffbcaafc212e49addad08846a5b82761355fa20624253af3477ba33262c5c` | 52 | `881ffbcaafc212e49addad08846a5b82761355fa20624253af3477ba33262c5c` | 52 |
| `src/assets/react.svg` | SAME | `35ef61ed53b323ae94a16a8ec659b3d0af3880698791133f23b084085ab1c2e5` | 0 | `35ef61ed53b323ae94a16a8ec659b3d0af3880698791133f23b084085ab1c2e5` | 0 |
| `src/assets/vite.svg` | SAME | `5be21acd42eb7b896e517f4e0f0f11eb5c5d9e54fbbcebe9453f033008fcca6f` | 1 | `5be21acd42eb7b896e517f4e0f0f11eb5c5d9e54fbbcebe9453f033008fcca6f` | 1 |
| `src/channelLabels.ts` | SAME | `70e927dcd550e0458469096cafbf516b177d765e2b6780bce545bbfb020a8fef` | 15 | `70e927dcd550e0458469096cafbf516b177d765e2b6780bce545bbfb020a8fef` | 15 |
| `src/chartTheme.ts` | SAME | `3887b8f74c5f15e6ca816a539df8fb6381ce914b1081e683c4423167693c7d84` | 42 | `3887b8f74c5f15e6ca816a539df8fb6381ce914b1081e683c4423167693c7d84` | 42 |
| `src/clientLabels.ts` | SAME | `5a0b4697ff6d8bbb857808f7072de3639bfabb36620aac771f5e755d0875d84b` | 34 | `5a0b4697ff6d8bbb857808f7072de3639bfabb36620aac771f5e755d0875d84b` | 34 |
| `src/components/ChannelCreateDialog.tsx` | SAME | `aab389c9b72de5a45c45f4c0519ca6d7db089145d15b66c2068d05bd626daae9` | 121 | `aab389c9b72de5a45c45f4c0519ca6d7db089145d15b66c2068d05bd626daae9` | 121 |
| `src/components/ConfirmDialog.tsx` | SAME | `3824d2c8cbba905452b358a320a8a1bba00178d2b7e389897f9fca47dc6b2f11` | 28 | `3824d2c8cbba905452b358a320a8a1bba00178d2b7e389897f9fca47dc6b2f11` | 28 |
| `src/components/Modal.tsx` | SAME | `96fea9b5a91baaa0dc5c94ac8a39113e86fdb2b6b9a4c6b3e8e2bb61ffa0f428` | 14 | `96fea9b5a91baaa0dc5c94ac8a39113e86fdb2b6b9a4c6b3e8e2bb61ffa0f428` | 14 |
| `src/components/OAuthLoginDialog.tsx` | SAME | `ff9abe9dd5ec8cd14cb2d14eb823d3982e35ec614a0e241fcfca4ee9e9f843b8` | 430 | `ff9abe9dd5ec8cd14cb2d14eb823d3982e35ec614a0e241fcfca4ee9e9f843b8` | 430 |
| `src/components/QuotaEditor.tsx` | SAME | `8c96ef473d5e50714137fbba7613cc28ffd5e0bd6a40420b7397348c277d9676` | 131 | `8c96ef473d5e50714137fbba7613cc28ffd5e0bd6a40420b7397348c277d9676` | 131 |
| `src/components/RequestDetail.tsx` | SAME | `84809c95d34523d8baf6bc787d615db69cd64efb413f7f75d8e6c8d217efac1c` | 38 | `84809c95d34523d8baf6bc787d615db69cd64efb413f7f75d8e6c8d217efac1c` | 38 |
| `src/components/ResultDialog.tsx` | SAME | `d9ef20126e1f8ae4b40cb3763a8206c361b9d77cd5bae531b5bec82cc8b87c3e` | 21 | `d9ef20126e1f8ae4b40cb3763a8206c361b9d77cd5bae531b5bec82cc8b87c3e` | 21 |
| `src/components/Select.tsx` | SAME | `c403234d9930bbab0f821bd9137c2e6868f1602b97b94c80b6507c63f62e714c` | 27 | `c403234d9930bbab0f821bd9137c2e6868f1602b97b94c80b6507c63f62e714c` | 27 |
| `src/components/UsageQueryDialog.tsx` | SAME | `50db0f10a65bf2a3cd26cf73ed5b434b50864057a18a221ac0503fec5b57e2dd` | 47 | `50db0f10a65bf2a3cd26cf73ed5b434b50864057a18a221ac0503fec5b57e2dd` | 47 |
| `src/components/VersionWidget.tsx` | L | `211d11d8d62ff0edd39ae17ca4a0d420c336691b33b2db552ddb77d5c69be5e5` | 167 | `ae82637f324ff95a9bc3230a79152f8858066bf87f87b1d6483fe151b6271d79` | 272 |
| `src/docs-entry.tsx` | SAME | `380cd962508bf6c8a548e17a6dbaf8af9cce52ebf43da8ab5da95aa0d9789bb0` | 13 | `380cd962508bf6c8a548e17a6dbaf8af9cce52ebf43da8ab5da95aa0d9789bb0` | 13 |
| `src/docs.css` | SAME | `d917fd13a5b569ccf044bbf4da8c9f261d4f2a75c087f5fcea78e51e4cb9806e` | 1 | `d917fd13a5b569ccf044bbf4da8c9f261d4f2a75c087f5fcea78e51e4cb9806e` | 1 |
| `src/docs.tsx` | SAME | `899664168bfd683028600051ceaab6e1faa1ddad46a94750d7d5b5eaf7330c3d` | 194 | `899664168bfd683028600051ceaab6e1faa1ddad46a94750d7d5b5eaf7330c3d` | 194 |
| `src/gatewayStatus.ts` | L | `a9435f81748fb3012f6292337894b0806f2578689458e15b320ae5af11f8362c` | 20 | `d8dc7050850fdd904d3dcb907059ee7f148ceb5c8cb8241137226b59838e3b86` | 25 |
| `src/index.css` | SAME | `0784cc0387cb5f39fc7cca1e0d70e8e6c003b0084e5d53c1466f1fb31c39f5ed` | 33 | `0784cc0387cb5f39fc7cca1e0d70e8e6c003b0084e5d53c1466f1fb31c39f5ed` | 33 |
| `src/main.tsx` | SAME | `74831db3ec773f7e0977fff554216bd5cd294b67b20968be005a3bea1d8c5324` | 14 | `74831db3ec773f7e0977fff554216bd5cd294b67b20968be005a3bea1d8c5324` | 14 |
| `src/pages/AnalyticsPage.tsx` | SAME | `d23ab1b23863ea1e060fe6509dfdf62e2f943644731e8b50e57fb8f5ce5d90ff` | 92 | `d23ab1b23863ea1e060fe6509dfdf62e2f943644731e8b50e57fb8f5ce5d90ff` | 92 |
| `src/pages/CachePage.tsx` | SAME | `51763ea282c1dd39a6a72236aeac620d65c4b75041a25fa60df2a5efdaae6dda` | 275 | `51763ea282c1dd39a6a72236aeac620d65c4b75041a25fa60df2a5efdaae6dda` | 275 |
| `src/pages/ChannelsPage.tsx` | SAME | `134d107a0ed32778fcdc9775b47a8844bd3c16924b118be52bb16bfa4796b158` | 326 | `134d107a0ed32778fcdc9775b47a8844bd3c16924b118be52bb16bfa4796b158` | 326 |
| `src/pages/ChartsPage.tsx` | SAME | `7a37f4db0ec8e54cd7c1c97954eb8ec4736e60f65f9c4e4bf54a781c6e4e9947` | 144 | `7a37f4db0ec8e54cd7c1c97954eb8ec4736e60f65f9c4e4bf54a781c6e4e9947` | 144 |
| `src/pages/CredentialUploadPage.tsx` | SAME | `ef953a23401ac3a6db61c3e5befb4d35fe6b3812cc3f8cfa005562c64963fecf` | 109 | `ef953a23401ac3a6db61c3e5befb4d35fe6b3812cc3f8cfa005562c64963fecf` | 109 |
| `src/pages/DashboardPage.tsx` | L | `9822b49060d9831e61e8c7401c2fcac0a8fe6d4ef5cf73c5b7c8f22e776e0899` | 51 | `b293a278be6f21855f54ff576e6727d2d977e5f06f224a48505bb64309c2fb4d` | 51 |
| `src/pages/HelpPage.tsx` | SAME | `a33a286da78b3a31bb623c000a063be0b1baefc733873555dfc470b249036c0e` | 229 | `a33a286da78b3a31bb623c000a063be0b1baefc733873555dfc470b249036c0e` | 229 |
| `src/pages/KeysPage.tsx` | SAME | `b714d94d55e89e380212eb02697842cb6b11d64d774d1966a4cdb8eb0bedcfab` | 152 | `b714d94d55e89e380212eb02697842cb6b11d64d774d1966a4cdb8eb0bedcfab` | 152 |
| `src/pages/LoginPage.tsx` | SAME | `8286c8e036676eb312b95fdb01662bf6f8a286f31de282e933a95673e9bd76ba` | 37 | `8286c8e036676eb312b95fdb01662bf6f8a286f31de282e933a95673e9bd76ba` | 37 |
| `src/pages/ModelsPage.tsx` | L | `e29c6d44a1f5ffd2bb895bf9fd6a51fa9a5e2109a60745ab6bf5160e05697387` | 191 | `b6950bebe329bba2349f438887460f861c1863a3841144e2d5993f0cb3584fe0` | 209 |
| `src/pages/MonitorPage.tsx` | P | `024c3d55a3c23a107c9c19a8ea1d87c81a75b22817339188d6956c73e36d27b0` | 209 | `698147a995e7ae5aa96bac76c1d4726c13f709306013daf07874deeebf15a87b` | 206 |
| `src/pages/OAuthPage.tsx` | SAME | `3a8ecd39fd4d2f095c8ae7102d9bea6ae51d9fe1554aa9d3d1166e66439b40a8` | 465 | `3a8ecd39fd4d2f095c8ae7102d9bea6ae51d9fe1554aa9d3d1166e66439b40a8` | 465 |
| `src/pages/UsagePage.tsx` | SAME | `2e327c46877f82dba965d05a1560a04a9fc194c04042a3a53e448332e40ab6a0` | 205 | `2e327c46877f82dba965d05a1560a04a9fc194c04042a3a53e448332e40ab6a0` | 205 |
| `src/request-details.css` | SAME | `bdc3e0f267d2a2f176d0d3d3ea4fe330071d443df3836a4f250210ccea2f65dc` | 9 | `bdc3e0f267d2a2f176d0d3d3ea4fe330071d443df3836a4f250210ccea2f65dc` | 9 |
| `src/types.ts` | L | `94262fb670c47f6616f3329390e620bc3f1f09a20144d27c307013a2eeff4963` | 500 | `a31cffd4e667e3308f861144a8929f26b228d86a185d46bc55665e18fd3cb104` | 568 |
| `tsconfig.app.json` | SAME | `3d972e46410867dfc6dc480524dd319feb7ef01cd4ea77ce367e93097610ad77` | 26 | `3d972e46410867dfc6dc480524dd319feb7ef01cd4ea77ce367e93097610ad77` | 26 |
| `tsconfig.json` | SAME | `91434fd9d32940ba5f1347be26f2c7ff676e7c1e203dba03e9986d71915755ff` | 8 | `91434fd9d32940ba5f1347be26f2c7ff676e7c1e203dba03e9986d71915755ff` | 8 |
| `tsconfig.node.json` | SAME | `afc4620f8c23f3cd5dda3726408cf705438a054db22ccf0e09ff73eacef601ab` | 23 | `afc4620f8c23f3cd5dda3726408cf705438a054db22ccf0e09ff73eacef601ab` | 23 |
| `tsconfig.server.json` | SAME | `acc8c1aa4c9bc61e9d8fab2919c41c8f1933668b7d0926f07adcfdac5308bfa8` | 19 | `acc8c1aa4c9bc61e9d8fab2919c41c8f1933668b7d0926f07adcfdac5308bfa8` | 19 |
| `vite.config.ts` | L | `cfb852aedcaeaf7f0790bc2be6426fe4e3e288262039ad45a14ba9b37ca12ef0` | 18 | `0d082af13221f81b8545f8d773655c25492d007755a241f7470420c925fcfb8c` | 35 |

### 8.5 第三方副本：`/opt/crosery-api-console`（mutable checkout）与当前 release 的对照

`git -C /opt/crosery-api-console rev-parse HEAD` = `662a5047fb577680d10794e7c788d5ffe254eb08`（与本地 `662a504` **同 SHA**）。下表是对其工作树（排除 `.env*`、`data/`、`node_modules/`、`dist*`、`.git/`）逐文件哈希的结果：

| 指标 | 数量 |
| --- | --- |
| release 文件总数（非构建） | 246 |
| mutable 工作树相关文件总数 | 161 |
| 与 release **逐字节相同** | 93 |
| 与 release **不同**（都是打补丁前的旧版本） | 66 |
| release 有、mutable **缺失** | 87 |
| mutable 有、release 没有（非 `.env*`） | 2 → ['rotate_key.mjs', 'src/.DS_Store'] |

**66 个「与 release 不同」的文件**（`mutable sha256` 即旧版本哈希，`PROD sha256` 为当前生产内容）：

| 路径 | mutable sha256 | PROD sha256 | 是否等于 BASE(662a504) |
| --- | --- | --- | --- |
| `.gitignore` | `da2c0e0c89575599326200cce9b17cc88d0a6cc8d7009785baa5b58e0cfd627e` | `4f82f9b1ddee740309f14d29f88ea035bea11766b8c9cff3a738acf268bf887c` | 是 |
| `README.md` | `6a3d2558644804592c8e3441e015fc63af58efeed045935dd289e0ca9d157186` | `eb6307713ac7322df6fb2529e33c5a12eeaee520117c6d452c88c43a6a2ee873` | 否 |
| `package-lock.json` | `b73219fb90897f50188d09c4056352cbc85746c17998247c30dad04e0a8e00b4` | `ff7c7f87525c92d24e3a65ba92f2767116b56b2b6625365a0db0295351fabf52` | 否 |
| `package.json` | `08f5859dc1cf44b85643ea7314c1202f1fa4a45afc1b801892c4ceeb28813c7c` | `7daf307f5b4b7a09753f9fc561deaa25f3d0073396c55a7837a7441d1ad9c403` | 否 |
| `scripts/build-pricing.mjs` | `88a3353222eb0c93d268af9c283302215e5e4dd777233359634e08b8aff8c96d` | `5d24eadfe8fcf2baf0b98453cf59b0bc8908e80d1b29a78bbbfb56880a58ff6b` | —（BASE 无此文件） |
| `server/accountQuota.test.ts` | `327168a20092d084a99c539519f91c505754b19d197b8334b2279ba4f15e7f17` | `49bcb5a530ea9b50396c561a326b3e68a84c80dc394ddc70e8c238c01710c23a` | —（BASE 无此文件） |
| `server/accountQuota.ts` | `6d917f63eca5590095721b6fc0041cac7fc29d40ca5b5269082036cb4286691e` | `73532b3c51123dcb4c6c2fc50556aeb88e728d1c7b91403246b99daa17d3898a` | —（BASE 无此文件） |
| `server/analyticsNavigationFallback.test.ts` | `afe525d99a1cf8e5fb3a941b650bd0b7f3b380a8ae7b7b06a76b14ec36190226` | `411e8a529b0d2daedf002cc5096215df20ac438d3a10fca9af5b29de9b57ce89` | —（BASE 无此文件） |
| `server/cacheAnalytics.ts` | `3eb68da1947e4e376da787dbd36e65bd6865be4a499792c1e028d2ce86d50177` | `ab8febcfb26eb3c2985e789bb9fb82c8b7c37a5efbe70ecf96f08f65397898e5` | —（BASE 无此文件） |
| `server/cacheStats.test.ts` | `62f2ce8f3591a470039a7e4f441681cfa4fea779f05a05ef28233545710f6d66` | `b56f7106b7b2eeec4935c1fcd0139711248877f26318cb03fb23c8c623afed7a` | —（BASE 无此文件） |
| `server/cacheStats.ts` | `d0b17fe592cad98e6755ca7c3ddfca10ed2f56a76b0d7f6dd19a8d88c21afb6b` | `8840b20be1ac0be4c2d08accb6acb548089b72c418623606fddf29bdbce6d313` | —（BASE 无此文件） |
| `server/cacheTrend.test.ts` | `1ff9f1ae8be89a00c5f53affb2237a5faf1e1e8bb4da4d30476fd18c03ce1bd1` | `bf1022730d8d43c99e892e1f07d18adbc15f318ae0061c003f15db2d94a36dd8` | —（BASE 无此文件） |
| `server/cacheTrend.ts` | `a41ca78341020adb955b63971b313d229e7d2913a9177f94f32cb1723bef84fa` | `b983c3e5a4271e2fb0b952fd5d7c505e2e780b5ee0b0e0a5aff547e80549c534` | —（BASE 无此文件） |
| `server/channels.ts` | `3c00116a346ad23799afa5f72a69a90a4b4f71e4168bd40432eb819a2543069f` | `80df0acd7cf851498b3690528d83fcc457fd73c2b768c8a46127ef7216888e2f` | —（BASE 无此文件） |
| `server/claudeQuotaCache.test.ts` | `e7e06626cf628112b0eb4455e164b90a5478f33e2934db51e2afe6dc37c9b68c` | `8946efb08b6f4d7f95a9a56944fbaae5d46e047d59e7c18f51a1a0099736c371` | —（BASE 无此文件） |
| `server/claudeQuotaCache.ts` | `31a33d505f197692bd5717f24198abe050cbecd6fbbc0ca60469af164f50cfe2` | `ae69b7a0fb67cf3a234f346ecbaeb9302c93489a8f7c7e7000c34f980295a9d6` | —（BASE 无此文件） |
| `server/clientAgent.test.ts` | `34f6e875cfdade3be996aed7ed7c3ba90db448649dc17c687ba9d3a5d9e37ba3` | `1af7aa6355a5a80bc063196a099fe6a8c7716804d5410a989dc0e495112f7ac5` | —（BASE 无此文件） |
| `server/clientAgent.ts` | `dd281894f1c644b6fa7b07f1e53c24df6023ac0d0db69279b2f9b7155326b105` | `a21dca71702505c49e2b4699ef3cf4728e99aa7a954e2f7102500187cb622967` | —（BASE 无此文件） |
| `server/config.test.ts` | `8f35fb3e90c6eafd29160a1c540e45a363058b81932c8ee7306ce06b8d8f9ce5` | `a9c6ec17df91762e1a05f43688e35b3c878da27f64c26a152e08730a37d98704` | —（BASE 无此文件） |
| `server/config.ts` | `9d3e5999a748c7e3a00ad1f5395e041f62d949c2ef2928839dacadcf9922e478` | `77cdbf772bcaed66868d762a4cdc4c52dec3bcccd4a217e6aa365bd80f92b774` | 否 |
| `server/cpa.test.ts` | `34618fc17b8f824874f16e8f896401ff04e9936bee1f1b77c7ff3b398ab4153a` | `c6f250985591a61c92ac4c77095a781e060833019aed2992e0fe2e4b35f517bf` | —（BASE 无此文件） |
| `server/cpa.ts` | `f9ebc7901b867b9f5579de5ba2be24bcd09f9b3b37ae264213fe8991bc038c7a` | `bd97f7ed622794053ca94135a8b19bcd16da4b6bd29416db140b93155f9eabeb` | 是 |
| `server/credentialUpload.test.ts` | `835eb3c2ce12c39b9e65f765456aae73a5aea18a55a731e0d5478c7cbb97829f` | `27d1ea80de2b66db41e575d1c13e644cec0bb5231437f8990c4d1f9ab5362711` | —（BASE 无此文件） |
| `server/credentialUpload.ts` | `e2e704077db811e3a657c782c1f87e42acf8b4cad5bd02b00463a47406a870d4` | `5c9b74b060eb79878ed67d4f237bae6231b8fb8475487ec80ae37d9ad7e3a35c` | —（BASE 无此文件） |
| `server/db.ts` | `e50fa6b4777f431b95741fc0760157705a5f3c9ed17dcda0b42a7501c2fcb163` | `e2dd87e441702b41dd9e0227d8fa8a60e5e6863e8e2525ca9994a7cdc4161ef4` | 否 |
| `server/index.ts` | `7bfd6e01f23425eeb7ce3e7317e1e9526dcd9ec5ea44fdf4f9dca03bb9b68f90` | `6d070bcde589beb514da5a82f63305a83cd6c88a6eb9c7b08f1fa648bdf55425` | 是 |
| `server/keyModelAccess.test.ts` | `3e020dd321299c4c436f5231b3729a2ae3aef5cc9754ea0962b8b81a7f60392f` | `d67f09a24f728fc6572c3cd092e54afd2de16f268471147657bd64d2dfb3d614` | —（BASE 无此文件） |
| `server/keyModelAccess.ts` | `ec50cc962bea81f0b938f1416bd6dbe7f3c85940c7d7ac78632afb6d6a6fb0ad` | `a1b08bce500000c551de46bc94d4cfa1ad442cc7b830c1b44ca380a78467ac8a` | —（BASE 无此文件） |
| `server/liveStream.test.ts` | `b89539a789d8f5be0de0fb924c6df1a75aa8157815435ed2a3ca76e54295f773` | `d96bf9c640a07a53dddd858de51fd684c78b00b62904b9816a2fbb1c8f526414` | —（BASE 无此文件） |
| `server/liveStream.ts` | `e05e034f46d030030b50de0a0152b0fba054dfdbea48571ea380d3f6f9b0bd58` | `b6fdfe65aec413626fb8a2d7c088fc8206e8647416f488b38ff5782432b0a688` | —（BASE 无此文件） |
| `server/managementDegrade.test.ts` | `961ef8e1a16d62c277aefd9def038290c4d5f2d2a325b04f1eb65f6cd768b4c8` | `7892c9f5f2569e7a83353c51cbe024ac2d423709918436d3b7be45d399c3c6f6` | —（BASE 无此文件） |
| `server/modelIndex.test.ts` | `afa81fcfb022f9c642296e51ef4e3fe2c813f4ab69b1d5b892503d9d91fb810b` | `b64d4f9d34828f3ff4280541f36910c4cb09d34e151078b3f49c834b43dbd805` | —（BASE 无此文件） |
| `server/modelIndex.ts` | `108e0e0455b6c338b6f43886bc5539d8021724c63bd28fdb15fbca91c9880270` | `47716f08d79d3ffcffcadc49ba87412820dc9fe9bd56f3d219eb85970665c631` | —（BASE 无此文件） |
| `server/pricing.data.json` | `140b0a313effab0b2723e64111c4169bd8273d24794a34d84dfe84a86f2e0e32` | `db0f549fce0af2ecf19f919d77fb3be655f3e5f2ba47b888ea942b2d04449039` | —（BASE 无此文件） |
| `server/pricing.test.ts` | `1249ff3e94d3819219b78eda9e9b4877a6ef9a578cfcb763daaf381329b2769b` | `56ec72bfe18cf67f6ed5512efe5754f8747b45202c815ab207e8969e1ab2cd5f` | —（BASE 无此文件） |
| `server/pricing.ts` | `230297bcb3c69dd3af98af80c6e78b5be20b8faa99a4d8728b9e4f835467154b` | `d536e2ec29fde0d8b82938e3ad208a50da3f321b076f77ce80ea3070d504f93b` | —（BASE 无此文件） |
| `server/proxyPresets.test.ts` | `454684c3282ae3b7f8ce6e5cb97a60e08555f12aec0c123b668f04fba40f5c26` | `9b901a93a6832c47ef5338fa9721880bb275853a4e5d19f362b65b19670f9171` | —（BASE 无此文件） |
| `server/quota.ts` | `514aad91d2d0fa8963ac80e7f52cf5e1e897bd7b094ef4201bce0073b07bd7ef` | `a1f43f2d9ccb47b48cdaa09569ee2d808811f203a37e17c640a920790e11a380` | —（BASE 无此文件） |
| `server/quotaEnforcer.ts` | `574569e03a1bbe6cd1dedd016f10ceb03044d09e8230b1b63078f909949121c6` | `312b8a55e9e37ec271342075b845d62328d24b918c6c7a999a762176aa78a1c3` | —（BASE 无此文件） |
| `server/quotaLedger.test.ts` | `9d6823bccbfe256c81a9c05c0500ed96634e62ebe1b79849d4d59c8a26e1fef9` | `90af559b1b56a2c461f402029cb140eb5dedc40b7419b872a24a0523e3a55451` | —（BASE 无此文件） |
| `server/quotaLedger.ts` | `b1f204f865e1e456b5d699588150d4373dba99ce6af92d548a4218bf616bf845` | `eadeb292f475c7fdced1e2d887a0e2e4773f449b5f28a092ef2f3a106d84acc5` | —（BASE 无此文件） |
| `server/requestCoordinator.test.ts` | `6520824e1f88373fd9a0a4fe7c5c6b63658f5351877cdb377a63370d38eb0514` | `4e5907ac058b3223adebd31d95c1cd63f6c0f4080fae293fe694494b4594a3cd` | —（BASE 无此文件） |
| `server/requestCoordinator.ts` | `d6730ec9861e38067e906d7d78757e52bc5e4e2436c3cd6a7e44caa8f134fa59` | `a94e7f670f869db5b30411a635da6eca0720e214e27e1b09cb8848f575e60fea` | —（BASE 无此文件） |
| `server/sync.ts` | `59799a12c74178a9166fc3732562647f651dadc7ff7901895d566f6cdceb62fc` | `dd5e282313ef9320be1365679ad4b793eedcc873403ab7682a11aa7d5d94b052` | 否 |
| `server/usageBreakdown.ts` | `6c34f1ab71dfa56b0b250db7c7e6dedd6d47a4bc1f0ad0dca90c01cead69b137` | `3cad15fa41541ed59c8afa484ed3b3ad516d4169bf2ff50f7c361e409fa067ac` | —（BASE 无此文件） |
| `server/usageDetails.ts` | `3ba1a30a070f60452f43ec6a783f6701ee7359428b8c6d50de9aa61ac6dcaa0f` | `c5c26ed4399eadde5ec6c493701c428ce29ffac975ab8ecd2176a6019eb68136` | 否 |
| `server/usageOverview.ts` | `a1e7deb30e9f8ea1b95648692c606f492345d9af9aa04ff2b95d7f179141a518` | `f2110d34576031a4569c6980e7b15e89d0f439c3cabac77aaf98591bd5b0121e` | —（BASE 无此文件） |
| `src/App.css` | `1a1737e0f2973ac1747da7a2a934ebf03085a46f53a8223fd7478d518b3e6412` | `8a690b2a9505ee4f3a20e974f7ca5e46301538608ffec1a1fd13324aeea4fba1` | 否 |
| `src/App.tsx` | `3d413c0708634a13706ec124403ae0282b7d08001752e8863ee111ac2ee9da08` | `cf8cff86c20935a69d8fe33ddac0d5ef89c7fe4edd5678a3d80d6154e900289f` | 否 |
| `src/api.ts` | `0976fd15133cb196f31891117d1f31487760ca0a4b96ff67193ef7735ea39f04` | `7e5b1b993b0e1014f6bd9c77ab702b1f113d4f5e8a0ee7fcc83c0e66d3312883` | 是 |
| `src/clientLabels.ts` | `b5a35e1bd22584192343758f4cc75ce685951035da9ca986ee8ec6efd7c979c7` | `5a0b4697ff6d8bbb857808f7072de3639bfabb36620aac771f5e755d0875d84b` | —（BASE 无此文件） |
| `src/docs.tsx` | `d470037a1bb30171845f49218ca385b7ed13f3744fdff8aa5feceb05feb8dc46` | `899664168bfd683028600051ceaab6e1faa1ddad46a94750d7d5b5eaf7330c3d` | —（BASE 无此文件） |
| `src/main.tsx` | `6b40cf5a819259293968e64a00e33132b518267b15ecdeb52fa0217d6d9968ab` | `74831db3ec773f7e0977fff554216bd5cd294b67b20968be005a3bea1d8c5324` | 否 |
| `src/pages/CachePage.tsx` | `844ef7df7525c40bb2de63594a6fa5fef42eabe034fc17581f37835f3d02b4c7` | `51763ea282c1dd39a6a72236aeac620d65c4b75041a25fa60df2a5efdaae6dda` | —（BASE 无此文件） |
| `src/pages/ChannelsPage.tsx` | `14b8de8365880584d12b490405e4447da73710c59e539b4eba1b310ad11cb6b9` | `134d107a0ed32778fcdc9775b47a8844bd3c16924b118be52bb16bfa4796b158` | —（BASE 无此文件） |
| `src/pages/ChartsPage.tsx` | `882d0b1e6dc43c54db6488dee0317df6123df1c20b6731774bd322ad947ddb48` | `7a37f4db0ec8e54cd7c1c97954eb8ec4736e60f65f9c4e4bf54a781c6e4e9947` | —（BASE 无此文件） |
| `src/pages/DashboardPage.tsx` | `a5fe38cd790730af51a557575d36b699b0e7a2ddf75969ffcaac3aa694a656ca` | `9822b49060d9831e61e8c7401c2fcac0a8fe6d4ef5cf73c5b7c8f22e776e0899` | 否 |
| `src/pages/HelpPage.tsx` | `87667d9b96910141f00f42020ea67cb3fd2569344c4227d632bdddc36d9d0ee4` | `a33a286da78b3a31bb623c000a063be0b1baefc733873555dfc470b249036c0e` | —（BASE 无此文件） |
| `src/pages/ModelsPage.tsx` | `36198cbaab70f81cb194129c699d4be3de5183bbc78b746540a2dacb8b55ea0b` | `e29c6d44a1f5ffd2bb895bf9fd6a51fa9a5e2109a60745ab6bf5160e05697387` | —（BASE 无此文件） |
| `src/pages/MonitorPage.tsx` | `276225da54e50328368a00c6217eb5a166db73efff8e22b917805e3ea97c755b` | `024c3d55a3c23a107c9c19a8ea1d87c81a75b22817339188d6956c73e36d27b0` | 是 |
| `src/pages/UsagePage.tsx` | `501f74055b6e243a2115844a0b94ff71f1254d0c0e367902295de42f85677191` | `2e327c46877f82dba965d05a1560a04a9fc194c04042a3a53e448332e40ab6a0` | —（BASE 无此文件） |
| `src/types.ts` | `7b98db925905228dbe32cca2ad2fe8c52a56a6c06447e47307f6e0b4e57a82f1` | `94262fb670c47f6616f3329390e620bc3f1f09a20144d27c307013a2eeff4963` | 否 |
| `tsconfig.app.json` | `8e5d12ba330e7d86409edec74b95451e0db22ee09b9426c94b5bf817571eddb0` | `3d972e46410867dfc6dc480524dd319feb7ef01cd4ea77ce367e93097610ad77` | 是 |
| `tsconfig.json` | `770b4140bbb581e2dfd9ea9946ffc9c75a1d86ba7d2db5f77c83e37cbdf9d808` | `91434fd9d32940ba5f1347be26f2c7ff676e7c1e203dba03e9986d71915755ff` | 是 |
| `tsconfig.node.json` | `d366cc0827139db39c61815f22491bbfda56c654354a42ad7795143d314e45e8` | `afc4620f8c23f3cd5dda3726408cf705438a054db22ccf0e09ff73eacef601ab` | 是 |
| `vite.config.ts` | `e83490611bc8ad4ebaa33784ebe4f97162bda2a27f300978fde989be04f98321` | `cfb852aedcaeaf7f0790bc2be6426fe4e3e288262039ad45a14ba9b37ca12ef0` | 否 |

### 8.6 release 链与本地各提交的逐字节重合文件数（分叉点定位）

| release | 文件条目 | 662a504 | 2b96f37 | **eb5a026** | 7e1c8ce | 281c30e(HEAD) |
| --- | --- | --- | --- | --- | --- | --- |
| `20260831T195446Z-low-latency-v2` | 296 | 22 | 161 | 158 | 154 | 152 |
| `20260901T155553Z-antigravity-monitor` | 323 | 22 | 164 | 161 | 157 | 155 |
| `20260902T0530Z-console-fixes` | 276 | 22 | 184 | 181 | 177 | 175 |
| `20260902T0620Z-console-final` | 276 | 22 | 186 | 183 | 179 | 177 |
| `20260902T0640Z-console-stats-ui` | 276 | 22 | 186 | 183 | 179 | 177 |
| `20260902T0710Z-console-coherent` | 276 | 22 | 186 | 183 | 179 | 177 |
| `20260902T0735Z-console-ui-dropdown-cost` | 276 | 22 | 187 | 184 | 179 | 177 |
| `20260907T0400Z-console-channel-access` | 276 | 22 | 187 | 184 | 179 | 177 |
| `20260907T1110Z-console-channel-access-fix` | 276 | 22 | 187 | 184 | 179 | 177 |
| `20260907T1400Z-console-strict-channel-pools` | 276 | 22 | 187 | 184 | 179 | 177 |
| `20260909T120000Z-console-omp-classification` | 293 | 22 | 197 | 194 | 189 | 187 |
| `20260910-native-search` | 312 | 22 | 208 | 205 | 199 | 197 |
| `20260923-approx-model-pricing` | 312 | 22 | 211 | 208 | 201 | 199 |
| `20260923-claude-banked-reset` | 316 | 22 | 216 | 213 | 206 | 204 |
| `20260923-display-billing-price` | 312 | 22 | 209 | 206 | 199 | 197 |
| `20260923-gateway-price-follow` | 312 | 22 | 207 | 204 | 198 | 196 |
| `20260923-quota-hint-truth` | 315 | 22 | 213 | 210 | 203 | 201 |
| `20260924-ms-query-rollup-opt` | 270 | 20 | 215 | 212 | 206 | 206 |
| `20260925-crapi-docs-btn-compact` | 292 | 22 | 235 | 230 | 218 | 215 |
| `20260925-oauth-login-version-monitor` | 291 | 23 | 236 | 224 | 215 | 212 |
| `20260925-oauth-modes-ui-refine` | 292 | 22 | 230 | 233 | 219 | 216 |
| `20260925-official-oauth-page-aligned` | 295 | 22 | 228 | 241 | 224 | 221 |
| `20260926-default-open-gpt-image` | 295 | 22 | 224 | 236 | 219 | 216 |
| `20260926-fix-failing-tests-upload-guard` | 295 | 22 | 219 | 229 | 213 | 210 |
| `20260928-reset-clears-cooldown` | 299 | 22 | 218 | 226 | 212 | 209 |

> `eb5a026`（本地 2026-09-26「对齐 CPA 官方 OAuth 面板」）在 release `20260925-official-oauth-page-aligned` 处取到最大值 241/295，即本地仓库的**导入点**；此后生产又发了 3 个 release（`20260926-default-open-gpt-image`、`20260926-fix-failing-tests-upload-guard`、`20260928-reset-clears-cooldown`），本地则走了 Magpie/RTK/Vue 方向。
