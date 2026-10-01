# RTK 第二轮对抗验证（红队 A / task-9，针对 task-3 最终 revision）

日期：2026-10-01 · 审计者：rtk-auditor（只读产品代码；写范围仅 `docs/qa/red-team/**`）
验证时点：**2026-10-01T00:53Z（本地 08:53）**，被验代码快照（工作区未提交，按 sha256 前 12 位记）：

```
211a8f509a16 server/rtkService.ts      e175951a41c7 server/rtkPlane.ts
97f443de6da6 server/index.ts           cd3ac927d23a server/cpa.ts
16c16f5f26f6 src/pages/RtkPage.vue     99579292b3b7 src/components/RtkBoard.vue
fe7eb9a9c4eb src/components/VersionWidget.vue
dist/index.html mtime 08:50:28（服务 pid 46769, runs=3）
```

> ⚠️ 工作区在本轮验证期间持续变化（blue-ui 在 08:50:28 又重建了 dist）。**第 3 节的 UI 结论对应我这次会话加载的那个 bundle**；蓝队/lead 定稿后需按本文的判据复跑一次。

判定口径：**已验证**＝我独立复现出同样事实；**被推翻**＝我的复现与主张相反；**部分被推翻**＝主张在部分条件下成立、在另一条件下不成立；**无法验证**＝我拿不到证据。

---

## 0. 逐条主张判定（结论在前）

| # | 蓝队主张 | 判定 | 一句话 |
| --- | --- | --- | --- |
| 1 | 平面语义：`plane=local`，kernel `not_supported:kernel_rtk_seam_missing`，relay `not_supported:relay_route_missing`，`connected=true v0.50.0` | **已验证** | `/api/rtk/status` 与 `/api/rtk/planes` 原文一致；我用假内核/假中转站还验证了 plane 解析顺序 kernel→relay→local 与逐平面 reason |
| 2 | C 层修复：形状 `{matcher,hooks[]}`、只增删自己那条、坏 JSON 不覆盖、检测不再 OR 链、CLI 走合法 flag + `--auto-patch` | **部分被推翻** | 形状/坏 JSON/关得掉/覆盖矩阵都对；但**「只增删自己那一条」在 cursor→claude 方向不成立**：cursor ON 会静默写 `.claude/settings.json` 并新建 `.claude/RTK.md`+`.claude/CLAUDE.md`，OFF 不还原（缺陷 1） |
| 3 | 写入策略：local 默认可写；kernel/relay 默认 501/403；install/upgrade 一律 501 | **已验证** | 假服务端日志证明默认 **0 条写请求**；`RTK_ALLOW_KERNEL_WRITE=1` 后才真的 POST 到内核（设计如此）；install/upgrade 501 + 人工命令 |
| 4 | 对 gemini 真实 OFF + rollback 后三个真实 agent 配置 sha256 与操作前一致 | **已验证（带限定条件）** | 真实文件与备份字节一致、第三方条目全在、无本次新增残留；但「操作前」的权威证据是被测工具自己的备份（时间顺序无争议：备份 00:35:54.541Z < toggle .626Z < rollback 00:36:03.697Z） |
| 5 | 写前备份 + `collateralRestored` 处理 `--agent cursor`↔claude 连带 | **部分被推翻** | 备份机制存在且可用；但 `collateralRestored` **只处理「被连带关掉」方向**，ON 方向既不改也不报（实测 cursor ON/OFF 两次响应里都没有该字段） |
| 6 | 反例 T1/T2/T3/T5/T7/T9/T10/T13/T16/T17 全绿；`npm run test:magpie` 55/54 pass/1 skip | **已验证** | 我独立跑出完全相同的 55/54/0 fail/1 skip；T5/T7/T8/T9/T10/T14/T16 我另做了 HTTP 级端到端复现（不是读它的测试） |

**一句话总结**：控制面语义、写入闸门、坏 JSON 防护、备份与回滚、测试套件都站得住；**没站住的是「跨 agent 连带」与「失败路径」这两块，以及 UI 的失败反馈**。

---

## 1. 缺陷清单（6 条，均为我独立复现）

### 缺陷 1（中高）cursor 开关静默改写 Claude 配置，且关闭时不还原、留下残留文件

**复现**（隔离实例 PORT=8795，临时 HOME=/tmp/cac-r2/home；同样的代码，只是 HOME 隔离）：

```
baseline: cursor_rtk=0  claude_rtk=0
$ curl -b cookies.txt -X POST /api/rtk/toggle -d '{"agent":"cursor","on":true,"plane":"local","confirm":true}'
HTTP 200 {ok:true, mechanism:"rtk-cli", cli:{command:"rtk init -g --agent cursor --auto-patch", exitCode:0, stderr:""}}
        ← 响应里没有 collateralRestored，也没有任何字段提到 claude
AFTER cursor ON : cursor_rtk=1  claude_rtk=1        ← .claude/settings.json 被连带写入 rtk 钩子
changed files   : .claude/settings.json, .claude/settings.json.bak, .cursor/hooks.json,
                  .claude/RTK.md(新建), .claude/CLAUDE.md(新建)
$ curl -b cookies.txt -X POST /api/rtk/toggle -d '{"agent":"cursor","on":false,"plane":"local","confirm":true}'
HTTP 200 {ok:true}                                  ← 仍然没有 collateralRestored
AFTER cursor OFF: cursor_rtk=0  claude_rtk=1        ← claude 的 rtk 钩子留在原地
status: claude=true cursor=false
残留：~/.claude/RTK.md EXISTS（首行 "# Command output"）、~/.claude/CLAUDE.md EXISTS
```

**代码根因**：`server/rtkService.ts:631-645` `repairCollateral()` 只处理 `isAgentOn(before) && !isAgentOn(after)`（原本开着→被关掉），对「原本关着→被打开」不做任何处理，也不进 `collateralRestored`；`src/pages/RtkPage.vue:57` 也只在 `collateralRestored` 非空时才提示。

**反向是好的**（不要一起改坏）：`claude OFF` 会连带删掉 `.cursor/hooks.json` 的 rtk 条目，此时响应确实给出 `collateralRestored:["cursor"]` 并修回。

**影响面**：用户点「Cursor 开」会**静默打开 Claude Code 的 rtk 钩子**；点「Cursor 关」后 Claude 仍带着 rtk 钩子运行；同时 `.claude/CLAUDE.md`（Claude 的全局记忆文件）被凭空创建。UI 没有任何提示。**与蓝队自己的测试名矛盾**（`✔ rtk 的真实耦合：cursor 目标会同时注册 Claude 钩子（UI 需如实展示，不能藏）`）——测试承认了耦合，但实现与 UI 都没有「如实展示」。

**建议**：把 `repairCollateral` 扩成双向（把被连带打开的文件也按快照还原），或者至少在 toggle 响应里回传 `collateralTouched[]`，UI 明确提示「本次同时改动了：Claude Code」并提供「一并撤回」。

### 缺陷 2（中）rtk 未安装时，local 平面仍报「本机 rtk 已安装」，与同一响应自相矛盾

```
$ PORT=8793 RTK_BIN=/nonexistent/rtk ... node server/index.ts
$ curl -b cookies-8793.txt http://127.0.0.1:8793/api/rtk/status
{"plane":"local","connected":false,"path":null,"version":null,
 "install":"curl -fsSL https://www.rtk-ai.app/install.sh | sh",
 "local":{"connected":false,"path":null,"version":null},
 "localPlane":{"id":"local","available":true,"configured":true,"state":"available",
               "reason":"local_host","detail":"本机 rtk 已安装"}}
```

同一个响应里 `connected:false / path:null` 与 `detail:"本机 rtk 已安装"` 互相打架；页面平面卡片会显示绿色「本机 · 已接通」+「本机 rtk 已安装」。

**代码根因**：`server/rtkPlane.ts:366` `const planes = [kernel, relay, probeLocalPlane()]` —— 没把 `binFound` 传进去，`probeLocalPlane(binFound = true)` 永远走「已安装」分支（第 331-337 行）。

**对照**：同实例的写入是诚实的 —— `POST /api/rtk/toggle` 返回 `503 rtk_binary_missing` + 安装命令。

**建议**：`probeLocalPlane(Boolean(bin))` 一行修复；`state` 也应在未安装时降级（例如 `available:true` 保留但 detail 如实写「未安装 rtk（仍可读写 agent 配置，但 CLI 路径不可用）」）。

### 缺陷 3（中高，数据完整性）rtk CLI 把钩子文件写坏后，控制台返回 409 但把坏内容留在原地，不回填备份

**最小复现**（隔离实例 8792，用一个「照常 exit 0 但把 .codex/hooks.json 覆盖成垃圾」的假 rtk 模拟 CLI 崩溃/被杀/写一半）：

```
before: bytes=190 valid=yes  {"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo third-party-a"}]}]}}
$ curl -b cookies-8792.txt -X POST /api/rtk/toggle -d '{"agent":"codex","on":true,"plane":"local","confirm":true}'
{"error":"codex 的 .codex/hooks.json 不是合法 JSON，拒绝覆盖","plane":"local","reason":"hook_file_unparsable",
 "backup":"/tmp/cac-r2/home/.agents/crosery/magpie-console/backups/2026-10-01T00-45-15-387Z"}   [HTTP 409]
after : bytes=16 valid=no   内容 = THIS IS NOT JSON      ← 备份目录里有合法原件，但没有回填
```

**代码路径**（`server/rtkService.ts`）：CLI 执行(第713行) → `verifyLocalHook` 失败 → 走 hooks-json 兜底 → `applyHookJson` 预检抛 409(第588行) → catch 里 `writeFileAtomic(filePath, existedBefore)`(第733-734行)，而 **`existedBefore` 是第729行在 CLI 之后读的**，此时已是坏内容 → 「还原」把坏内容写回坏内容。真正的前置原件只在 `backup.dir` 里，响应只给路径。

**真实文件影响面**：这条路走到的前提是「rtk CLI 让目标文件变成非法 JSON」。真实概率不高，但一旦发生，受害的是**用户的 agent 钩子文件**（`~/.codex/hooks.json` 或 `~/.claude/settings.json`），
而这两个文件同时也是 orca / clawd / 其他工具注册钩子的地方（本机实测各 3 条 PreToolUse），坏掉会让这些工具**全部失效**。控制台手上有完整备份却不自动回填，属于「有救不回」。

**建议**：在 CLI 运行前就把 `spec.hookFile` 的原文存进 `guardSnapshot`（现在只存了 otherHookFiles），失败路径统一用它回填；错误文案补一句「已备份，可 /api/rtk/rollback 恢复」。

**附带（次要）**：目标目录不可写时返回裸 Node 异常 —— `{"error":"EACCES: permission denied, open '/tmp/.../.rtk-50319-...tmp'"}` [HTTP 500]，泄漏服务端临时文件路径且不带 `reason/plane`（文件本身没被破坏，这点是好的）。

### 缺陷 4（低中）备份无保留策略，且每次 toggle 全量备份

```
# 我的一次探测脚本（~25 次 toggle，隔离 HOME）
$ ls .../backups/ | wc -l         → 46        （后来继续增长）
$ du -sh .../backups/             → 1.3M
# 真实机器：蓝队 1 次写操作 = 1 个备份目录 104K
104K  ~/.agents/crosery/magpie-console/backups/2026-10-01T00-35-54-541Z/

$ grep -n "retention\|prune\|maxBackups\|BACKUP" server/rtkService.ts server/rtkPlane.ts
server/rtkService.ts:194:  const override = String(env.RTK_BACKUP_DIR || '').trim()   # 只能改目录，不能限量
```

另外每次 toggle 的响应会把**最近 10 个备份目录 + 完整文件清单**整包返回（见 `10-cursor-claude-collateral.txt` 里的 `backups[]`），响应体随历史线性膨胀。
影响：用户每点一次开关多 104K，没有清理入口（rollback 只恢复、不删除）。建议保留最近 N 份或按时间/体积轮转。

### 缺陷 5（中，UI）所有失败提示被随后的状态刷新清空，「点了没反应」

**复现**（浏览器实测，20ms 间隔 DOM 观察器）：

```
点击「安装 rtk」→「确认执行」（接口固定 501）
alert timeline: [{ "at": 1303, "text": "操作失败（未做任何静默降级） | HTTP 501 · 控制台不代为安装本机 rtk，
                  请人工执行：curl -fsSL https://www.rtk-ai.app/install.sh | sh · 平面=local ·
                  原因=local_install_not_supported" }]
alerts visible now: 0                      ← 提示出现后立即消失
API /api/rtk/install -> 501 {"error":"控制台不代为安装本机 rtk…","plane":"local","reason":"local_install_not_supported"}
```

**代码根因**：`src/pages/RtkPage.vue:75-80` catch 写 `errorText`，`finally { await load() }`；`load()` 成功时第 42 行 `errorText.value = ''` 把刚写的错误清掉。同页第 102 行的 `TxAlert` 因此一闪而过。
影响面：**全部失败路径**（501 install/upgrade、403 确认缺失、409 坏 JSON、503 rtk 缺失、远端 401/404）在 UI 上都表现为「点了没反应」，用户拿不到原因——这与该页自我宣称的「操作失败（未做任何静默降级）」正好相反。

### 缺陷 6（中，UI/无障碍）危险操作确认框的 Escape 关闭不可靠

同一页面、同一会话，连续 4 次「打开确认框 → 只按一次 Escape」：

```
escape trials: [{"i":0,"opened":true,"closedByOneEscape":false},
                {"i":1,"opened":true,"closedByOneEscape":false},
                {"i":2,"opened":true,"closedByOneEscape":false},
                {"i":3,"opened":true,"closedByOneEscape":false}]
```

另一次会话里同一步骤第一次 Escape 就关掉了（`overlays 8→2, hasConfirmTitle false`）；还有一次 Tab 到「取消」后按 Escape **不关**（`{"modal":true,"focusInModal":false}`），只能鼠标点「取消」。
焦点陷阱本身正常（Tab 在 容器→取消→确认执行 之间循环，不出 modal）。
**判据与 lead 在 `/keys` 的结论一致**：TxModal 的 Escape 命中与否取决于焦点/时序，属于不稳定行为；对「破坏性开关」这种对话框，键盘用户会关不掉。

截图：`shots/round2/02-confirm-open.png`、`03-after-escapes.png`、`04-modal-keyboard.png`、`05-escape-stuck.png`

### 附带发现（不单列为缺陷）

- 确认框文案**过度承诺**：「写入前会备份 ~/.cursor 相关文件，只增删 rtk 自己那一条，第三方钩子保持不变；**失败自动还原**」——缺陷 1 与缺陷 3 都证伪了后半句。
- 全程没有任何「需要重启 agent / 需要批准 hook 信任」的提示（`grep 信任|重启|trust` 在 RtkPage/RtkBoard/VersionWidget 全为 0 命中）；rtk CLI 自己会打印 "Restart Codex. For a project hook, approve it when Codex asks you to trust it."，但控制台只留 exitCode/stderr → **文件写完 ≠ 生效**这一点没有传达（我上轮的反例 T17）。
- rtk CLI 会在用户配置目录留下 `*.bak`（实测 `.claude/settings.json.bak`、`.cursor/hooks.json.bak`、`.codex/hooks.json.bak`、`.trae/*`、`.factory/*`），控制台不清理也不纳入备份。
- `POST /api/rtk/toggle` 在 `writeMode=local` 下**不要求 `confirm:true`**（实测不带 confirm 也 200 并真的写了）；UI 始终带 confirm，所以这是「API 面比 UI 面宽」的设计取舍，不是漏洞，但值得写明。
- 同一状态两处措辞不一致：`/rtk` 平面卡片写「已接通」（`RtkBoard.vue:35`），顶部 VersionWidget 写「本机：可用 (v0.50.0)」（`VersionWidget.vue:243`）。
- `status.latest` 现在恒为 `null`（第一轮是硬编码 `v0.50.0`）；UI 无消费者（grep 0 命中），属无害，但字段名有误导性。

---

## 2. 必做验证项：结果与命令

### 2.1 T7 第三方条目保全 / T8 关得掉 / T9 坏 JSON / T10 覆盖矩阵 / T5 真实配置零改动（HTTP 级，隔离 HOME）

脚本：`docs/qa/red-team/evidence/round2/probe-local-writes.mjs`（我写的，独立于蓝队测试）

```
T8-codex-OFF        : 200 ok=true  mechanism=rtk-cli
                      codex PreToolUse → 2 条（两条第三方，rtk 条目已移除）
T8-detect-after-OFF : codexOn=false                        ← 第一轮「永远 true」的 bug 已修
T7-codex-ON         : 200 ok=true  → 3 条（第三方两条 + {matcher:"Bash",hooks:[{type:"command",command:"rtk hook codex"}]}）
T16-codex-OFF-again : 200 ok=true  → 回到 2 条；claude 的 rtk 条目未被误删（true）
T14-claude-ON       : 200 ok=true  → .claude/settings.json 真的写入 rtk 条目（--auto-patch 生效）
T14-gemini-ON       : 200 ok=true  → .gemini/settings.json 出现 BeforeTool + rtk-hook-gemini.sh
T9-bad-json         : 409 {"error":"codex 的 .codex/hooks.json 不是合法 JSON，拒绝覆盖","reason":"hook_file_unparsable"}
                      原文件字节不变(31) → 通过
T4-concurrent-ON    : 两次并发 ON 都 200；rtk 条目 = 1，JSON 合法     ← 幂等通过
T5-real-config      : 7 个真实文件 sha256 前后完全一致（identical: true）
T10 matrix          : 11 个 agent 全部 on=200/true/detected=true → off=200/true/detected=false
rollback            : 200 {"backupId":"2026-10-01T00-42-08-343Z","restored":[13 个文件]}
```

T16 我另做了最有杀伤力的那条：`claude OFF` 是否误伤 cursor →

```
claude OFF response: {"ok":true,"collateralRestored":["cursor"]}
cursor still has rtk entry: 1        ← 修回来了，这条主张成立
```

### 2.2 蓝队那次真实写入的只读取证（主张 4/5）

```
audit: 00:35:54.541Z 备份目录 → 00:35:54.626Z toggle_rtk_hook gemini on=false,plane=local,outcome=ok,mechanism=rtk-cli
       → 00:36:03.697Z rollback_rtk_hook restored=13 文件; 另 install/upgrade 两条 501 记录
mtime: 真实四个配置 = 2026-10-01T00:36:03Z（＝rollback 时刻）；备份目录 = 00:35:54Z
hash : ~/.codex/hooks.json, ~/.claude/settings.json, ~/.cursor/hooks.json, ~/.gemini/settings.json,
       ~/.gemini/GEMINI.md, ~/.omp/.../rtk.ts, ~/.pi/.../rtk.ts  全部 = 备份里的操作前副本（IDENTICAL）
条目 : codex PreToolUse 3 条（orca, clawd, rtk）/ claude PreToolUse 3 条（clawd, rtk, orca）
残留 : 备份 manifest 里 existed:false 的 6 个文件（.gemini/hooks/rtk-hook-gemini.sh, .copilot/hooks/rtk-rewrite.json,
       .trae/hooks.json, .factory/hooks.json, .hermes/.../plugin.yaml, .vibe/hooks.toml）实测全部 absent
```

结论：**主张 4 成立**。限定条件写进报告：操作前内容只能由「备份 + 时间顺序 + 我第一轮（不同时间/不同工具）的条目结构观测」三重印证，不是独立哈希。

### 2.3 写入面收口（假内核 socket + 假中转站）

见 `evidence/round2/15-write-containment.txt`。要点：

```
默认（无允许位）：kernel 写 → 501 kernel_write_not_supported；relay 写 → 501 relay_write_not_supported
假内核日志：仅 GET /internal/rtk（+ 我手工 curl 的一条）；假中转站日志：GET 若干，POST/PUT/DELETE = 0
RTK_ALLOW_KERNEL_WRITE=1 + confirm:true：请求真的 POST 到假内核（WRITE-REACHED-KERNEL），返回 200 ok:true
RTK_ALLOW_REMOTE_WRITE=1 + relay(404)：仍 501，假中转站 0 条写请求
真实中转站：GET /api/library/rtk → 404；认证 GET /v0/management/rtk → 404；认证 GET /v0/management/auth-files → 200
```

「中转站真机 0 条写请求」我没有做真机抓包，是由**同代码同状态**（`relay_route_missing`，写闸门先短路）的隔离实例外推 —— 标注为**部分无法验证**。

### 2.4 诚实性

```
$ curl -b cookies.txt http://127.0.0.1:8791/api/version
{"engine":"magpie","version":"3fe2ff9","upstream":{"rtkConnected":false,"oauthConnected":false,...},
 "rtk":{"plane":"local","planes":[{"id":"relay","state":"not_supported","reason":"relay_route_missing"},...]}}
```

- `rtkConnected:false`、`oauthConnected:false` —— **已修好**（第一轮 `server/cpa.ts:395` 是 `oauthConnected: true` 硬编码、`rtkConnected` 由本机二进制推导；现在 `server/cpa.ts:436-439` 改为「relay 平面可用才算接通」+ `localOAuthConnected()` 真实读本机凭据库）。
  **时点提醒**：08:39 我抓到的还是旧的 `true/true`（cpa.ts 08:41:46 才改完并重启），所以这条结论对应 08:42 之后的服务；deploy-reconciler 若再改，以此判据复跑。
- `/api/rtk/status.connected=true` 仍表示「本机 rtk 二进制可用」，但页面已按平面分别标注（本机=已接通、内核/中转站=未提供该接口），顶部 widget 改为「中转站：未接通」。**没有再把「本机装了」说成「已接通本中转站」**。

### 2.5 UI 实测（ego-browser，详见 `evidence/round2/16-ui-browser-test.txt`）

- `/rtk` 打开正常（dist 08:45 构建版），平面徽标诚实、11 个可切换 agent + 5 个项目级只读、点击有确认框。
- 窄屏 390×844：`horizontalOverflow:false`、无元素越界（`overflowers: []`）、11 个开关可点；卡片左右贴边（次要）。
- 失败态、Escape 两条缺陷见上文缺陷 5/6。
- 结束时 `finish({ keep: [] })` 调用一次；未 adopt/close 他人 space、未清 cookie/存储/缓存、未动 profile；`/tmp/cac-browser.lock` 当时属 ab-harness，我未 rmdir（现在已空）。

### 2.6 测试套件复现（主张 6）

```
$ npm run test:magpie
ℹ tests 55   ℹ pass 54   ℹ fail 0   ℹ skipped 1   ℹ duration_ms 758.48
（断言前后真实 agent 配置 sha256 完全一致：YES）
```

同时段取 `/tmp/cac-build.lock` 串行执行，用完释放。

---

## 3. 无法验证 / 未验证

1. **真实中转站「0 条写请求」**：未做真机抓包（见 2.3），只做了隔离实例 + 代码路径外推。
2. **中转站宿主机是否存在可写入的 RTK 面**：仍然是 404（认证后也一样），无法进一步取证。
3. **UI 缺陷 5/6 是否在 blue-ui 最新构建里仍在**：我验证的是 08:45 构建、08:50:28 又被重建过一次；需按同判据复跑（Escape 4 连测 + 失败提示是否常驻）。
4. **`RTK_ALLOW_KERNEL_WRITE=1` 打开后对真实内核的影响**：我只打到假内核；真实内核二进制还没有 `/internal/rtk`（第一轮已验证字符串计数 0），所以真机上这条路径目前仍会 501。
5. **Escape 缺陷的第 1 次按下的成功率**：三次会话里分别是 1 次成功、4/4 失败、Tab 后失败 —— 判定为不稳定，但无法给出稳定复现率。

---

## 4. 建议的处置顺序（给 lead）

| 优先级 | 事项 | 规模 |
| --- | --- | --- |
| P0 | 缺陷 3：失败路径从 `guardSnapshot` 回填（含 hookFile），错误文案补 rollback 指引 | `server/rtkService.ts` 小改 |
| P0 | 缺陷 5：失败提示被 `load()` 清空（`finally` 里不要把 `errorText` 清掉，或失败时不 reload） | `src/pages/RtkPage.vue` 小改 |
| P1 | 缺陷 1：`repairCollateral` 双向化 / 回传 `collateralTouched` + UI 提示 | `server/rtkService.ts` + RtkBoard 中改 |
| P1 | 缺陷 6：确认框 Escape 稳定化（这条是 tuffex 封装层，需与 lead 的 `/keys` 结论合并处理） | 组件层 |
| P2 | 缺陷 2：`probeLocalPlane(Boolean(bin))` 一行 | `server/rtkPlane.ts` 一行 |
| P2 | 缺陷 4：备份保留策略（最近 N 份 / 90 天）+ 响应里只回最近 1 条 | `server/rtkService.ts` 小改 |
| P3 | 确认框文案「失败自动还原」「第三方钩子保持不变」按实际能力改写 | `src/pages/RtkPage.vue` 文案 |
| P3 | 补「写完需重启/信任 agent 钩子」提示；`.bak` 残留清理 | UI 文案 + 备份集合 |

---

## 5. 证据索引

| 文件 | 内容 |
| --- | --- |
| `evidence/round2/01-status.json` / `02-planes.json` / `03-version.json` | 现网 `/api/rtk/status`、`/api/rtk/planes`、`/api/version` 原文 |
| `evidence/round2/probe-local-writes.mjs` + `18-local-writes-e2e.{json,txt}` | 我写的 C 层端到端探测器与结果（T4/T5/T7/T8/T9/T10/T14/T16 + rollback） |
| `evidence/round2/10-cursor-claude-collateral.txt` | 缺陷 1（含响应、变更文件、残留、代码根因、反向对照） |
| `evidence/round2/11-local-plane-misreport.txt` | 缺陷 2 |
| `evidence/round2/12-failure-restore.txt` | 缺陷 3 + 3b |
| `evidence/round2/13-backup-growth.txt` | 缺陷 4 |
| `evidence/round2/14-real-write-forensics.txt` | 主张 4/5 的只读取证（mtime/hash/audit/manifest） |
| `evidence/round2/15-write-containment.txt` | 假内核/假中转站 + 真实中转站只读探测 |
| `evidence/round2/16-ui-browser-test.txt` | 浏览器实测（含缺陷 5/6 与窄屏数据） |
| `evidence/round2/17-test-suite.txt` | `npm run test:magpie` 复现 |
| `docs/qa/red-team/shots/round2/*.png` | 10 张截图（平面卡片、确认框、Escape 卡住、501 提示、窄屏） |
| `docs/qa/red-team/rtk-sync-audit.md` | 第一轮审计（基线与四层修复建议） |
