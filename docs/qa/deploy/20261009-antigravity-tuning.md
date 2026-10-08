# 2026-10-09 Antigravity 调度与出口：实测与调优

主机只写 `<正式机>`、`<预发布机>`；账号记作 A1–A10，不对应任何真实标识。正式机只读取，没有改动，也没有经正式网关发请求。

## 结论

- **出口不是瓶颈，维持正式现状。** 预发布单账号 A/B：Gemini 的首字延迟在两个出口之间差异落在噪声内；Claude-via-Antigravity 香港直连快约 0.6 秒。正式 4 天内两个出口都没有 `User location is not supported`，传输层失败（EOF、TLS 握手超时）只出现在美国出口（10 次，约 0.3%）。
- **真正的问题在重试。** 正式的 Claude 额度一旦全队耗尽，每个失败请求要打 26 次上游、客户端等 24–35 秒才拿到 429。来源有两处：一是 `max-retry-credentials: 4` 让每轮只试 4 个账号，后续轮次反复重试同一批高优先级账号；二是 `antigravity-credits` 再把所有账号扫一遍。4 天里这一遍扫描 9 次，全部 429。
- **建议改 3 个值：** `max-retry-credentials: 4 → 0`、`max-retry-interval: 180 → 8`、`antigravity-credits: true → false`，已在预发布生效并验证。`switch-project` / `switch-preview-model` 在当前代码里没有运行时效果，保持不动。

## 范围与方法

| 项 | 内容 |
|---|---|
| 正式基线 | 控制台用量表（只读打开），2026-10-05 03:36 至 10-08 20:54 UTC，4,697 条 Antigravity 记录（31 条 Magpie 期记录已剔除）；CPA 日志 2026-10-05 19:38 至 10-08 20:52 UTC 的上游失败行；账号文件只读取优先级、出口、停用标记 |
| 预发布实测 | 唯一的 Antigravity 账号，经 8316 → 8317，每次间隔 ≥ 3 秒，`max_tokens` ≤ 64；共 45 次生成请求 + 2 次额度查询，无 403、无地域拒绝 |
| 调度参数 | 读 CPA 8.0.21 源码（与预发布同一提交）；再在本机起同一提交的 CPA，接一个假 Antigravity 上游，按场景返回 429/503，账号全是假凭据，不碰真实账号 |
| 版本差异 | 正式 8.0.13：本文涉及的重试、冷却、凭据上限、积分回退逻辑与 8.0.21 相同（已对照 `v8.0.13` tag） |

## 正式基线（只读）

### 按账号

请求数与成功率取用量表（一条 = 一个请求的最终结果，记在最后尝试的账号上；499 为客户端取消，计入失败）。失败尝试取 CPA 日志，按每次上游调用计数。

| 账号 | 优先级 | 出口 | 请求 | 成功率 | 429 | 5xx | 499 | 首字 p50 / p95 | 总耗时 p50 / p95 | 失败尝试 429 / 404 / 503 |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | 950 | 香港直连 | 265 | 100% | 0 | 0 | 0 | 5.4 / 14.9 s | 6.1 / 19.2 s | 14 / 2 / 0 |
| A2 | 950 | 香港直连 | 0 | — | — | — | — | — | — | 14 / 1 / 0 |
| A3 | 1000 | 美国（未钉，走全局代理） | 1,338 | 96.5% | 16 | 3 | 24 | 8.0 / 18.6 s | 8.5 / 23.2 s | 43 / 8 / 0 |
| A4 | 1000 | 美国 | 930 | 97.7% | 0 | 4 | 11 | 7.4 / 19.1 s | 8.2 / 24.6 s | 33 / 12 / 1 |
| A5 | 1000 | 香港直连 | 348 | 88.8% | 4 | 16 | 19 | 9.1 / 62.6 s | 10.6 / 70.8 s | 36 / 9 / 19 |
| A6 | 1000 | 香港直连 | 558 | 95.9% | 0 | 0 | 23 | 6.7 / 21.5 s | 7.6 / 28.4 s | 32 / 8 / 0 |
| A7 | 950 | 美国 | 1 | 0% | 1 | 0 | 0 | — | — | 16 / 3 / 0 |
| A8 | 1000 | 美国（未钉，走全局代理） | 1,226 | 98.2% | 3 | 8 | 8 | 7.9 / 21.7 s | 8.9 / 27.2 s | 37 / 5 / 1 |
| A9 | 950 | 美国（未钉，走全局代理） | 0 | — | — | — | — | — | — | 17 / 3 / 0 |
| A10 | — | 10-08 移至预发布 | 0 | — | — | — | — | — | — | 14 / 3 / 0 |

- 流量集中在优先级 1000 的 5 个账号；950 档只在 1000 档全部不可用时才轮到，A2、A9 期间没有成功请求。
- A5 的 16 次 503 全是上游 `No capacity available`（`gemini-3.8-flash(-high)`），属于账号自身，换号后都成功了。

### 按出口（只取 `gemini-3.8-flash`，排除模型构成差异）

| 出口 | 账号 | 请求 | 成功率 | 首字 p50 / p95 | 输入 < 2 万 token 的首字 p50 | 传输失败 | 地域拒绝 |
|---|---|---|---|---|---|---|---|
| 香港直连 | A1 A5 A6 | 1,050 | 95.8% | 7.1 / 29.4 s | 10.4 s（A1 4.1、A5 17.0、A6 2.4） | 0 | 0 |
| 美国 | A3 A4 A8 | 3,202 | 98.8% | 7.8 / 19.4 s | 4.0 s（A3 3.8、A4 4.0、A8 4.7） | 10（EOF 9、TLS 握手超时 1） | 0 |

差异主要来自账号（A5），不是出口。

### 失败请求的构成（日志按请求号关联）

| 模型 / 上游错误 | 请求 | 最终结果 | 客户端耗时 p50 / 最大 |
|---|---|---|---|
| `claude-sonnet-4-6` 429 | 11 | 200（换号成功） | 13.7 / 24.6 s |
| `claude-sonnet-4-6` 429 | 9 | 429 | 24.1 / 35.3 s |
| `claude-opus-4-6-thinking` 429 | 6 | 200 | 3.7 / 61.0 s |
| `gemini-3.8-flash-high` 503 | 16 | 200 | 28.7 / 299 s |
| `claude-opus-5-5-high` / `claude-sonnet-5-5-high` 404 | 13 | 404 | 2.7 / 4.6 s |

- 429 正文都是不带 `RetryInfo` / `ErrorInfo` 的 `RESOURCE_EXHAUSTED`，所以 CPA 只能按 1、2、4、8… 秒的阶梯冷却，账号很快又被重试。
- 一个全队耗尽的 Claude 请求依次是：4 轮 × 每轮 4 个账号，再加积分回退扫一遍全部 10 个账号，合计 26 次上游调用，耗时约 30 秒。积分回退 9 次，0 次成功。
- 两次上游尝试之间等待 ≥ 9 秒的情况一次也没有：`max-retry-interval: 180` 在窗口内从未起作用，也没挽回过任何请求。

## 预发布出口 A/B

单账号，同一提示词，逐个切换账号的 `proxy_url`。每格为首字延迟中位数，括号内为样本数与区间。40/40 均返回 200。

| 模型 | 模式 | 美国出口 | 香港直连 |
|---|---|---|---|
| `gemini-3.8-flash` | JSON | 3.29 s（5，2.64–3.54） | 2.57 s（5，2.41–4.68，最大值为切换后首个冷连接） |
| `gemini-3.8-flash` | SSE | 2.88 s（5，2.30–3.43） | 2.56 s（5，2.37–3.02） |
| `gemini-3.1-pro-low` | JSON | 2.95 s（2） | 3.50 s（2，2.80–4.21） |
| `gemini-3.1-pro-low` | SSE | 2.87 s（2） | 2.91 s（2） |
| `claude-sonnet-4-6` | JSON | 1.51 s（3） | 0.93 s（3） |
| `claude-sonnet-4-6` | SSE | 1.60 s（3） | 0.79 s（3） |

不带凭据的纯网络测量（各 8 次，返回 401）：直连 TLS 约 0.03 s、首字节约 0.05 s；美国出口 TLS 约 0.50 s、首字节约 0.67 s。连接复用后，每个请求的出口开销约为一次往返。

## 调度参数：代码语义与实测

### 代码语义（CPA 8.0.21，路径相对 CPA 仓库）

| 参数 | 语义 |
|---|---|
| `routing.strategy: round-robin` | 只在最高优先级档内轮转，档内按凭据 ID 排序。低档只在高档全部被冷却或本轮已试过时才用（`sdk/cliproxy/auth/selector.go`） |
| `session-affinity` | 会话键依次取请求头会话 ID、Claude `metadata.user_id`、提示词前缀等。绑定优先于优先级；绑定的账号被冷却时重选并改绑 |
| `max-retry-credentials` | 每轮最多试几个**不同**账号，0 = 不限（`conductor_execution.go`） |
| `request-retry` | 一轮失败后最多再来几轮；`tried` 每轮清空，冷却已过期的账号会被再次选中 |
| `max-retry-interval` | 两轮之间的最长等待。最近恢复时间超过它就不等，直接返回错误。刚在本轮 429 的账号至少按 10 秒计（`minQuotaCooldownFloor`，`conductor_selection.go`），所以取值 < 10 时不会再为 429 睡眠 |
| `disable-cooling` | 关掉后不记冷却，每轮立即重试 |
| Antigravity 429 | 有 `RetryInfo` 时按上游时长冷却（下限 10 秒）；没有时按 1 秒起翻倍、封顶 30 分钟的阶梯。冷却按「账号 × 模型」记 |
| `antigravity-credits` | 仅限 Claude 模型。整个重试循环失败后，带 `enabledCreditTypes: GOOGLE_ONE_AI` 再扫一遍所有启用的 Antigravity 账号，**不看冷却**（`conductor_home.go`） |
| `switch-project` / `switch-preview-model` | 只有管理接口读写，执行路径没有任何读取，示例配置标注为 compatibility-only |
| 账号 `proxy_url` | 优先于全局 `proxy-url`；`direct` 表示直连；经 `PATCH /v0/management/auth-files/fields` 热生效 |

### 本机复现（同一提交的 CPA + 假上游）

「保持现值」= `request-retry 3 / max-retry-credentials 4 / max-retry-interval 180 / 积分回退开`。

| 场景 | 配置 | 结果 |
|---|---|---|
| 3 个账号全部 429（无 RetryInfo），连续 3 个请求 | 保持现值 | 客户端分别等 33 s、59 s、193 s 后拿到 429，上游 12 / 9 / 6 次 |
| 同上 | `max-retry-interval 8` | 每个请求至多等 8 s、上游 3 次；冷却超过 8 s 后直接返回本地 `model_cooldown` 429，带 `Retry-After`，不打上游 |
| 单账号 `RATE_LIMIT_EXCEEDED` 2 s，第二次放行 | `max-retry-interval` 180 或 15 | 10.4 s 后 200（10 秒下限） |
| 同上 | `max-retry-interval 8` | 立即 429；之后 9 秒内本地 `model_cooldown` |
| 单账号 `QUOTA_EXHAUSTED`，3 小时后重置 | 任意 | 立即 429；之后返回本地 `model_cooldown`，`Retry-After` 10799，不打上游 |
| 同上，`switch-*` 开 / 关 | — | 结果完全相同，上游收到的模型名不变（Claude 与 Gemini 都试过） |
| 3 个健康账号，同一会话 6 次 | 亲和开 / 关 | 开：6 次同一账号；关：1、2、3、1、2、3 轮转 |
| A1 429，其余健康，会话已绑 A1 | 亲和开 | 同轮换到 A2 并改绑，之后每次 1 次上游 |
| 3 个账号全 429，账号报告有积分 | 积分回退开 / 关 | 开：每个失败请求 6 次上游，冷却期内仍打 3 次；关：3 次 |
| 3 个账号全 429 | `disable-cooling true` | 每个请求 12 次上游，没有冷却 |

再按正式规模模拟：9 个账号，5 个优先级 1000、4 个 950，每次上游 429 耗时 0.8 秒。

| 配置 | 全部 429 | 只有两个 950 档账号健康 |
|---|---|---|
| 保持现值 | 22–25 次上游，18–20 s，429 | 24 次、19.4 s 后 200，**靠积分回退扫到健康账号** |
| 关积分回退 + `max-retry-interval 8`（凭据上限仍 4） | 16 次，13 s，429 | **429**：16 次全打在 1000 档，从未轮到 950 档 |
| 再加 `request-retry 1` | 8 次，6.5 s，429 | **429** |
| **关积分回退 + `max-retry-interval 8` + `max-retry-credentials 0`** | 9 次（每个账号 1 次），7.3 s，429 | 8 次、6.5 s 后 200；会话随即绑到健康账号，之后每次 1 次 |

关键：每轮只试 4 个账号时，几秒内高档账号的阶梯冷却就过期，后续轮次又选回它们，低档账号永远轮不到；现在是积分回退在替它兜底。所以关积分回退必须和 `max-retry-credentials: 0` 一起改。

## 预发布已应用

| 项 | 改前 | 改后 | 方式 |
|---|---|---|---|
| `max-retry-credentials` | 4 | 0 | `PUT /v0/management/max-retry-credentials`，热生效 |
| `max-retry-interval` | 180 | 8 | 原地改 `config.yaml` + 重启 CPA |
| `antigravity-credits` | true | false | 同上（没有 v0 接口） |
| 账号出口 | 未设，走全局美国出口 | `direct`（香港直连） | `PATCH /v0/management/auth-files/fields` |
| 不变 | `request-retry 3`、`round-robin`、会话亲和开（1h）、`disable-cooling false`、`switch-* true` | | |

- 备份：`/etc/cli-proxy-api/config.yaml.bak-agy-tuning-20261009T052053`（任何改动之前，旧布局）、`…T055637`（改 `max-retry-credentials` 之前，v8 布局）。
- 验证 [verified]：管理接口读回 `request-retry 3 / max-retry-credentials 0 / max-retry-interval 8`、积分回退 `false`、账号 `active`。经 8316 实测：`gemini-3.8-flash` JSON 200（1.9 s）；`claude-sonnet-4-6` SSE 200，首字节 1.1 s，收到 `[DONE]`；`claude-sonnet-4-6` 工具往返，第一跳返回 `get_weather({"city":"Paris"})`，回填结果后第二跳给出正文；改完 `max-retry-credentials` 后再测 `gemini-3.8-flash` SSE 200（1.6 s）。直连时采样 CPA 连接，只看到直连 Google 的连接。实测期间预发布 Antigravity 上游失败 0 次。
- 预发布 `config.yaml` 在 05:49:50（UTC+8）被控制台的 `PUT /v0/management/api-keys` 写成了 `config-version: 8` 布局，与本次调优无关。原因是 04:50 加入的根级 `models:` 段：`IsV8ConfigLayout` 据此判定为 v8，于是之后的第一次 v0 写入就触发了迁移。迁移时注释掉了 `api-key-channel-access-required`、`claude-cache-ttl-upgrade`、`codex`、`enable-gemini-cli-endpoint`，这几项 8.0.21 本来就不读，补丁 0001 也预期它们会被归档为注释。之后要跨大版本回滚，需要用上面的旧布局备份。

### 预发布回滚

```text
PUT  /v0/management/max-retry-credentials   {"value":4}
PUT  /v0/management/max-retry-interval      {"value":180}
PATCH /v0/management/auth-files/fields      {"name":"<账号文件名>","proxy_url":""}
```

- 积分回退：把 `oauth.providers.antigravity.antigravity-credits` 改回 `true`（现为 v8 布局），然后 `systemctl restart cli-proxy-api`。
- 出口回滚要写空字符串，不要写 `null`：`null` 不会清掉内存里的 `ProxyURL`（`auth_files_fields.go` 只同步字符串值）。

## 正式建议

### 配置差异（正式当前为旧布局）

```diff
 request-retry: 3
-max-retry-credentials: 4
+max-retry-credentials: 0
-max-retry-interval: 180
+max-retry-interval: 8
 disable-cooling: false
@@
 quota-exceeded:
   switch-project: true
   switch-preview-model: true
-  antigravity-credits: true
+  antigravity-credits: false
```

如果到时配置已迁移为 v8 布局，对应的键是 `routing.retry.max-retry-credentials`、`routing.retry.max-retry-interval`、`oauth.providers.antigravity.antigravity-credits`。

| 改动 | 理由 | 代价 |
|---|---|---|
| `max-retry-credentials: 0` | 第一轮就按优先级把每个账号各试一次，部分账号耗尽时能换到低档健康账号，不再靠积分回退兜底 | 全队耗尽时每个请求约 9 次上游（每号 1 次），直到阶梯冷却变长后改为本地 429；对 Codex 等多账号渠道同样生效，失败时会试遍全部账号 |
| `max-retry-interval: 8` | 低于 CPA 固定的 10 秒 429 下限，网关不再为已知的 429 睡眠，客户端拿到的是快速失败和本地 `Retry-After`。8.0.21 下若保持 180，凡是本轮所有可选账号都 429 的渠道（单账号的 Claude、Codex）会出现 33 s → 59 s → 193 s 的挂起 | 单账号渠道的短暂 429 不再由网关自动等 10 秒重试，改由客户端重试（Claude Code、Codex CLI 自带重试） |
| `antigravity-credits: false` | 4 天 9 次全部失败；每次多打一整轮且不看冷却；Google One AI 积分如果真有，也不应被默认消耗 | 账号若有意用积分兜底，这条路就关了 |

不改的项：`round-robin` 与会话亲和保持现状。亲和让同一会话留在同一账号（日志：命中 942 次、新绑 54 次、改绑 1 次）；部分账号耗尽时，会话改绑到健康账号后就不再回头试耗尽的账号（本机复现：改绑后每次只打 1 次上游）。上游按项目的上下文缓存是否因此多命中，未验证。`request-retry 3` 保留，给无冷却的传输错误留立即重试的余地。`disable-cooling` 保持 `false`。`switch-*` 是空操作。出口布局不改：两个出口 IP 都在用是刻意分散的，不宜把账号集中到一个 IP。

### 生效方式与回滚（需所有者授权）

1. 先 `cp -p config.yaml config.yaml.bak-<时间戳>`。
2. `PUT /v0/management/max-retry-credentials {"value":0}`、`PUT /v0/management/max-retry-interval {"value":8}`，热生效。
3. `antigravity-credits` 没有 v0 接口：原地改 `config.yaml` 后 `systemctl restart cli-proxy-api`，或并入 8.0.21 升级窗口。不要用改名替换文件，CPA 不会热加载。
4. 验收：读回三个值；JSON、SSE 各一次；一次 Claude 工具往返；之后观察日志，Claude 429 请求的上游失败次数应不超过账号数，客户端耗时应在 10 秒量级。
5. 回滚：两个数值用同样的 v0 接口写回 4 / 180；积分回退改回 `true` 后重启；或直接恢复第 1 步的备份再重启。

## 风险与遗留

- **[residual risk]** 两个重试参数是全局的，会影响 Codex、Claude 与 API Key 渠道（见上表「代价」）。预发布只有单账号渠道，多账号 Codex 的行为只在本机复现里验证过。
- **[residual risk]** 预发布账号出口从美国改到香港，这个账号的出口国家换过一次。若出现 `400 FAILED_PRECONDITION: User location is not supported`，把 `proxy_url` 写回空字符串即可。
- **[unverified]** 正式 Claude 429 都不带 RetryInfo，无法区分「周额度耗尽」与「瞬时限流」。按代码，这两种都走阶梯冷却。
- 出口 A/B 每格只有 2–5 个样本；Gemini 的差异在噪声内，结论只到「出口不是瓶颈」。
- 交给其他负责人：`claude-opus-5-5-high` 与 `claude-sonnet-5-5-high` 在所有 Antigravity 账号上都返回 404，每个请求都会扫过多个账号，并让它们对该模型冷却 12 小时（目录问题）。A5 容量 503 偏多，可考虑降优先级。A3、A8、A9 没有钉专属出口，靠的是全局代理，账号同步工具可以把它们显式钉住。
- 正式机升级到 8.0.21 且配置里加入根级 `models:` 后，下一次 v0 写入同样会把正式 `config.yaml` 迁移成 v8 布局，跨大版本回滚要预先留旧布局备份。
