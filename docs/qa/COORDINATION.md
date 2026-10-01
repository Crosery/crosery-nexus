# 红蓝对抗协作约定（Lead 维护）

日期：2026-10-01 · 仓库：`/Users/crosery/work_file/crosery-api-console`

## 角色与写入边界

| 成员 | 任务 | 可写范围 |
| --- | --- | --- |
| rtk-auditor（红A） | task-1 | `docs/qa/red-team/rtk-sync-audit.md`、`docs/qa/red-team/evidence/**` |
| ux-auditor（红B） | task-2 | `docs/qa/red-team/ui-interaction-audit.md`、`docs/qa/red-team/shots/**` |
| blue-rtk（蓝A） | task-3 | `server/rtk*.ts`、`src/api.ts`、`src/types.ts`(追加)、`src/pages/RtkPage.vue`、`src/components/RtkBoard.vue`、`src/pages/HelpPage.vue`、`docs/qa/blue/rtk-*` |
| blue-ui（蓝B） | task-4 | `src/lib/**`、新交互原语组件、`src/App.vue`、`src/components/{ConsoleShell,VersionWidget,RequestDetail}.vue`、`src/pages/*`（除 HelpPage/RtkPage）、`src/styles/**`、`docs/qa/blue/ui-refactor.md`、`docs/qa/blue/shots/**` |
| lead | 集成 | `src/router.ts`、`src/components/ConsoleNav.vue`、最终构建/重启/验收 |

写范围之外的文件一律只读。需要别人改，用 `send_message` 说明「谁、哪个文件、要什么改动、为什么」。

## 共享资源：构建与服务重启必须串行

`npm run build`（tsc -b + vite）、`npm test`、服务重启都会互相踩。规则：

**先看工作树，再跑全量**：别人正在写文件时，全量测试会把你自己的验证变成"别人的半成品"。**第 27 轮 Lead 就踩了一次**——`git status` 明明显示 `scripts/rollup-rebuild.mjs` 被改到一半（`rebuild is not defined`），还是跑了全量，白追一条假失败。正确做法二选一：

```bash
git status --short          # 有别人的未提交改动 → 换下面这条
git archive HEAD | tar -x -C /tmp/cac-clean && ln -s "$PWD/node_modules" /tmp/cac-clean/node_modules
cd /tmp/cac-clean && npm test     # 干净副本上跑，结论才算数
```

红队在第十八轮就是这么做的（`git archive HEAD` 副本 + 记录脏文件指纹），值得照抄。

```bash
# 取锁（最长等 180s，失败就报给 lead）
for i in $(seq 1 36); do mkdir /tmp/cac-build.lock 2>/dev/null && break || sleep 5; done

# 用完必须释放（即使命令失败也要释放）
rmdir /tmp/cac-build.lock 2>/dev/null
```

- 日常增量检查优先用 `npm run lint`（快，可并发）。
- 只有串行区内的命令才需要取锁：`npm run build`、`npm test`、`npm run test:magpie`、重启服务。
- ⚠️ `cat scripts/qa-*.mjs | ego-browser nodejs` 时，**`$?` 取到的是管道末尾命令的退出码**（`tail`/`grep`），而且 `ego-browser` 包装层会把脚本的真实退出码 **2（没量成）折叠成 1（有发现）**（红队 R11-B）——判据请读**脚本自己打印的 JSON 摘要**或 ego 报告的 `exited with code N`，不要只看 shell 的 `$?`。
- **门禁按退出码判定，不要 grep `fail` 计数**（红队 R5-A/R6 验证）：挂起类失败会计入 `cancelled`，汇总里 `fail` 仍是 0，只数 `fail` 的门禁会静默放行。测试脚本已带 `--test-timeout=30000`，挂起会在有界时间内以非 0 退出。
- **只允许重启** `com.crosery.console-magpie`：`launchctl kickstart -k gui/$(id -u)/com.crosery.console-magpie`。禁止动其它 `com.crosery.*` 服务。
- UI 改动要生效：先 `npm run build`，再刷新 `http://127.0.0.1:8791`（Express 静态托管 `dist/`，重建即生效）。
- 服务端改动要生效：`npm run build` 不是必须，但必须重启 `com.crosery.console-magpie`。
  **提交服务端改动的人负责重启并抽验**：先用 `launchctl kickstart -k ...` 重启，再对**运行中的实例**发一条真实请求验证新行为（红队 R7-A：`server/index.ts` 的修复已提交但服务没重启，线上仍在静默改写用户输入，而所有进程内测试都是绿的——测试 spawn 自己的子进程，验不到「进程没重启」）。

## 服务与沙箱（第 19 轮真实事故）

- **沙箱只允许写工作区**：`~/.agents/crosery/magpie-console/`（运行时目录：内核 socket、备份、日志）**在工作区之外，从受限会话里不可写**。表现是：
  - 手动/子进程启动内核会报 `Magpie kernel did not become ready`（内核无法在运行时目录创建 socket）；
  - `launchctl bootstrap|load` 报 **I/O error 5**，`kickstart` 报 service not found。
- ⇒ **不要 `launchctl bootout`（或任何方式停掉）这套服务**。第 19 轮我为修数据把服务停掉，结果是：内核起不来、launchd 也拉不回，控制台（8791 + 网关 8790）**对用户中断了十几分钟**，最后只能用一个一次性提权命令 `launchctl bootstrap` 恢复。
- **要重启就用** `launchctl kickstart -k gui/$(id -u)/com.crosery.console-magpie`（对已注册服务有效；不需要写运行时目录）。若真的需要停服务，**先确认自己能把它拉回来**。
- 需要写运行时目录或动 launchd 的操作，**一次性的提权请求是正确做法**，不要用"换个路径/换个端口"绕过（那会让用户的实例与真实运行时目录脱节）。

### 停服务前的 pre-flight（红队 R18-D 补强，关键判据不是"能 kickstart"）

`kickstart` 不需要写 runtime 目录，`bootstrap` 需要——这正是当时判断失误的地方。**想 bootout 之前必须先跑这三项，全绿才允许**：

```sh
RT=~/.agents/crosery/magpie-console
touch "$RT/.preflight" && rm "$RT/.preflight" && echo "1) runtime 可写 ✓"      # 关键判据
test -f ~/Library/LaunchAgents/com.crosery.console-magpie.plist && echo "2) plist 在 ✓"
launchctl print gui/$(id -u)/com.crosery.console-magpie >/dev/null 2>&1 && echo "3) 当前已注册 ✓"
```

- **无提权通道时的退路**（默认禁止停服 + 声明式例外）：① 请用户在自己的终端跑 `launchctl bootstrap`；② 在工作区内的临时 runtime 起前台实例并**明确标注"不是用户真实实例"**；③ 直接放弃停服，改用不需要冻结写入的修复方式。
- **停服前声明停机时间预算与观察窗口**，超时立即升级（当时没有预算，所以"十几分钟"是无意识的）。
- **恢复后验证清单**：`/api/session` 200 + 8790 `/health` 200 + `launchctl print` 的 `state = running` 且 PID 已变化 + 抽一条真实请求，并留证据。

### 重启/恢复时的两条实测坑（红队第二十七轮崩溃演练）

- **重启前先确认旧进程真的退出了**：两个实例共用同一个 DATA_DIR 会直接 `database is locked (261)`（单实例设计，没有"第二个自动退出"这种优雅行为）。`launchctl kickstart -k` 会先杀后起，但**手写进程/后台任务**时要自己确认。
- **备份目录里的文件副本可能以 `.` 开头**（原始文件名就是 `.xxx` 时），`ls` 看不到——排查"备份里到底有什么"要用 `ls -a`（我第一轮就看漏了一处）。
- **PID 变化是正常的**：Lead 会因为让服务端修复生效而 `launchctl kickstart -k`（第 20 轮修数据、第 27 轮 `/v1` 降级与 OAuth 修复各一次）。看到 PID 变了先对照本条，别当成异常。

## Git（共享工作区，血泪教训）

多个成员共用**同一个索引与同一个分支**，所以：

- **`git add` 与 `git commit` 都必须带显式路径**（`git commit -- <paths>`）。索引里随时可能有别人的暂存内容，裸 `git commit` 会把队友的文件卷进你的提交。
- **不要在共享分支上 `amend`/`reset`/`rebase` 别人的提交**。第 10 轮真实发生过：A 的提交卷走了 B 的 17 个文件 → A `reset --soft` 改写 → **B 的改动从 HEAD 消失、退回暂存区**（内容没丢，但一度以为丢了）。改写前先 `git diff --cached` 看清谁的暂存。
- 提交前固定自查：`git diff --cached --stat` **逐项**是否都属于本任务写范围。
- 临时改动一律用 `git diff` + `shasum` 自证还原，别用 `git checkout .`（会连队友的改动一起冲掉）。

## 浏览器（ego-browser）

- 同一时间只允许一个成员驱动浏览器。用 `/tmp/cac-browser.lock` 同样的 mkdir 方式取锁，用完 `rmdir`。
- 严禁 `Network.clearBrowserCookies`、清缓存/Cookie、动 profile 目录。
- TaskSpace 结束必须 `await task.finish({ keep: [] })`，只调一次；中途不用的页面 `page.close()`。

## 事实与证据

- 结论必须能复现：仓库事实给 `path:line`，运行期事实给「命令 + 关键输出」。
- 分「已验证 / 未验证 / 推断」三类；未验证就写未验证，不许脑补中转站或远端行为。
- 凭据只在环境变量/Keychain/stdin 里引用，**不得**出现在源码、日志、文档、截图或命令行明文参数里。
- 不新增生产依赖。测试里禁止读写真实 `~/.codex`、`~/.claude`、真实业务库；用临时 HOME/临时目录。


## 生产主机上的进程操作（第 35 轮真实事故）

**禁止**在生产主机上用宽泛的 `pgrep -f <脚本名>` 做批量 kill：它同时匹配到生产进程树里的
`sh -c tsx` / `node .bin/tsx` / 真正的 node 三个进程，而白名单只跳过 `MainPID` 是不够的——
**它的子进程不在白名单里**。第 35 轮我这样杀掉了生产 child，服务停在 `inactive/dead`：
systemd 是 `Restart=on-failure`，而 SIGTERM 退出码为 0（干净退出）⇒ **不会自动拉起**。

规则：

1. **要停的是临时实例，就按"端口 / 临时 DATA_DIR"精确定位**，别按脚本名：
   `ss -ltnp | grep :18787` 拿到 PID，再 `ps -o pid,ppid,cmd -p <PID>` 确认它的父进程是 `npm run start`，然后 **`kill -- -<PGID>`** 杀整个进程组（`setsid` 启动的临时实例才有独立进程组）。
2. **杀之前先列生产进程树并存档**：`systemctl show -p MainPID` + `pgrep -P <MainPID>`，逐个比对，别靠一个 PID。
3. **改任何"靠近生产"的东西之前，先确认回退动作**（`systemctl start` 是否能把它拉回来——本轮能，8 秒恢复）。
4. `Restart=on-failure` **不等于**"杀了会自动回来"：干净退出不会重启。写 runbook 时别把这条当默认。

## 部署目标（第 36 轮真实事故）

**用户说「提交上线」不等于授权你部署到生产。** 第 36 轮我把「提交上线」当成部署批准，
把本机开发中的 Vue 改造推到了 `<relay-console 域名>`，而用户的要求是**这轮 UI 改造只在本机做**。
生产页面对用户是「别人看得见的东西」，改它属于对外变更。

规则：

1. **动生产前必须由用户点名环境**（主机 + 服务 + 域名），不能从"上轮说过上线"推断本轮也授权。
2. **本机控制台（127.0.0.1:8791）与生产控制台（`console.ai.crosery.com`）是两件事**：
   本机是开发沙箱，生产是对外的。UI / 交互实验**默认只在本机**，除非用户点名要上线。
3. 部署前把「回退动作」写进命令里再执行，部署后立刻在同一批命令里跑对外验收 + 记录回退目标。
4. **只读也要注意凭据**：`cat` 生产 `data/*.json` 会把 `sk-` 明文带进会话记录。要看策略文件就看
   **条数与 hash**（`unlimitedKeyCount` / `policyHash`），不要打印内容。
