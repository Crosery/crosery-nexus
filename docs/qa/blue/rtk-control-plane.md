# RTK 控制面打通（task-3 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 仓库：`<repo>`

分层口径按用户确认的 A/B/C/D 四层执行；本文件中「已验证」= 有命令输出或 `path:line` 可复现，「未验证」= 明确没做。

---

## 0. 结论摘要

| 层 | 结果 | 一句话 |
| --- | --- | --- |
| A 控制面 | **部分打通（诚实回退）** | 权威平面按 `kernel → relay → local` 解析，逐平面如实上报 `state/reason`；现网内核二进制没有 RTK seam、中转站是 CPA 主机没有 RTK 路由，因此现网 `plane=local`（回退可见，不假装同步）。内核重编与中转站侧改造**未做**（Lead 裁决不在本轮）。 |
| B 接入帮助 | **已打通** | `HelpPage.vue` 新增第 8 节：安装 / hook / 验证 / 卸载四段命令，明确「作用于本机客户端，`https://ai.crosery.com/v1` 不承载配置下发」，并标注 `--auto-patch` 不能省。 |
| C 客户端落地 | **已修好（含破坏性写入修复）** | 开关走官方 `rtk init -g …`（11 个 agent 全部实测 exit 0 / stderr 空），写前备份、原子写、写后校验、失败还原；只增删 rtk 自己那一条，第三方 hook 3 条全保留；坏 JSON 不覆盖；关得掉；并发幂等。 |
| D 中转站侧 | **只读实现 + 诚实标注** | relay 平面客户端与探测已实现；实测中转站没有 RTK 管理面（404），写操作一律 501/403，**不发任何写请求**（有测试与抓包断言）。 |

**最重要的三个实测缺陷（红队 S3/S4/S5）已在本轮修掉**：手写 hooks 形状错误、`--uninstall` 缺 agent 目标、`--agent claude` 缺 `--auto-patch` 导致「exit 0 但根本没写进去」。

---

## 1. 改动文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `server/rtkPlane.ts` | 新增 | 平面类型/协议、agent 注册表、内核与中转站客户端、逐平面探测、写闸门、响应归一化、脱敏 |
| `server/rtkService.ts` | 重写 | 本机平面实现（检测/读写/备份/回退）、权威平面编排、install/upgrade/rollback、错误归一化 |
| `server/rtkService.test.ts` | 重写 | 31 个用例：平面解析/回退/501/写闸门/真实配置零改动/红队反例 |
| `server/index.ts` | 仅 RTK 路由段（Lead 授权） | 新增 `/api/rtk/planes`、`/api/rtk/install`、`/api/rtk/upgrade`、`/api/rtk/rollback`；status/toggle 支持 501/403 透传与审计带 plane；status 打印 `rtk.plane` 日志 |
| `src/types.ts` | 追加 | `RtkPlaneId/RtkPlaneState/RtkPlaneProbe/RtkAgentStatus/RtkBackupSummary`，`RTKStatusResponse` 扩展（字段只增不改名） |
| `src/api.ts` | 追加 | `RtkApiError`（带 plane/reason/backup）、`getRTKPlanes/installRTK/upgradeRTK/rollbackRTK`，`toggleRTK` 支持 `{plane,confirm}` |
| `src/pages/RtkPage.vue` | 新增 | RTK 页面：平面卡片、本机开关、远端下发、权威只读视图、备份回退、确认弹窗 |
| `src/components/RtkBoard.vue` | 新增 | 上述视图的可复用板组件（默认导出，可被 `<RtkBoard />` 直接用） |
| `src/pages/HelpPage.vue` | 修改 | 新增第 8 节「本机 RTK」+ 目录项 |
| `docs/qa/blue/rtk-control-plane.md` | 新增 | 本文件 |

**未新增任何生产依赖**；未改 `src/router.ts`、`src/components/ConsoleNav.vue`（Lead 负责挂路由；页面期望挂在 `/rtk`，HelpPage 里的链接指向 `/rtk`）。

---

## 2. 接口契约

```
GET  /api/rtk/status    → { plane, planes[{id,available,configured,state,reason,detail?}], connected, version, path,
                            gain, days, latest, agents[{id,name,icon,on,supported,plane,installed?,blocked?}],
                            localAgents[…], local{connected,path,version}, backups[{id,at,files}],
                            install?, url, writeMode, remoteWriteEnabled, kernelWriteEnabled, installEnabled, error? }
GET  /api/rtk/planes    → { plane, planes[…], fellBack }                # 只探测，不读数据
POST /api/rtk/toggle    body {agent, on, plane?='local', confirm?}      → status + { ok, plane(写入平面), readPlane,
                                                                            mechanism?, backup?, fallbackReason?, collateralRestored? }
POST /api/rtk/install   body {plane?, confirm?}                          → 成功返回 status；不支持时 501 {error,plane,reason}
POST /api/rtk/upgrade   同上
POST /api/rtk/rollback  body {backup?, confirm:true}                     → status + { ok, backupId, restored[] }
```

约定与实现取舍（与 task-3 契约的差异都在这里说明）：

1. **`plane` 的语义**：`status.plane` = 权威**读取**平面；`toggle.plane` = 实际**写入**平面。写入默认 `local`——只有控制台这台机器才有用户的 agent 配置（见 §3.A 的沙箱 HOME 事实）。响应里额外给 `readPlane` 保留读取平面信息。
2. **`agents` vs `localAgents`**：`agents` 是权威平面的视图（契约字段），`localAgents` 恒定是本机（C 层开关的目标）。两者在 `plane=local` 时内容相同。
3. **`planes[].configured`**：区分「未配置」（`state=not_configured`）与「配置了但不可达/401/无该路由」（`unreachable/unauthorized/not_supported`）。
4. **平面不支持 → 501**，永不静默成功：`local`/`kernel` 的 install/upgrade、`relay` 在没有管理面时的任何写入。
5. 所有写操作（成功与失败）都进 `audit_log`，details 里带 `plane`、`outcome`、`status`、`reason`，成功时另带 `mechanism`。
6. 错误响应只回显脱敏后的文本（`Bearer ***`、`key/token/secret/password=***`），不回显任何密钥。

---

## 3. 分层实现

### A. 权威平面解析（`server/rtkPlane.ts`）

顺序 `kernel → relay → local`；每个平面都真实探测并给出 `state/reason`；探测结果 30s 缓存（`/api/version` 也走这条链，避免每次多打两次网络）。

| 情形 | 结果 |
| --- | --- |
| `GATEWAY_ENGINE=magpie` + socket 存在 + `GET /internal/rtk` 200 | `plane=kernel` |
| socket 不存在 | `not_configured / kernel_socket_missing`（**不返回 5xx**，回退 local，且不表述成「RTK 未安装」） |
| 内核返回 400/404/405（旧构建没有 seam） | `not_supported / kernel_rtk_seam_missing`，detail 带 `HTTP <status>` |
| 中转站未配置 | `not_configured / relay_base_url_missing` 或 `relay_credential_missing` |
| 中转站 401/403 | `unauthorized / relay_http_401` |
| 中转站 404 | `not_supported / relay_route_missing` |
| 探测说可用但读失败 | 该平面降级为 `unreachable / <plane>_read_failed` 并继续回退，`error` 字段如实说明 |

**内核沙箱 HOME（已验证，Lead 裁决依据）**：`scripts/magpie-console.mjs:92-93` 用 `HOME=<runtime>/home` 启动内核（即 `~/.agents/crosery/magpie-console/home`），而 `:103` 启动控制台进程时不覆盖 `HOME`（继承真实 `~`）。所以内核的 `library.ReadRTK/SetRTK` 读写的 agent 配置落在沙箱 HOME，**对用户真实 `~/.codex`、`~/.claude` 毫无影响**。据此：内核平面只做探测 + 只读展示，写入默认 **501 `kernel_write_not_supported`**；只有运维显式设置 `RTK_ALLOW_KERNEL_WRITE=1`（再加 `RTK_ALLOW_REMOTE_WRITE=1` + 请求 `confirm:true`）才允许下发。

**内核 seam 现状（已验证）**：运行中的 `~/.agents/crosery/magpie-console/bin/magpie-kernel`（2026-09-30 16:19）里 `grep -a -c "/internal/rtk"` = **0**，`curl --unix-socket … /internal/rtk` → **400 `request id required`**（落到推理 handler 兜底）；`/internal/health` → 200 且 revision `3fe2ff9…`。据此现网 `kernel` 平面为 `not_supported`，UI 文案为「未提供该接口 / 内核未编译 RTK seam」。**本轮不重编内核**（Lead 裁决；`npm run magpie:build` 需要 pinned 干净源码，且会重启 8790 网关）。

### B. 帮助页（`src/pages/HelpPage.vue`）

新增第 8 节（目录同步）：安装 → 按客户端选一条 hook → 验证/卸载，命令与 `rtk init --help`（0.50.0）逐条核对；明确写清两条边界：**RTK 作用于本机客户端**、**`https://ai.crosery.com/v1` 是推理端点不承载配置下发**。另用 TxAlert 标注 `--auto-patch` 不可省的原因。

### C. 本机落地（`server/rtkService.ts`）

**已核实的 CLI 事实（rtk 0.50.0，全部在临时 HOME 实测，真实 `~/.codex` 未动）**：

| agent | 合法命令 | 落盘文件 | 检测标记 |
| --- | --- | --- | --- |
| codex | `rtk init -g --codex` | `.codex/hooks.json` | `rtk hook codex` |
| claude | `rtk init -g --agent claude --auto-patch` | `.claude/settings.json` | `rtk hook claude` |
| cursor | `rtk init -g --agent cursor --auto-patch` | `.cursor/hooks.json`（**并连带写 `.claude/settings.json`**） | `rtk hook cursor` |
| gemini | `rtk init -g --gemini --auto-patch` | `.gemini/settings.json` | `rtk-hook-gemini` |
| copilot | `rtk init -g --copilot` | `.copilot/hooks/rtk-rewrite.json` | `rtk hook copilot` |
| trae / droid / omp / pi / hermes / vibe | `rtk init -g --agent <id> --auto-patch` | `.trae|.factory|.omp|.pi|.hermes|.vibe/…` | 见注册表 |
| windsurf / cline / kilocode / antigravity / kimi | **无全局开关**：`-g` 被拒（kilocode/antigravity/kimi）或仍写到当前目录（windsurf/cline） | — | `supported:false` |

**与红队线索的差异（重要更正）**：`rtk init --help` 里 **`--codex` 确实存在**（独立 flag，不属于 `--agent` 取值；`--gemini`、`--copilot` 同理）。所以「`-g --codex` 是无效 flag」不成立。真正的缺陷是另外三条：

1. **手写 hooks 形状错误**（旧 `rtkService.ts:284-286/308-310`）：写成了 `{"hooks":{"PreToolUse":[{"command":"rtk hook codex"}]}}`，缺 `matcher` 与嵌套 `hooks[]`。权威形状（rtk CLI 实测输出）：
   ```json
   { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "rtk hook codex" } ] } ] } }
   ```
   各 agent 的完整实测形状（codex/claude/trae/droid/cursor/copilot）已固化进 `HOOK_JSON` 表并被测试逐字节比对。
2. **`rtk init --uninstall` 不带 agent 目标**：实测只清 Claude（关错对象），无 `-g` 时直接 `exit 1 Uninstall only works with --global flag`。现在 OFF 一律 `rtk init -g <agent 目标> --uninstall`。
3. **`--auto-patch` 缺失**：`--agent claude` / `--gemini` / `--agent vibe` 在非交互下对「Patch settings.json with RTK hook? [y/N]」默认 N —— **exit 0 但 hook 根本没写进去**，这正是「点了不生效」的机制级原因。现在所有全局命令都带 `--auto-patch`，并且子进程 `stdin=/dev/null`（否则 prompt 会把进程挂到超时——这也是实测：不加 `--auto-patch` 时矩阵用例曾卡满 20s 超时）。

**破坏性写入的修复**：旧实现整体赋值 `PreToolUse = [...]`（实测把 3 条第三方 hook 覆盖成 1 条）。现在 `stripCommand()` 递归只摘掉 `command === "rtk hook <agent>"` 的条目，并在摘空时移除空壳（避免留下 `{"matcher":"Bash","hooks":[]}`），其余第三方条目原样保留。

**写入安全链**：`withFileLock(`同 agent 串行`) → createRtkBackup(目标文件 + 说明文件 + **其它 agent 的 hook 文件**) → mkdir 需要的目录 → 官方 CLI → 校验目标状态 → 连带修复（见下） → 失败则从备份还原并抛错`。文件用「临时文件 + rename」原子替换；备份默认落在 `<home>/.agents/crosery/magpie-console/backups/<ts>/`（可用 `RTK_BACKUP_DIR` 覆盖），含 `manifest.json`，可一键回退。

**rtk 的真实跨 agent 耦合（实测，已在实现里处理）**：`rtk init -g --agent cursor` 会**连带**在 `.claude/settings.json` 注册 claude 钩子；`rtk init -g --agent claude --uninstall` 会**连带删掉** `.cursor/hooks.json`。控制台的处理：ON 如实展示（状态页会同时显示 claude 已挂载）；OFF 只关用户点的那个——被连带删掉的其它 agent 钩子文件会从备份修复，并在响应里返回 `collateralRestored: ["cursor"]`、进审计日志。

**写闸门**：

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `RTK_WRITE_MODE` | `local` | `local`=本机可写；`confirm`=需请求 `confirm:true`；`off`=全只读 |
| `RTK_ALLOW_REMOTE_WRITE` | 关 | 中转站/内核写入总开关（仍要 `confirm:true`） |
| `RTK_ALLOW_KERNEL_WRITE` | 关 | 内核平面写入开关（默认 501） |
| `RTK_ALLOW_INSTALL` | 关 | 预留（当前 local 安装仍一律 501，不代为执行网络安装脚本） |
| `RTK_HOME` | 未设 | 只用于测试/显式覆盖本机目标 home |
| `RTK_BACKUP_DIR` | 未设 | 备份根目录覆盖 |

判断：**本机写入默认开启**（C 层要求「开关真的落到客户端」，且 UI 每次操作都有确认弹窗 + 审计），**远端写入默认关闭**（D 层要求「默认只读、默认不自动执行」）。需要绝对只读时设 `RTK_WRITE_MODE=off`。这是本轮唯一一处「默认值由我们定」的取舍，已在 §6 标为需人工批准项。

**测试安全网**：`NODE_TEST_CONTEXT` 下，任何指向真实 home 的写入（含 rollback）都会被硬闸门拒绝（`test_context_real_home_refused`），不依赖测试自己记得设 `RTK_HOME`；测试末尾再用 sha256 断言真实 agent 配置逐字节未变。

### D. 中转站侧（只读）

- 客户端：`GET/POST ${MAGPIE_SOURCE_CPA_BASE_URL}/api/library/rtk[/install|/upgrade]`，Bearer `MAGPIE_SOURCE_CPA_KEY`；响应形状按上游 `library.RTKView` 归一化（字段来源 `deploy/magpie/upstream/api.json` 的 `library.RTKView` schema）。
- **实测中转站没有这些路由**：`GET https://ai.crosery.com/api/library/rtk` → **404**（带管理密钥同样 404；`/v0/management/rtk`、`/v0/management/library/rtk` 均 404）。该主机是 **CLI Proxy API**，不是 Magpie GUI 宿主。
- 因此：relay 平面**只读展示**（UI 显示「未提供该接口 / relay_route_missing」，**不复用「已接通」文案**）；写操作：没有管理面 → **501 `relay_write_not_supported`**；假设将来中转站真的暴露了该面 → 默认 **403 `remote_write_disabled`**，需要 `RTK_ALLOW_REMOTE_WRITE=1` + `confirm:true` 才下发。当前部署永远不会发出写请求（测试 + 证据里对假中转站的请求日志均只有 GET）。
- 未改 `server/cpa.ts:395-396`（`oauthConnected:true` 硬编码、`rtkConnected` 由本机二进制推导）——不在 task-3 写范围；**这两个字段不应再喂给用户可见文案**，已另行告知 Lead/蓝队 B（VersionWidget 的「已成功接通本中转站」文案在 task-4 范围内）。

---

## 4. 如何回退

| 层面 | 回退方式 |
| --- | --- |
| 单次 agent 写入 | 备份目录原地恢复：`POST /api/rtk/rollback {"backup":"<id>","confirm":true}`（或直接把 `backups/<id>/*` 拷回、删掉 manifest 里 `existed:false` 的文件） |
| rtk 侧 | `rtk init -g <agent 目标> --uninstall`（必须带 `-g` 与 agent 目标） |
| 该 agent 的钩子 | 只删 `command === "rtk hook <agent>"` 那一条即可，第三方条目不要动 |
| 开关粒度 | `RTK_WRITE_MODE=off` 一键全只读；远端再加 `RTK_ALLOW_REMOTE_WRITE` / `RTK_ALLOW_KERNEL_WRITE` 不设即关闭 |
| 代码 | 改动集中在 4 个 server 文件 + 4 个前端文件 + 1 个帮助页；`git revert` 单个 commit 即可；`server/index.ts` 只动 RTK 路由段 |

---

## 5. 证据

### 5.1 构建与测试（完成条件 1、2）

```
$ npm run test:magpie     → ℹ tests 55 · pass 54 · fail 0 · skipped 1   （基线 26 passed / 1 skipped + 本次新增用例）
$ npm run build           → ✓ built in 557ms（tsc -b + vite，exit 0）
$ npm run lint            → 仅 server/nativeResponses.ts:200/203 两条既有 no-control-regex 告警
$ npx tsc -p tsconfig.app.json --noEmit --pretty false → exit 0
```

新增用例覆盖：平面解析（内核可用/未配置/socket 不存在/seam 未编译）、回退（内核坏+中转站好 → relay；都不可用 → local）、平面不支持 501（local/kernel/relay × install/upgrade）、写闸门（403 × 3 种）、真实配置零改动、并发幂等、第三方 hook 保全、坏 JSON 不覆盖、备份回退、`rtk gain` 字段一致性。

### 5.2 三情形 curl（完成条件 3）

一次性实例（`PORT=8799`、`DATA_DIR`/`RTK_HOME`/`RTK_BACKUP_DIR` 全在 `/tmp`，用完即杀），完整输出保存在 `/tmp/rtk-evidence/evidence.json`：

| 情形 | 构造 | `GET /api/rtk/status` | `POST /api/rtk/toggle {agent:codex,on:true}` | `toggle plane=kernel` | `toggle plane=relay` | `install/upgrade {}` |
| --- | --- | --- | --- | --- | --- | --- |
| **A 内核可用** | 假内核 unix socket 提供 `/internal/rtk`（200） | `plane=kernel`，`kernel:available:kernel_rtk_ok` | 200，`plane=local`，写临时 HOME | 501 `kernel_write_not_supported` | 501 `relay_write_not_supported`（未配置） | 501 `kernel_*_not_supported` / `local_*_not_supported` |
| **B 只有远端配置** | 假中转站暴露 `/api/library/rtk`（200）+ 非 magpie 引擎 | `plane=relay`，`relay:available:relay_rtk_ok` | 200，`plane=local` | 501 `kernel_write_not_supported` | **403 `remote_write_disabled`**（默认只读） | install/upgrade → 403 `remote_write_disabled`（有面但未开远程写） |
| **B2 真实中转站** | `ai.crosery.com` + 真实管理密钥（只读 GET） | `plane=local`，`relay:not_supported:relay_route_missing` | 200，`plane=local` | 501 `kernel_write_not_supported` | 501 `relay_write_not_supported` | 501 `local_*_not_supported`（权威平面回退到 local） |
| **C 都不可用** | 非 magpie 引擎 + 未配置中转站 | `plane=local`，kernel/relay 均 `not_configured` | 200，`plane=local` | 501 | 501 | 501 |

同一次运行还断言了：

```
=== 真实 agent 配置零改动比对
    ~/.codex/hooks.json        d234642427dd4c2e → d234642427dd4c2e OK
    ~/.claude/settings.json    c08f957851d68845 → c08f957851d68845 OK
    ~/.cursor/hooks.json       4734d152efa28ffb → 4734d152efa28ffb OK
=== 假内核收到的请求：全部是 GET /internal/rtk（0 条 POST）
=== 假中转站收到的请求：全部是 GET /api/library/rtk（0 条写请求）
```

### 5.3 现网实况（重启 `com.crosery.console-magpie` 后）

```
GET /api/rtk/planes → plane=local
  kernel: not_supported  kernel_rtk_seam_missing
  relay:  not_supported  relay_route_missing
  local:  available      local_host
GET /api/rtk/status → connected=true version=0.50.0 path=~/.local/bin/rtk
  gain={commands:227,input:210019,saved:75950,pct:36.16}
  localAgents: codex/claude/omp/pi = on，gemini/cursor/copilot/trae/droid/hermes/vibe = off，windsurf/cline/kilocode/antigravity/kimi = supported:false
POST /api/rtk/install {} → 501 local_install_not_supported（附人工命令）
POST /api/rtk/upgrade {} → 501 local_upgrade_not_supported
POST /api/rtk/toggle {agent:gemini,on:false} → 200 {ok:true, plane:local, mechanism:rtk-cli,
     backup:…/backups/2026-10-01T00-35-54-541Z}
POST /api/rtk/rollback {backup:…,confirm:true} → 200 {ok:true, restored:[…13 个文件]}
/api/audit → toggle_rtk_hook|gemini|on=false, plane=local, outcome=ok, mechanism=rtk-cli
             install_rtk|local|outcome=error, status=501, reason=local_install_not_supported
             upgrade_rtk|local|outcome=error, status=501, reason=local_upgrade_not_supported
service.log → {"event":"rtk.plane","plane":"local","planes":["kernel:not_supported:kernel_rtk_seam_missing",
               "relay:not_supported:relay_route_missing","local:available:local_host"]}
```

> 说明：为取得真实端到端证据，在现网对 `gemini` 执行了一次**真实** OFF（它本来就是 off，属于无害动作），随后用 `/api/rtk/rollback` 回到写入前状态；`~/.codex/hooks.json`、`~/.claude/settings.json`、`~/.cursor/hooks.json` 的 sha256 与操作前完全一致，`.gemini/settings.json`、`.gemini/GEMINI.md` 与备份逐字节相同。

### 5.4 红队 T1–T17 自测结果

| # | 断言 | 结果 | 证据 |
| --- | --- | --- | --- |
| T1 | socket 不存在 → status 200 + `plane:'local'`，且不把「内核不可用」说成「RTK 未安装」 | ✅ | 用例「T1/T2 内核 socket 不可用时 status 仍可用」；`planes[0].reason=kernel_socket_missing` |
| T2 | seam 未编译（400 `request id required`）→ 视为控制面不可用并回退，日志能看到 plane 与状态码 | ✅ | 用例「T2 内核平面：旧构建…」断言 `not_supported` + detail `HTTP 400`；现网 service.log 的 `rtk.plane` 行 |
| T3 | `RTK_BIN=/nonexistent` → toggle 返回 409/503 + 安装指引，不得 200；status `connected:false` | ✅ | 用例「T3 rtk 未安装时拒绝写入」→ 503 `rtk_binary_missing`，message 含 `install.sh`；`findRTKBinary()` 返回 null 且不回落其它候选 |
| T4 | 并发两次 ON → 合法 JSON、rtk 条目恰好 1 条、第三方数量不变 | ✅ | 用例「T4/T6 并发与幂等」+ 进程内文件锁 |
| T5 | 临时 HOME 跑完整 ON→OFF，真实配置 sha256 不变 | ✅ | 用例「T5/T10」+ 文件末尾 `after()` 断言 10 个真实文件；5.2 的三情形运行同样比对 |
| T6 | 连续两次 ON 字节级一致、无重复条目 | ✅ | 用例「T4/T6」`assert.equal(readFileSync, once)` |
| T7 | 第三方 hook 保全：ON 后 3+1，OFF 后只剩 3 条 | ✅ | 用例「T7 关闭时只移除 rtk 自己那一条」 |
| T8 | 关得掉：CLI ON → 控制台 OFF → 无 rtk 条目、`on:false` | ✅ | 用例「T8 关得掉」（旧实现此处永远 true） |
| T9 | 坏 JSON 不覆盖：返回错误、原文件字节不变、备份存在 | ✅ | 用例「T9 坏 JSON 不覆盖」→ 409 `hook_file_unparsable`，`error.backup` 存在且含 manifest |
| T10 | agent 覆盖矩阵：11 个全局 agent 各自 ON→OFF，flag 合法、`stderr` 空、`exitCode===0`、状态独立 | ✅ | 用例「T10 agent 覆盖矩阵」（每个 agent 独立 HOME）；flag 白名单另外用 `rtk init --help` 解析后比对注册表 |
| T11 | `GET /api/rtk/status` 与 `rtk gain --daily --format json` 字段逐项相等 | ✅ | 用例「T11 字段一致性」；现网 gain 与红队 ground-truth 数值一致（227/210019/75950/36.16） |
| T12 | 中转站未接通必须诚实，不得出现「已接通」 | ✅ | 后端 `relay:not_supported:relay_route_missing` → 前端 `RtkBoard.vue` 渲染「未提供该接口」；`server/cpa.ts:396` 的 `rtkConnected` 未再用于我的页面文案（该文件不在本任务写范围，已上报 Lead） |
| T13 | 不得对中转站发起任何写请求 | ✅ | 假中转站请求日志只有 `GET /api/library/rtk`；用例「T13 中转站」断言 403/501 时 0 条写请求 |
| T14–T17 | 红队最终清单里的补充项（本机写入闸门、远端默认只读、回退可用、并发/幂等回归） | ✅ | 用例「本机写入闸门」「内核写入默认 501」「一键回退」「T4/T6」 |

---

## 6. 需要人工批准的动作

| 动作 | 状态 | 说明 |
| --- | --- | --- |
| 重编内核二进制（`npm run magpie:build`）+ 重启 8790 网关 | **未执行** | Lead 裁决本轮不做（缺 pinned 干净源码）。执行后 `kernel` 平面才会真正可用 |
| 中转站侧提供 RTK 管理面 + 管理凭据扩权 | **未执行** | 需要中转站侧配合与凭据 scope 设计；当前只读展示 |
| 真实本机 agent 配置写入（`~/.codex` 等） | **已执行 1 次并可回退** | 现网对 `gemini` 做了一次真实 OFF 并回退（§5.3）。其余写入都发生在临时 HOME |
| `RTK_WRITE_MODE` 默认值（本机可写 vs 全只读） | **待确认** | 当前默认 `local`（本机可写，UI 有确认弹窗 + 审计 + 备份）；要更保守就设 `RTK_WRITE_MODE=off` |
| HelpPage 第 8 节的 `/rtk` 链接 | **待 Lead 挂路由** | 页面组件已就绪（`RtkPage.vue` 默认导出） |

---

## 7. 仍未验证 / 剩余风险

1. **内核平面端到端未验证**：运行中的内核没有 seam，本轮也没重编。所以「内核可用」只看过假内核 socket 的 200 应答；真实 `library.ReadRTK/SetRTK` 的返回形状未验证（按上游 `library.RTKView` 类型做了归一化，字段名取自 `deploy/magpie/upstream/api.json`）。
2. **中转站真实管理面未验证**：上游契约里有 `/api/library/rtk*`，但当前中转站 404；「改造后能否工作」未验证。relay 写路径只在假中转站上验证过。
3. **`--auto-patch` 的副作用范围未穷尽**：实测它让 claude/gemini/vibe 能非交互写入；对 trae/copilot/hermes/pi/omp/droid 也传了（都 exit 0），但这些 agent 原本就不需要它，是否有额外改动未逐字节比对。
4. **跨 agent 连带关系只覆盖了已知的两条**（cursor→claude 加挂、claude-uninstall→删 cursor）。已实现通用「连带关掉就修复」的机制，但 rtk 未来版本可能新增别的耦合。
5. **项目级 agent**（windsurf/cline/kilocode/antigravity/kimi）只标了 `supported:false`，没有提供「按项目初始化」的控制台入口。
6. **前端未做浏览器实测**：RtkPage/RtkBoard 通过了 `tsc -p tsconfig.app.json` 与 `npm run build`，但没有用 ego-browser 实跑（本任务的证据以接口/CLI 为主；页面挂在 `/rtk` 之后建议由 Lead 或蓝队 B 的浏览器回归覆盖）。
7. **`server/cpa.ts:395-396`** 的 `oauthConnected:true` / `rtkConnected` 推导仍在（不在本任务范围），会经由 `/api/version` 进入 VersionWidget 文案——需要 task-4 或 Lead 收口。
8. 本机写入默认开启（`RTK_WRITE_MODE=local`）是产品取舍，不是技术限制；如需默认全只读，一个环境变量即可切换。
