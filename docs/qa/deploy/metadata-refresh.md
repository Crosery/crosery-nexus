# task-19：仓库根发布元数据刷新（MANIFEST.sha256 / RELEASE.json）

- **日期**：2026-10-01 ｜ **执行**：deploy-reconciler ｜ **状态**：完成（两个根文件已刷新并校验）
- **依据**：`deploy/edge/README.md:44` ——「`RELEASE.json` records the change set of the release it sits in; **keep it and `MANIFEST.sha256` in step with the tree**」
- **触发原因**：`e52617a`（blue-ui 删除 25 个 React 死文件）+ `fabd4fe`（Lead 删除 `src/App.css`、`server/pageMotionVisibility.test.ts`）之后，根目录那两份元数据与代码树脱节（详 §3）
- **零生产写入**：未连生产执行任何命令；不执行 runbook §1–§4

## 0. 摘要

| 项 | 结果 |
| --- | --- |
| `MANIFEST.sha256` | 由 **295 行（生产 release 清单的旧拷贝）** 重写为 **310 行（本仓库工作树清单）**；生成器 [refresh-root-metadata.mjs](<docs/qa/deploy/refresh-root-metadata.mjs>) |
| 校验 | `shasum -a 256 -c MANIFEST.sha256` → **310/310 OK、0 FAILED**（构建后复跑仍全通过，证明清单与生成物解耦） |
| `RELEASE.json` | 重写为「本地工作树」元数据；**保留 `releaseId`=`local-working-tree-20261001`、`createdAt`**（`server/cpa.ts:510-524` 读它俩做 Console 版本显示）；`changes` 里**已无任何被删 `.tsx` 路径引用** |
| 三项命令 | `npx tsc -b` **0 错误**；`npm test` **exit=0｜546 tests / 536 pass / 0 fail / 10 skipped**；`npm run build` **绿**（skip 差异见 §7） |
| 草稿同步 | `docs/qa/deploy/` 的 release 侧草稿**已一并刷新**（发布源 `26554bd` → `fabd4fe`），见 §6 |

---

## 1. 清单规则（生成器内置，逐条给理由）

**文件来源**：`git ls-files -z`（受版本控制的文件 = 一次干净检出会有的文件）。工作区里已删除但仍在索引里的条目会被跳过并列出（本次 **0 条**）。
**格式**：`<sha256>  ./<相对路径>`，按路径 `LC_ALL=C` 升序，末尾单个换行（与历史格式一致）。

| 排除项 | 理由 |
| --- | --- |
| `docs/qa/**` | 本轮 QA 交付物/证据（含截图与日志），不属于应用树；release 组装同样排除 |
| `.env`、`.env.*`（**放行 `.env.example`**） | 本地密钥绝不进清单；`.env.example` 是模板，保留 |
| `MANIFEST.sha256` | 自身，无法自引用 |
| `.DS_Store`、`._.DS_Store` | macOS 噪音（旧清单里正是有 `./.DS_Store` 才被点名） |
| `.git/**`、`node_modules/**`、`dist/**`、`build/**`、`.cache/**`、`*.tsbuildinfo`、`data/**` | VCS 元数据 / 依赖 / 构建产物 / 增量缓存 / 本地运行态（`data/console.db` 是本地 SQLite，绝不能进清单）。它们本就不在 `git ls-files` 里，列出是为了把规则写全 |
| **未跟踪文件** | 不入清单（干净检出不会有它们）：本地存在的 `public/tuffex-dashboard-preview.png`、`.pi-subagents/**`（agent 抓取物）因此都不在清单内 |

### 与「历史形状」的差异（以 assembly 规则为准）

刷新前那份 **295 行**清单**不是本仓库的清单**，而是 2026-09-25 开源导入时从**生产 release 目录**整体拷来的：它含 `dist/**`（49 条生产 React 构建产物）、`build/**`（2 条）、`./.DS_Store` 与 `./src/.DS_Store`，以及 **65 条当时就不存在于本仓库的路径**。本次产出的是**本仓库工作树**的清单，因此：
- 新增 **排除**：`dist/**`、`build/**`、`.cache/**`、`*.tsbuildinfo`、`docs/qa/**`、`data/**`、`.DS_Store` 系列、`.env` 系列、未跟踪文件；
- **不再**包含任何生产构建产物的路径；
- 内容上改为「本地这份」语义（见 §4）。

---

## 2. 校验证据

### 2.1 `shasum -a 256 -c MANIFEST.sha256`（仓库根执行）

```
$ shasum -a 256 -c MANIFEST.sha256
./.env.example: OK
./.gitignore: OK
./.oxlintrc.json: OK
./LICENSE: OK
./README.md: OK
…
./tsconfig.server.json: OK
./uno.config.ts: OK
./vite.config.ts: OK
# 汇总：310 行 → OK=310，FAILED=0（exit=0）
```

完整 310 行输出已存档：[evidence/root-manifest-shasum-check.txt](<docs/qa/deploy/evidence/root-manifest-shasum-check.txt>)。

**构建后复检**（先 `npm run build` 再 `shasum -c`）：仍 **310/310 OK** —— 说明清单与 `dist/**` 解耦，重新构建不会让清单失效。

### 2.2 `RELEASE.json` 合法性 + 必填字段

```console
$ node -e "const r=JSON.parse(require('fs').readFileSync('RELEASE.json','utf8'));console.log(Object.keys(r).join(', '))"
releaseId, createdAt, baseline, sourceRepository, source, baseRelease, changes, provenance

$ node -e "… console.log(r.releaseId, r.createdAt)"
local-working-tree-20261001 2026-10-01T01:54:00.106Z
```

- `releaseId` / `createdAt` **均为字符串且存在**；`createdAt` 可被 `Date.parse` 解析（`Z` 结尾的 UTC ISO），`VersionWidget.vue:293` 的 `new Date(...).toLocaleString('zh-CN')` 不会显示 `Invalid Date`。
- 消费者清单：`server/cpa.ts:510-524`（读 `releaseId`→`releaseId`、`createdAt`→`releaseDate`，并缓存进 `ConsoleVersionInfo`）；`src/types.ts:143-144`；`src/components/VersionWidget.vue:291-293`。**无任何消费者读 `baseRelease`/`changes`/`baseline`**（`grep -rn baseRelease` 仅命中我的组装脚本），因此这些字段可以安全改写为本地语义。
- `changes` 全量扫描：**0 处**指向已删 `.tsx` 的路径（仅有一句中文说明「React 死树已于 e52617a / fabd4fe 移除」，不含路径）。

---

## 3. 新旧清单差异（295 → 310）

| 维度 | 结果 |
| --- | --- |
| 旧有新无 | **80 条** = `dist/` 49 + `src/` 27 + `build/` 2 + `server/` 1（`pageMotionVisibility.test.ts`）+ 根文件 1（`.DS_Store`）；其中 **65 条确实已不存在于工作树**，其余 15 条是「存在但按新规则排除」（`dist/**`、`build/**`） |
| 新有旧无 | **95 条** = `src/` 48 + `server/` 19 + `scripts/` 15 + `deploy/` 9 + `packages/` 2 + `docs/` 1 + 根文件 1（都是"旧清单拷贝自生产、缺本地新增文件"造成的） |
| 两边都有但哈希不同 | **42 条** = `server/` 31 + 根文件 8 + `src/` 3 |

关键事实核对（旧清单的 27 条 `.tsx` 正是被点名的问题）：

```console
$ 旧清单 .tsx 条目 27 → 已不存在 25；仍存在 2 = ['src/docs-entry.tsx', 'src/docs.tsx']   # 这两个仍在构建图内，保留
$ src/App.css 存在? False    server/pageMotionVisibility.test.ts 存在? False             # 均已删除
$ 旧清单 .DS_Store 条目: ['.DS_Store', 'src/.DS_Store']                                   # 新清单已排除
```

---

## 4. 本地这份 ≠ 生产 release 目录里那份（务必别混）

| | **仓库根 `RELEASE.json` / `MANIFEST.sha256`（本次刷新）** | **生产 release 目录里的同名文件** |
| --- | --- | --- |
| 位置 | `<repo>/RELEASE.json`、`<repo>/MANIFEST.sha256` | `/opt/crosery-api-console-releases/<release-id>/{RELEASE.json,MANIFEST.sha256}`，当前由 `/opt/crosery-api-console-current` 指向 |
| 描述对象 | **本地工作树**（`releaseId` = `local-working-tree-20261001`） | 那一个 **release** 的内容（例如 `20260928-reset-clears-cooldown`，`sourceRepository` = `/opt/crosery-api-console`） |
| 覆盖范围 | 受版本控制的文件，排除生成物/QA/密钥（§1） | 该 release 目录内的全部文件，除 `node_modules/**`、`.DS_Store`、`MANIFEST.sha256` 自身（**含 `dist/**` 与 `.cache/*.tsbuildinfo`**） |
| 谁生成 | 本轮的 [refresh-root-metadata.mjs](<docs/qa/deploy/refresh-root-metadata.mjs>) | 发布时由 [assemble-release.mjs](<docs/qa/deploy/assemble-release.mjs>) 按 `deploy/edge/README.md:37-44`「复制当前 release 再叠加」生成 |
| 发布时会不会被用上 | **会被覆盖**：组装脚本把本地这两个文件叠加进 release 后，**重新生成** release 内的 `RELEASE.json`/`MANIFEST.sha256`（见 release-plan §4.2/§4.3） | 是最终生效的那份，切换 symlink 前用 `sha256sum -c` 校验 |

> 一句话：**根目录这份是"工作树自述"**，用来满足 README:44 的「与代码树同步」；**release 目录那份才是发布事实**。release-plan.md §4.2/§4.3 已经把两者的生成规则分开写清。

---

## 5. 本轮踩到并修掉的两个工具 bug（诚实记录）

| # | 症状 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 首跑把 `MANIFEST.sha256`/`RELEASE.json` 写进了 **`docs/`**（并使清单只剩 `qa/**`+`research/`） | 脚本用 `path.resolve(dirname(import.meta.url), '../..')` 算根目录，少了一层（`docs/qa/deploy` → `docs`） | 立即删除两个误建文件（确认它们此前不存在，根文件未被覆盖）；改为 `git rev-parse --show-toplevel` 判定，并加**安全断言**：根目录必须含 `package.json`/`server/index.ts`/`src`/`vite.config.ts`，且 basename 不得是 `docs`/`deploy` |
| 2 | 修正根目录后，**73 个中文名文件**被误判为「索引里已删除」而跳过 | `git ls-files` 默认对非 ASCII 路径做引号转义（`"docs/qa/ab/shots/00-lab-\345\205\245\345\217\243.png"`），既匹配不上排除规则也 `existsSync` 不到 | 改用 `git ls-files -z`（NUL 分隔、不转义）；重跑后「已跳过」归零，`docs/qa/**` 正确排除 195 条 |

补充：生成顺序也是坑——**必须先写 `RELEASE.json` 再生成 `MANIFEST.sha256`**，否则清单里记的是上一版 `RELEASE.json` 的哈希、当场 `shasum -c` 失败（与 task-15 演练发现的同一个坑，已在脚本注释里写明）。

---

## 6. `docs/qa/deploy/` 草稿同步结论：**需要，已一并刷新**

- **必须刷新的理由**：`release-plan.md` 的「发布源」与逐文件哈希基于 `26554bd`；此后 HEAD 推进到 `fabd4fe`（含 27 个死树文件删除 + 我 task-18 的 22 个测试文件改动），清单已过期。
- **已做的刷新**：
  1. 干净克隆当前 HEAD（`fabd4fe`）→ `npm run build` → 重跑 `assemble-release.mjs` 两种模式；
  2. `evidence/{assembly-report-vue.md, assembly-report-keep-prod.md, RELEASE.draft-vue.json, MANIFEST.draft-vue.sha256}` 全部覆盖为 `fabd4fe` 版本；
  3. `release-plan.md`：发布源改为 `fabd4fe`，数字更新为 **vue 416 文件 / 7.10 MB / MANIFEST 413 / dist 74（树哈希 `5b69bbf7…`）**、**keep-prod 342 / 5.88 MB / 339 / 生产 dist 49**；非 dist 变更 **115 → 131**（replace 36 / add 95）；表 A 整体重生成；新增 §3.0「`26554bd` → `fabd4fe`」delta 表。
- **两模式仍 PASS、缺失生产文件 0**，V3 仍是同一对已知 WARN；`vite manifest` 里 `.tsx` 条目已为 **0**（死树清理完成的旁证）。
- **注意**：草稿里的 release 侧 `MANIFEST.sha256`（413 条）与根目录这份（310 条）**规则不同、对象不同**（§4），不要互相覆盖。

---

## 7. 三项命令（本轮实跑）

| 命令 | 结果 |
| --- | --- |
| `npx tsc -b --pretty false` | **exit=0（0 错误）** |
| `npm test` | **exit=0 ｜ ℹ tests 546 ｜ ℹ pass 536 ｜ ℹ fail 0 ｜ ℹ skipped 10** |
| `npm run build` | **exit=0**（`✓ built in 592ms`） |

### 7.1 为什么本轮是 `10 skipped`（**显式说明：这不是"测试被删除"**）

`npm test` 的 skip 数会随**运行环境**变化，与本轮改动无关。对照如下：

| 运行方式 | tests | pass | fail | skipped | 说明 |
| --- | --- | --- | --- | --- | --- |
| Lead 基线（真实 HOME） | 546 | **545** | 0 | **1** | 唯一 skip = 需要 pinned 内核二进制的 `real headless kernel … # Run npm run test:magpie:kernel with the pinned kernel binary` |
| 本轮（`HOME=/tmp/cac-deploy-recon/fakehome` 隔离 + 独立 `DATA_DIR`） | 546 | **536** | 0 | **10** | **总数一样（546）**，多出的 9 个 skip 全部是 RTK **CLI 集成**用例 |
| 本轮补充对照（真实 HOME，单文件） | — | **45** | 0 | **0** | `node --test --import tsx server/rtkService.test.ts` → 45 pass / 0 skip（证明那 9 个用例存在且能跑） |

- 多出的 9 个 skip（用例名见 `evidence/test-datadir-run*.txt` 的 `﹣ … # SKIP` 行）都是需要**真实 `rtk` 二进制 / 真实 agent 配置目录**的集成用例：`T5/T10 本机开关`、`T8 关得掉`、`T10 agent 覆盖矩阵`、`T11 字段一致性`、`本机检测：注册表覆盖 rtk init --help`、`红队 ⑥ 宽并发`、以及三条 `缺陷 1 …` 回归用例。它们在**临时 HOME** 下按设计自跳过（找不到用户级 agent 配置），**不是被删除或失败**。
- 我把 `HOME` 指向临时目录，是为了满足「测试不得读写真实 `~/.codex` / `~/.claude`」的纪律；**代价就是这些集成用例在本轮被 skip**。验收/发布时若需要这 9 个用例真跑，请在真实 HOME 下跑 `npm test`（或单独 `server/rtkService.test.ts`），预期回到 `545 pass / 1 skipped`。
- 与 task-18 的数字一致（当时 547/537/0/10；总数少 1 是因为 `fabd4fe` 删掉了 `server/pageMotionVisibility.test.ts`）。

---

## 8. 未验证 / 限制

1. **干净检出的可校验性**：清单描述的是**当前工作树**。本次刷新的两个根文件在提交前，`git archive HEAD` 出来的树**不满足** `shasum -c`（因为 `RELEASE.json` 内容不同）——这符合"工作树自述"的语义，但**提交时必须把 `MANIFEST.sha256` 与 `RELEASE.json` 一起提交**，之后任一干净检出都能通过校验。
2. **未纳入未跟踪文件**：`public/tuffex-dashboard-preview.png`（本地存在、未跟踪）与 `.pi-subagents/**`（agent 抓取物）都不在清单里，理由见 §1；如果团队希望它们进清单，需要先决定它们是否属于仓库内容。
3. **`data/**` 未做任何校验**（本地 SQLite/WAL 与凭据）：按规则排除，未读取、未哈希。
4. **生产侧 release 的元数据未被触碰**（零写入）；生产那份 `RELEASE.json` 是否与它自己的树一致，属 task-6 的范畴（结论：一致，MANIFEST 逐条通过）。
