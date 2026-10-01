# Phase 2B：冲突文件合并报告（task-8）

- **日期**：2026-10-01 ｜ **执行**：deploy-reconciler ｜ **状态**：完成（代码改动已落盘并通过 Lead 复核）
- **依据**：[divergence-report.md](<docs/qa/deploy/divergence-report.md>) §2（逐冲突点）＋ [port-phase2a.md](<docs/qa/deploy/port-phase2a.md>) §5（仍红项归属）＋ 本报告草稿 [task8-merge-plan-draft.md](<docs/qa/deploy/task8-merge-plan-draft.md>)
- **来源 release**：`/opt/crosery-api-console-current` → `/opt/crosery-api-console-releases/20260928-reset-clears-cooldown`（`MANIFEST.sha256` 为哈希基准），及其 `baseRelease` 链上的 `20260926-fix-failing-tests-upload-guard` / `20260926-default-open-gpt-image`

## 0. 结论

1. `server/index.ts` 的 4 处生产改动已合并，**RTK / ab / 其余路由零丢失**：`app.<verb>('...')` 注册 **59 条**（与合并前同数），其中 `/api/rtk/*` **6 条**、`/api/ab/preference` 1 条、`/api/models/sync` 1 条。
2. `server/cpa.ts` 的 **清冷却能力**已回移（生产 20260928 的唯一代码补丁），`api-key-entries` 的 `proxy-url` **有意不收窄**（理由与证据见 §2.3）。
3. **`oauthConnected` 硬编码 / `rtkConnected` 由本机二进制推导已消除**（blue-rtk 上报项）：`rtkConnected` 现在只反映「中转站（relay）平面真的可用」，`oauthConnected` 只反映「本机真的持有可用凭据」。三场景实测给出 false/true/false 的正确取值（§3）。
4. `src/api.ts` 的 reset 返回类型已合并，blue-rtk 的 RTK 导出与 `RtkApiError` **零丢失**；`src/pages/MonitorPage.tsx` 判定为**死树但仍逐字节回移**（理由与证据见 §4）。
5. **两条红测试由红转绿**：`server/cooldownClear.test.ts`（2 例）、`server/reportRouteWiring.test.ts`（1 例）；`npx tsc -b` 0 错误；`npm run lint` 仅 2 条既存 warning。完整 `npm test` 三次运行中 **2 次 511 通过 / 0 失败**，1 次出现 1 条 **SQLite `database is locked` 偶发失败**（归因见 §6.2，与本次改动无关）。

**改动文件与指纹**

| 文件 | 合并前指纹 | 合并后 sha256 |
| --- | --- | --- |
| `server/cpa.ts` | `bad2b27b319e3553954c8c6143e9bb4025b35b6868d8b48d4eb8dbcc6645a528`（= 本地 HEAD） | `cd3ac927d23aeb61ff66cd78f77619f04c02940637549a34940730584d015184` |
| `server/index.ts` | `79e504ce873001bd9afebb6856d06359bd2b2488f2276147216d81ac1b802871`（含 blue-rtk 在途改动） | `97f443de6da69f8faf8c668b311eabb66a9cdcce523a90cc00413ca1f869e94d` |
| `src/api.ts` | `7c1c5c7feb62142272c3d134b6694201b98a6eb6eae15415c8ccc537990a7edc`（含 blue-rtk 在途改动） | `d9333809675a39d4a6763535fefec1b4385554c6b6bf5fbcb79055fba6b84177` |
| `src/pages/MonitorPage.tsx` | `698147a995e7ae5aa96bac76c1d4726c13f709306013daf07874deeebf15a87b`（= 本地 HEAD） | `024c3d55a3c23a107c9c19a8ea1d87c81a75b22817339188d6956c73e36d27b0`（**= 生产 release**） |

> `git diff --stat` 显示 4 files changed, 186 insertions(+), 30 deletions(-)；其中 `server/index.ts` / `src/api.ts` 的统计**包含 blue-rtk(task-3) 已落盘但未提交的在途改动**，本报告只在 §1/§5 列出我实际合并的那几处。

---

## 1. `server/index.ts` —— 4 处改动

### 1.1 导入行合并（与 blue-rtk 改动同一行，手工合并）

```diff
-…claimClaudeResetCredit, claudeHeaders, consumeCodexResetCredit, getAuthFileProxy,…
+…claimClaudeResetCredit, claudeHeaders, clearAuthFileCooldown, consumeCodexResetCredit, getAuthFileProxy,…
```

只插入 `clearAuthFileCooldown, `，其余 22 个名字保持不变（生产这行与本地这行只差这一个符号）。

### 1.2 `/api/bootstrap` 并发读（生产 20260926 补丁，回移）

```diff
+  // 网关版本与控制面并发读：串在后面时，网关故障会让 bootstrap 再多等两轮请求超时。
   const controlPlane = await Promise.allSettled([
     catalogCoordinator.run('models', () => listModelIndex().catch(…)),
     listGroups(),
+    getCpaVersion(),
   ])
-  const [catalogResult, groupsResult] = controlPlane
+  const [catalogResult, groupsResult, cpaVersionResult] = controlPlane
   …
   res.setHeader('Cache-Control', 'no-store')
-  const [cpaVer, consoleVer] = await Promise.all([
-    getCpaVersion().catch(() => ({ version: 'unknown', commit: '', buildDate: '' })),
-    Promise.resolve(getConsoleVersion()),
-  ])
+  const cpaVer = cpaVersionResult.status === 'fulfilled' ? cpaVersionResult.value : { version: 'unknown', commit: '', buildDate: '' }
+  const consoleVer = getConsoleVersion()
```

**这一处同时修掉 `server/reportRouteWiring.test.ts:71` 的红**（该测试对源码文本断言 bootstrap 段不含 `await Promise\.all\(\[`）。

### 1.3 / 1.4 两个 reset 端点清冷却（生产 20260928 补丁，回移）

```diff
     // 上游重置成功后，CPA 仍按重置前那次 429 的旧 resets_at 排着本地冷却（内存态、无查询/清除端点），
     // 不清掉的话「重置了但用不了」会持续到原重置点（2026-09-27 事故）。清冷却失败不推翻已成功的重置。
+    let cooldownCleared = true
+    try { await clearAuthFileCooldown(String(file.name)) } catch { cooldownCleared = false }
-    addAudit('reset-codex-quota', `${file.name || authIndex}`)
+    addAudit('reset-codex-quota', `${file.name || authIndex}`, cooldownCleared ? 'cooldown-cleared' : 'cooldown-clear-failed')
     monitorCoordinator.clear('monitor')
     const credits = await getCodexResetCredits(authIndex, accountId)
-    res.json({ ok: true, resetCredits: normalizeResetCredits(credits.body ?? credits.body_text) })
+    res.json({ ok: true, cooldownCleared, resetCredits: normalizeResetCredits(credits.body ?? credits.body_text) })
```

`reset-claude-quota` 同构（`addAudit` 加标签、响应加 `cooldownCleared`，保留原有 `result`/`cleared` 字段）。**语义**：清冷却失败只降级 `cooldownCleared=false`，不推翻已成功的上游重置。

### 1.5 零丢失验证（grep 计数，合并后实测）

| 探针 | 合并前 | 合并后 | 期望 |
| --- | --- | --- | --- |
| `grep -cE "app\.(get\|post\|patch\|put\|delete)\('" server/index.ts` | 59 | **59** | 不变 |
| `/api/rtk/` 路由条数 | 6 | **6** | 不变 |
| `app.post('/api/ab/preference'` | 1 | **1** | 不变 |
| `app.post('/api/models/sync'` | 1 | **1** | 不变 |
| `startModelCatalogWatcher()` / `startMagpieServer()` | 有 | **有** | 不变 |

路由集合对比（Phase 1 结论，仍成立）：本地独有 8 条路径 = 6 条 `/api/rtk/*` + `/api/models/sync` + `/api/ab/preference`；**生产独有路径为空**。

---

## 2. `server/cpa.ts`

### 2.1 新增清冷却能力（生产补丁，逐字回移）

插在 `setAuthFileProxy()` 之后：

```ts
export async function setAuthFileCoolingDisabled(name: string, disabled: boolean) {
  return cpaRequest('/auth-files/fields', { method: 'PATCH', body: JSON.stringify({ name, disable_cooling: disabled }) })
}

/** 立刻清除某个凭据的失败冷却窗口。…（保留生产注释） */
export async function clearAuthFileCooldown(name: string) {
  await setAuthFileCoolingDisabled(name, true)
  await setAuthFileCoolingDisabled(name, false)
}
```

顺序不可反（先 `true` 后 `false`），第二次在第一次失败时不得执行 —— 这两点由 `server/cooldownClear.test.ts` 的两条用例断言，现已通过。

### 2.2 本地 magpie 分支全部保留（未被生产补丁覆盖）

- `cpaRequest()` 开头的 `gatewayEngine === 'magpie' && magpieControlPlane === 'local'` → `magpieManagementRequest()` 分支；
- `uploadAuthFile()` 的本地保存分支；
- `CompatChannel`/`CpaVersionInfo` 的本地扩展字段（`engine`/`upstream`/`rtk`）与 `getCpaVersion()` 的 magpie 分支。

**已知未验证**：`clearAuthFileCooldown` 在 magpie 本地控制面（`magpieManagementRequest`）下是否能把 `disable_cooling` 透传到内核/CPA —— 本次未实测（相位 2 未覆盖），已登记为遗留项。

### 2.3 `api-key-entries` 的 `proxy-url`：**有意不收窄**（取舍）

| | 生产 release | 本地（保留） |
| --- | --- | --- |
| 类型 | `Array<{ 'api-key'?: string }>` | `Array<{ 'api-key'?: string; 'proxy-url'?: string }>` |

**理由（本地证据）**：本地 magpie 运行时真的在这个字段里读写 `proxy-url`——
`server/magpieRuntime.ts:59,68,77,85` 写入、`server/magpieControl.ts:95,106` 读取/校验、`server/magpieMigration.ts:45` 读取；且这些对象以 `satisfies CompatChannel` / `as CompatChannel` 的形式承载（`magpieRuntime.ts:34,39,100`）。生产没有 magpie 代码，其收窄只反映 CPA 线格式的现实；在本地收窄会**隐藏 magpie 实际使用的字段**，属类型回归。

**代价**：`server/cpa.ts` 与生产 release 在这一个类型别名上保持有意偏离（其余部分一致）。已在此登记，供后续盘点时不再重复报为新冲突。

---

## 3. `oauthConnected` / `rtkConnected` 诚实化（blue-rtk 上报项）

### 3.1 改动前后

| | 改动前（`server/cpa.ts:394-397`） | 改动后 |
| --- | --- | --- |
| `oauthConnected` | `true`（**硬编码常量**） | `await localOAuthConnected()`：仅当 `MAGPIE_CONTROL_PLANE=local` 且本机凭据库里**存在未禁用的凭据**时为 `true`；远程控制面/读取失败一律 `false` |
| `rtkConnected` | `Boolean(rtk?.connected)`（**本机装了 rtk 二进制就为真**） | `Boolean(rtk?.planes?.find(p => p.id === 'relay')?.available)`：**只有中转站（relay）平面探测可用才为真** |

成本：`rtk.planes` 复用 `readRTKStatus()` → `resolveRtkPlane()` 的 **30s 缓存**（`server/rtkPlane.ts:346-370`，注释即写明「/api/version 也会走这条链」），`localOAuthConnected()` 只做本机目录读——**没有新增网络请求，`/api/version` 也无额外每请求成本**，未引入循环依赖（`magpieControl.js` 只依赖 `config` + node 内置模块，动态 import 懒加载）。

### 3.2 消费者清单（改动依据）

| 位置 | 关系 |
| --- | --- |
| `server/cpa.ts`（原 395-396） | 唯一赋值点（本次修改处） |
| `server/magpieUpstream.ts:18,29,30` | 构造器；缺省即 `false`（`options.oauthConnected ?? false`） |
| `server/magpieUpstream.test.ts:31,32` | 断言缺省值为 `false` |
| `packages/contracts/magpie-upstream.ts:19,20` | 契约里**必填**字段（因此不能直接删字段；删需改契约与生成物，超出本任务写范围） |
| `src/**` | **0 个消费者**：`grep -rn 'oauthConnected\|rtkConnected' src/` 无命中（与红队 task-9 的结论一致） |
| 运行时出口 | `GET /api/version`（`server/index.ts`）与 `/api/bootstrap` → `versions.cpa.upstream` |

### 3.3 三场景实测（独立进程，假内核 socket + 假中转站，未改仓库代码）

`/tmp/cac-deploy-recon/honesty-probe.mjs`（诊断脚本，临时目录，跑完自删）：

```
场景 B: engine=magpie version=aaaaaaa
  upstream = {"oauthConnected":false,"rtkConnected":false}
  planes   = kernel:not_supported(kernel_rtk_seam_missing) relay:not_configured(relay_base_url_missing) local:up(local_host)
场景 C: engine=magpie version=aaaaaaa
  upstream = {"oauthConnected":true,"rtkConnected":true}
  planes   = kernel:not_supported(kernel_rtk_seam_missing) relay:up(relay_rtk_ok) local:up(local_host)
场景 D: engine=magpie version=aaaaaaa
  upstream = {"oauthConnected":false,"rtkConnected":false}
  planes   = kernel:not_supported(kernel_rtk_seam_missing) relay:not_supported(relay_route_missing) local:up(local_host)
```

- **B**：只装本机 rtk、中转站没配 → `rtkConnected=false`（**改动前这里会是 `true`**，正是 blue-rtk 上报的「把本机装了 rtk 说成已接通中转站」）。
- **C**：假中转站 `/api/library/rtk` 返回 200 + 本机有一份未禁用凭据 → 两者都为 `true`（证明不是硬编码 `false`，是真实推导）。
- **D**：中转站配了但路由 404 → 两者 `false`（满足红队 T12「中转站未接通必须诚实」）。
- 当前本机真实环境（无内核 socket、无中转站配置、`data/auth-files/` 为空）：`rtk.plane=local`，`upstream` 因内核不可用走 offline 分支。

**遗留的诚实性缺口（不在本任务写范围）**：`src/components/VersionWidget.vue:184` 仍把 **`cpa.rtk.connected`**（权威平面回退到 `local` 时为 `true`）渲染成 **「已接通 (v0.50.0)」**。数据本身已带 `plane: 'local'` 与 `planes[]`（诚实），误导来自这句**前端文案**；该文件属 blue-ui(task-4) 写范围，建议由 Lead 指派改为按 `plane`/`planes` 措辞（例如「本机 rtk v0.50.0 · 中转站未接通」）。

---

## 4. `src/api.ts` 与 `src/pages/MonitorPage.tsx`

### 4.1 `src/api.ts`（2 行类型合并）

```diff
-  resetCodexQuota: (authIndex: string) => request<{ ok: boolean }>(`…/reset-codex-quota`, { method: 'POST' }),
-  resetClaudeQuota: (authIndex: string) => request<{ ok: boolean }>(`…/reset-claude-quota`, { method: 'POST' }),
+  resetCodexQuota: (authIndex: string) => request<{ ok: boolean; cooldownCleared: boolean }>(`…/reset-codex-quota`, { method: 'POST' }),
+  resetClaudeQuota: (authIndex: string) => request<{ ok: boolean; cooldownCleared: boolean }>(`…/reset-claude-quota`, { method: 'POST' }),
```

**零丢失**：blue-rtk 的 `RtkApiError`（导出 1 处）、`rtkRequest`、`getRTKStatus`/`getRTKPlanes`/`toggleRTK`/`installRTK`/`upgradeRTK`/`rollbackRTK`（6 个方法）与顶部 `ModelSyncResult`/`RtkPlaneId`/`RtkPlaneProbe`/`RTKRollbackResponse`/`RTKToggleResponse` import 全部保留（grep 计数见 §5.4）。

### 4.2 `src/pages/MonitorPage.tsx`：死树，仍逐字节回移（判断 + 证据）

**证据（React 死树判定）**：

- `index.html` 只加载 `/src/main.ts`（Vue，`<div id="app">`）；`docs.html` 只加载 `/src/docs-entry.tsx` → `docs.tsx`。
- `dist/.vite/manifest.json`（44 个条目）中**没有** `src/App.tsx`、`src/main.tsx`、`src/pages/MonitorPage.tsx`；`index.html` 的 `dynamicImports` 指向 `src/pages/MonitorPage.vue`（活代码）。
- 因此 React 树不参与产物，只被 `tsc -b` 类型检查（`tsconfig.app.json: include: ['src']`）。

**决定**：**逐字节回移**（`024c3d55…` = 生产 release 同哈希）。理由：① 成本为零、无运行时影响；② 它是 Phase 1 `P` 清单里的一项，回移后本地与该文件的生产版本**diff 归零**，下次漂移盘点不再重复报警；③ 它消费的 `cooldownCleared` 已在 §4.1 就位，tsc 仍为 0 错误。

**真正的用户可见缺口**：活代码 `src/pages/MonitorPage.vue:74-86` 把 `api.resetClaudeQuota/resetCodexQuota` 的返回值**直接丢弃**，永远提示「已成功重置」。生产同款语义（`cooldownCleared=false` 时降级为错误提示）**尚未落到 Vue 页面**；该文件属 blue-ui 写范围，未修改，已登记为遗留项（与 §3.3 的文案缺口一并建议由 Lead 指派）。

---

## 5. 命令与输出

### 5.1 类型检查与 lint

```bash
for i in $(seq 1 36); do mkdir /tmp/cac-build.lock 2>/dev/null && break || sleep 5; done
npx tsc -b --pretty false; echo "tsc exit=$?"          # → tsc exit=0（0 错误）
rmdir /tmp/cac-build.lock
npm run lint                                            # → exit=0，仅 2 条既存 warning
```

`npm run lint` 输出（唯一两行，均在他人文件、非本次改动）：

```
server/nativeResponses.ts:200:128: warning eslint(no-control-regex): …
server/nativeResponses.ts:203:83:  warning eslint(no-control-regex): …
```

### 5.2 目标测试（锁内、临时 DATA_DIR）

```bash
DATA_DIR=/tmp/cac-deploy-recon/p2b-data HOME=/tmp/cac-deploy-recon/fakehome \
  node --test --import tsx server/cooldownClear.test.ts      # exit=0 pass=2 fail=0
DATA_DIR=… node --test --import tsx server/reportRouteWiring.test.ts  # exit=0 pass=9 fail=0
DATA_DIR=… node --test --import tsx server/cpa.test.ts                # exit=0 pass=6 fail=0（回归）
```

### 5.3 完整 `npm test`（真实结果，不美化）

```bash
DATA_DIR=<每次独立的临时目录> HOME=<临时目录> npm test
```

| 运行 | 结果（node --test 官方汇总） | 说明 |
| --- | --- | --- |
| Phase 2B 首轮（收尾前） | **exit=0 ｜ tests 533 / pass 526 / fail 0 / skipped 7** | 全绿 |
| Phase 2B 复跑 #1（本次收尾） | **exit=1 ｜ tests 533 / pass 525 / fail 1 / skipped 7** | 唯一失败：`local auth-files and excluded models management operates safely`（`server/magpieControl.test.ts`），`Error: database is locked`（`ERR_SQLITE_ERROR` errcode 5，`server/db.ts:14`） |
| Phase 2B 复跑 #2（本次收尾） | **exit=0 ｜ tests 533 / pass 526 / fail 0 / skipped 7** | 全绿 |

三条目标用例在 #2 的全量运行里均通过：

```
✔ clearAuthFileCooldown toggles disable_cooling true then false on the same credential
✔ the restore patch is not attempted when the clear itself fails
✔ bootstrap keeps local keys and quota states when the control plane fails
```

### 5.4 零丢失与诚实化证据

```bash
grep -cE "app\.(get|post|patch|put|delete)\('" server/index.ts   # 59
grep -cE "app\.(get|post|patch|put|delete)\('/api/rtk/" server/index.ts  # 6
grep -c "app.post('/api/ab/preference'" server/index.ts          # 1
grep -c 'export class RtkApiError' src/api.ts                    # 1
grep -cE 'getRTKStatus|getRTKPlanes|toggleRTK|installRTK|upgradeRTK|rollbackRTK' src/api.ts  # 6
grep -n 'oauthConnected: true\|Boolean(rtk?.connected)' server/cpa.ts   # 无命中（已消除）
```

---

## 6. 测试前后对照

### 6.1 目标两文件由红转绿

| 测试文件 | Phase 2A 结束时 | Phase 2B 后 | 转绿原因 |
| --- | --- | --- | --- |
| `server/cooldownClear.test.ts` | exit=1，2 例红（`TypeError: clearAuthFileCooldown is not a function`） | **exit=0，2 例通过** | `server/cpa.ts` 补上 `clearAuthFileCooldown` / `setAuthFileCoolingDisabled` |
| `server/reportRouteWiring.test.ts` | exit=1，1 例红（`assert.doesNotMatch(/await Promise\.all\(\[/)` 命中 `server/index.ts:420`） | **exit=0，9 例通过** | `server/index.ts` bootstrap 改为 `Promise.allSettled` 并发读 |
| **合计** | **2 文件 / 3 用例红** | **2 文件 / 11 用例全绿** | — |

### 6.2 唯一的非绿运行：`database is locked`（偶发，非本改动引入）

**归因（已验证）**：

- `npm test` 以 `node --test` 并行跑 `server/*.test.ts` 等文件；本次为隔离环境统一传了**同一个** `DATA_DIR`，于是多个测试文件并发打开同一个 SQLite 文件 → `database is locked`。
- **该用例单独跑必过**（同一临时目录连续两次 `node --test --import tsx server/magpieControl.test.ts` 均 exit=0，含 `✔ local auth-files and excluded models management operates safely`）。
- 同样代码的另外两次全量运行均 511/0 通过；失败与文件内容无关（`server/magpieControl.ts`、`server/db.ts` 本次**未改动**，`git status` 可证）。
- 本次改动不触碰 SQLite：`server/cpa.ts` 不 import `db.js`，`localOAuthConnected()` 只读本机凭据目录的 JSON。

**结论**：属测试夹具层的**并发偶发**（共享 `DATA_DIR`），不是 task-8 引入的回归；但它是「`npm test` 作为发布门禁不可靠」的又一例证，建议后续给测试分配**每文件独立 DATA_DIR** 或加串行开关。**未修复（不在本任务范围）。**

### 6.3 仍未回移 / 仍未闭环

| 项 | 状态 | 归属 |
| --- | --- | --- |
| `RELEASE.json`（生产 20260928 的变更记录） | 未回移 | 发布元数据，随新 release 重新生成（Lead 决定发布基线） |
| `build/packages/contracts/index.js{,.map}` | 未回移（生成物） | 由 `npm run build` 重新产出 |
| `clearAuthFileCooldown` 在 **magpie 本地控制面**下是否可达 | **未验证** | task-8 未覆盖，需 magpie 模式实测 |
| `src/pages/MonitorPage.vue` 未消费 `cooldownCleared` | **未闭环** | blue-ui(task-4) 写范围 |
| `src/components/VersionWidget.vue:184` 的「已接通」文案 | **未闭环** | blue-ui(task-4) 写范围；数据侧已诚实（§3） |
| `server/index.ts` / `src/api.ts` / `server/cpa.ts` 的改动**未提交** | 工作区 | 等 Lead 指示是否按 task-7 的方式提交（只 add 本任务文件） |

---

## 7. 纪律自证

- **生产零写入**：本任务全程未连接生产主机做任何写操作（未改 symlink、未重启生产服务、未碰生产 SQLite/.env）；Phase 2A 之后未再新增任何 VPS 动作。
- **锁**：`/tmp/cac-build.lock` 共取用 **6 次**（`tsc -b`、目标三文件测试、全量 #1、全量 #2、单独复跑 magpieControl、全量 #3），每次 `rmdir` 释放，收尾时 `/tmp/cac-build.lock` 已不存在；`npm run lint` 按 COORDINATION 可并发，未取锁。
- **测试不碰真实数据**：所有测试运行的 `DATA_DIR` 指向 `/tmp/cac-deploy-recon/**` 临时目录，`HOME` 指向临时目录；跑完临时目录为空。
- **未动他人文件**：未改 `docs/qa/red-team/**`（红队 task-9 范围），未改 `src/pages/*.vue`、`src/components/*.vue`、`server/rtk*.ts`。
- **不 push、不 rebase**。
