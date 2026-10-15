# CPA 补丁系列（基于上游 v8.0.29）

- 基底：上游 tag `v8.0.29`（`5fc580b1`）。`git am --committer-date-is-author-date 00*.patch`（0001–0013）后 HEAD = `34e0d771`；版本串 `8.0.29-patched.34e0d771`。
- 移植自 `../v8.0.23/`（12 个补丁一一对应），共 3 处冲突手工合并：
  - 0003 `sdk/api/handlers/claude/code_handlers.go`：上游改成 `cfg := h.CurrentConfig()`，保留上游写法，再对 `h.Models()` 套 `FilterModelsForAPIKey`。
  - 0003 `sdk/api/handlers/openai/codex_client_models.go`：上游给 `BuildResponseForClientWithToolCapabilities` 多加了一个能力函数参数，保留上游参数，把 `h.Models()` 换成已按 Key 过滤的 `models`。
  - 0011 `internal/api/handlers/management/handler.go`：上游 `SetConfig` 改成先 `cloned := cfg.CloneForRuntime()`，保留 `cloned`，再套上我们的 `defer Unlock` 和 `HotReloadIsStale()` 检查，最后 `h.cfg = cloned`。
- 0013 只改测试：上游 `NewHandler` 改为克隆配置，key 访问测试要对 handler 的配置断言；上游 `TestResponsesInterruptStopsHTTPUpstream` 在纯 v8.0.29 上也会抖（取消标志是异步置位），改为短轮询。
- 其余说明、补丁表同 `../v8.0.23/README.md`。
