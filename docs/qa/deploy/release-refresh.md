# task-18：发布方案刷新（A）＋ 测试夹具 DATA_DIR 隔离（B）

- **日期**：2026-10-01 ｜ **执行**：deploy-reconciler ｜ **状态**：A 完成（刷新到 HEAD `26554bd`）；B **已落地**（3× 并行 `npm test` 全绿 + 对照组复现旧 flake）
- **零生产写入**：本轮未连生产执行任何步骤；不执行 runbook §1–§4（等前端 A/B 拍板与 Lead 放行）
- 配套：[release-plan.md](<docs/qa/deploy/release-plan.md>)（已刷新）、[release-runbook.md](<docs/qa/deploy/release-runbook.md>)（未变更）、[assemble-release.mjs](<docs/qa/deploy/assemble-release.mjs>)（未变更）

---

## 0. 摘要

| 项 | 结果 |
| --- | --- |
| **发布源** | **`26554bd`**（本地 HEAD）= `docs(qa): record the RTK round-3 adversarial verification`；其**代码内容**等价于 `9e78045`（最后一个非 docs 提交），`docs/qa/**` 被组装脚本排除 |
| A：两模式校验 | **都 PASS、0 个生产文件缺失**；vue = 415 文件 / 7.09 MB / MANIFEST 412 / dist 74（树哈希 `3419fe9f…`）；keep-prod = 341 / 5.87 MB / 338 / 沿用生产 dist 49（`655bec5e…` 不变） |
| A：delta | **文件集合零增减**（115 个非 dist 文件、21 replace + 94 add 不变），**16 个文件内容位移**（见 §A4） |
| A：新出现的校验失败 | **无**。V1 缺失 0；V2/V4/V5 通过；V3 仍是同一对已知 WARN（本地 Node v26.7.0 vs 生产 v24.20.0） |
| B：修法 | 新增 [`server/testDataDir.ts`](<server/testDataDir.ts>)，22 个测试文件各加**一行** `import './testDataDir.js'`（放在首行，利用 ESM 求值顺序） |
| B：实测 | **并行 3 次 `npm test` 全部 exit=0 / 547 tests / 537 pass / fail=0 / skipped=10**，无 `database is locked`；对照组（`CROSERY_TEST_DATA_DIR_SHARED=1` 退回旧行为）2 次里 **1 次复现 `database is locked`** |
| B：避让 | 三个禁改文件**一行未动**；本次对照组里出现的 3 个守卫红项已归因到 **blue-ui 的在途编辑**（干净克隆同文件全绿），与本改动无关（见 §B4） |

---

## A. 发布方案刷新

### A1. 「发布源」的定义与复核

- **定义**：发布源 = **组装那一刻** `git rev-parse HEAD` 指向的提交。本次 = `26554bd`。
- 目录里所有“草稿哈希/清单”都是相对这个提交的；上机前必须复核：
  ```bash
  cd <repo> && git rev-parse HEAD          # 必须是 26554bd…（或按 §A2 重新组装）
  git status --porcelain                   # 必须为空（组装脚本默认拒绝脏工作区）
  ```
- 若 HEAD 已推进：**重跑 §A2 的两条组装命令**，不要直接用旧草稿（上一版草稿就是因此过期的）。

### A2. 刷新命令（本地，临时目录，零生产）

```bash
# 1) 干净检出当前 HEAD（避免把他人未提交改动打进 release），复用工作区 node_modules 构建 dist
git clone --no-hardlinks <repo> /tmp/cac-deploy-recon/clean-repo
ln -sfn <repo>/node_modules /tmp/cac-deploy-recon/clean-repo/node_modules
cd /tmp/cac-deploy-recon/clean-repo && npm run build         # tsc -b && vite build（取 /tmp/cac-build.lock）

# 2) 两种模式各组装一次并校验（生产 release 只读快照见 task-15 §6.1）
node docs/qa/deploy/assemble-release.mjs --prod-snapshot=<BASE快照> --repo=/tmp/cac-deploy-recon/clean-repo \
  --dist-from=/tmp/cac-deploy-recon/clean-repo/dist --out=/tmp/cac-deploy-recon/release-20261001-tuffex-rtk \
  --release-id=20261001-tuffex-rtk --frontend=vue --expect-node=v24.20.0
node docs/qa/deploy/assemble-release.mjs --prod-snapshot=<BASE快照> --repo=/tmp/cac-deploy-recon/clean-repo \
  --out=/tmp/cac-deploy-recon/release-keep-react --release-id=20261001-server-only \
  --frontend=keep-prod --expect-node=v24.20.0
```

### A3. 输出（原样，发布源 `26554bd`）

```
releaseId: 20261001-tuffex-rtk | mode: vue | HEAD: 26554bd
文件 415 个 / 7.09 MB | MANIFEST 412 条 | dist 74 个 (tree 3419fe9f14af2d93…)
本地动作: replace=21 keep-prod=221 add=94
V1 缺失生产文件: 0 | 预期缺失: 5 | 替换: 24 | 新增: 95
V3 node: local=v26.7.0 prod=v24.20.0 engines=>=24 <25 -> WARN
结果: PASS（含 2 条警告）
```

```
releaseId: 20261001-server-only | mode: keep-prod | HEAD: 26554bd
文件 341 个 / 5.87 MB | MANIFEST 338 条 | dist 49 个 (tree 655bec5e91a5acc6…)
本地动作: replace=11 keep-prod=180 add=45
V1 缺失生产文件: 0 | 预期缺失: 5 | 替换: 11 | 新增: 46
V3 node: local=v26.7.0 prod=v24.20.0 engines=>=24 <25 -> WARN
结果: PASS（含 2 条警告）
```

### A4. 相对上一版草稿的 delta（`0e27b9e` → `26554bd`，共 16 个文件）

**文件集合没有任何增减**：两版都是 115 个非 dist 文件、21 replace + 94 add、keep-prod=221。变的只有**内容与来源 commit**：

| 文件 | 动作 | 上一版 sha256 | 新版 sha256 | 变更 | 新来源 commit |
| --- | --- | --- | --- | --- | --- |
| `server/rtkService.test.ts` | add | `6e483564af47b649…` | `d52fad22169bc5ca…` | 内容更新 | `9e78045` |
| `server/rtkService.ts` | add | `2d05ed259fd7a2ac…` | `2d1d039ab9437e59…` | 内容更新 | `9e78045` |
| `src/components/ErrorPanel.vue` | add | `983c25e2ab16fbd0…` | `c87697151c57124e…` | 内容更新 | `e0ac1ec` |
| `src/components/RtkBoard.vue` | add | `c16b4ab881c07bfe…` | `3ac36bab330ef08e…` | 内容更新 | `9e78045` |
| `src/pages/AnalyticsPage.vue` | add | `d5f4de969d129b04…` | `c1b286acd95efafa…` | 内容更新 | `e0ac1ec` |
| `src/pages/CachePage.vue` | add | `6b02c180bef9b989…` | `b1ef27b19217f74f…` | 内容更新 | `e0ac1ec` |
| `src/pages/ChannelsPage.vue` | add | `c0facf966c98944b…` | `49c23e73d2683fd1…` | 内容更新 | `e0ac1ec` |
| `src/pages/ChartsPage.vue` | add | `d451e34704e712de…` | `75f72618696242c7…` | 内容更新 | `e0ac1ec` |
| `src/pages/DashboardPage.vue` | add | `bd759422058fa870…` | `ea3d4f37811a0c63…` | 内容更新 | `e0ac1ec` |
| `src/pages/KeysPage.vue` | add | `c1f63e004d51f990…` | `33644af6b3f697e2…` | 内容更新 | `e0ac1ec` |
| `src/pages/ModelsPage.vue` | add | `6b79ccd08d4a3d46…` | `8c332cae0a7c1681…` | 内容更新 | `e0ac1ec` |
| `src/pages/MonitorPage.vue` | add | `5c5976d7bbf6a7a9…` | `9319809044fa1780…` | 内容更新 | `e0ac1ec` |
| `src/pages/OAuthPage.vue` | add | `3e989763a3d8c603…` | `c106c0be5395af24…` | 内容更新 | `e0ac1ec` |
| `src/pages/RtkPage.vue` | add | `8383fe251cbe0697…` | `3a214a0a504422aa…` | 内容更新 | `3118990` |
| `src/pages/UsagePage.vue` | add | `4df05baf5629f5a9…` | `e3e8b7bb1a2442d2…` | 内容更新 | `e0ac1ec` |
| `src/types.ts` | replace | `887b6781c04ee8a0…` | `2ee08a2ce25c436e…` | 内容更新 | `9e78045` |

配套产物变化：`dist` 树哈希 `e38301a4…` → **`3419fe9f…`**；`keep-prod` 模式不重建 dist，故其树哈希 `655bec5e…` 不变。
对应提交：`e0ac1ec`（/models 分页排序筛选、同步确认、陈旧数据横幅、OAuth 轮询上限）、`3118990` + `9e78045`（RTK 备份保护与串行闸）、`26554bd`（仅 docs，不入 release）。

### A5. 是否有**新出现**的校验失败？——没有

| 校验 | 上一版（`0e27b9e`） | 本次（`26554bd`） | 说明 |
| --- | --- | --- | --- |
| V1 不缺失生产文件 | PASS（缺失 0） | **PASS（缺失 0）** | 预期缺失仍是 5 项（`.cache/*.tsbuildinfo` ×3 + AppleDouble ×2） |
| V2 dist 与源码一致 | PASS | **PASS** | dist 比源码新；入口引用完整；vite manifest 含 `index.html` 与 .vue 页面 |
| V3 Node 版本 | WARN ×2 | **WARN ×2（未变）** | 本地 v26.7.0 vs 生产 v24.20.0；等级仍 P2（release-plan §7.2） |
| V4 MANIFEST 自洽 | PASS | **PASS** | 逐条重算 |
| V5 禁运清单 | PASS | **PASS** | `docs/qa/**`、`.env`、`data/**`、`node_modules/**`、`*.log`、`*.tar.gz` 均未进入 |

**没有放宽任何校验规则**；本轮只更新输入（新的 HEAD 与新的 dist），校验逻辑一字未改。

### A6. evidence 刷新清单

| 文件 | 内容 |
| --- | --- |
| `evidence/assembly-report-vue.md` | vue 模式完整报告（412 条目 MANIFEST 草稿 + 逐文件动作表） |
| `evidence/assembly-report-keep-prod.md` | keep-prod 模式完整报告 |
| `evidence/RELEASE.draft-vue.json` | 草稿 `RELEASE.json`（`localHead = 26554bd…`） |
| `evidence/MANIFEST.draft-vue.sha256` | 草稿 MANIFEST（412 条，含 dist 74） |
| `evidence/test-datadir-run{1,2,3}.txt` | B 的三次全绿日志（含 node --test 官方汇总） |

### A7. 刷新期发现的**新问题**（不是本任务引入，也不是校验失败）

1. **React 死树正在被删除（25 个文件，已被他人暂存）**
   - 现象：`git status --short` 出现 `D  src/App.tsx`、`D  src/main.tsx`、`src/components/*.tsx` ×11、`src/pages/*.tsx` ×13（共 25 项，删除已在**暂存区**，不是我的改动；我的文件一个都不在暂存区）。
   - 对本次刷新**无影响**：我的组装基于**干净克隆的 HEAD `26554bd`**，该提交仍跟踪这些文件，因此 §A3/§A4 的清单与哈希对 `26554bd` 有效。
   - 对**下一次刷新**有影响：组装脚本「只叠加、不删除」，这 25 个文件会以 **BASE 版本**留在 release 里。其中 **21 个与生产逐字节相同**，**4 个本地曾改过**（`src/App.tsx`、`src/components/VersionWidget.tsx`、`src/pages/DashboardPage.tsx`、`src/pages/ModelsPage.tsx`）→ 这 4 个会从表 A 的 `replace` 变成保留 BASE 版，非 dist 变更 **115 → 111**。详见 [release-plan.md](<docs/qa/deploy/release-plan.md>) §4.4（含两种处置方案）。
   - 已核对：`git diff --cached --name-only | grep -c 'server/\|docs/qa/deploy'` = **0**，即暂存区里没有我的任何文件；本轮我**未触碰**这些删除。
2. **`src/**` 的活代码仍是 Vue**：删除的 25 个 `.tsx` 都不在 vite 构建图里（`index.html` → `src/main.ts`），因此删除**不影响 `dist`**，也不影响 `--frontend=vue` 的产物；`--frontend=keep-prod` 用的是 BASE 里的 React 源与 dist，同样不受影响。

---

## B. 测试夹具 DATA_DIR 隔离（已落地）

### B1. 问题与根因

- 现象：`npm test` 偶发 `Error: database is locked`（`ERR_SQLITE_ERROR` errcode 5，`server/db.ts:14`）。task-8 的收尾里 3 次全量跑出现过 1 次。
- 根因：`node --test` **并行跑多个测试文件（每文件一进程）**，而这些进程默认共享同一个 `DATA_DIR`（未设置时是仓库 `./data`）→ 多进程同时打开同一个 SQLite，默认 `busy_timeout=0` → 直接 `SQLITE_BUSY`。
- 静态盘点（按 import 图传递闭包）：**22 个测试文件会触碰 `server/db.ts` 却没有设置 `DATA_DIR`**；另有 3 个自行设置（`keyPoolReconcile`/`managementDegrade`/`syncScheduler`），49 个不触碰 db。

### B2. 修法（最小改动）

1. 新增 [`server/testDataDir.ts`](<server/testDataDir.ts>)：模块求值时即 `mkdtempSync` 出**每进程独占**的临时目录并写入 `process.env.DATA_DIR`；进程退出时尽力删除（`CROSERY_TEST_KEEP_DATA_DIR=1` 可保留现场）。
2. 在 22 个受影响测试文件的**第一行**加一条副作用 import：
   ```ts
   import './testDataDir.js'

   import assert from 'node:assert/strict'
   …（原有 import 不动）
   ```
   **为什么必须在第一行**：ESM 按 import 声明顺序求值，先求值本模块才能让 `config.ts`（进而 `db.ts`）读到新的 `DATA_DIR`；若它排在 `./db.js` 之后，`config.dataDir` 已经绑定到旧路径，设置就晚了。
3. **不改** `server/db.ts` 的运行时语义（本轮一行未动）。

### B3. 实测（并行 3 次 + 对照组）

**修后：并行 3 次 `npm test`（每次仍显式传入一个共享 `DATA_DIR`，即原触发条件）**

| 运行 | 退出码 | tests | pass | fail | skipped | `database is locked` |
| --- | --- | --- | --- | --- | --- | --- |
| run1 | **0** | 547 | 537 | **0** | 10 | 无 |
| run2 | **0** | 547 | 537 | **0** | 10 | 无 |
| run3 | **0** | 547 | 537 | **0** | 10 | 无 |

日志：`evidence/test-datadir-run{1,2,3}.txt`。

**对照组：`CROSERY_TEST_DATA_DIR_SHARED=1`（退回旧行为，共享 DATA_DIR）**

| 运行 | 退出码 | fail | `database is locked` |
| --- | --- | --- | --- |
| old-run1 | 1 | 3（见 §B4，全部为 blue-ui 在途编辑造成） | 0 |
| old-run2 | 1 | 4（其中 1 个 = `✖ server/magpieOAuth.test.ts` 的 locked 失败） | **2** |

→ 旧行为在 2 次里复现了 1 次锁定失败；修后 3 次 0 失败、0 锁定。

**机制演示 + 清理**

```console
$ DATA_DIR=/tmp/demo-shared node --import tsx -e "const m=await import('./server/testDataDir.js'); console.log(process.env.DATA_DIR)"
/var/folders/…/T/crosery-test-22553-1DtU0j          # 默认：每进程独占（含 pid）
$ DATA_DIR=/tmp/demo-shared CROSERY_TEST_DATA_DIR_SHARED=1 node --import tsx -e "…"
/tmp/demo-shared                                     # 显式退回旧行为（用于复现/对照）
$ ls -d /tmp/crosery-test-* | wc -l
0                                                    # 退出清理生效，无临时目录残留
```

**质量门**：`npm run lint` exit=0（仅既存 2 条 `nativeResponses.ts` warning）；`npx tsc -b` **0 错误**。

### B4. 与 blue-ui 的避让（未触碰三个禁改文件）

- `git status --short` 证据：`server/analyticsNavigationFallback.test.ts`、`server/reportPageFrontend.test.ts`、`server/reportRouteWiring.test.ts` **不在我的改动列表中**（我的改动 = 22 个其它 `server/*.test.ts` + 新增 `server/testDataDir.ts`）。
- 本轮**不需要**动这三个文件：按 import 传递闭包，它们不触碰 `server/db.ts`（只 import node 内置模块），因此不参与这次锁定问题。
- **对照组里出现的 3 个守卫红项不是本改动造成的**（诚实归因）：
  - 红项：`charts 页真的请求 /api/charts 并把 trend 画出来（D3 回归守卫）`、`report 页面用专用 loader，竞态由 useResource 的序号守卫统一丢弃过期响应`、`请求明细页在 keyUsage 缺失时不解引用（活代码：AnalyticsPage.vue）`，全部属于 `server/analyticsNavigationFallback.test.ts` 与 `server/reportPageFrontend.test.ts`。
  - 归因实验：**干净克隆（HEAD `26554bd`，0 项改动）**里这两个文件 `exit=0 / fail=0`；同一时刻工作区版本 `analyticsNavigationFallback` `exit=1 / fail=2`——差异只能来自这两个文件的**未提交在途改动**（blue-ui），与 SHARED 开关和本改动无关（另一次工作区实测中 `reportPageFrontend` 已由 blue-ui 修好并转绿，说明现场在分钟级变化）。
- **预案（如果将来这三个文件也需要隔离）**：同一行 import，可直接应用；届时请由 Lead 串行安排，或把下面这段当补丁：
  ```diff
  --- a/server/reportRouteWiring.test.ts
  +++ b/server/reportRouteWiring.test.ts
  @@
  +import './testDataDir.js'
  +
   import assert from 'node:assert/strict'
  ```
  （`analyticsNavigationFallback.test.ts`、`reportPageFrontend.test.ts` 同理；**本轮未应用**。）

### B5. 回退与开关

- **回退**：删掉那 22 行 `import './testDataDir.js'` 与 `server/testDataDir.ts` 即可回到原状（无其它耦合）。
- **开关**：`CROSERY_TEST_DATA_DIR_SHARED=1` 退回旧的共享 `DATA_DIR` 行为（用于复现 flake 或排查依赖共享库的测试）；`CROSERY_TEST_KEEP_DATA_DIR=1` 保留临时目录便于看失败现场。

### B6. 未验证 / 已知限制

- 复现对照组只跑了 2 次（flake 概率约 1/3，2 次里复现 1 次），**不能**据此给出精确复现率。
- 仓库 `data/` 未被测试触碰一事：由「22 个文件全部改走独占临时目录 + 退出后 0 个临时目录残留」间接证明；**未**做 `data/` 内容的逐字节前后比对。
- 共享库依赖：若有测试**故意**依赖「同一 `DATA_DIR` 里由别的测试文件写入的数据」，本改动会暴露它——3 次全量跑未见此类失败。
