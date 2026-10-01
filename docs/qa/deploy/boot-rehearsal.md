# 发布包本地启动演练（Release boot rehearsal）

日期：2026-10-01 ｜ 执行：Lead ｜ 发布源 `8fa05fe` ｜ 位置：`/tmp/cac-release-r2`（`--frontend=vue` 组装产物）

## 为什么做这一步

此前对发布包只做过三类验证：**内容**（MANIFEST/缺失文件/体积）、**dist 一致性**（V2）、**同构预演**（本地跑源码实例）。**从来没有把"组装出来的那棵树"真的启动过**——也就是说，"包装完能不能跑"这条一直没人验。组装正确 ≠ 能启动：路径、入口、`node_modules` 解析、`package.json` 脚本、静态托管目录，任何一处错都只在启动时暴露。

## 做法（隔离、可回退、不碰生产）

```bash
cd /tmp/cac-release-r2 && ln -sfn <repo>/node_modules node_modules     # 发布树不含 node_modules，按生产做法外置
env -i PATH="<repo>/node_modules/.bin:<node dir>:/usr/bin:/bin" \
  HOME=/tmp/cac-boot-home DATA_DIR=/tmp/cac-boot-data \
  HOST=127.0.0.1 PORT=18899 \
  CPA_BASE_URL=http://127.0.0.1:9 CPA_MANAGEMENT_KEY=staging-not-real \
  SESSION_SECRET=staging-not-real-0123456789abcdef0123 \
  CONSOLE_USERNAME=staging CONSOLE_PASSWORD=staging-not-real \
  node node_modules/tsx/dist/cli.mjs server/index.ts
```

- 隔离 `HOME` 与 `DATA_DIR`（临时目录，跑完只剩一个空的 `console.db`）、**备用端口 18899**、CPA 指向 `127.0.0.1:9`（必然不可达，看降级是否优雅）。
- 与生产服务的区别只有这些环境变量与端口；启动方式（`tsx server/index.ts`）与 systemd 单元的 `ExecStart` 一致。

## 结果（全部实测）

| 探测 | 结果 |
| --- | --- |
| 启动 | 监听成功，日志：`Crosery API Console listening on http://127.0.0.1:18899` |
| `/` | **200**，引用 `assets/console-DtL7feHU.js`、`assets/__uno-Dw_mkPgC.js`（Vue 构建产物） |
| `/docs` | **200**，引用 `assets/docs-CiWVj5H_.js`（Vue 版 docs） |
| 深链接 `/keys/anything` | **200**（SPA catch-all 正常） |
| 静态资源 | `assets/console-DtL7feHU.js` **200 / 98,926 B** |
| 登录 | `POST /api/login`（staging 凭据）**200** |
| `/api/rtk/status`（未登录） | **401**（鉴权生效） |
| `/api/rtk/status`（登录后） | 诚实三平面：`kernel: not_configured / gateway_engine_not_magpie`、`relay: not_configured`、`plane: local` |
| CPA 不可达 | 按预期降级：`sync.failed / fetch failed` + `[report-warmup] 默认报表预热失败，将在下个周期重试`（**没有崩、没有返回假数据**） |
| 收尾 | 杀进程后端口不再响应；线上 8791 / 8790 全程正常（演练不共享任何状态） |

## 这条验证的边界（不要当成"发布已通过"）

- 它证明的是**包能启动、静态资产与鉴权正常、依赖不可达时优雅降级**；**不证明** runbook §4 的「第二实例健康检查」在 **VPS 上**能过（那里有生产 dist、生产 `.env`、systemd 的 `ProtectSystem=strict`）。
- `node_modules` 是**外置软链**，与生产（`/opt/crosery-node-current` + 生产 node_modules）不同；本地 node 是 v26，生产 runtime 是 v24（`engines >=24 <25` 的警告仍在）。
- 未验证 systemd 单元本身的启动路径（`ExecStart=/opt/crosery-node-current/bin/npm run start`），只验证了同一条命令 `tsx server/index.ts`。
