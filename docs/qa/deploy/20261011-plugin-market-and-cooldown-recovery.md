# 插件市场常驻 + 「重置后仍用不了」自动清冷却（2026-10-11）

日期：2026-10-11 · 正式 `<正式机>`（8.0.13-patched.7b53aee6）+ 预发布 `<预发布机>`（8.0.21-patched.7929ae0a）

## 1. 起点：三个别的问题，三条不同的根因

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| `gpt-6.1-sol` 429「All credentials … cooling down」，retry-after ≈ 71 h | 账号在 ChatGPT 侧重置后上游已放行（`wham/usage: allowed=true, used_percent=0`，新窗口到 10-18 14:20 CST），但 CPA 仍按旧 429 的 `resets_at` 排着本地冷却（内存态、无查询端点） | 已手工清冷却（`disable_cooling` true→false），`gpt-6.1-sol` 实测 200；**重置券没用掉**（`available_count=1`、`redeemed_at=null`） |
| `oc-*` 400 `MissingSessionID` | opencode Go 要求 `x-opencode-session`；omp 不发，CPA 出站重建头也不补 | 见 §2（插件市场 + session-mapper 插件） |
| `minimax-m3.1-flash` 401 `invalid access token` | 通道 `agent.minimax.cn/mavis` 的 token 失效（另有 6 次 TLS handshake timeout） | 按用户决定不处理 |

## 2. 插件市场：在 CPA 里，不是我们自建

- 上游 `CLIProxyAPI-Plugins-Store` 是官方插件注册表；管理面板（`Cli-Proxy-API-Management-Center`，即 `ai.crosery.com/management.html`）有 `/plugins` 与 `/plugin-store` 两个页面，支持检索、多版本选择安装、更新、删除、可视化配置。
- **页面是否出现取决于内核**：后端响应头带 `x-cpa-support-plugin: true` 才显示。我们的 `8.0.13-patched` / `8.0.21-patched` 都是**静态构建（CGO_ENABLED=0）**，`pluginhost` 直接报
  `standard dynamic library plugin loading requires cgo: …so`，所以插件装了也 `registered=false / effective_enabled=false`。
- 管理面接口（实测 8.0.13 / 8.0.21 都在）：`GET /v8/management/plugins`、`GET /v8/management/plugins/store`、`POST /v8/management/plugins/store/<id>/install?source=<sourceId>`（同一 id 出现在多个来源时必须带 `source`，否则 400 `plugin_store_source_required`）、`DELETE /v8/management/plugins/<id>`。
- 配置段安全：控制台只写 `/v0/management/<section>` 分节端点，且 CPA 侧 `SaveConfigPreserveComments` 保留 `plugins` 子树（补丁 0001/0002 的既有测试守着），所以 `plugins.enabled` 不会被写丢。

### 预发布已就位（2026-10-11）

- `plugins.enabled: true`（配置备份 `config.yaml.bak-plugins-20261011T…`）。
- `opencode-session-mapper v0.3.2`（MIT，官方商店来源 `official`）已下载到 `plugins/linux/amd64/opencode-session-mapper-v0.3.2.so`，`configured=true`；**等 cgo 内核到位后重启即注册**。
- 测试用假上游：`session-echo` 渠道（`http://127.0.0.1:3999/v1`，`headers: {X-Opencode-Session: $X-Opencode-Session, X-Opencode-Client: $X-Opencode-Client}`）+ `/tmp/echo.py`（记录收到的头）。插件注册后用 curl 打 `echo-model` 即可验「插件注入 + `$` 引用落到线请求」。
- `$` 引用语义（官方 config.example）：以 `$` 开头的值从**下游客户端请求**复制同名头；客户端不发则上游头省略——所以只有插件注入（或客户端自己发）之后才有值。

### 内核改到 cgo（仓库已改 + 已在 arch 实测出内核）

- 2026-10-11：在 `arch` 上用钉死镜像 `golang:1.26.5-bookworm@sha256:53eeac89…` + `CGO_ENABLED=1` 构建 v8.0.23 补丁系列：
  - 源树 `git am --committer-date-is-author-date`（提交者取补丁的 From）→ HEAD `45a47198`、tree `d4de82c3`；
  - 产物 `8.0.23-patched.45a47198`，`sha256=19568dcd479156d3e6d354d3b0f9b8994b8a1ba2c6c299df5c42fa6efd61d667`（69,864,768 B，动态链接 ELF）；
  - 位置：`arch:~/cpa-build/out/cli-proxy-api`。
- **插件加载实测通过**（隔离环境：本地 config + `plugins.enabled: true` + 官方店 v0.3.2 的 `opencode-session-mapper.so`）：
  `pluginhost: plugin loaded plugin_id=opencode-session-mapper` / `plugin registered` → `registered/effective_enabled` 为真。方案 A 的最后一环由此打通。


- `deploy/kernels/cpa-builder/run.sh`：`CGO_ENABLED=0 → 1`；`build-in-container.sh` 注释同步；`docs/ops/kernel-autoupdate.md` 记了「CGO 参数变了就是另一个二进制」。
- 依据：钉死的 `golang:1.26.5-bookworm` 镜像自带 `gcc/g++/libc6-dev/make/pkg-config`；产物动态链接 bookworm 的 glibc 2.36，两台目标机 Ubuntu 24.04（2.39）/ 26.04（2.43）向上兼容（实测 `ldd --version`）。
- 流水线现在停在「合并 v8.0.23 冲突（`internal/runtime/executor/openai_compat_executor.go`）」——**不解决移植，流水线不会构建任何东西**，包括 cgo 版本。
- 候选库按「版本 + sha256」复用：同名旧候选（静态构建）要先删，或等新 HEAD 自然换版本串。

## 3. 「重置后仍用不了」的自动修复

- 新模块 `server/cooldownRecovery.ts`，挂在 `server/index.ts` 的 `loadMonitorPayload` 单账号映射（后台 60s 预热 + `/api/monitor` + 手动同步三条路径共用）。
- 判定（全部满足才清）：新鲜额度（无 `error` 兜底）+ 上游明确可用（codex `allowed && !limit_reached` 且各窗口 < 100%；claude 每窗口 < 100% 且非 critical）+ CPA 侧确有**额度类**冷却（`credential_quota` / `quota` / 429；无冷却明细时要求状态文案是额度/限流）+ 未停用；同一凭据 5 分钟只清一次；清失败不抛（读路径不能挂），失败也进节流窗口并写审计 `auto-clear-cooldown`。
- 不处理瞬时错误冷却（5xx/网络）与 antigravity（形状不同，等实测样例）。
- 手动路径不变：控制台的「重置」按钮仍然先兑现上游重置额度再清冷却。

## 4. 控制台接口 + cradmin

- `server/cpa.ts`：`listPlugins`（v8，404 回退 v0）/ `listPluginStore` / `installPlugin(id, source?)` / `deletePlugin(id)`；`cpaRequest` 支持完整 `/vN/management` 路径。
- `server/index.ts`：`GET /api/plugins`、`GET /api/plugins/store`、`POST /api/plugins/store/:id/install`（成功后 `plugin-install` 审计）、`DELETE /api/plugins/:id`（`plugin-remove` 审计）；全部在既有 session guard 之后。
- `cli/lib/commands/plugins.mjs`：`cradmin plugins ls | store | install <id> [--source X] | rm <id>`；写操作走 `runPlan`（`--dry-run`/`--yes`）；多个来源含同一 id 而没给 `--source` 时列出候选并报错（不猜）。

## 5. 验证与未完成

已验：`npm test` 1601 项 / 1599 过 / 0 失败（2 skipped）；`npx tsc -b --pretty false` 干净；`scripts/cpa-builder.test.mjs` 断言已随 CGO 改动更新（14/14）；预发布插件下载与 `plugins.enabled` 实测生效（`registered=false` 是预期的静态内核限制）。

未完成（依赖外部条件）：
1. ~~v8.0.23 补丁移植~~ **已完成并自验**：`deploy/kernels/cpa-patches/v8.0.23/`（0001–0012，SHA256SUMS + README）。干净 v8.0.23 检出 `git am` 12/12 干净、`sha256sum -c` 全 OK、`go build ./...` 通过，树 `d4de82c3`；0006/0008 的冲突在 `openai_compat_executor.go`：v8.0.23 把 TTFT 观测改成 `TrackHTTPClientRoundTripOnly` + `processFrame` 里的 `ObserveChatTokenEvent`，重写时把 relay 分流补成 `ObserveResponsesTokenEvent`（relay 与非 relay 各记各的）。
2. ~~预发布验收（插件 + 注入 + 真 `oc-*` 200）~~ **已完成，见 §6**；剩构建机同步 `run.sh` / `build-in-container.sh` + 清同名候选，让正式那半走流水线。
3. 控制台 0.2.5 出包（先预发布）：`cooldownRecovery` + 插件接口 + cradmin 都在这批里。
4. 正式 `plugins.enabled` + 插件安装 + opencode 三个凭据的 `headers:`（等 cgo 内核）。

## 6. 预发布真上游验收（2026-10-11 16:01，已完成）

**结论：方案 A 端到端打通** —— 新内核（cgo `8.0.23-patched.45a47198`）+ `opencode-session-mapper` v0.3.2 + 真 opencode Go 渠道，`oc-deepseek-v4.1-flash` 实测 **200**（真上游 completion：`{"model":"deepseek-v4.1-flash",…}`，1.9s；同一模型在没有这套机制的正式侧此前是 400 `MissingSessionID`）。

证据（`<预发布机>:/root/.cli-proxy-api/logs/main.log`）：
- `config_reload.go:142  provider added: opencode-go (api-keys=1, models=1)`
- `selector.go:1228  session-affinity: LCP cache miss, new binding | session=lcp:v1:f… auth=openai-compatibility:opencode-go:33778c00fd76`

会话头注入两条路径都在假上游（`session-echo`）上验过：客户端**不带**会话头 → 上游收到 `x-opencode-session: lcp:v1:2dc1…`（宿主按会话算的稳定 ID）+ `x-opencode-client: cliproxy`；客户端带 `X-Session-Id` → 上游收到原值。两条都是 200。

**渠道写法（踩过的坑，照抄）**：
```yaml
        - name: opencode-go
          base-url: https://opencode.ai/zen/go/v1
          keys:                      # ← 文件里是 keys:；管理 API 视图显示的 api-key-entries 只是投影，
            - api-key: <opencode Go key>   #   写进文件会报 "keys must be a list" 并让 CPA 无限重启
              proxy-url: "direct"    # ← 必须写在凭据条目内；写在渠道级不生效，出站会被全局代理拦成 502
          headers:
            User-Agent: crosery-coding-agent/0.2.4
            X-Opencode-Session: $X-Opencode-Session
            X-Opencode-Client: $X-Opencode-Client
          models:
            - name: deepseek-v4.1-flash
              alias: oc-deepseek-v4.1-flash
```

**环境隔离**：验收用**临时入口 Key + 临时渠道**，只借正式的 opencode Go key 走一次真上游。验完立即撤：渠道块、入口 Key 及其在 `api-key-model-access` / `api-key-channel-access` 里被控制台补的条目、本地备份全部删除；复验 `session-echo` 测试架仍 200，`config.yaml` 里 opencode 残留为 0。（提醒：控制台会给新出现的 Key 显式补写访问条目，删 Key 时三处都要删。）

**当时预发布状态**：内核 `8.0.23-patched.45a47198`（sha256 `19568dcd…`），`kernel-applier adopt` 已接入试运行台账（soak 到 `2026-10-12T07:53:28Z`），插件 `registered: true, effective_enabled: true`。
