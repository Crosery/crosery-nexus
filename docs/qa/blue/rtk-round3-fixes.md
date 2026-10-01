# RTK 第三轮缺陷修复（task-16 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依据：`docs/qa/red-team/rtk-round3-verification.md` 与 `docs/qa/red-team/evidence/round3/`（task-9 复验）+ task-16 描述

5 条逐条：修前复现 → 根因 → 改法 → 修后证据。HTTP 级证据全量在 `/tmp/rtk-r3-evidence/evidence.json`。

---

## 0. 汇总

| # | 缺陷 | 优先级 | 状态 | 修后判据（实测） |
| --- | --- | --- | --- | --- |
| 1 | 轮转会删掉在飞/刚返回的 backupId | P0 | ✅ | 6 个并发 toggle（KEEP=2）：id 全唯一、目录+manifest 全在、拿响应里的 id 去 rollback → **200** |
| 2 | OFF 与 ON 的写后校验不对称（OFF 能把坏文件报成成功） | P0 | ✅ | 同一个「exit 0 但写坏文件」的假 rtk：ON **409**、OFF **409**，两边都回填到操作前原文 |
| 3 | 整文件还原会抹掉 CLI 窗口内的第三方改动 | P1 | ✅ | 条目级最小差异还原：窗口内新增的 `user-added-during-cli` 保留，rtk 自己那条被摘掉 |
| 4 | 目标文件自身的 `.bak` 未纳管 | P1 | ✅ | 成功与失败路径都把用户原有 `.bak` 还原；响应给 `preservedBak` |
| 5 | 同一 agent 同时出现在 reverted 与 restored | P2 | ✅ | `collateral` 每个 agent 只有一条（`action` 唯一），旧字段互斥，audit 输出 `collateral=restored:claude` |
| 附 | 无 manifest 的孤儿备份目录不清理 | 次要 | ✅ | 过保护窗口后清理（含红队 ⑦ 的 `zzz-orphan` 空目录）；`status.backupOrphans` 如实计数 |
| ⑥ | 宽并发下 rtk CLI 互相干扰、部分 agent 稳定 502 / 状态互相抹掉（红队报告 §3） | P2 | ✅ | 本机写操作改为**进程内全局串行**（按 home）：12 路并发全部 200，最终 6 个 agent 全部保持挂载 |
| ⑧ | ON 方向的连带说明写成「被连带关掉」 | P3（措辞） | ✅ | 由 §5 的 `collateral` 唯一真源顺带修好：该场景 action=`reverted`，UI 文案为「已撤回 rtk 连带打开的其他客户端」 |

验证汇总：

```
npm run test:magpie → ℹ tests 69 · pass 68 · fail 0 · skipped 1   （新增 8 条：P0-1 ×2 / P0-2 / P1-a ×2 / P1-b / P2 / ⑥ 宽并发）
npx tsc -b → 0 ；npx tsc -p tsconfig.app.json → 0 ；npm run build → ✓ ；npm run lint → 仅既有 2 条 nativeResponses 告警
真实 ~/.codex/hooks.json、~/.claude/settings.json、~/.cursor/hooks.json、~/.gemini/settings.json、
     ~/.codex/hooks.json.bak 的 sha256 在全部证据跑完后逐项不变（见 §6）
```

---

## 1. P0-1 轮转误删在飞备份

**修前复现**（红队 `evidence/round3/03-rotation.txt` §4.3；我在隔离实例上同样复现）：`RTK_BACKUP_KEEP=1` 下 2 个并发 toggle，两个请求都返回 200，但**其中一个响应里的 backupId 在返回时已被轮转删掉**，拿它 rollback → 404 `backup_not_found`。

**根因**：`pruneRtkBackups()` 在每个写请求里立刻执行「只留最新 N 份」，没有任何「在飞/刚创建」概念；并发下先完成的请求会删掉别的请求正在返回的目录。

**改法**（`server/rtkService.ts`）：

- 双条件保护（task 建议的形状）：
  - `beginRtkBackupUse(id)` / `endRtkBackupUse(id)`：进程内维护「正在处理中」的备份 id 集合，`finally` 里释放，轮转跳过；
  - `RTK_BACKUP_GRACE_MS`（默认 **120000**）：窗口内新建的备份一律不轮转；两者都在 `pruneRtkBackups(home, keep, { protect })` 里生效。
- 备份 id 加 6 位随机后缀（`2026-10-01T01-32-15-629Z-c91e77`）：并发请求落在同一毫秒时不再互撞目录（原来的 id 只有毫秒精度，同毫秒并发会互相覆盖）。
- 孤儿目录纳入同一套保护窗口后清理：**备份 id 形状**的目录（无 manifest）与**空目录**（崩溃时只 mkdir 了目录）过窗口即清；**不认识的目录只计数不删**（`status.backupForeign`），避免误删用户放进备份根目录的东西。红队 ⑦ 的 `zzz-orphan`（空目录）会被清掉。

**修后证据**（HTTP，`RTK_BACKUP_KEEP=2`，6 个不同 agent 并发）：

```
statuses: [200×6]，ids 唯一 = true
allAlive = true（每个 id 的目录 + manifest.json 都在）
POST /api/rtk/rollback {"backup":"2026-10-01T01-32-15-629Z-c91e77","confirm":true} → 200 {"backupId":"…629Z-c91e77"}
status: backupKeep=2, backupGraceMs=120000, backupOrphans=1（我塞的孤儿目录被如实计数）
```

新增用例：`P0-1 轮转不得删掉在飞/刚创建的备份`、`P0-1（次要）孤儿备份目录`。原「缺陷 4」用例改为显式 `RTK_BACKUP_GRACE_MS=0`，用于验证窗口之外仍按 N 保留的语义。

---

## 2. P0-2 OFF 路径写后校验只看标记存在

**修前复现**（红队 `evidence/round3/02-integrity-degraded.txt` §3.4；我复现一致）：假 rtk「exit 0 但把 `.codex/hooks.json` 写成垃圾」——

```
ON  → 409 hook_file_unparsable（诚实）
OFF → 200 成功，文件已是垃圾          ← 方向不对称
```

**根因**：写后校验只有 `verifyLocalHook(spec, on, home)`，它判的是「标记还在不在」；文件变成垃圾时标记自然不存在，OFF 就被判成成功。

**改法**：新增 `hookFileIntegrity(spec, home)`（`JSON_HOOK_FILES` 白名单内的钩子文件：不存在/空是合法终态，存在则必须是合法 JSON 对象），**ON 与 OFF 共用同一条判定链**：

```
跑 CLI → ①文件完整性不通过 → 409 brokenHookFileError（回填 + plane/reason/backup）
        → ②目标状态未达成 → 走已核实 schema 兜底 / 502 hook_write_unverified（同样回填）
        → ③两者都通过 → 成功
```

兜底写入后也再查一次完整性；`hook_cli_failed` 现在同样带 `backup`。

**修后证据**（HTTP，同一个假 rtk）：

```json
"on" : {"http":409,"reason":"hook_file_unparsable","plane":"local","backup":true,"restoredByteIdentical":true,"bakRestored":true},
"off": {"http":409,"reason":"hook_file_unparsable","plane":"local","backup":true,"restoredByteIdentical":true,"bakRestored":true}
```

新增用例：`P0-2 OFF 与 ON 共用同一套写后校验`（ON/OFF 两个方向都断言 409 + 原文回填 + 备份存在）。

---

## 3. P1-a 整文件还原抹掉窗口内的合法改动

**修前复现**：`collateralReverted` 走整文件快照替换 `.claude/settings.json`；用户在「CLI 执行中」这段时间对同一文件的合法改动会被静默回滚。

**改法**：选择 task 的 (a) 方案——**条目级最小差异还原**（`minimalCollateralEdit()`），并且**钩子文件一律走这条路**（不再依赖「CLI 之后有没有被改过」的事后判定，因为窗口内的改动在 CLI 结束时已经混进文件，事后比对看不出来）：

1. 摘掉**本次 rtk 新增**的条目：只认 rtk 自己的 `command`（`rtk hook <agent>`），且该条目在操作前的快照里不存在；
2. 补回**被 CLI 删掉的原条目**：操作前有、CLI 之后没有、当前也没有的，按原样补回；
3. 用户在窗口内新增的条目（不含 rtk command）原样保留；
4. 结构不认识（文件非法 JSON / 列表结构异常）→ **不写**，返回 `skipped` 并如实上报 `collateralSkipped[{agent,file,reason}]`。

说明文件类（`.claude/RTK.md`、`.claude/CLAUDE.md` 等 rtk 生成物）仍按快照整文件还原；若 CLI 之后又被第三方改过（`current !== after`）则不覆盖并上报 skip。

**修后证据**（HTTP，假 CLI 在写 rtk 条目的同时写入一条「用户窗口内新增」的条目）：

```json
{"http":200,
 "commands":["orca-hook","user-added-during-cli"],   // 只摘掉 rtk 自己那条，用户改动保留
 "collateralReverted":["claude"],"collateralSkipped":null}
```

另有用例验证「结构不认识就不覆盖」：伪造未加引号的坏 JSON → `collateralSkipped=[{agent:'claude',file:'.claude/settings.json',reason:'unparsable_or_unknown_shape'}]`，文件原样留在 `not json at all`。

---

## 4. P1-b 目标文件自身的 `.bak` 未纳管

**修前复现**：rtk CLI 会覆写 `<hookFile>.bak`；用户原有的 `.bak` 被静默替换，失败路径也不还原。

**改法**：把 `<hookFile>.bak` 加入**目标文件集**（与 hookFile、extraFiles 同级）——于是它自动进入备份、CLI 前快照、失败回填；成功路径额外执行 `preserveUserBaks()`：操作前就存在、且被 CLI 改过的 `.bak`，一律还原成用户原件，并在响应里回 `preservedBak[]`。

**语义写清**：`.bak` 是「用户自己的备份文件」，不是 rtk 的产物；控制台永远保证它回到操作前的内容。rtk 新建的 `.bak`（操作前不存在的那种）保留不动。

**修后证据**（HTTP）：

```json
p1a: {"preservedBak":[".cursor/hooks.json.bak"],"userBakKept":true}      // 成功路径
p02: {"on":{"bakRestored":true},"off":{"bakRestored":true}}              // 失败路径
```

新增用例：`P1-b 目标文件自己的 .bak 纳管：成功后还原用户原件，失败后也回到操作前`。

---

## 5. P2 reverted / restored 重复

**修前复现**：同一 agent 可能同时进两个集合 → audit 出现 `collateral=reverted:claude|restored:claude`，UI 同时显示「已撤回」和「已修复」。

**改法**：新增**唯一真源** `collateral: Array<{agent, action, files, reason?}>`，每个 agent 只有一条，`action ∈ {reverted, restored, skipped}`；同一 agent 两个方向同时出现时按确定性优先级取最终态 `restored > reverted > skipped`。旧字段 `collateralReverted` / `collateralRestored` 由 `collateral` **派生**，天然互斥——`server/index.ts` 的审计行不用改，输出自动变成单一集合；UI 也改成读 `collateral`（与 audit 同源）。

**修后证据**（HTTP，假 CLI 同时做「删掉 claude 已有条目」与「新建 .claude/RTK.md」两件事）：

```json
{"collateral":[{"agent":"claude","action":"restored","files":[".claude/RTK.md",".claude/settings.json"]}],
 "collateralReverted":null,"collateralRestored":["claude"],"disjoint":true,
 "auditDetails":"on=true, plane=local, outcome=ok, mechanism=rtk-cli, collateral=restored:claude"}
```

新增用例：`P2 同一 agent 不会同时出现在 reverted 与 restored`。

---

## 6. 真实配置零改动自证

```
~/.codex/hooks.json        d234642427dd4c2e → d234642427dd4c2e
~/.claude/settings.json    c08f957851d68845 → c08f957851d68845
~/.cursor/hooks.json       4734d152efa28ffb → 4734d152efa28ffb
~/.gemini/settings.json    196e2dca8dacab1b → 196e2dca8dacab1b
~/.codex/hooks.json.bak    d66d0cc41ad23dbe → d66d0cc41ad23dbe
```

所有缺陷复现都在一次性实例（`PORT=8799`，`DATA_DIR`/`RTK_HOME`/`RTK_BACKUP_DIR` 全在 `/tmp`）上完成；单元测试继续用临时 HOME，并在 `NODE_TEST_CONTEXT` 下对真实 home 有硬闸门。

现网（已按 COORDINATION 取锁重启 `com.crosery.console-magpie`）：

```
GET /api/rtk/status → plane=local, kernel:not_supported:kernel_rtk_seam_missing,
  relay:not_supported:relay_route_missing, local:available:local_host
  backupKeep=10, backupGraceMs=120000, backupOrphans=0,
  backups=[{id,at,fileCount:29},{id,at,fileCount:13}]（仍是紧凑摘要，无 files 清单）
```


---

## 7bis. ⑥ 宽并发下 rtk CLI 互相干扰（红队报告 §3，task-16 未列但同属本文件）

**修前复现**（红队 §3 ⑥ + 我在隔离实例上的复现）：12 路并发（6 agent × 2 次 ON，fresh HOME）——

```
红队：批次1 gemini 502 ×2；批次2/3 pi 502 ×2    （错误体 502 hook_cli_failed「rtk 执行成功但目标状态未生效」）
我的复现（B 版代码）：12 个请求**全部 200**，但**最终只有最后一个 agent 还是挂载状态**（其余被抹掉）
```

**根因**（两层，我这边才是主因）：`applyLocalAgentHook` 的「快照 → CLI → 连带还原 → 校验」整体不是原子的。
并发时 A 的合法写入会落在 B 的快照之后、B 的连带还原之前，于是 B 把 A 刚打开的那个 agent 当成「rtk 的连带改动」**撤回**掉，
结果每个请求都返回 200，但互相抹掉（红队看到的 502 是同一竞态在「校验」时点的另一种表现）。

**改法**：

- 本机写操作改用**进程内全局串行闸**（按 home 区分）：`withFileLock('rtk-local-write:' + home, …)` 包住整个操作，
  使「快照 → CLI → 还原 → 校验」相对其它本机写操作原子；per-agent 文件锁保留（同 agent 串行语义不变）。
- rtk CLI 调用另外加一次**串行重试**：`exit 0 但目标状态未生效` 时，在同一条闸内重跑一次再判定（红队建议的形状）。
- 代价：同一台机器上的本机 toggle 串行执行（实测 12 路总耗时仍是百毫秒级）；不同 home 互不阻塞。

**修后证据**（HTTP，12 路并发，真实 rtk，fresh HOME）：

```json
{"statuses":[200,200,200,200,200,200,200,200,200,200,200,200],"failures":[],
 "finalOn":["claude","codex","copilot","cursor","gemini","pi"]}
```

新增用例：`红队 ⑥ 宽并发下 rtk CLI 不再互相干扰：6 个 agent × 2 次并发 ON 全部成功`。

**⑧ 措辞**：该场景（claude 原本 off、被 cursor ON 连带打开、随后被还原）现在净结果是 `collateral` 里 `action='reverted'`、
`collateralReverted:["claude"]`，UI 输出「已撤回 rtk 连带打开的其他客户端：claude」——不再出现「被连带关掉」的错向表述。

---

## 7. 改动文件

| 文件 | 说明 |
| --- | --- |
| `server/rtkService.ts` | 本机写操作进程内全局串行闸 + CLI 串行重试；轮转双条件保护 + 随机 backupId + 孤儿/陌生目录区分处理；`hookFileIntegrity` 统一 ON/OFF 校验；`minimalCollateralEdit` 条目级还原 + `collateralSkipped`；目标 `.bak` 纳管与 `preservedBak`；`collateral` 唯一真源 |
| `server/rtkService.test.ts` | 新增 8 条用例（P0-1 ×2、P0-2、P1-a ×2、P1-b、P2、⑥ 宽并发）；原缺陷 4 用例显式设 `RTK_BACKUP_GRACE_MS=0` |
| `src/types.ts` | `RtkCollateralEntry`、`collateral`/`collateralSkipped`/`preservedBak`、`backupGraceMs`/`backupOrphans` |
| `src/pages/RtkPage.vue` | 结果提示改成读 `collateral`（与 audit 同源），新增「并发修改未自动还原」「已还原你原有的备份文件」提示 |
| `src/components/RtkBoard.vue` | 备份区说明补保护窗口与孤儿计数（保留 Lead 在 `0e27b9e` 加的「写完 ≠ 生效」提示，未回退） |
| `docs/qa/blue/rtk-round3-fixes.md` | 本文件 |

未改 `server/index.ts`、`src/router.ts`、`src/components/ConsoleNav.vue`、`src/lib/**`、`src/components/ConfirmHost.vue`、其他页面。

---

## 8. 未做 / 未验证

1. **跨进程并发**：`beginRtkBackupUse` 与全局写闸都是**进程内**的；两个进程同时写同一个 HOME（多实例共用一个 `RTK_HOME`）仍可能互相抹掉，只靠 120s 备份保护窗口兜底。当前部署只有一个控制台进程，够用；若将来多进程，需要文件锁（`flock`）级别的保证。
2. **保护窗口是可配的经验值**：极端情况下（一次批量操作超过 120s 才返回）仍可能被更晚的请求轮转掉；可把 `RTK_BACKUP_GRACE_MS` 调大或改用引用计数。
3. **条目级还原的边界**：只对已核实 schema 的 6 个 JSON 钩子文件做条目级还原；说明文件与其它形态（扩展/插件/TOML）仍是整文件还原（并在检测到并发修改时跳过）。
4. **`collateralSkipped` 的人工收口**：上报了但没有提供「一键按快照强制还回」的按钮（避免误覆盖）；目前需要手动 rollback。
5. UI 侧本轮只做了类型/文案同步，未再做浏览器实测（前一轮的 4 张截图仍有效；本轮改动集中在后端与提示文案）。
