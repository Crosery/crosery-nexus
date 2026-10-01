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
- **只允许重启** `com.crosery.console-magpie`：`launchctl kickstart -k gui/$(id -u)/com.crosery.console-magpie`。禁止动其它 `com.crosery.*` 服务。
- UI 改动要生效：先 `npm run build`，再刷新 `http://127.0.0.1:8791`（Express 静态托管 `dist/`，重建即生效）。
- 服务端改动要生效：`npm run build` 不是必须，但必须重启 `com.crosery.console-magpie`。

## 浏览器（ego-browser）

- 同一时间只允许一个成员驱动浏览器。用 `/tmp/cac-browser.lock` 同样的 mkdir 方式取锁，用完 `rmdir`。
- 严禁 `Network.clearBrowserCookies`、清缓存/Cookie、动 profile 目录。
- TaskSpace 结束必须 `await task.finish({ keep: [] })`，只调一次；中途不用的页面 `page.close()`。

## 事实与证据

- 结论必须能复现：仓库事实给 `path:line`，运行期事实给「命令 + 关键输出」。
- 分「已验证 / 未验证 / 推断」三类；未验证就写未验证，不许脑补中转站或远端行为。
- 凭据只在环境变量/Keychain/stdin 里引用，**不得**出现在源码、日志、文档、截图或命令行明文参数里。
- 不新增生产依赖。测试里禁止读写真实 `~/.codex`、`~/.claude`、真实业务库；用临时 HOME/临时目录。
