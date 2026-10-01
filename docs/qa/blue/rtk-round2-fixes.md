# RTK 第二轮缺陷修复（task-11 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依据：`docs/qa/red-team/rtk-round2-verification.md`（task-9）

6 条逐条：修前复现 → 根因 → 改法 → 修后证据。UI 两条附 `docs/qa/blue/shots/` 截图。

---

## 0. 汇总

| # | 缺陷 | 严重度 | 状态 | 修后判据 |
| --- | --- | --- | --- | --- |
| 1 | cursor↔claude 连带写入单向、静默改 Claude 配置 | 中高 | ✅ 修好 | cursor ON→OFF 后 `.claude/*` 回到操作前；响应回传 `collateralReverted/files`；UI 显示「已撤回 …」 |
| 2 | rtk 未安装时 local 平面仍报「本机 rtk 已安装」 | 中 | ✅ 修好 | `RTK_BIN=/nonexistent/rtk` → local 平面 `degraded / local_rtk_missing`，文案不含「已安装」 |
| 3 | CLI 写坏钩子文件后 409 却把坏内容留在原地 | 中高（数据完整性） | ✅ 修好 | 修后返回 409（带 plane/reason/backup），文件字节回到 CLI 运行前原文；EACCES 包成结构化错误不泄漏临时路径 |
| 4 | 备份无保留策略 + 响应携带全量历史 | 低中 | ✅ 修好 | `RTK_BACKUP_KEEP`（默认 10）轮转；toggle 响应只回本次备份摘要，status 的 backups 只留 `{id,at,fileCount}` |
| 5 | 失败提示被随后的状态刷新清空 | 中（UI） | ✅ 修好 | 501 提示 3.5s 后仍在，含 `原因=local_install_not_supported`；`load()` 不再清错误 |
| 6 | 危险操作确认框 Escape 关闭不可靠 | 中（UI/无障碍） | ✅ 修好 | 真实鼠标点开 4 轮，每轮一次 Escape 全部关闭，焦点回到触发按钮 |

验证汇总：

```
npm run test:magpie  → ℹ tests 61 · pass 60 · fail 0 · skipped 1   （新增 6 条：缺陷 1/2/3/4 + 反向回归）
npx tsc -b           → exit 0        npx tsc -p tsconfig.app.json → exit 0
npm run build        → ✓ built（exit 0）
npm run lint         → 仅 server/nativeResponses.ts:200/203 两条既有告警
真实 ~/.codex/hooks.json、~/.claude/settings.json、~/.claude/RTK.md、~/.claude/CLAUDE.md、
     ~/.cursor/hooks.json、~/.gemini/settings.json 的 sha256 在全部证据跑完后逐项不变（见 §7）
```

---

## 1. 缺陷 1（中高）连带写入是单向的

**修前复现**（红队 task-9 §1；我在隔离实例 8799 + 临时 HOME 上同样复现）：

```
POST /api/rtk/toggle {"agent":"cursor","on":true,...}  → 200，响应里没有 collateralReverted/Touched
AFTER cursor ON : cursor_rtk=1  claude_rtk=1   ← .claude/settings.json 被静默写入
                  .claude/RTK.md、.claude/CLAUDE.md 被凭空创建
POST /api/rtk/toggle {"agent":"cursor","on":false,...} → 200，claude 钩子仍留在原地
```

**根因**：`repairCollateral()` 只处理 `wasOn && !isOn`（原本开着被关掉）这一方向；对「原本关着被打开」既不还原也不上报，UI 也只在 `collateralRestored` 非空时提示。

**改法**（`server/rtkService.ts`）：

- 守卫集从「其他 agent 的 hookFile」扩成 `guardEntries()`：其他 agent 的 **hookFile + extraFiles（RTK.md/CLAUDE.md/GEMINI.md…）+ `.bak`**。
- `reconcileCollateral()` 双向处理：`wasOn && !isOn` → 修回（`collateralRestored`）；`!wasOn && isOn` → 按快照撤回（`collateralReverted`）；说明文件任何改动一律还原；被撤回/修回的文件若被 CLI 留下新 `.bak`，一并清掉（原本就有的 `.bak` 不动）。
- 失败路径也执行同一套还原（CLI 可能已经动过别人的文件）。
- 响应新增 `collateralReverted[]`、`collateralFiles[]`（`collateralRestored[]` 保留），UI 逐条显示。

**修后证据**（HTTP 级，隔离实例 + 临时 HOME，`/tmp/rtk-r2-evidence/evidence.json`）：

```json
"afterOn": {
  "claudeRtkHooks": 0, "cursorOn": true, "claudeOn": false,
  "rtkMd": false, "claudeMd": false,
  "collateralReverted": ["claude"],
  "collateralFiles": [".claude/RTK.md", ".claude/CLAUDE.md", ".claude/settings.json"]
},
"afterOff": { "claudeRtkHooks": 0, "cursorOn": false, "claudeOn": false, "rtkMd": false, "claudeMd": false }
```

UI（隔离实例，截图 `shots/round2-11-collateral-notice.png`）：

```
cursor 已挂载；机制=rtk-cli；已撤回 rtk 连带打开的其他客户端：claude
（.claude/RTK.md、.claude/CLAUDE.md、.claude/settings.json）；本次备份 2026-10-01T01-06-44-434Z（29 个文件）
```

临时 HOME 复查：只落地 `.cursor/hooks.json`，`.claude/` 为空目录（settings.json 原本不存在 → 删除，未残留）。

**反向不许改坏**：新增用例「缺陷 1（反向）：claude OFF 连带删掉的 cursor 钩子仍要修回」断言 `collateralRestored:['cursor']` ✅；另加用例「既有 claude 已开启」断言 cursor ON 时 `.claude/settings.json` **字节不变** ✅。

---

## 2. 缺陷 2（中）local 平面谎报「已安装」

**修前复现**：`RTK_BIN=/nonexistent/rtk` 时同一响应里 `connected:false / path:null` 与 `detail:"本机 rtk 已安装"` 并存，页面显示绿色「本机 · 已接通」。

**根因**：`rtkPlane.ts` 里 `resolveRtkPlane()` 调 `probeLocalPlane()` 没传参，`binFound` 默认 `true`。

**改法**：`RtkPlaneState` 增加 `degraded`；`findRTKBinary()` 移到 `rtkPlane.ts`（避免 rtkService↔rtkPlane 循环依赖，rtkService 继续 re-export 保持兼容）；`probeLocalPlane(binFound)` 在未安装时返回 `state:'degraded'`、`reason:'local_rtk_missing'`、`detail:'本机未安装 rtk：仍可读写 agent 配置，但无法执行 rtk CLI（安装后重试）'`；`resolveRtkPlane()` 用 `findRTKBinary() !== null` 作为默认值。UI 新增琥珀色「可用但未装 rtk」标签（不再显示绿色「已接通」）。

**修后证据**：

```json
"defect2": { "http": 200, "plane": "local", "connected": false, "path": null,
  "localPlane": { "state": "degraded", "reason": "local_rtk_missing",
                  "detail": "本机未安装 rtk：仍可读写 agent 配置，但无法执行 rtk CLI（安装后重试）" },
  "toggle": { "status": 503, "reason": "rtk_binary_missing" } }
```

用例「缺陷 2：rtk 未安装时 local 平面不再谎报『已安装』」断言 detail 不含「已安装」且 `connected:false` ✅

---

## 3. 缺陷 3（中高，数据完整性）写坏的文件不回填

**修前复现**（红队 §3；假 rtk「照常 exit 0 但把 `.codex/hooks.json` 覆盖成垃圾」）：

```
before: 190 bytes 合法 JSON（含第三方 echo third-party-a）
POST /api/rtk/toggle → 409 hook_file_unparsable + backup 路径
after : 16 bytes 内容 "THIS IS NOT JSON"      ← 原件只在备份目录里，没有回填
```

**根因**：`existedBefore` 是在 CLI **之后**才读的（旧 `rtkService.ts:729`），失败路径 `writeFileAtomic(filePath, existedBefore)` 等于把坏内容写回坏内容。

**改法**：

- 备份与快照全部前移到 CLI **之前**：`snapshot` 现在同时包含目标 `hookFile` + `extraFiles` + 全部守卫文件；失败路径统一走 `restoreTargets()` 用快照原子回填（写临时文件 + rename）。
- 409/502 文案补「原文件已按备份回填，也可用 `/api/rtk/rollback` 恢复」。
- 附带项：把权限/磁盘等原生异常包成 `RtkPlaneError(500,'local','hook_write_failed', '写入 <agent> 的钩子配置失败（EACCES）：原文件未改动，已备份，可用 /api/rtk/rollback 恢复')`，**不回显服务器临时路径**。

**修后证据**（HTTP 级，假 rtk `RTK_BIN=/tmp/.../fake-rtk-corrupt.sh`）：

```json
"defect3": {
  "http": 409,
  "restoredByteIdentical": true,
  "backupExists": true,
  "body": {
    "error": "codex 的 .codex/hooks.json 不是合法 JSON，拒绝覆盖；原文件已按备份回填，也可用 /api/rtk/rollback 恢复",
    "plane": "local", "reason": "hook_file_unparsable",
    "backup": "/tmp/rtk-r2-evidence/d3/backups/2026-10-01T00-59-24-465Z"
  }
}
```

备份目录里同时留有 `.codex__hooks.json` 原件与 `manifest.json`。用例「缺陷 3」「缺陷 3（附带）EACCES」覆盖这两条路径 ✅

---

## 4. 缺陷 4（低中）备份无保留策略 + 响应膨胀

**修前复现**：25 次 toggle → 46 个目录 1.3M；每次 toggle 响应带「最近 10 个备份 + 完整文件清单」。

**改法**：

- `rtkBackupKeep(env)`：`RTK_BACKUP_KEEP`（1–200，默认 10）。
- `pruneRtkBackups(home, keep)`：每次建备份后立即轮转，删掉超出的旧目录（rollback 只恢复不清理，所以清理必须在这里）。
- `RtkBackupSummary` 改为 `{ id, at, fileCount }`（去掉完整文件清单）。
- **toggle 响应不再回传 `backups` 历史**，只给本次的 `backup`（目录）、`backupId`、`backupFileCount`；status 只保留紧凑摘要（≤ `min(keep,10)` 条）并新增 `backupKeep`。

**修后证据**：

```json
"backups": { "keep": 3, "dirs": 3,
  "summaries": [{ "id": "2026-10-01T00-59-23-534Z", "at": "…", "fileCount": 29 }, …],
  "summaryHasFileList": false },
"afterOn": { "hasBackupHistory": false, "backupId": "2026-10-01T00-59-23-407Z", "backupFileCount": 29 }
```

用例「缺陷 4：备份按 RTK_BACKUP_KEEP 轮转，toggle 响应不回传备份历史」断言 5 次 toggle 后目录数 = 3、响应无 `backups`、摘要无 `files` ✅

---

## 5. 缺陷 5（中，UI）失败提示被状态刷新清空

**修前复现**（红队 §5）：点「安装 rtk」→「确认执行」→ 提示出现后立即消失（`load()` 成功时 `errorText=''`），全部失败路径都表现为「点了没反应」。

**改法**（`src/pages/RtkPage.vue`）：

- `load()` 只在 catch 里写错误，**永不清理** `errorText`。
- 错误只在「用户下一次操作真正开始」或「手动关闭提示」时清除；提示里加了 `data-testid="rtk-error-text"` 与「关闭提示」按钮。
- 成功提示与失败提示分开渲染，失败优先。

**修后证据**（真实浏览器，`shots/round2-11-error-persistent.png`）：

```
immediate  : HTTP 501 · 控制台不代为安装本机 rtk，请人工执行：curl -fsSL https://www.rtk-ai.app/install.sh | sh · 平面=local · 原因=local_install_not_supported
after 3.5s : 同一文本，元素仍可见（stillVisibleAfter3s: true，元素在视口内）
```

---

## 6. 缺陷 6（中，UI/无障碍）确认框 Escape 不可靠

**修前复现**（红队 §6）：连续 4 次「打开确认框 → 只按一次 Escape」全部没关（页面自己用 `TxModal`，Escape 绑在遮罩元素上，焦点一旦不在遮罩子树就失效）。

**改法**：删掉页面自带的 `TxModal` + `pending` 状态，改为复用全局 `confirm()`（`src/lib/confirm.ts` + `App.vue` 挂载的 `ConfirmHost`，Lead 已在其中加了 window 捕获阶段 Escape 与触发元素焦点归还）。每个操作在 `await confirm(...)` 通过后才真正发请求。

**修后证据**（真实鼠标点开，连续 4 轮，每轮只按一次 Escape）：

```json
[{"i":0,"closedByOneEscape":true,"focusAfterEscape":"安装 rtk"},
 {"i":1,"closedByOneEscape":true,"focusAfterEscape":"安装 rtk"},
 {"i":2,"closedByOneEscape":true,"focusAfterEscape":"安装 rtk"},
 {"i":3,"closedByOneEscape":true,"focusAfterEscape":"安装 rtk"}]
```

截图：`shots/round2-11-confirm-open.png`（确认框打开）、`shots/round2-11-escape-closed.png`（Escape 后关闭且焦点回到触发按钮）。
补充（红队「附带发现」）：确认框文案不再承诺「失败自动还原」这一绝对说法，改为「写入前会备份，失败会按备份回填；若 rtk 连带改动了别的客户端，控制台会把连带改动一并撤回并在结果里说明」。

---

## 7. 真实配置零改动自证

同一轮证据脚本在跑完全部 HTTP 用例后比对真实 home（`/tmp/rtk-r2-evidence/evidence.json` → `realHomeCheck`）：

```
~/.codex/hooks.json        d234642427dd4c2e → d234642427dd4c2e
~/.claude/settings.json    c08f957851d68845 → c08f957851d68845
~/.claude/RTK.md           dc37dc6afdf51320 → dc37dc6afdf51320
~/.claude/CLAUDE.md        5afc2f75a1f96a72 → 5afc2f75a1f96a72
~/.cursor/hooks.json       4734d152efa28ffb → 4734d152efa28ffb
~/.gemini/settings.json    196e2dca8dacab1b → 196e2dca8dacab1b
```

另外，`server/rtkService.test.ts` 在 `NODE_TEST_CONTEXT` 下对真实 home 的写入有硬闸门（`test_context_real_home_refused`），并在文件末尾 `after()` 里比对 10 个真实 agent 文件的 sha256。

浏览器取证时：缺陷 5/6 在**现网 8791** 上做（只读：Escape 一律取消、安装固定 501，零写入）；缺陷 1 的 UI 提示在**隔离实例 8799（临时 HOME/DATA_DIR）**上做，避免动真实 `~/.cursor`、`~/.claude`。

---

## 8. 改动文件

| 文件 | 说明 |
| --- | --- |
| `server/rtkPlane.ts` | `degraded` 状态、`findRTKBinary()` 迁入、`probeLocalPlane(binFound)`、`resolveRtkPlane` 注入 `localBinFound` |
| `server/rtkService.ts` | 双向 `reconcileCollateral` + 守卫集扩展、CLI 前快照与失败回填、结构化写错误、备份轮转与摘要瘦身、toggle 响应去掉历史 |
| `server/rtkService.test.ts` | +6 条用例（缺陷 1 正反向/缺陷 2/3/3-附带/4） |
| `src/pages/RtkPage.vue` | 全局 `confirm()`、失败提示常驻、连带改动如实提示 |
| `src/components/RtkBoard.vue` | `degraded` 标签配色、备份摘要 `fileCount`、保留策略文案 |
| `src/types.ts` | `degraded`、`fileCount`、`backupKeep`、`collateralReverted/Files` |
| `docs/qa/blue/shots/round2-11-*.png` | 4 张 UI 证据截图 |
| `docs/qa/blue/rtk-round2-fixes.md` | 本文件 |

未改 `server/index.ts`（RTK 路由段）、`src/router.ts`、`src/components/ConsoleNav.vue`、`src/lib/**`、`src/components/ConfirmHost.vue`、其他页面。

---

## 9. 未做 / 未验证

1. **toggle 审计行仍不含连带改动明细**：`addAudit('toggle_rtk_hook', …)` 的行文本在 `server/index.ts` 的 RTK 路由段里，本轮未获授权改动，因此 `collateralReverted/Files` 只出现在 HTTP 响应与 UI 里。若需要进审计，请授权我补一行 details。
2. **`.bak` 清理只覆盖「被撤回/修回」的守卫文件**：目标文件自己的 `.bak`（rtk CLI 的产物）仍保留，未纳入备份清单（红队「附带发现」里的这一条只做了一半）。
3. **「文件写完 ≠ 生效」的提示仍缺失**：rtk CLI 会提示「Restart Codex / 首次使用需批准 hook 信任」，控制台只保留 exitCode/stderr，未在 UI 传达 T17 那条。本轮未做（属文案改动，可与 B 层帮助页一起排）。
4. **`writeMode=local` 时 API 不强制 `confirm:true`**：保持原设计（UI 始终带 confirm，API 面更宽），未改。
5. 缺陷 5/6 只验证了 Chromium（ego-lite）与桌面视口；未覆盖其他浏览器与窄屏。
