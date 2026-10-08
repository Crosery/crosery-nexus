# 2026-10-09 预发布/正式拆分：执行记录

按 `docs/ops/release.md` 的发布方式执行。主机只写 `<正式机>`、`<预发布机>`。

## 状态

| 阶段 | 状态 |
|---|---|
| 1 仓库与发布方式 | 完成 [verified] |
| 2 预发布环境 | 主机、CPA、控制台、账号、RTK 中转完成 [verified]；预发布 API 域名 DNS、控制台 CDN 回源、外网验收未完成 |
| 3 自动更新 | 六项都已合入并在预发布运行 [verified]；CPA 程序首个候选在预发布浸泡中 |
| 4 功能 | 供应商页、CLI 树形输出、契约测试、Antigravity 调优已合入；其余见文末 |

## 阶段 1：仓库与发布方式

- `main` 指向正式实际运行的代码（`0eff63e`），之后只快进到预发布验收过的提交；功能在 `stage` 合入，打 `v0.2.0-rc.N` 发预发布。
- `scripts/release.mjs` + `scripts/release-policy.mjs`（纯函数，`release-policy.test.mjs` 覆盖 tag 规则、正式证据、回滚目标、env 文件合规）。
- 演练（预发布，`deployments.jsonl` 记录）：

| 时间 (UTC) | 动作 | 结果 | 说明 |
|---|---|---|---|
| 19:16 | deploy rc.1 | success | 全新 `npm ci` |
| 19:22 | deploy rc.2 | success | `node_modules` 从现有发布硬链接复制 |
| 19:23 | rollback ×2 | success | 回滚、再前滚 |
| 19:25 | rollback | failed → restored | 故意指向坏目录，健康检查失败后自动切回 |
| 19:46 | deploy rc.3 | success | 封锁 Key 显式拒绝所有渠道 |
| 20:28 | deploy rc.4 | success | 可用性探测、OAuth 账号归零不撤权 |
| 20:38 | deploy rc.5 | success | 系统 Key 文件契约 |
| 20:47 | deploy rc.6 | success | CPA 模型目录与价格巡检 |
| 21:29 | deploy rc.7 | success | 供应商页、CLI 树形输出、契约测试、CPA 流水线与 RTK 自动升级 |
| 21:38 | deploy rc.8 | success | RTK 中转独立进程；中转 unit 未装，发布脚本判定 `skip` |
| 21:51 | deploy rc.9 | success | 可复现构建、验收三态；中转代码未变，判定 `keep`，没有重启中转 |

每次切换后 4 秒内健康（`/api/public/release` 的提交号一致，`/api/session` 与 `/` 均 200）。

## 阶段 2：预发布环境

- `<预发布机>`：2C / 1.9G，加 2G swap；Node 24.20.0；目录布局与正式一致。
- 数据面：反向代理 → 8792 RTK 中转（后备 8316）→ 8316 context guard → 8317 CPA。CPA `8.0.21-patched.7929ae0a`（补丁 0001–0012，见 `deploy/kernels/cpa-patches/v8.0.21/`，构建可复现，sha256 与 `SHA256SUMS` 一致），每次替换前保留旧二进制，替换后 `config.yaml` 字节不变。
- 停止超时 drop-in：CPA `TimeoutStopSec=5`，换二进制后 30 秒内恢复服务。
- 美国出口：mihomo 只监听回环，CPA 账号经它出站。
- 账号：从正式 10 个 Antigravity 账号中拨出 1 个——先在正式停用并备份删除，再在预发布启用；正式剩 9 个，正式 Key 的模型与渠道权限在同步周期之后复核未变。Claude/Codex 没有第二个账号，预发布不测。
- 实测（经 8316，预发布验收 Key）：`/v1/models` 43 个；Antigravity Gemini 模型 JSON 与 SSE 正常；OpenRouter 免费模型返回上游共享池 429（上游限流，与本机无关）。
- 安全：`api-keys` 永不写空（写空会让 CPA 不再校验 Key）。没有用户 Key 时写入封锁 Key，并显式拒绝所有渠道；旧封锁 Key 已轮换。

## 阶段 3：自动更新（预发布实测）

| 项 | 实测 |
|---|---|
| 模型目录 | `cpa-catalog` 从官方地址拉取，写出 `data/cpa/models.json`（0644），历史行带来源与 sha256。CPA `models.catalog` 指向该文件后，Antigravity 模型 44 → 46。补充目录中已被官方收录的 2 个模型记为 `redundant`，官方条目不被替换。补丁 0009 让 CPA 每 15 秒检查文件变化，无需重启 |
| 模型可用性 | 首轮：antigravity 22 在线 / 2 未探测，openrouter 17 在线 / 2 未探测，无告警。探测 Key 每个服务一把，只钉在本服务渠道；rc.4 生成的旧格式探测 Key 在 rc.5 后的首轮被清除，未被导入为用户 Key |
| Key 白名单 | 下线模型退出白名单；OAuth 账号临时归零时保留分组与权限（回归测试复现 2026-10-09 403 事故并通过）；每次实际变化写审计 |
| 价格 | `price-watch` 每 6 小时；首轮只记基线 |
| 共享目录 | models-sync 装到预发布，网关指向本机回环，每小时检查新模型 |
| CPA 程序 | 构建机：补丁系列 → 合入上游 → 固定镜像编译 → 冒烟 → 协调器。预发布：验收 → 浸泡 24 小时 → 再验收 → 写晋级记录；正式只接受有晋级记录的版本，且只在 05:00–07:00（Asia/Shanghai）替换。当前预发布 `installed` 为手工装的 `7929ae0a`（`adopt` 收编），浸泡到 2026-10-09T21:30Z；构建机已产出下一个候选 `8.0.22-patched.c8e0356f`。验收结论三态：`passed` / `failed` / `inconclusive`（网络或 DNS 原因，不推进也不判失败，连续 6 次报警） |
| RTK | 中转独立进程已装在预发布并在监听；控制台发版只在中转代码、环境变量或 drop-in 变化时重启中转（rc.8 `skip`、rc.9 `keep`）。rtk CLI 自动升级 timer 已装 |

注意：

- 在 CPA 运行时，用改名替换 `config.yaml` 不会触发热加载；改配置走管理接口或重启。
- `config.yaml` 有顶层 `models:` 时，下一次管理接口写入会把文件迁成 v8 布局（客户端 Key 移到 `access.api-keys`）。回滚到 8.0.13 可以正常启动，但 8.0.13 的管理接口写入会删掉 `models:` 段。
- 一次会话日志里出现过预发布验收 Key 与探测 Key：已轮换验收 Key（新 Key 200、旧 Key 401，构建机与 models-sync 同步更新），清空探测 Key 让可用性任务重建，核对 CPA 只剩两把新探测 Key。

## 预发布：OpenRouter 渠道被模型发现扩到 469 个

- 起因：按钮巡检时在预发布手动运行了一次「模型目录」（渠道 `/models` 探测，06:38 Asia/Shanghai）。发现只加不删，OpenRouter 渠道从 19 个（免费模型与免费路由）扩到 469 个，新增 450 个付费模型全部启用。该渠道的 Key 有 1 美元额度，下一轮可用性探测会对 469 个模型逐个发请求。
- 处理（06:52，下一轮探测之前）：先备份渠道表与控制台库，再把 450 个模型写成控制台的停用墓碑（与逐个点「停用」写入的记录相同，下次发现不会加回），然后一次性写回只含原 19 个模型的渠道表，并记一条审计。保留集合取自 06:35 那轮可用性探测的 OpenRouter 模型清单。
- 结果 [verified]：渠道 19 个模型，墓碑 450 条，两把 Key 的白名单不含被撤下的模型；随后一轮可用性探测只探测了 OpenRouter 的 19 个模型。处理过程中 OpenRouter 探测 Key 出现在会话输出里，已从系统 Key 文件删除让任务重建，CPA 里旧 Key 已不在。
- 正式不受影响：正式的 OpenRouter 渠道由主机上每 5 分钟一次的免费模型同步维护，当前 19 个模型。预发布没有这个同步，所以在预发布上，手动运行渠道发现仍然会加入付费模型。

## 正式环境的改动

| 时间 (Asia/Shanghai) | 改动 | 方式 | 结果 |
|---|---|---|---|
| 10-09 06:09 | 重试参数：`max-retry-credentials` 4 → 0，`max-retry-interval` 180 → 8（与预发布调优结论一致，见 `20261009-antigravity-tuning.md`） | 管理接口写入，配置文件仍是旧布局，只有这两行变化；改前备份在 `<正式机>` 归档目录 | 改前 30 分钟 `/v1*` 626 个请求、失败 4 个（0.64%）；改后 12 分钟 239 个、失败 0 [verified] |

正式 CPA 程序、控制台版本、nginx 未改动。

## 回滚入口

- 控制台：`release rollback preview`（或 `--to <发布目录>`）。
- 预发布 CPA：`/usr/local/bin/cli-proxy-api.<版本>` 为上一版二进制，`/etc/cli-proxy-api/config.yaml.before-*` 为改前配置；替换后 `systemctl restart cli-proxy-api`。
- 模型目录：删除 `config.yaml` 的 `models:` 段并重启 CPA，即回到 CPA 自带的官方来源。

## 未完成

- 预发布 API 域名 DNS 改指 `<预发布机>`、控制台域名 CDN 回源切到 `<预发布机>`：等 DNS 服务商的二次验证。
- 外网验收 `release accept preview`（控制台 + 网关 JSON/SSE/工具往返）：依赖上一条。
- `<正式机>` 上旧的预发布站点与证书：外网验收通过后删除。
- 正式发布：预发布验收通过后，同一提交打 `v0.2.0`。
