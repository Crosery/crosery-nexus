# 2026-10-09 预发布/正式拆分：执行记录

按 `docs/ops/release.md` 的发布方式执行。主机只写 `<正式机>`、`<预发布机>`。

## 状态

| 阶段 | 状态 |
|---|---|
| 1 仓库与发布方式 | 完成 [verified] |
| 2 预发布环境 | 主机、CPA、控制台、账号完成 [verified]；预发布 API 域名 DNS、控制台 CDN 回源、外网验收未完成 |
| 3 自动更新 | 模型目录、可用性、Key 白名单、价格在预发布运行 [verified]；CPA 程序流水线与 RTK 中继未合入 |
| 4 功能 | 供应商页、CLI 树形输出已合入；其余见文末 |

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

每次切换后 4 秒内健康（`/api/public/release` 的提交号一致，`/api/session` 与 `/` 均 200）。

## 阶段 2：预发布环境

- `<预发布机>`：2C / 1.9G，加 2G swap；Node 24.20.0；目录布局与正式一致。
- 数据面：反向代理 → 8316 context guard → 8317 CPA。CPA `8.0.21-patched.474ef85e`（补丁 0001–0011，见 `deploy/kernels/cpa-patches/v8.0.21/`），每次替换前保留旧二进制，替换后 `config.yaml` 字节不变。
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
| CPA 程序 | 补丁移植到 8.0.21 并在预发布运行；自动编译 → 预发布 → 浸泡 → 正式窗口替换的流水线未合入 |
| RTK | 中继改为独立进程（控制台发版不打断中继中的流），未合入 |

注意：在 CPA 运行时，用改名替换 `config.yaml` 不会触发热加载；改配置走管理接口或重启。

## 回滚入口

- 控制台：`release rollback preview`（或 `--to <发布目录>`）。
- 预发布 CPA：`/usr/local/bin/cli-proxy-api.<版本>` 为上一版二进制，`/etc/cli-proxy-api/config.yaml.before-*` 为改前配置；替换后 `systemctl restart cli-proxy-api`。
- 模型目录：删除 `config.yaml` 的 `models:` 段并重启 CPA，即回到 CPA 自带的官方来源。

## 未完成

- 预发布 API 域名 DNS 改指 `<预发布机>`、控制台域名 CDN 回源切到 `<预发布机>`：等 DNS 服务商的二次验证。
- 外网验收 `release accept preview`（控制台 + 网关 JSON/SSE/工具往返）：依赖上一条。
- `<正式机>` 上旧的预发布站点与证书：外网验收通过后删除。
- 正式发布：预发布验收通过后，同一提交打 `v0.2.0`。
