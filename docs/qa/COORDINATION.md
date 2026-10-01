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
