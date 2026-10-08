# 发布：预发布 → 正式

没有 CI/CD。所有者在本机从干净 worktree 构建，直接发到目标机。正式只接收在预发布部署成功、并通过含网关真实请求验收的同一提交。

## 分支与 tag

| 分支 / tag | 用途 |
|---|---|
| `stage` | 预发布线。功能合到这里，打 `vX.Y.Z-rc.N` 发预发布 |
| `main` | 正式线。只快进到预发布验收过的提交，打 `vX.Y.Z` 发正式 |
| `vX.Y.Z-rc.N` | 预发布 tag，X.Y.Z 必须等于该提交 `package.json` 的 `version` |
| `vX.Y.Z` | 正式 tag，必须与某个 `vX.Y.Z-rc.N` 指向同一提交 |

## 环境

| | 预发布 | 正式 |
|---|---|---|
| 数据面 | 反向代理 → 8316 context guard → 8317 CPA | 反向代理 → 8316 context guard → 8317 CPA |
| 运行配置（入库） | `deploy/env/preview.env` | `deploy/env/production.env` |
| 发布目标（不入库） | `deploy/env/preview.release.local` | `deploy/env/production.release.local` |

两套完全独立：各自的 CPA、凭据目录、控制台数据与 API Key。订阅 OAuth 账号只能在一处（刷新会轮换令牌）。目录布局两边相同：发布目录 `/opt/crosery-api-console-releases/<releaseId>`，`/opt/crosery-api-console-current` 指向当前发布，密钥与主机相关配置在 `/opt/crosery-api-console/.env`，数据在 `/opt/crosery-api-console/data`。

仓库公开，所以配置分三处：

- `deploy/env/<env>.env`（入库）：只放通用的非密钥项。脚本拒绝像密钥的键名、`RELEASE_*`、IP 和非回环 URL。随发布目录生效：发布脚本写入 systemd drop-in `10-release-env.conf`，内容是 `EnvironmentFile=-/opt/crosery-api-console-current/deploy/env/<env>.env`。改配置 = 改文件 + 发版。
- `deploy/env/<env>.release.local`（本机，不入库，格式见 `release.local.example`）：SSH 别名、目标目录、控制台与 API 的公网地址、验收要实测的模型。
- 目标机 `/opt/crosery-api-console/.env`（root 600）：密钥、域名、内网地址等主机相关项。

## 命令

构建必须用 Node 24：

```bash
alias release='fnm exec --using 24.20.0 node scripts/release.mjs'

release plan    preview v0.2.0-rc.1     # 只跑门禁，不改任何东西
release deploy  preview v0.2.0-rc.1
RELEASE_ACCEPT_KEY=… release accept preview   # 预发布验收必须带网关 Key（控制台 + /v1/models + 每个 RELEASE_ACCEPT_MODELS 的 JSON/SSE/工具往返）
git branch -f main <同一提交>                  # 只能快进；然后打正式 tag
git tag v0.2.0 <同一提交>
release plan    production v0.2.0
release deploy  production v0.2.0
release accept  production                    # 可选带正式 Key
release status  production
release rollback production                   # 切回当前发布记录的上一个目录；或 --to <发布目录>
```

## deploy 做了什么

1. 门禁：tag 格式与环境匹配、版本等于 `package.json`、提交在对应分支上、目标机没有发布锁、目标没在跑同一提交；正式另外要求预发布证据（同提交 rc tag、预发布成功部署记录、之后针对同一发布目录且 `api=passed` 的验收记录、预发布主机与公网 `/api/public/release` 都是这个提交）。
2. 构建：`git worktree add --detach <tag 提交>` → `npm ci` → `npm test` → `npm run lint` → `npm run build`，任一失败即停。
3. 打包：跟踪文件（去掉 `docs/qa/`、`.env*`、`data/`）+ `dist/` + 生成的 `RELEASE.json`（releaseId、env、version、tag、commit、构建时间、Node 版本、锁文件摘要、RTK 中转加载的文件 `relayFiles`）+ `MANIFEST.sha256`。
4. 目标机：拿发布锁 → 解包到 `.incoming` → `sha256sum -c` 校验清单 → `node_modules`（锁文件相同就从现有发布 `cp -al` 硬链接复制，否则 `npm ci`）→ 落到 `<releaseId>`。
5. 切换：`ln -sfn` + `mv -T` 原子替换 current → 更新 drop-in → 重启服务 → 120 秒内 `/api/public/release` 的 commit 等于本次提交、`/api/session` 与 `/` 都是 200。
6. RTK 中转（`crosery-rtk-relay.service`，见 `docs/ops/rtk-relay.md`）：控制台健康之后，只有中转加载的代码、它读的环境变量或它的 drop-in 变了才 `systemctl restart --no-block`（旧进程排空最长 15 分钟）；unit 没装或没 enable 就跳过。回滚同样处理。
7. 不健康：自动切回上一个目录并重启，记录失败；中转不动。
8. 每一步结果追加到目标机 `/opt/crosery-api-console-releases/deployments.jsonl`（部署、验收、回滚）。

## 注意

- 旧发布（`20261006-*` 等）的 `node_modules` 是指向 `20261003-console-v3` 的符号链接，新发布用硬链接复制，不再共享符号链接；删旧目录前仍要先核对没有发布链接到它，也不是 RTK 中转正在运行的目录。
- 控制台发布只重启控制台进程，不碰 CPA 与 guard，也不中断经过 RTK 中转的流；API 流量（`/v1/*`）不经过控制台，只有 `/v1/model-catalog` 会在重启的十几秒内不可用。
- 发布锁残留（脚本被强杀）：确认没有发布在跑之后删除目标机 `/opt/crosery-api-console-releases/.release.lock`。
