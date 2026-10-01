# RTK × 中转站 / 内核控制面 同步缺口审计（红队 A / task-1）

日期：2026-10-01 · 仓库：`/Users/crosery/work_file/crosery-api-console` @ `281c30e`
审计者：rtk-auditor（只读；未改任何 `src/`、`server/`、`deploy/` 文件，未执行任何会改本机 agent 配置的命令）
证据目录：`docs/qa/red-team/evidence/`（12 个文件，全部可被本次命令原样复现）

标记约定：**【已验证】**＝有 file:line 或命令+输出；**【推断】**＝由已验证事实直接推出；**【未验证】**＝无法取证。

> ⚠️ **基线说明（重要）**：本文所有 `file:line` 引用都针对**基线提交 `281c30e`**（审计开始时的工作区内容与 HEAD 逐行一致，已用 `git show 281c30e:server/rtkService.ts` 复核）。审计期间蓝队 `blue-rtk` 已重写工作区的 `server/rtkService.ts`（`git diff --stat`：+948/-253）并新增 `server/rtkPlane.ts`，**因此当前工作区的行号已不适用**；引用时请用 `git show 281c30e:<path>` 或基线 commit 复核。蓝队 WIP 与反例测试的对应关系见 §8。

---

## 0. 结论摘要（先看这段）

用户原话「RTK 设置等相关配置没有同步到我们的中转站链接里」最可能的指代，按置信度排序：

| 排序 | 解释 | 置信度 | 一句话依据 |
| --- | --- | --- | --- |
| 1 | **控制台里的 RTK 面板/开关根本没有走控制面**：它直接读写本机 `~/.codex`、`~/.claude`，内核 `/internal/rtk` seam 未接、中转站 `/api/library/rtk` 在本机证据里是 404 | 高 | `server/index.ts:1116-1137` 只调 `rtkService`；内核 socket `GET /internal/rtk` → **400 `request id required`**（运行中的内核没有这条路由）；`GET https://ai.crosery.com/api/library/rtk` → **404** |
| 2 | **点开关不生效**：6 个 agent 里只有 Codex 名义上"接了"，Claude/Gemini 即使换成正确命令也**只提示"手工添加"、exit 0 却不写配置**，其它 agent 一半命令非法，关闭路径 100% 失败 | 高 | `rtk init -g --claude` → **exit 2**；`rtk init -g --agent claude`（正确命令）→ **exit 0 但 `settings.json` 未写入**（stderr：`(non-interactive mode, defaulting to N)`）；`rtk init --uninstall` → **exit 1**（`server/rtkService.ts:327,329`） |
| 3 | **中转站那台机器上的 RTK 也要能下发**（D 层）：现在仓库里没有任何远程执行通路，中转站也没有 RTK 接口 | 中 | 仓库 `scripts/`、`server/` 无 ssh/远程执行；中转站三类 RTK 路径全部 404 |
| 4 | **帮助页给用户的中转站链接没把 RTK 带进去**（B 层）：`HelpPage.vue` 全文 0 处 RTK；且 `https://ai.crosery.com/v1` 是**推理端点**，本身不承载配置 | 中 | `src/pages/HelpPage.vue:12`；实测 `GET /v1` → 404、`GET /` → `{"message":"CLI Proxy API Server"}` |
| 5 | 把 RTK 配置写进 `MAGPIE_SOURCE_CPA_BASE_URL` 指向的 CPA 管理面 | 低（应排除） | `server/magpieControl.ts:22-45` 对该管理面**只做 6 类凭据端点的 GET**；CPA 无 RTK 概念（`/v0/management/rtk` → 404） |

**最先要修的三件事**（也是"点了不生效"的直接原因）：

1. `server/rtkService.ts:284-286` 手写的 Codex hook 形状与 rtk 0.50.0 权威形状不一致（缺 `matcher` 与嵌套 `hooks[{type,command}]`）→ Codex 不会执行这个 hook（§2.5 三源对照）。
2. 同一个开关**会先摧毁** `hooks.json` / `settings.json` 里已有的 `PreToolUse` 条目：实测打开一次会删掉 3 条中的 2 条（`09-destructive-overwrite-sim.txt`）。这是数据破坏级 bug，不只是"不同步"。
3. 修好命令也还不够：`rtk init -g --agent claude`（正确命令）在无 TTY 时**exit 0 但不写 `settings.json`**（`(non-interactive mode, defaulting to N)`），`--gemini` 同样；必须显式 `--auto-patch`。关闭路径 `rtk init --uninstall` 缺 `-g` 直接 exit 1，补上 `-g` 又只清 Claude（§3 S5/S6）。

---

## 1. 必答 1：「中转站链接」在本仓库里的候选指代

| # | 候选链接 | 值 / 位置 | 谁读 | 谁写 | 与 RTK 的关系 |
| --- | --- | --- | --- | --- | --- |
| L1 | **CPA 凭据源**（"中转站"最正统的指代） | `MAGPIE_SOURCE_CPA_BASE_URL` 默认 `https://ai.crosery.com`（`scripts/magpie-console.mjs:16`，`.env.example:14`），解析进 `config.magpieSourceCpaBaseUrl`（`server/config.ts:87`） | `server/magpieControl.ts:22-45 readMagpieSource()`（**只 GET** 6 个凭据端点：`openai-compatibility`/`claude-api-key`/`codex-api-key`/`gemini-api-key`/`vertex-api-key`/`auth-files`）；`scripts/magpie-console.mjs:28-32`（prepare 时快照）；`:110` 传给控制台进程 | **无任何写路径**（全仓库仅 3 处引用，均为读/传参） | **不相关**。RTK 不在 CPA 数据模型里；实测 `/v0/management/rtk`、`/v0/management/library/rtk` 均 404 |
| L2 | **本地 CPA 管理面** | `config.cpaBaseUrl` 默认 `http://127.0.0.1:8317`（`server/config.ts:98`） | `server/cpa.ts:61`（`/v0/management/*` 代理）、`:144`、`:412` | 同文件内的管理写操作 | **不相关**：指向本机 CPA，不是中转站；RTK 不经过它（`/api/rtk/*` 在 `server/index.ts` 直连 `rtkService`） |
| L3 | **帮助页给用户复制的接入地址** | `https://ai.crosery.com/v1`（`src/pages/HelpPage.vue:12`，同页 :46/:54/:64/:72/:121/:244/:249/:258） | 用户手抄；页面无任何 API 调用 | 无（纯静态文案） | **不相关**：这是推理端点。实测 `GET /v1` → **404**，`GET /` → `{"endpoints":["POST /v1/chat/completions","POST /v1/completions","GET /v1/models"],"message":"CLI Proxy API Server"}`。**推理 URL 不承载配置下发**，B 层只能在这里加"RTK 怎么装/怎么接"的说明，不能"把设置同步进去" |
| L4 | **控制台自身 HTTP 面** | `http://127.0.0.1:8791`（`scripts/magpie-console.mjs:63`） | 前端 `src/api.ts:72-73`（**死代码**）、`VersionWidget.vue` 读 `/api/version` | `POST /api/rtk/toggle`（`server/index.ts:1126`） | **当前唯一的 RTK 写入路径**，只影响本机 agent 配置 |
| L5 | **内核 unix socket** | `~/.agents/crosery/magpie-console/kernel.sock`（`config.magpieKernelSocket`，`server/config.ts:84`） | `server/cpa.ts:391`、`server/magpieEngine.ts:196,225`、`server/modelSync.ts:173`（只会 `/internal/health`、`/internal/providers`） | 同上 | **seam 已写在源码但未接、也未编译**：`deploy/magpie/kernel/main.go:61-81`，运行中的二进制里 `grep -a -c "/internal/rtk"` = **0** |
| L6 | **上游 Magpie 管理面契约**（`/api/library/rtk`） | `deploy/magpie/UPSTREAM.md:64-76`、`deploy/magpie/upstream/API.md:55`、`packages/contracts/magpie-upstream.generated.ts` | **只被统计**：`server/magpieUpstream.ts:25` 数路由条数；`server/magpieUpstream.test.ts:30` 断言 = 4 | 无 | **这是"应该接却没接"的那条控制面**。中转站 `ai.crosery.com` 上实测 404 |

**一句话**：仓库里"中转站链接"有 L1（凭据源，只读）、L3（帮助页文案，纯静态）、L6（上游契约，只被计数）三种含义，**三种都没有、也不构成 RTK 的同步通道**；RTK 目前是一条纯本地旁路（L4→本机文件）。

---

## 2. 必答 2：RTK 现状实测

### 2.1 本地 RTK 面板：数据是真的，通道是假的 【已验证】

登录后（`admin` + Keychain `com.crosery.console-magpie.local`，密码经 stdin 传入，未落盘、未进 argv）：

```
$ curl -s -c /tmp/rtk-audit-cookies.txt -X POST http://127.0.0.1:8791/api/login --data-binary @-   # body 经 stdin
{"ok":true}
$ curl -s -b /tmp/rtk-audit-cookies.txt http://127.0.0.1:8791/api/rtk/status
{"connected":true,"path":"/Users/crosery/.local/bin/rtk","version":"0.50.0",
 "gain":{"commands":227,"input":210019,"saved":75950,"pct":36.163394740475866},
 "days":[{"date":"2026-08-16",...},{"date":"2026-08-19",...},{"date":"2026-09-30",...}],
 "latest":"v0.50.0","agents":[codex=true,claude=true,gemini=false,cursor=false,omp=true,copilot=false],
 "url":"https://www.rtk-ai.app"}
```
（完整原文：`evidence/03-console-api-rtk-status.runtime.json`）

字段/数值与真实 rtk 输出**逐项对得上**【已验证】。真实输出取自 rtk 数据库快照（`evidence/01-rtk-gain-daily.groundtruth.json`，命令：`HOME=/tmp/rtk-db-home rtk gain --daily --format json`，快照 = `~/Library/Application Support/rtk/{history.db,recall.db,filters.toml}` 的只读拷贝）：

| rtk JSON 字段 | console 字段 | rtk 值 | console 值 | 一致 |
| --- | --- | --- | --- | --- |
| `summary.total_commands` | `gain.commands` | 227 | 227 | ✅ |
| `summary.total_input` | `gain.input` | 210019 | 210019 | ✅ |
| `summary.total_saved` | `gain.saved` | 75950 | 75950 | ✅ |
| `summary.avg_savings_pct` | `gain.pct` | 36.163394740475866 | 36.163394740475866 | ✅ |
| `daily[].date/commands/input_tokens/saved_tokens/savings_pct` | `days[]` | 3 天 | 3 天 | ✅ |

> 复现注意：在**文件沙箱内**直接跑 `rtk gain` 会得到 `Failed to initialize tracking database: ... Error code 14`——这是沙箱拒绝写 `~/Library/Application Support/rtk` 导致的（`touch` 该目录 → `Operation not permitted`），**不是 rtk 或控制台的 bug**；控制台进程不受沙箱约束，读到了真实数据。详见 `evidence/10-rtk-sandbox-caveat.txt`（rtk 自己也会在 `rtk init` 输出里提示 workspace-write 沙箱要加 `writable_roots`）。

### 2.2 `agents[].on` 与真实文件状态：Codex/Claude 的 `on=true` 成立，但**来源不是控制台** 【已验证】

```
$HOME/.codex/hooks.json  : PreToolUse 共 3 条；其中 1 条是 {matcher:"Bash", hooks:[{type:"command",command:"rtk hook codex"}]}
$HOME/.codex/RTK.md      : exists (由 `rtk init --codex` 生成，首行 "rtk-owned")
$HOME/.claude/settings.json: 含 "rtk hook claude"
$HOME/.claude/RTK.md     : exists
$HOME/.omp/agent/extensions/rtk.ts : exists
```
即真实状态是 rtk 官方 CLI 装出来的；控制台只是"读到了"（`server/rtkService.ts:78-158`）。

### 2.3 内核 `GET /internal/rtk` 实测：**运行中的内核没有这条路由** 【已验证】

```
$ curl -s --unix-socket ~/.agents/crosery/magpie-console/kernel.sock http://localhost/internal/health
{"engine":"magpie","ok":true,"revision":"3fe2ff99587e17dfe0ea707ffd0eccc088824433"}          HTTP 200
$ curl -s --unix-socket ... http://localhost/internal/rtk
request id required                                                                          HTTP 400
$ curl -s --unix-socket ... http://localhost/internal/nope-xyz      # 对照组：未匹配路径走 catch-all "/"
request id required                                                                          HTTP 400
$ grep -a -c "/internal/rtk" ~/.agents/crosery/magpie-console/bin/magpie-kernel   → 0
$ grep -a -c "/internal/health" ...                                                → 1
$ ls -l bin/magpie-kernel → Sep 30 16:19
$ git log -S'/internal/rtk' -- deploy/magpie/kernel/main.go → 7e1c8ce  2026-10-01 01:50:20 feat(magpie): adapt magpie kernel, dynamic model sync, oauth and rtk
```
（原文：`evidence/02-kernel-socket-probe.txt`）

**结论**：`400 request id required` 是 `main.go:141-159` 的 catch-all 兜底响应，说明**路由没被匹配**；内核二进制（09-30 16:19）早于 seam 提交（10-01 01:50）。A 层"seam 未接"在运行期得到证实：**不是前端没接，是后端根本没有可用的端点**。

### 2.4 中转站（`https://ai.crosery.com`）管理面实测 【已验证=404 事实；未验证=其"能否改造"】
用已有凭据（`~/.agents/crosery/credentials/AI_CROSERY_MGMT_SECRET`，仅通过 `-H @-` 经 stdin 传入，值未出现在命令行/输出）做**只读 GET**：

```
GET /                                     -> 200  {"endpoints":[...],"message":"CLI Proxy API Server"}
GET /v1/models                            -> 401  {"error":"Missing API key"}
GET /api/library/rtk                      -> 404
GET /health                               -> 404
GET /api/version                          -> 404
GET /v0/management/openai-compatibility   -> 200  (仅统计 bytes/shape，未打印内容)
GET /v0/management/auth-files             -> 200  (同上)
GET /v0/management/rtk                    -> 404
GET /v0/management/library/rtk            -> 404
GET https://console.ai.crosery.com/       -> 200  (HTML 控制台页，不是 API 根)
```
（原文：`evidence/06-relay-readonly-probe.txt`）

**已验证**：中转站是 **CLI Proxy API（CPA）**，其管理面**存在且凭据可用**（`/v0/management/*` 可认证读取），但**没有任何 RTK 相关路由**；Magpie 的 `/api/library/rtk`（`UPSTREAM.md:69-72`）在那里是 404。
**未验证**：中转站宿主机上是否装了 rtk、是否跑着 Magpie GUI 面、是否允许新增 RTK 端点——**本审计无任何证据，不得臆造**。**本次没有对中转站发起任何写操作**（未 POST `/api/library/rtk`、未 POST `/install`、未 `/upgrade`）。

### 2.5 独立复核：Codex hooks schema 与控制台手写形状（lead / blue-rtk 指定项）【已验证 + 一处推断】

三源对照（`evidence/08-codex-hooks-shapes.txt`、`evidence/11-codex-hooks-schema.txt`）：

| 源 | 形状 | 是否含 `matcher` | 是否含嵌套 `hooks[]` |
| --- | --- | --- | --- |
| **(a) rtk 0.50.0 权威输出**（throwaway HOME 跑 `rtk init -g --codex`） | `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook codex"}]}]}}` | ✅ | ✅ |
| **(b) 本机真实 `~/.codex/hooks.json`**（`PreToolUse` 共 3 条，**3/3 都是嵌套 `hooks[]` 形状**；前 2 条省略 matcher，第 3 条 rtk 的带 `matcher:"Bash"`） | 同上结构 | 嵌套 ✅（matcher 可选） | ✅ |
| **(c) 控制台手写**（`server/rtkService.ts:284-286`） | `{"hooks":{"PreToolUse":[{"command":"rtk hook codex"}]}}` | ❌ | ❌ |
| **(d) rtk 给 Claude 的权威形状**（`rtk init -g --agent claude --auto-patch` 实测写出） | `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]}]}}` | ✅ | ✅ |

**Codex 侧独立佐证（codex-cli 0.159.2 原生二进制 `@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`）**：
- 内置 hooks 引擎源码路径串：`hooks/src/types.rs`、`hooks/src/engine/{dispatcher,schema_loader,command_runner,discovery,mcp_runner}.rs`；
- 解析/校验报错串：`failed to parse hooks config `、`invalid generated hooks schema `、`invalid matcher `、`skipping empty hook command in `、`clamping <x> hook timeout to <y>`、`hook exited with code `、`hook returned decision:block without a non-empty reason`、serde 的 `missing field` / `unknown variant` / `unknown field`；
- 事件名枚举：`PreToolUse PermissionRequest PostToolUse PreCompact PostCompact SessionStart SessionEnd UserPromptSubmit SubagentStart SubagentStop Stop Interrupt`；
- 条目结构串（serde 字段相邻）：`matcher` + `hooks` + `HookStateToml` + `trusted_hash`；命令处理器是 `ConfiguredHookHandler::Command with 6 elements`；
- 存在**信任门**：`codex --help` 有 `--dangerously-bypass-hook-trust  Run enabled hooks without requiring persisted hook trust`，`rtk init` 也提示 "For a project hook, approve it when Codex asks you to trust it"。

**结论（已验证）**：控制台写出的条目**既没有 matcher 也没有嵌套 hooks 数组**，与 rtk 权威形状、与本机实际生效的形状、与 Codex 引擎的 schema 均不符，**不可能被当作 command handler 执行**。
**结论（推断，未闭环）**：Codex 是否会**报错拒绝**、还是**静默忽略**该条目，本次未能实测——试过 `CODEX_HOME=<隔离目录> codex doctor --json` 对两种形状各跑一次，`doctor` 不输出 hooks 解析结果（两种形状都因隔离 HOME 的其它检查 `overallStatus=fail`）。该闭环动作已列入反例测试 **T15**。
**附带发现（已验证）**：控制台的 OFF 正则把命令清成 `"command": ""`，而 Codex 引擎对空命令的行为是 `skipping empty hook command in <file>`——即**留下永不执行的垃圾条目 + 一条警告**，而不是干净移除。

---

## 3. 必答 3：「配置没有同步」的具体形态清单

### S1 控制面完全旁路：控制台直写本机 agent 文件，不经过任何控制面 【已验证】

`server/index.ts:1116-1137` 两个端点只 `import('./rtkService.js')`；全仓库 `/internal/rtk` 调用点 **0**，`/api/library/rtk` 调用点 **0**（唯一出现处是 `server/magpieUpstream.ts:25` 的路由计数）。
`server/rtkService.ts:270-337` 直接 `fs.writeFileSync(~/.codex/hooks.json)`、`fs.writeFileSync(~/.claude/settings.json)`。

### S2 内核 seam 已写但未接也未部署（运行期二次确认）【已验证】

源码有 `deploy/magpie/kernel/main.go:61-81`；`server/*.ts` 只调 `/internal/health`、`/internal/providers`（`server/cpa.ts:391`、`server/magpieEngine.ts:196,225`、`server/modelSync.ts:173`）；运行二进制里该字符串计数为 0、`GET /internal/rtk` → 400（见 §2.3）。

### S3 Codex 开关：手写形状错误（rtk 不会认），且**先破坏再修补** 【已验证】

- 权威形状（throwaway HOME 实测 `rtk init -g --codex` 生成）：
  `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook codex"}]}]}}`
- 控制台手写形状（`server/rtkService.ts:284-286`）：`{"hooks":{"PreToolUse":[{"command":"rtk hook codex"}]}}` —— **缺 `matcher`、缺嵌套 `hooks[]`**（对照 `evidence/08-codex-hooks-shapes.txt`）。
- 破坏性：`server/rtkService.ts:283-287` 是**整体赋值** `hooks.PreToolUse = [...]`。在真实文件的**内存副本**上跑同一逻辑：`PreToolUse` 条目 3 → 1，**销毁 2 条**（真实文件里这 2 条分别是 orca 与 clawd 的 PreToolUse hook）；`~/.claude/settings.json` 同样 3 → 1，销毁 2 条。见 `evidence/09-destructive-overwrite-sim.txt`。
- 之后调用的 `rtk init -g --codex` **确实合法**（exit 0），会把 rtk 自己的条目补回去，但**不会恢复被删掉的第三方条目**。
- 形状正确性另有 §2.5 的三源对照结论；**"`--codex` flag 不存在"的说法不成立**：实测 `rtk init -g --codex` exit 0 并写出 `.codex/hooks.json`（`evidence/07-rtk-init-probe.txt`、`evidence/12-rtk-agent-init-matrix.txt`）。

### S4 Claude 开关：命令行直接报错（错误被吞）【已验证】

`server/rtkService.ts:327`：`execFileAsync(bin, ['init','-g',`--${agentId}`])` → agentId=`claude` 时是 `rtk init -g --claude`：
```
$ HOME=/tmp/rtk-init-probe rtk init -g --claude
error: unexpected argument '--claude' found
  tip: a similar argument exists: '--claude-md'
exit=2
```
`rtk init --help` 的合法 flag 是 `--codex` / `--gemini` / `--copilot` / `--opencode` / `--agent <claude|cursor|trae|windsurf|cline|kilocode|antigravity|kimi|pi|hermes|droid|vibe|omp>`；**没有 `--claude`**。异常被 `server/rtkService.ts:331-333` 的空 `catch` 吞掉 → 接口照样返回 200。

> 补充（推翻一处现有怀疑）：`--codex` **存在且合法**，lead 线索里"`--agent` 取值没有 codex"是对的，但 `rtk init -g --codex` 并不是无效命令；真正无效的是 `--claude`、`--cursor`、`--omp`。

**更深的坑（已实测，直接影响"点开关不生效"）**：即使把命令改成正确的 `rtk init -g --agent claude`，在**非交互**（控制台 `execFile` 无 TTY、无 stdin）下默认回答 **N**，退出码仍是 **0**，但 `settings.json` **不会被写入**：

```
$ HOME=/tmp/rtk-claude-probe rtk init -g --agent claude < /dev/null
exit=0
stdout: |RTK hook registered (global).| ... |  MANUAL STEP: Add this to /tmp/.../.claude/settings.json:|  {"hooks": {"PreToolUse": [{"matcher":"Bash","hooks":[{...}]}]}}|  Then restart Claude Code.|
stderr: |Patch existing /tmp/.../.claude/settings.json? [y/N] |(non-interactive mode, defaulting to N)|
settings.json: MISSING

$ HOME=/tmp/rtk-claude-probe rtk init -g --agent claude --auto-patch < /dev/null
exit=0 ; settings.json: EXISTS (写入正确形状)
```
（`evidence/12-rtk-agent-init-matrix.txt`）**`--gemini` 同样**：输出 `Patch .../.gemini/settings.json with RTK hook? [y/N] Skipped. Add hook manually later.`，exit 0，只写了 hook 脚本与 `GEMINI.md`，**没有把 hook 注册进 `settings.json`**。`--codex` / `--copilot` 不需要 `--auto-patch`（实测直接写入）。

### S5 关闭路径 100% 失败，而且**会关错对象** 【已验证】

- `server/rtkService.ts:329`：`rtk init --uninstall`（无 `-g`）→
  ```
  $ HOME=<临时> rtk init --uninstall ; exit=1
  rtk: Uninstall only works with --global flag. For local projects, manually remove RTK from CLAUDE.md
  ```
  前后文件 sha256 快照完全一致 → **一个字节都没改**（`evidence/07-rtk-init-probe.txt`、`12-rtk-agent-init-matrix.txt`）。
- 即便补上 `-g`，**不带 agent 目标时默认只清 Claude**：临时 HOME 里同时装好 codex+claude 后跑 `rtk init -g --uninstall` → exit 0，Claude 的 `settings.json` 条目被移除、`RTK.md` 删除；**Codex 的 `hooks.json` 条目仍是 1 条、`.codex/RTK.md` 仍在、`AGENTS.md` 仍引用 `RTK.md`**。Codex 必须显式 `rtk init -g --uninstall --codex`（实测 exit 0，条目→0、`AGENTS.md` 引用移除），Claude 用 `rtk init -g --agent claude --uninstall`，`omp` 用 `rtk init -g --agent omp --uninstall`（输出 `RTK OMP extension was not installed (nothing to remove)`）。
- 先行的正则清洗 `server/rtkService.ts:292-293` 只把 `"command": "rtk hook codex"` 换成 `"command": ""`，留空命令条目（实测替换 1 处、产生 1 个空命令），`RTK.md` 与 `AGENTS.md` 引用**原样保留**；而 Codex 引擎对空命令的处理是 `skipping empty hook command in <file>`（§2.5）——**留下一堆永不执行的垃圾条目 + 每次启动一条警告**。
- 检测是 OR 链：`server/rtkService.ts:85-87`（`hooks.json` 命中 **或** `~/.codex/RTK.md` 存在 **或** `AGENTS.md` 引用 `RTK.md`）。真实 `~/.codex/RTK.md` 存在 → **无论怎么关，`on` 永远是 `true`**。

### S6 agent 覆盖不完整，且部分 agent 的命令非法 / 非交互下不写入 【已验证 = 各条命令实测；推断 = 端到端用户观感】

控制台 `server/rtkService.ts:327` 对所有 agent 统一执行 `rtk init -g --<agentId>`。把 6 个 agent 逐个在**临时 HOME** 里实跑（`evidence/12-rtk-agent-init-matrix.txt`）：

| agent | 控制台实际执行 | 实测结果 | 正确做法（实测） |
| --- | --- | --- | --- |
| codex | `rtk init -g --codex` | **exit 0**，写出正确的 `hooks.json` + `RTK.md` + `AGENTS.md` 引用 | 同（无需 `--auto-patch`） |
| claude | `rtk init -g --claude` | **exit 2** `unexpected argument '--claude' found`，文件零改动 | `rtk init -g --agent claude --auto-patch`（缺 `--auto-patch` 则 exit 0 但**不写 `settings.json`**） |
| gemini | `rtk init -g --gemini` | exit 0，但**未注册 hook**（`/y/N` 默认 N），只写脚本与 `GEMINI.md` | `rtk init -g --gemini --auto-patch`（exit 0 且写入 `settings.json`） |
| cursor | `rtk init -g --cursor` | **exit 2** `unexpected argument '--cursor' found` | `rtk init -g --agent cursor`（+ 关掉时 `--uninstall`） |
| omp | `rtk init -g --omp` | **exit 2** `unexpected argument '--omp' found` | `rtk init -g --agent omp` |
| copilot | `rtk init -g --copilot` | exit 0，写出 `hooks/rtk-rewrite.json` + instructions | 同 |

HTML 层面的叠加缺陷：`setRTKAgentHook` 只对 `codex`(:274)、`claude`(:298) 有手写分支；所有分支的 CLI 失败都被 `server/rtkService.ts:331-333` 的空 `catch` 吞掉，接口照常返回 `readRTKStatus()`（HTTP 200），前端无法区分"成功"与"什么都没发生"。关闭路径对 6 个 agent 全部无效（S5）。

### S7 没有 install / upgrade 能力 【已验证】

- 中转站契约有 `POST /api/library/rtk/install`、`/upgrade`（`deploy/magpie/UPSTREAM.md:71-72`）。
- 控制台无对应端点：`grep -n "rtk" server/index.ts` 仅 :1116、:1126 两条；`server/rtkService.ts:252` 的 `install: 'curl -fsSL https://www.rtk-ai.app/install.sh | sh'` 只在**未安装**分支返回，而 `src/components/VersionWidget.vue` 里 `grep -n install` = 0 命中 → 前端根本不展示它。

### S8 前端只有只读展示，没有入口，也没有"可操作"的语义 【已验证】

- `src/api.ts:72-73` 的 `getRTKStatus`/`toggleRTK` **零调用点**（`grep` 全 `src/` 仅这两行）→ 死代码。
- `src/router.ts` 无 RTK 路由；侧边栏无 RTK 入口。
- `src/components/VersionWidget.vue:178-185` 只读展示，且文案"**已接通 (v0.50.0)**"完全由 `cpa.rtk.connected`（**本机二进制是否存在**）驱动。
- 该值来自 `server/cpa.ts:386-387,396`；同处 `oauthConnected: true` 是**硬编码常量**（`server/cpa.ts:395`），并非探测结果。二者都只是 `upstream.*` 里的字段，**Vue 界面未渲染**（`grep -rn "rtkConnected\|oauthConnected" src/` = 0）。
- 遗留 React 文件里有一句直接对用户宣称"**OAuth 登录与 RTK Token 压缩管理已成功接通本中转站。**"（`src/components/VersionWidget.tsx:220`）——该文件**不在产物里**（`index.html` 只引 `/src/main.ts`；`grep -rl "已成功接通" dist/` = 0），属于死文件里的不实文案，但蓝队若复用 `VersionWidget.tsx` 会把它带回来。

### S9 状态无持久化、无对账 【已验证】

`app_settings` 表中**没有任何 rtk 键**（只有 `quota-ledger-cost-backfill-v2`、`reporting.groups.lastKnown.v1`）；`/api/audit` 最近 100 条里 **rtk 记录 0 条**（说明本机从没成功点过这个开关）。状态完全由文件系统即时推导。

### S10 帮助页（B 层）与 RTK 零交集 【已验证】

`grep -in "rtk" src/pages/HelpPage.vue` = 0 命中；帮助页给的是 `https://ai.crosery.com/v1`（:12）等推理示例。用户照着帮助页接入，不会得到任何 RTK 安装/挂载步骤。

### S11 暴露面与鉴权（现状是好的，别改坏）【已验证】

`server/index.ts:249` `app.use('/api', requireAuth)` 在 :1116/:1126 之前；未登录实测：`POST /api/rtk/toggle` → `401 {"error":"请先登录"}`，`GET /api/rtk/status` → 401（`evidence/05-console-rtk-auth-boundary.txt`）。

### S12 运行期配置漂移 【已验证】

`scripts/magpie-console.mjs:16-17` 的默认值只在**通过该脚本**启动时生效；`:91` 构造的 `env` 只透传 `PATH/LANG/LC_ALL/TMPDIR`（**丢弃 HOME**），`:93` 只给内核显式传 `HOME=<runtime>/home`，`:103-111` 给控制台进程**不传 HOME**。当前运行 manifest 记录 `credentialSourceBaseUrl = https://ai.crosery.com`（`~/.agents/crosery/magpie-console/console-manifest.json`）。若用 `npm run dev:edge` / 直接 `node server/index.ts` 启动，`MAGPIE_SOURCE_CPA_BASE_URL` 为空 → `readMagpieSource` 抛 `Read-only CPA credential source is not configured`（`server/magpieControl.ts:24`）。RTK 侧当前不读这些变量，因此不受影响——**但 A/D 层一旦接控制面，就必须把 base url / 凭据 / 目标 agent 列表一起纳入配置面**。

---

## 4. 必答 4：四层修复点清单（A/B/C/D）

前置约定（否则一定改坏）：任何写 agent 配置的动作必须 **①先备份 ②只改自己那一条 ③失败不改原文件 ④可一键回退**。当前 `server/rtkService.ts` 四条全不满足。

### 层 C：让开关真的生效（**最高优先级，纯仓库内，能自动化验收**）

| 项 | 内容 |
| --- | --- |
| 改哪个文件 | `server/rtkService.ts`（蓝 A 的范围）；可选 `server/index.ts:1126-1137` 响应体扩展（蓝 A 范围不含 `server/index.ts`，需 lead 或另行授权） |
| 怎么改 | ①删除 :284-286 / :308-310 的整体赋值，改为"读取 → 定位 rtk 自己的条目（`command === 'rtk hook <agent>'`）→ 增/删这一条 → 原样保留其余条目"；②ON 一律走官方 CLI，**按 agent 精确映射并带 `--auto-patch`**：`codex→init -g --codex`、`copilot→init -g --copilot`、`gemini→init -g --gemini --auto-patch`、`claude→init -g --agent claude --auto-patch`、`cursor→init -g --agent cursor --auto-patch`、`omp→init -g --agent omp --auto-patch`（缺 `--auto-patch` 时 claude/gemini 会 exit 0 但不写配置——这是"点了不生效"的最直接原因）；③OFF 必须带目标：`codex→init -g --uninstall --codex`，其余 `init -g --agent <id> --uninstall`（**不带目标的 `-g --uninstall` 只清 Claude**，不带 `-g` 直接 exit 1）；④采集 `exitCode`/`stderr`，**禁止空 catch**；⑤ON/OFF 之前把 `hooks.json`、`settings.json`、`AGENTS.md` 备份到 `~/.agents/crosery/magpie-console/backups/<ts>/`；⑥写完必须**回读校验**（条目存在 + 形状含 `matcher` 与嵌套 `hooks[]`），校验失败即回滚备份并报错 |
| 检测逻辑 | `detectAgentHooks()`(:78-158) 必须改成"命中 rtk 自己的 hook 条目"（嵌套形状 + `matcher`），**不能**把 `RTK.md` 存在当成"已挂载"，否则永远关不掉（S5） |
| 需要哪些配置 | 无新增。可选 `RTK_BIN`（已有 `server/rtkService.ts:48`）、`RTK_SUPPORTED_AGENTS`（如需白名单） |
| 是否动生产凭据 | **否** |
| 是否需中转站配合 | **否** |
| 风险 | 写真实 agent 配置（当前机器上有 orca/clawd/datetime 等第三方 hook）；误写会破坏用户环境 |
| 回退 | 备份目录原地恢复；`rtk init -g --agent <id> --uninstall`；本改动只涉及 `server/rtkService.ts`，`git revert` 单文件即可 |
| 人工批准 | **写真实 `~/.codex`/`~/.claude` 的验收动作必须由用户/lead 批准**；自动化测试一律用临时 HOME |

### 层 A：把控制面接上（分 A1 本机内核 / A2 中转站）

**A1（推荐先做，仓库内可闭环）**

| 项 | 内容 |
| --- | --- |
| 改哪个文件 | `server/rtkService.ts`（新增 plane 选择）、`server/magpieEngine.ts`（已有 `kernelJSON`，复用它调 `/internal/rtk`）、`deploy/magpie/`（无源码改动，只需重编二进制） |
| 怎么做 | 新增 `RTK_PLANE=auto|local|kernel`（默认 `auto`）：magpie 模式下先 `kernelJSON(socket,'/internal/rtk')`；**非 200 或连不上就回退 local，并在返回体里标注 `plane:'local'`**（禁止把 400/失败当成"没有 RTK"）。写路径同理：`POST /internal/rtk {agent,on}`，失败回退 local 或直接报错 |
| 前提 | 运行中的内核**必须重编重部署**：`npm run magpie:build`（`scripts/build-magpie-kernel.mjs` 会校验 pinned 干净源码 + 契约验证后打 overlay）→ 重启 `com.crosery.console-magpie` |
| 是否动生产凭据 | 否（unix socket 0600，`main.go:29-36`） |
| 是否需中转站配合 | 否 |
| 风险 | 重编/重启是**服务级操作**，会短暂中断网关（8790）；内核二进制与 overlay 强绑定，源码不干净会直接拒绝构建 |
| 回退 | 保留旧二进制（现有惯例：`bin/magpie-kernel.before-*`），停服务→换回→启动→`/internal/health` 校验；控制台侧 `RTK_PLANE=local` 一个变量即可退回 |
| 人工批准 | **需要**（重建 + 重启生产服务，按 `docs/qa/COORDINATION.md:17-33` 串行锁执行） |

**A2（中转站侧，独立立项）**

| 项 | 内容 |
| --- | --- |
| 改哪个文件 | 中转站宿主机（不在本仓库）；本仓库只加客户端（`server/magpieControl.ts` 或新文件） |
| 怎么做 | 在中转站管理面上真的提供 `/api/library/rtk`（等价 Magpie `library.ReadRTK/SetRTK`）或一个受限的 RTK 代理端点 |
| 现状 | **已验证**：`GET /api/library/rtk` → 404；**未验证**：宿主机能力、可改造性、凭据 scope |
| 是否动生产凭据 | **是**：需要新的管理凭据/scope；**不得**把现有 `AI_CROSERY_MGMT_SECRET`（凭据源只读用途）扩大成"能改远端 agent 配置"的万能钥匙 |
| 风险 | 远端 agent 配置写入不可逆性更高；一旦凭据泄漏，等于远程代码/配置写入权 |
| 回退 | 端点侧开关默认关闭 + 控制台 plane 变量退回 `local` |
| 人工批准 | **必须**（远端生产变更 + 凭据 scope 扩大） |

### 层 B：帮助页把 RTK 带进接入流程（**纯文案/组件，最低风险**）

| 项 | 内容 |
| --- | --- |
| 改哪个文件 | `src/pages/HelpPage.vue` |
| 怎么做 | 在接入步骤后追加"本机 RTK（可选，省 token）"小节：安装（`curl -fsSL https://www.rtk-ai.app/install.sh \| sh` 或控制台未安装时返回的 `install` 字段）、挂载（`rtk init -g --codex`；`rtk init -g --agent claude --auto-patch`；`rtk init -g --gemini --auto-patch`；`rtk init -g --agent cursor\|omp`）、验证（`rtk gain --daily --format json`，期待 `summary.total_saved > 0`）、卸载（`rtk init -g --uninstall --codex` / `rtk init -g --agent <id> --uninstall`）；并链到控制台 RTK 页。**注意：不带 `--auto-patch` 时 claude/gemini 只打印"手工添加"且 exit 0，帮助页不能给出会静默失败的简化命令** |
| 必须写清的边界 | **`https://ai.crosery.com/v1` 是推理端点，不能承载配置下发**；RTK 是**客户端侧**工具，装在中转站上不会让用户本机省 token |
| 是否动生产凭据 | 否 |
| 是否需中转站配合 | 否 |
| 风险 | 文案误导（例如暗示"设置在中转站上"）；命令必须与实际 `rtk --help` 一致（本审计给出了实测清单） |
| 回退 | 单文件 revert |

### 层 D：把 RTK 配置同步/下发到中转站那台机器（**需要中转站侧配合，当前无通路**）

| 项 | 内容 |
| --- | --- |
| 现状 | **已验证**：本仓库无 ssh/远程执行（`grep -rn "ssh" scripts/ server/` = 0）；中转站无 RTK 端点（404）；**未验证**：那台机器上是否已有 rtk/agent 配置 |
| 可选形状 | ①中转站跑一个受限 agent（systemd/launchd 守护 + 只接受 `{agent,on}` 白名单的最小端点）← 与 A2 合并；②控制台通过既有隧道/SSH 推送 ← 需新增远程执行能力，安全面大，**不推荐**；③中转站侧保持人工运维，控制台只做**只读对账**（显示远端状态，不写）← 最保守，可先落地 |
| 是否动生产凭据 | **是**（远端写入权） |
| 风险 | 远端 agent 配置写入 + 不可逆；与"OAuth 凭据不上本机"的安全不变量（handoff 2.1 / 3.3）同类风险 |
| 回退 | 远端端点默认 dry-run/关闭；控制台侧功能开关 |
| 人工批准 | **必须**：任何对远端真实 agent 配置的写入都要用户明确批准；在此之前 UI 必须显示"中转站 RTK：**未接通**"，不得复用 `已接通` 文案 |

### 推荐方案（明确一个）

**第一批（同一 PR，全部仓库内 + 可自动化验收）：C + A1 + B。**
- C 修正确性（且修掉破坏性写入），A1 把 seam 接上（含"内核不可用即回退本地并显式标注 plane"），B 把用户可见的接入路径补齐。
- 验收全部可用临时 HOME + mock socket 完成，不碰真实 `~/.codex`/`~/.claude`。
- 需要人工批准的动作只有两个：**重建内核二进制 + 重启服务**，以及**最后在真实 HOME 上做一次 ON→OFF 回归**。
- 第一批里 UI 文案必须诚实：区分"本机 RTK"与"中转站 RTK（未接通）"；不要复用 `src/components/VersionWidget.tsx:220` 那句"已成功接通本中转站"。

**第二批（独立立项）：A2 + D。** 需要中转站侧配合与凭据 scope 设计，先做只读对账，写入能力放在显式开关后。

---

## 5. 必答 5：蓝队实现后的反例测试清单（对抗验证用）

每条都可在 CI/本地自动化，除标注外**不得触碰真实 `~/.codex`/`~/.claude`**（一律临时 HOME）。

| # | 反例 | 断言（失败即打回） |
| --- | --- | --- |
| T1 | **plane 回退**：`MAGPIE_KERNEL_SOCKET` 指向不存在的 socket | `GET /api/rtk/status` 仍 200，返回 `plane:'local'`，数据来自本机 rtk；**不得**返回 5xx、**不得**把"内核不可用"表述成"RTK 未安装" |
| T2 | **seam 未编译的内核**（用当前运行中的二进制做 fixture：`/internal/rtk` → 400 `request id required`） | 客户端把非 200 视为"控制面不可用"并回退，**不得**构造空 `RTKView` 冒充成功；日志里能看到 plane 与状态码 |
| T3 | **rtk 未安装**：`RTK_BIN=/nonexistent` 且 PATH 无 rtk | `POST /api/rtk/toggle` 返回 409/503 + 安装指引；**不得**返回 200；状态里 `connected:false` |
| T4 | **并发 toggle**：同一 agent 并发 2 次 ON | `hooks.json` 仍是合法 JSON、rtk 条目**存在且仅 1 条**、第三方条目数量不变（跑 T7 断言） |
| T5 | **真实配置零改动**：以临时 HOME 跑完整 ON→OFF 周期 | 真实 `~/.codex/hooks.json`、`~/.claude/settings.json` 的 sha256 **完全不变**（本审计已用该手法自证没写真实文件） |
| T6 | **幂等**：连续两次 ON（已 ON 状态） | 产物与一次 ON 字节级一致；无重复条目 |
| T7 | **第三方 hook 保全**：fixture 里放 2 条无关 `PreToolUse` 条目 | ON 之后 3 条都在；OFF 之后只剩 2 条无关条目、rtk 条目被移除；**回归当前 bug**（现状 3→1） |
| T8 | **关得掉**：先 `rtk init -g --codex`，再走控制台 OFF | `hooks.json` 无 rtk 条目，`RTK.md`/`AGENTS.md` 引用按 rtk 官方 uninstall 语义移除，`GET /api/rtk/status` 中该 agent `on:false`（**当前 bug：永远 true**） |
| T9 | **坏 JSON 不覆盖**：把 `hooks.json` 写成非法 JSON 后点 ON | 返回错误、**原文件字节不变**、备份存在；**不得**静默重置成 `{}` |
| T10 | **agent 覆盖矩阵**：6 个 agent 各自 ON→OFF | 每个 agent 的 CLI 调用都是合法 flag（用 `rtk init --help` 解析出的白名单校验），`stderr` 为空、`exitCode===0`，per-agent 状态独立（**当前 bug：`--claude`/`--cursor`/`--omp` exit 2、OFF exit 1**） |
| T11 | **字段一致性回归**：同一 HOME 下 `GET /api/rtk/status` vs `rtk gain --daily --format json` | `gain.commands/input/saved/pct` 与 `summary.total_*`、`days[]` 与 `daily[]` 逐项相等（当前 1:1 成立，防回归） |
| T12 | **中转站未接通必须诚实**：mock 中转站返回 404/401 | UI/接口显示"中转站 RTK：未接通"；**不得**出现 `已接通`；`upstream.rtkConnected` 不得再由"本机二进制存在"推导（当前 `server/cpa.ts:396` 就是这么算的） |
| T13 | **只读性**（若实现 A2/D）：控制台不得对中转站发起任何 `/install`、`/upgrade`、`POST /api/library/rtk`，除非用户显式点击且该动作在审计日志留痕 | 抓包/审计日志断言 |
| T14 | **非交互 default N 反例**：把 `execFile` 的 stdin 设为 `/dev/null`（模拟控制台），对 claude 与 gemini 各跑一次 ON | `settings.json` **必须真的出现 hook 条目**；若实现返回 ok 而文件未变 → 直接打回（当前 `rtk init -g --agent claude` 正是 exit 0 + 不写入） |
| T15 | **Codex 引擎闭环**：在隔离 `CODEX_HOME` 里放 (a) 控制台旧形状、(b) rtk 正确形状，用真实 Codex 触发一次 `PreToolUse`（如 `codex exec` 带一条会被 hook 处理的命令） | (a) 必须被 Codex 判定为无效/忽略(记录实际行为)，(b) 必须真正执行 hook；据此把 §2.5 的"推断"升级为"已验证"，并作为形状回归断言 |
| T16 | **uninstall 目标语义**：每个 agent 各自 `ON` 后只关自己 | 目标 agent 条目→0；**其它 agent 的条目与文件保持不变**（回归：不带目标的 `-g --uninstall` 会误清 Claude、且 Codex 纹丝不动；不带 `-g` 直接 exit 1） |
| T17 | **hook 信任门**：Codex/Claude 对新增 hook 有 trust/approval 机制（`--dangerously-bypass-hook-trust` 的存在即证明） | 实现必须在 UI 明确提示"需要在 agent 侧批准/重启"，且不得把"文件已写入"等同于"已生效" |

---

## 6. 证据索引

| 文件 | 内容 | 复现命令要点 |
| --- | --- | --- |
| `evidence/01-rtk-gain-daily.groundtruth.json` | rtk 真实 `gain --daily --format json` | `HOME=<rtk 数据目录只读快照> rtk gain --daily --format json` |
| `evidence/02-kernel-socket-probe.txt` | 内核 socket `health/rtk/对照路径` + 二进制字符串计数 + mtime | `curl -s --unix-socket <sock> http://localhost/internal/rtk` |
| `evidence/03-console-api-rtk-status.runtime.json` | 登录后 `/api/rtk/status` 原文 | Keychain 取密码 → `POST /api/login` → `GET /api/rtk/status` |
| `evidence/04-console-api-version.runtime.json` | `/api/version` 原文（含 `upstream.rtkConnected=true`） | 同上 |
| `evidence/05-console-rtk-auth-boundary.txt` | 未登录 401、审计表 rtk 记录数 | 无 cookie 直接 POST/GET |
| `evidence/06-relay-readonly-probe.txt` | 中转站只读探测（含认证 GET，未打印任何密钥/内容） | `curl -H @- https://ai.crosery.com/...` |
| `evidence/07-rtk-init-probe.txt` | `rtk init` flag 合法性实测（`--codex`/`--claude`/`--omp`/`--cursor`/`--uninstall`） | `HOME=/tmp/... rtk init -g --claude` |
| `evidence/08-codex-hooks-shapes.txt` | rtk 权威形状 vs 控制台手写形状 vs 真实文件条目结构 | throwaway HOME 生成 + 真实文件只读解析 |
| `evidence/09-destructive-overwrite-sim.txt` | 开关 ON 的破坏性仿真（3→1 条，codex+claude 各销毁 2 条） | 内存副本模拟 `rtkService.ts:283-287` |
| `evidence/10-rtk-sandbox-caveat.txt` | 沙箱内 `rtk gain` 失败原因（SQLITE_CANTOPEN）+ rtk 自带提示 | `touch ~/Library/Application Support/rtk/x` |
| `evidence/11-codex-hooks-schema.txt` | Codex 0.159.2 原生二进制的 hooks 引擎/schema 证据串 + `codex doctor` 尝试 | `strings -a -n 6 <codex native binary> \| grep -E 'hooks/src\|matcher'`；`CODEX_HOME=<tmp> codex doctor --json` |
| `evidence/12-rtk-agent-init-matrix.txt` | 6 个 agent 的 `rtk init -g <flag>` 实测矩阵（exit code / 写出的文件 / 非交互默认 N / `--auto-patch` 对比） | `HOME=<tmp> rtk init -g --agent claude`（无/有 `--auto-patch`） |

---

## 7. 未验证 / 不确定点（不要当成结论用）

1. **中转站宿主机的真实状态**：是否安装 rtk、是否有 agent hook、能否新增 RTK 端点——**完全未验证**。本审计只能证明"从公网管理面看不到 RTK 路由"。
2. **端到端"点了有没有生效"**：为了避免改动真实 `~/.codex`/`~/.claude`，**没有真正执行过 `POST /api/rtk/toggle`**；§3 的 C 层结论来自「CLI 实测」+「内存副本仿真」+「代码逐行」，**推断链已在文档中标注**。
3. **运行中的 `dist/` 是否与 HEAD `281c30e` 字节一致**：未做构建比对。已确认的是：`dist` 里是 Vue 产物（含 `RTK 适配`），且**不含** `VersionWidget.tsx:220` 那句不实文案。UI 相关结论以此为准。
4. **`rtk init --uninstall` 的正确组合**：本审计已实测 `-g --uninstall`（只清 Claude）、`-g --uninstall --codex`、`-g --agent claude --uninstall`、`-g --agent omp --uninstall` 四种（见 S5）；**未实测** `--agent cursor --uninstall` 等其余 agent 的卸载路径，蓝队实现时应逐个补测（已列入 T16）。
5. **中转站管理面凭据的确切 scope**：本次只验证了 6 个只读凭据端点的 GET 可用；未测试任何写端点，也未评估该 secret 是否有其他权限。
6. **Codex 对旧形状的实际处置**（报错拒绝 vs 静默忽略）：未闭环（`codex doctor` 不校验 hooks），标为推断；闭环动作见 T15。

---

## 8. 审计基线与在飞改动（仅供 lead 排期，不构成对蓝队代码的审计）

审计期间工作区出现蓝队 WIP（**未审计、且在持续变化，不作为结论**），仅记录事实以便 lead 安排对抗验证：

```
$ git status --porcelain                     # 审计者只新增 docs/qa/**，未改任何产品文件
 M server/index.ts          (rtk 路由从 2 条变 6 条：status/planes/toggle/rollback/install/upgrade)
 M server/rtkService.ts     (+948/-253)
?? server/rtkPlane.ts
$ grep -n "internal/rtk" server/rtkPlane.ts
272: const result = await kernelRtkRequest(socket, '/internal/rtk')
277: // 运行中的内核没有 overlay 的 /internal/rtk 缝，请求落到推理 handler 的兜底分支。
281: detail: `HTTP ${result.status}: 内核运行时未包含 /internal/rtk（可能为旧构建），需要重新构建内核`
$ grep -n "PreToolUse" server/rtkService.ts   # 已出现 matcher/nested 形状表
489: codex: { kind: 'nested', root: ['hooks'], list: 'PreToolUse', matcher: 'Bash', command: 'rtk hook codex' },
```

**含义**：蓝队 WIP 看起来正对着本文的 S1/S2/S3/S5/S6/C 层（kernel plane 探测 + 400 兜底识别 + nested 形状 + remote-write 门）。

**给 lead 的对抗验证要求**：
1. 本文所有结论与 T1–T17 必须**针对蓝队最终 revision 重跑**，不要用本文行号去核对新代码；
2. 重点回归 T2（本机当前旧内核二进制的 400 兜底）、T7（第三方 hook 保全）、T14（非交互 default N）、T16（uninstall 目标语义）、T17（信任门 UI 提示）；
3. A1 的"内核重编"仍是**需要人工批准 + 串行锁**的动作（`docs/qa/COORDINATION.md:17-33`）；在重编之前，任何 `/internal/rtk` 都必须走回退分支并在 UI 标注 `plane:local`。
