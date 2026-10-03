# 中转站网关内核换成 Magpie：可行性评估（2026-10-03）

**结论：现在换不了，也谈不上无痛。** 中转站约 81% 的请求、约 99% 的花费走的是订阅账号（Claude / Antigravity / Codex）。v3 的 Magpie 模式还不能用这些账号提供推理服务。只有 API Key 渠道能搬过去，占约 19% 的请求、约 1% 的花费。生产没有任何改动。

## 1. 线上实际流量（近 7 天，`usage_hourly_rollup`，只读）

共 126,370 次请求，按价目折算约 $6,890。

| provider | 请求占比 | 花费占比 | 类型 |
| --- | --- | --- | --- |
| claude | 45.7% | 66.3% | 订阅账号（6 个 auth 文件） |
| antigravity | 26.9% | 13.9% | 订阅账号（10 个） |
| codex | 8.5% | 18.8% | 订阅账号（29 个） |
| cline-pass / commandcode / qoder-cn / openrouter | 18.9% | 1.0% | API Key 渠道 |

- 按端点：`/v1/messages` 60.8%，`/v1/chat/completions` 23.7%，`/v1/responses` 15.1%，`/v1/images/*` 0.4%，Gemini 19 次。
- 按客户端：claude-code 60.4%，omp 16.6%，codex-desktop / codex-cli 合计 4.2%。

## 2. 为什么订阅账号搬不过去（代码事实）

- **`MAGPIE_CONTROL_PLANE=cpa`**（唯一能直接复用线上 CPA 渠道配置的模式）：`magpieRoutes()` 只把 CPA 的 API Key 渠道（`openai-compatibility` 与 provider key）变成路由，订阅账号根本不进路由表。
- **`MAGPIE_CONTROL_PLANE=local`**：订阅账号会变成路由，但有以下问题：
  - access token 直接发给厂商，没有刷新流程。Claude、Codex 的 token 过期后就失效。
  - Codex 发到 `api.openai.com/v1`，不是 ChatGPT 订阅实际用的接口。Antigravity 按 chat 协议发到 `generativelanguage`，协议和端点都不对。
  - 账号绑定的 `127.0.0.1:179xx` 出口（线上 7 个 `mihomo-codex` 服务）会被**改成直连**，账号会从 VPS 的 IP 直接出去。
  - 如果配了「CPA bridge」，就拿管理密钥当推理 Key 去调 CPA，订阅流量仍然全靠 CPA。
- 内核接入文档（`deploy/magpie/CONSOLE-KERNEL.md`）自己列出的上线前置条件，至今都还没有完成：
  - 订阅账号「listed and managed, but do not serve inference yet」；
  - OAuth 的凭据格式和刷新流程需要专门的适配层；
  - 图片接口、Responses WebSocket、有状态 Responses、内置工具都没有开放；
  - 进程异常退出时，已经发出的上游调用可能来不及记账；
  - 原生 Gemini / Vertex 还没有接入。
- 线上 CPA 还在用这些补丁配置，迁移时都要逐项对齐：
  - `api-key-channel-access` / `api-key-model-access`；
  - `credential-concurrency` / `credential-in-flight`；
  - `oauth-model-alias`、`oauth-excluded-models`；
  - `claude-header-defaults`、`claude-cache-ttl-upgrade`；
  - `payload` 改写规则、`quota-exceeded`、`routing`；
  - `codex` / `ws-auth`、`antigravity`、`discovery`、`plugins`、`passthrough-headers`；
  - 重试与冷却：`max-retry-credentials`、`disable-cooling`。

## 3. 演练（`sj-4837-new`）

- **内核能在 Linux 上运行** [verified]：
  - 用固定的上游版本 `3fe2ff9` 交叉编译出 linux/amd64 版本（`GOAMD64=v1`，静态链接）；
  - 在线上控制台同款 systemd 沙箱里运行：socket 权限 `0600`，`/internal/health` 返回 ok，keychain 为 false，内存 15 MB，7 个线程。
- **同一把 Key 分别走两个内核** [verified]（控制台 `GATEWAY_ENGINE=magpie`、`MAGPIE_CONTROL_PLANE=cpa`）：

| | CPA `:8317` | Magpie `:8790` |
| --- | --- | --- |
| `/v1/models` | 6 个模型 | **0 个** |
| `/v1/images/generations` | 可路由 | `404 route_not_supported` |

演练结束后，已把演练机恢复为 CPA 模式，相关服务都已停止。

## 4. 可选路线

1. **保持 CPA 作为线上内核**（推荐，现状）：控制台已经是 v3，它的「网关」分区会如实显示 CPA 的版本。
2. **混合模式**：API Key 渠道（约 19% 请求）改走 Magpie，订阅账号继续走 CPA。需要 nginx / 准入层按模型分流；收益很小，却多一跳、多一个故障点。
3. **完整迁移**（开发项目，不是部署）。以下每一项都要先在演练机上通过，再谈切换：
   1. 订阅账号适配层：Claude / Codex / Antigravity 各自的 token 刷新、正确的端点、按账号走出口代理；
   2. 对齐上面列出的 CPA 补丁能力；
   3. 图片接口与 Responses WebSocket；
   4. 进程异常退出时不丢账（崩溃安全的记账交接）；
   5. 用线上真实流量做影子比对后，再灰度切换。
