# CPA 补丁系列（基于上游 v8.0.21）

- 基底：上游 tag `v8.0.21`（54946fa3）。`git am 00*.patch`（0001–0012）后树 = `2f28b592`（HEAD = `7929ae0a`：从 tag 起 `git am --committer-date-is-author-date`、提交者 = 补丁作者，可复现；原移植分支留作 `deploy-v8.0.21-port`，HEAD `84c37416`、同一棵树）；0001–0011 时树 = `8a81b380`、HEAD = `474ef85e`；0001–0009 时树 = `1e3297ce`、HEAD = `c55ec374`；0001–0008 时树 = `bda3f007`、HEAD = `0b05400e`。
- 构建：`deploy/kernels/cpa-builder/build-in-container.sh`，版本串 `8.0.21-patched.<HEAD8>`（`8.0.21-patched.7929ae0a`）。
- 构建机 deploy 分支 = 这串补丁；之后上游每个 release（含新 major）由 `run.sh` 合进去，冲突时停住，人工移植后把新系列放到 `cpa-patches/<上游 tag>/`。
- 移植自 `../v8.0.13/`：上游把三个模型目录的拉取/刷新收进 `catalogUpdater`（`models.catalog` 等自定义源 + 热重载），0004 改挂到新入口；上游把 payload 规则挪到发请求前，0008 跟着改；0008 不再夹带误提交的 `server` 二进制。

| 补丁 | 内容 |
|---|---|
| 0001 | 两种配置布局都带 fork 字段：Key 级模型/渠道白名单（v8 迁移映射到 `access.*`，不会被注释掉）、渠道设置 |
| 0002 | 管理接口读写 Key 级白名单，暴露给控制台 |
| 0003 | 按 Key 强制模型与渠道白名单 |
| 0004 | models.dev 补全模型元数据（通用目录每次发布都补全，含自定义源；updater 由 `main` 启动，`--local-model` / Home 模式不启动） |
| 0005 | 内置 Claude Fable 5.1 / Opus 5.5 |
| 0006 | 修复 OpenAI 兼容渠道泄漏的 thinking |
| 0007 | Codex 独立 Alpha Search 走专用渠道 |
| 0008 | 兼容渠道 Responses 原生中继（`relay-mode: responses` 直发上游 /responses；上游新增的 EOF 补终结事件不作用于 relay） |
| 0009 | 本地文件模型目录（`models.catalog` / `codex-catalog` / `devin-catalog` 为绝对路径）每 15s stat 一次，mtime 或大小变了才重读并走原刷新路径；外部任务原子 rename 新文件后约 15s 内生效，不用重启 |
| 0010 | `/v1beta/interactions`（含流式）等协议执行入口也按 Key 模型白名单拦截，不在白名单直接 403 `model_not_allowed`、不发上游；agent 请求按 agent 名校验 |
| 0011 | 修复 /v0 连续写入在内存里被热重载回滚：每次写 config.yaml 记一个进程内写序号，热重载读文件前记下序号，读完后若已有新写入则丢弃这次重载（管理端 `SetConfig` 同样拒收）；重载哈希取实际加载的字节，重载串行执行 |
| 0012 | Codex live / realtime（`/v1/live`、`/v1/live/:call_id`、`/v1/realtime*` 的建呼叫、WebSocket、sideband、hangup、client secret）按 Key 模型白名单和渠道白名单拦截：检查实际运行的 Codex 模型（未指定时为默认 `gpt-live-1-codex`，`gpt-realtime` 系别名同样归到它）和 `codex` 渠道（含 `__console_no_channels_allowed__`），不允许直接 403 `model_not_allowed` / `channel_not_allowed`，不选凭据、不连上游；client secret 按签发它的 Key 判断。受限 Key 要用 live 需把 `gpt-live-1-codex` 加进模型白名单 |

配置格式：v8 照旧读旧布局，不改写文件；控制台用 /v0 写回也保持旧布局。只有走 v8 自己的管理接口（/v8/management 或上游面板）写一次，config.yaml 才迁移成 `config-version: 8`，之后 v7 起不来。applier 每轮记录 `configLayout`，跨大版本的一键回滚只在仍是旧布局时提供。上游新增的顶层 `models:`（`catalog` / `codex-catalog` / `devin-catalog`）两种布局都认，没配时 /v0 写回不会加出这一节。
