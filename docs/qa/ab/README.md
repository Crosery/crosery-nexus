# A/B 实验台与真实用户通道（task-5）

对象仓库：`/Users/crosery/work_file/crosery-api-console`（基线 `281c30e`）｜实例：<http://127.0.0.1:8791>
负责人：`ab-harness`｜可写范围：`src/pages/AbLabPage.vue`、`src/ab/**`、`server/abLab.ts`、`scripts/ab-report.mjs`、`docs/qa/ab/**`

---

## 1. 这是什么（给用户看的一段话）

用户原话是「要有真实用户参与」，同时又说「别问我」。因此这里不做问卷、不发通知、不打断任何人：

> **打开 <http://127.0.0.1:8791/ab>，选一个流程 → 按页面上的任务脚本做一遍 → 底部投一票（选 A / 选 B / 都不行 + 一句话理由）。随时来、随时走；不投也没关系，对照本身就能看。**

不需要讲解：使用说明、任务脚本、「好」的判定标准都写在 `/ab` 页面里，谁打开都能自己上手。

**实验对象（三个真实流程，读的是真实数据）**

| flow id | 流程 | A（迁移前） | B（迁移后） |
| --- | --- | --- | --- |
| `keys-access` | API Key 列表：筛选 / 搜索 / 删除确认 | `281c30e` 的 `KeysPage.vue` 冻结副本 | 当前真实 `KeysPage.vue` |
| `integration-rtk` | 接入与 RTK 配置 | `281c30e` 的 `OAuthPage.vue` 冻结副本（+ 冻结帮助页作文档面） | 当前真实 `OAuthPage.vue`（+ 当前帮助页作文档面） |
| `dashboard-overview` | 运行概览 Dashboard 首屏 | `281c30e` 的 `DashboardPage.vue` 冻结副本 | 当前真实 `DashboardPage.vue` |

**深链**（刷新保持、可分享、可单开一栏）：

```
/ab                                  默认：keys-access + 并排
/ab?flow=keys-access&v=a             A 单侧
/ab?flow=dashboard-overview&v=b      B 单侧
/ab?flow=integration-rtk&v=split     并排
/ab?flow=keys-access&v=a&full=1      收起说明，只看对照（「单侧打开」按钮用的就是这个）
```

参数名刻意避开 `q` / `status` / `page` / `days` / `keyId`：B 侧渲染的是真实页面，这些页面会把自身筛选写回 URL（TUF M6 模式），不能和实验台的参数抢名字。

---

## 2. 代码落点

| 文件 | 作用 |
| --- | --- |
| `src/pages/AbLabPage.vue` | 实验台页面（默认导出，可被懒加载）。顶部只读说明 + 深链；中部任务脚本 / 判定标准 / A-B 对照；底部投票。 |
| `src/ab/flows.ts` | 三个流程的任务脚本（可照着做）与判定标准（六项固定口径 + 审计出处）。 |
| `src/ab/registry.ts` | **唯一** import 变体组件的地方：A 侧 4 个冻结 `.vue`、B 侧真实页面。Phase 2 换 B 侧只改这里。 |
| `src/ab/labState.ts` | 深链解析/生成（纯函数）：`parseLabQuery` / `labLink`。 |
| `src/ab/preference.ts` | 投票的客户端契约（类型 + 提交前校验 + `submitPreference`）。权威校验在服务端。 |
| `src/ab/readOnlyGate.ts` | **只读闸门**（红队 R1 收口）：api 函数层 / fetch / XHR 三层拦写，唯一放行本页自己的投票；实现与验证见 `comparison.md` §7。 |
| `src/ab/variants/legacy/*.legacy.vue` | A 侧：`git show 281c30e:<path>` 的冻结页面副本（逐字，仅改 import 指向）。 |
| `server/abLab.ts` | `POST /api/ab/preference` 的实现与校验（独立文件，路由由 Lead 注册）。 |
| `scripts/ab-report.mjs` | 汇总命令：按流程统计 A/B 票数与理由摘要。 |

**接线已由 Lead 完成**：`src/router.ts`（`/ab` + 侧栏入口）、`server/index.ts`（`POST /api/ab/preference`）。

---

## 3. A 侧冻结副本是怎么产生的（可复现）

```bash
cd /Users/crosery/work_file/crosery-api-console
mkdir -p src/ab/variants/legacy
for p in KeysPage DashboardPage OAuthPage HelpPage; do
  git show 281c30e:src/pages/$p.vue > src/ab/variants/legacy/$p.legacy.vue
done
# 仅改 import 指向：'../api' → '../../../api'，'../types' → '../../../types'，'../gatewayStatus' → '../../../gatewayStatus'
```

**为什么只冻结页面、不冻结 `api.ts` / `types.ts` / `gatewayStatus.ts`**：一开始把这三个也冻结了，结果冻结副本里的
`import('../packages/contracts/magpie-upstream')`（`src/types.ts:111`）按新深度解析不到，直接让 `npm run build`
的 `tsc -b` 失败（Lead 于 08:33 报障）。改为指向活模块，并逐个核对了 A 侧真正用到的面：
10 个方法 `cancelOAuth / createRevealToken / deleteKey / getOAuthStatus / resetQuota / revealKey / startOAuth /
submitOAuthCallback / updateKey / updateQuota`，7 个类型 `ApiKeyItem / GatewayModelAccess / Group /
QuotaWindowState / DashboardData / OAuthStartResult / ModelIndexData`——都在活文件里，且 blue-rtk 对
`src/api.ts`、`src/types.ts` 只做追加。

**冻结的边界要说清**：A 侧被冻的是**页面组件**（视图与交互行为 = 基线快照），`api.ts` 的薄封装是活的。
因此「A 侧行为」在 blue-rtk 追加方法时不会被改动，但严格意义上 A 不是「整个 commit 的镜像」。

---

## 4. 偏好留痕：接口、校验与隐私边界

`POST /api/ab/preference`（`server/abLab.ts`）

```ts
export async function recordAbPreference(
  payload: unknown,
  context?: { userAgent?: string | null; admin?: boolean | null },
): Promise<{ ok: true; id: string }>
```

| 字段 | 规则 | 违反时 |
| --- | --- | --- |
| payload | 非 null 的非数组对象 | 400 |
| `flow` | `keys-access` / `integration-rtk` / `dashboard-overview` | 400 |
| `choice` | `a` / `b` / `neither` | 400 |
| `note` | 可选字符串；trim 后 ≤ 500 字；`choice === 'neither'` 时必须非空 | 400 |
| `blocker` | 可选字符串；trim 后 ≤ 300 字 | 400 |
| 其它键 | **一律丢弃**（从不透传） | 忽略 |

- `userAgent` / `admin` **只接受服务端 context**，请求体里同名键一律忽略 → 无法伪造。
- 长度上限在**脱敏之前**按原文判定：否则 `'x'.repeat(501)` 会先被「≥40 位长串」规则替换成 11 个字而绕过上限（自测踩到过，已修）。
- 自由文本先脱敏：私钥块 / JWT / `Bearer …` / `sk-`·`rk-`·`pk-` / `gsk_` / `AIza` / `gh[pousr]_` / `xox*` / ≥40 位长串 → `[已隐去疑似密钥]`，并置 `redacted: true`。
- 落盘：`config.dataDir/ab-preferences.jsonl`（默认 `data/ab-preferences.jsonl`），一行一条，权限 `0600`，追加写串行化。

记录形状：

```json
{"schema":1,"id":"abp_muosubtf_ca0c33b0","at":"2026-10-01T00:31:52.659Z","flow":"dashboard-overview",
 "choice":"neither","note":"页面把故障显示成健康 第二行 [已隐去疑似密钥] 应该被脱敏",
 "blocker":"[已隐去疑似密钥]","userAgent":"selftest/1.0","admin":true,"redacted":true}
```

**禁止记录**：密钥、密码、Prompt 内容。上面「其它键一律丢弃 + 服务端 context」的组合保证请求体里就算塞
`apiKey` / `password` / `prompt` 也不会落盘（已实测）。

## 5. 汇总命令

```bash
node scripts/ab-report.mjs                # 人类可读：每流程 A/B/都不行 票数 + 理由 + 卡点
node scripts/ab-report.mjs --json         # 机器可读
node scripts/ab-report.mjs --file /tmp/x.jsonl --limit 5
```

输出末尾固定带一句「样本量可能只有 1 人，不得外推」。文件不存在时不算错（exit 0），只提示还没人投票。

---

## 6. 判定标准从哪来

判定标准不是自创的，逐条挂在红队审计 `docs/qa/red-team/ui-interaction-audit.md` 的缺陷号上（页面「审计出处」列）：
D1（错误率恒 0）、D2（故障伪装成空数据）、D3（永久加载）、D4（移动端列宽塌陷）、D5/D26（重置额度零确认）、
D6（批量剪枝零确认）、D8（Modal 套 Modal）、D13（筛选不进 URL）、D16（单位/缺值多套）、D21（主标识死点击）、
D24（轮询无上限）、D27（开关即时生效）、D30（术语漂移）；模式引用 TUF 的 M1/M2/M3/M4/M6/M8/M10/M14。

指标口径固定六项：**步数 / 点击数 / 误操作 / 卡住点 / 是否可恢复 / 需要看文档次数**。

---

## 7. 现状（Phase 1 + Phase 2 均已完成）

**已验证**
- `npx tsc -p tsconfig.app.json --noEmit`、`npx tsc -p tsconfig.server.json --noEmit`：exit 0。
- `npx oxlint src/ab src/pages/AbLabPage.vue server/abLab.ts scripts/ab-report.mjs`：无输出（0 warning）。
- `npm run build`（在 `/tmp/cac-build.lock` 内）：exit 0，产出 `dist/assets/AbLabPage-*.js` 与 4 个 `*.legacy-*.js` 变体 chunk。
- 5 个 SFC 用 `@vue/compiler-sfc` 单独 parse + compileScript + compileTemplate + compileStyle：全部 PASS，相对 import 全部解析成功。
- `/ab` 已挂路由与导航项（Lead 接线：`src/router.ts`、`src/components/ConsoleNav.vue`），浏览器实测可打开、三个流程可切换、A/B 并排渲染真实数据；投票前对照正常展示。
- `POST /api/ab/preference` 已接线（`server/index.ts`）：未登录 401；页面投票实测成功后 `data/ab-preferences.jsonl` 出现该条记录，`node scripts/ab-report.mjs` 能读出（输出见 `comparison.md` §6）。
- `server/abLab.ts` 隔离环境自测（`DATA_DIR=/tmp/...`，未碰真实 data/）：9/9 校验用例通过；额外键（`apiKey`/`password`/`prompt`）被完全丢弃；`sk-…`/`Bearer …` 被替换为「[已隐去疑似密钥]」并置 `redacted:true`；落盘 0600、每行合法 JSON。
- A/B 任务式评估已完成：`docs/qa/ab/comparison.md`（三个流程各一张对照表 + A/B 真实截图 + 复现命令）。
- **只读闸门已完成并逐一验证**（红队 R1）：4 个 legacy 副本各实点一条交互，页内无非 GET 请求、计数符合预期、无真实副作用；闸门逻辑自测 19/19；投票通道例外已验证。详见 `comparison.md` §7。

**未验证 / 残余风险（详见 `comparison.md` §5）**
- 样本量 1（唯一操作者），不得外推。
- 破坏性动作的**最终提交**一律未执行（走到确认框即取消）：删除 Key / 重置额度 / 剪枝 / RTK 开关的「确认之后」行为只有代码推断。
- flow 1 未做接口失败注入（该条仅有静态代码证据）；移动端 390×844 未复测。
- B 侧「重置额度」的确认框仍叠在额度弹窗之上（2 层可见）——已记录为 B 侧唯一遗留交互问题，未计入缺陷数。

