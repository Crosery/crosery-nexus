# task-8 合并方案草案（**未执行**，待 Lead 放行 + task-3 complete）

- 作者：deploy-reconciler ｜ 日期：2026-10-01 ｜ 状态：**草案 / 只读准备**，未改任何目标文件
- 依据：[divergence-report.md](<docs/qa/deploy/divergence-report.md>) §2（逐冲突点）、[port-phase2a.md](<docs/qa/deploy/port-phase2a.md>) §5.2（`reportRouteWiring` 红因）
- **执行前必做**：重新核对下表指纹，与草案不一致就按新内容重新推导（blue-rtk / 其他成员仍在改这些文件）

| 文件 | 草案依据指纹（2026-10-01 08:38 工作区） | 备注 |
| --- | --- | --- |
| `server/index.ts` | `79e504ce873001bd9afebb6856d06359bd2b2488f2276147216d81ac1b802871` | **已含** blue-rtk 的 RTK 路由 + ab 路由（未提交） |
| `src/api.ts` | `7c1c5c7feb62142272c3d134b6694201b98a6eb6eae15415c8ccc537990a7edc` | 已含 blue-rtk 的 `rtkRequest` 等 |
| `server/cpa.ts` | `bad2b27b319e3553954c8c6143e9bb4025b35b6868d8b48d4eb8dbcc6645a528` | 此刻仍等于本地 HEAD（未被打过 patch 的版本） |
| `src/pages/MonitorPage.vue` | `b114072dce25597e752ce8777948f5bc3a68c43236bfd8fe60322085be4dff04` | 属 blue-ui 写范围，**我不写** |
| `src/pages/MonitorPage.tsx` | `698147a995e7ae5aa96bac76c1d4726c13f709306013daf07874deeebf15a87b` | = 本地 HEAD（React 遗留文件） |

---

## 0. 零丢失基线（合并后必须逐条仍在）

**本地独有、生产没有的 8 条路由**（合并 `server/index.ts` 时最容易误删）：

```
POST /api/models/sync        GET  /api/rtk/status     GET  /api/rtk/planes
POST /api/rtk/toggle         POST /api/rtk/rollback   POST /api/rtk/install
POST /api/rtk/upgrade        POST /api/ab/preference
```

- 实测路由集合对比（当前工作区 `server/index.ts` vs 生产 release 的 `server/index.ts`）：
  - 本地 **59 条 `app.<verb>('...')` 注册 = 54 个不同路径**（52 个 `/api/*` + 2 个 `/v1/*`）；
  - 生产 **46 条注册**；
  - **本地独有路径恰好就是上面 8 条**；**生产独有路径：空**（生产补丁只改既有端点内部逻辑，不加不删路由）。合并后应保持 59 条注册、8 条独有路径仍在。
- 回归探针（合并前后各跑一次，diff 必须为空）：
  ```bash
  grep -oE "app\.(get|post|patch|put|delete)\('/api/[^']*'" server/index.ts | sort > /tmp/routes-before.txt
  # 合并后
  grep -oE "app\.(get|post|patch|put|delete)\('/api/[^']*'" server/index.ts | sort > /tmp/routes-after.txt
  diff /tmp/routes-before.txt /tmp/routes-after.txt   # 期望无输出
  ```
- 除路由外还必须零丢失：`startModelCatalogWatcher()`、`startMagpieServer()`、`readRTKStatus`/`setRTKAgentHook`/RTK 平面与 rollback/install/upgrade 实现（`server/rtkService.ts`、`server/rtkPlane.ts`）、`handleAbPreference`（`server/abLab.ts`）。

---

## 1. `server/index.ts` —— 4 个 hunk，位置不重叠、只有导入行同冲突

### 1.1 导入行（**同一行冲突，必须手工合并**）

```diff
- ...claimClaudeResetCredit, claudeHeaders, consumeCodexResetCredit, getAuthFileProxy,...
+ ...claimClaudeResetCredit, claudeHeaders, clearAuthFileCooldown, consumeCodexResetCredit, getAuthFileProxy,...
```

就是往现有 `import { … } from './cpa.js'`（当前第 9 行）里插入 `clearAuthFileCooldown, `。**其余名字一个都不能删**（本地这行与生产这行在别名集合上一致，只是本地缺这一个 + 生产缺 RTK 相关名字——RTK 相关名字不在这一行，安全）。

### 1.2 `/api/bootstrap`（生产 hunk，回移）

```diff
   const controlPlane = await Promise.allSettled([
     catalogCoordinator.run('models', () => listModelIndex().catch((error) => { ... })),
     listGroups(),
+    getCpaVersion(),
   ])
-  const [catalogResult, groupsResult] = controlPlane
+  const [catalogResult, groupsResult, cpaVersionResult] = controlPlane
   ...
   res.setHeader('Cache-Control', 'no-store')
-  const [cpaVer, consoleVer] = await Promise.all([
-    getCpaVersion().catch(() => ({ version: 'unknown', commit: '', buildDate: '' })),
-    Promise.resolve(getConsoleVersion()),
-  ])
+  const cpaVer = cpaVersionResult.status === 'fulfilled' ? cpaVersionResult.value : { version: 'unknown', commit: '', buildDate: '' }
+  const consoleVer = getConsoleVersion()
   res.json({
```

- **同时修好 `server/reportRouteWiring.test.ts:71` 的红**（它断言 bootstrap 段不含 `await Promise.all([`）。
- ⚠️ 本地 `getCpaVersion()` 在 magpie 模式下会走内核 `/internal/health`（`server/cpa.ts` 的 magpie 分支）：放进 `Promise.allSettled` 后**超时语义变化**——原先是串行第二段、现在与目录/分组并发。行为上更好（网关故障少等两轮超时），但要在本地 magpie 模式下实跑一次 bootstrap 确认 `engine/upstream/rtk` 字段仍返回（探针见 §5）。
- 若合并时本地 bootstrap 已经又多出别的并发读（blue-rtk 可能在加），把 `getCpaVersion()` 与它们放进**同一个** `Promise.allSettled` 数组，保持「一次并发、不串行」。

### 1.3 `reset-codex-quota`（生产 hunk，回移）

```diff
-    addAudit('reset-codex-quota', `${file.name || authIndex}`)
+    // 上游重置成功后，CPA 仍按重置前那次 429 的旧 resets_at 排着本地冷却……
+    let cooldownCleared = true
+    try { await clearAuthFileCooldown(String(file.name)) } catch { cooldownCleared = false }
+    addAudit('reset-codex-quota', `${file.name || authIndex}`, cooldownCleared ? 'cooldown-cleared' : 'cooldown-clear-failed')
     monitorCoordinator.clear('monitor')
     const credits = await getCodexResetCredits(authIndex, accountId)
-    res.json({ ok: true, resetCredits: normalizeResetCredits(credits.body ?? credits.body_text) })
+    res.json({ ok: true, cooldownCleared, resetCredits: normalizeResetCredits(credits.body ?? credits.body_text) })
```

要点：清冷却**失败不推翻已成功的上游重置**（`catch` 后仍 `ok: true`，只是 `cooldownCleared: false`）。

### 1.4 `reset-claude-quota`（生产 hunk，回移）

```diff
-    addAudit('reset-claude-quota', `${file.name || authIndex}`)
+    let cooldownCleared = true
+    try { await clearAuthFileCooldown(String(file.name)) } catch { cooldownCleared = false }
+    addAudit('reset-claude-quota', `${file.name || authIndex}`, cooldownCleared ? 'cooldown-cleared' : 'cooldown-clear-failed')
     claudeQuotaCache.clear(authIndex)
     monitorCoordinator.clear('monitor')
-    res.json({ ok: true, result: outcome, cleared: claimBody.cleared ?? [] })
+    res.json({ ok: true, cooldownCleared, result: outcome, cleared: claimBody.cleared ?? [] })
```

⚠️ 本地该端点可能已被别人改过（例如加了 `result`/`cleared` 字段或换了 `claudeQuotaCache`），**以执行时的实际代码为准插桩**，只加「清冷却 + 字段 + 审计标签」三件事。

### 1.5 明确**不动**的部分

`app.post('/api/models/sync')`、`/api/rtk/*` 全部 7 条、`/api/ab/preference`、启动段的 `startModelCatalogWatcher()` / `startMagpieServer()` —— 逐字保留。

---

## 2. `server/cpa.ts` —— 2 处必须回移 + 1 处需判定

（此刻该文件 = 本地 HEAD 版本，可直接按生产 `bd97f7ed6227…` 的 diff 应用。）

### 2.1 必须回移（生产独有，纯增量）——放在 `setAuthFileProxy()` 之后、`getAuthFileProxy()` 的注释块之前

```ts
export async function setAuthFileCoolingDisabled(name: string, disabled: boolean) {
  return cpaRequest('/auth-files/fields', { method: 'PATCH', body: JSON.stringify({ name, disable_cooling: disabled }) })
}

/**
 * 立刻清除某个凭据的失败冷却窗口。……（保留生产注释：disable_cooling true→false、
 * 已清掉的冷却不回灌、2026-09-27 事故）
 */
export async function clearAuthFileCooldown(name: string) {
  await setAuthFileCoolingDisabled(name, true)
  await setAuthFileCoolingDisabled(name, false)
}
```

**顺序不可反**（先 `true` 后 `false`）：`cooldownClear.test.ts` 的两条用例正是在断言这一点，第二条还断言「第一次 PATCH 失败时不得尝试第二次」。

⚠️ **必须隔离的本地分支**：本地 `cpaRequest()` 开头有
`if (config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local') → magpieManagementRequest()`
——`clearAuthFileCooldown` 会走这条分支（magpie 本地控制面）。生产环境是 `gatewayEngine !== 'magpie'`，行为不受影响；本地 magpie 模式下是否能清冷却**未验证**，需要在 Phase 2B 用 magpie 本地控制面实测一次（探针见 §5），并在必要时给 magpie 分支补 `disable_cooling` 透传。

### 2.2 必须保留（本地独有）

`uploadAuthFile()` 的 magpie 本地保存分支、`CpaVersionInfo` 的 `engine`/`upstream`/`rtk` 字段、`getCpaVersion()` 的 magpie 分支（内核 revision + `readMagpieUpstreamStatus` + `rtk`）。**注意**：§1.2 的 bootstrap 改动依赖 `getCpaVersion()` 返回类型不变，这两处要一起看。

### 2.3 需判定：`CompatChannel['api-key-entries']` 的 `'proxy-url'`

| 生产（`bd97f7ed6227`） | 本地（`bad2b27b319e`） |
| --- | --- |
| `'api-key-entries'?: Array<{ 'api-key'?: string }>` | `'api-key-entries'?: Array<{ 'api-key'?: string; 'proxy-url'?: string }>` |

生产在 20260928 **顺手收窄**了这个类型（同一 release 的 `RELEASE.json` 的 `changes` 未单列它）。判定方法（执行时做，只读）：找一个真实 `/openai-compatibility` 响应，看条目的 `api-key-entries` 里是否还有 `proxy-url` 字段。
- 若**没有**：跟随生产收窄（本地保留该字段只会让读取处永远拿到 `undefined`，是死代码）。
- 若**有**（或无法确认）：**保留本地**（收窄会丢掉一个可能被读取的类型字段），并在报告里记为「与生产有意偏离」，附证据。

---

## 3. `src/api.ts` —— 2 行类型（与 blue-rtk 的改动不同区域）

```diff
-  resetCodexQuota: (authIndex: string) => request<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(authIndex)}/reset-codex-quota`, { method: 'POST' }),
-  resetClaudeQuota: (authIndex: string) => request<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(authIndex)}/reset-claude-quota`, { method: 'POST' }),
+  resetCodexQuota: (authIndex: string) => request<{ ok: boolean; cooldownCleared: boolean }>(`...reset-codex-quota`, { method: 'POST' }),
+  resetClaudeQuota: (authIndex: string) => request<{ ok: boolean; cooldownCleared: boolean }>(`...reset-claude-quota`, { method: 'POST' }),
```

- 当前这两行是第 55/56 行（指纹 `7c1c5c7f…`），blue-rtk 改的是 `rtkRequest`/`getRTKPlanes`/`getRTKRollback` 等区域，**不同行**，只要不整文件覆盖就不会互相踩。
- 保留本地全部 RTK API：`getRTKStatus` / `getRTKPlanes` / `toggleRTK` / `installRTK` / `upgradeRTK` / `rollbackRTK`、以及顶部 `ModelSyncResult`/`RtkPlaneId`/`RtkPlaneProbe`/`RTKRollbackResponse`/`RTKToggleResponse` 的 import。

---

## 4. `src/pages/MonitorPage.tsx`（React 遗留）与 `MonitorPage.vue`（真实 UI）

- **`MonitorPage.tsx`：建议按生产 `024c3d55a3c2…` 逐字节回移**。它在本地是遗留文件（路由走 Vue），改动只影响类型检查；好处是与生产保持逐字节同步、避免下次盘点再报一条 P。前提是 §3 的 `src/api.ts` 先改（否则 `outcome.cooldownCleared` 不存在 → tsc 报错）。
- **`MonitorPage.vue`：这才是用户看到的界面，但它属 blue-ui 写范围，我不动。** 现状（`src/pages/MonitorPage.vue:74-86`）把 `api.resetClaudeQuota/resetCodexQuota` 的返回值**直接丢弃**，永远提示「已成功重置」。建议由 Lead 指派 blue-ui（或授权我）补成生产同款语义：

  - `cooldownCleared === true` → 成功文案追加「并清除网关侧冷却」；
  - `cooldownCleared === false` → **降级为错误态**：「额度已在上游重置，但网关本地冷却清除失败，请求可能仍被挡到原重置时间点；请稍后重试或重启 cli-proxy-api」。

  这是纯前端改动，不涉及生产写入；若 Lead 希望本轮 Task-8 就闭环，需要把该文件加进我的写范围（当前不在）。

---

## 5. 验收标准（task-8 完成时必须实跑）

1. `server/cooldownClear.test.ts` → 2 例绿（现状：`TypeError: clearAuthFileCooldown is not a function`）。
2. `server/reportRouteWiring.test.ts` → 1 例绿（现状：`assert.doesNotMatch(/await Promise\.all\(\[/)`）。
3. 路由零丢失：§0 的 diff 探针无输出，且 `/api/rtk/planes`、`/api/ab/preference` 仍在。
4. `npm run lint` 通过；`npx tsc -b` 除他人文件外零错误。
5. 完整 `npm test`：目标是把 port-phase2a.md §5 的「2 文件红 / 3 用例」清零；若有新的红，必须逐条归因。
6. 本地 bootstrap 冒烟（不碰生产）：重启 `com.crosery.console-magpie` 后 `curl -s http://127.0.0.1:8791/api/bootstrap` 仍返回 `engine/upstream/rtk` 字段、无 5xx（**取 `/tmp/cac-build.lock`**）。
7. 生产侧仍零写入；本任务不切 symlink、不重启生产。

## 6. 回退

三个文件都在版本控制里，且 task-7 已把无冲突部分提交为 `f4c5e69`；task-8 若出问题：`git checkout -- server/index.ts server/cpa.ts src/api.ts src/pages/MonitorPage.tsx`（**仅在确认这些文件没有他人未提交改动时**），或按 `git diff` 逐 hunk 反向应用。合并期间不 push、不 rebase。
