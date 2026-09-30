# Magpie 接入 Crosery CPA：结论与验证记录

检查时间：2026-09-30。审查的是固定源码 commit
`3fe2ff99587e17dfe0ea707ffd0eccc088824433`，不是对未来最新版本的承诺。

## 结论

**可以把 Magpie 的推理下一跳接到我们的中转站，已经本地部署并实测。不能把
Magpie 直接当作现有 CPA 多租户管理后台和数据账本的无损替代品。**

本次选择 `客户端 -> Magpie -> 本机凭据桥 -> CPA -> 上游`。CPA 继续拥有原有
Key、账户池、配额、历史用量和管理权限；Magpie 负责本地模型选择、路由和必要的
协议转换。没有生产切流，也没有批量改写真实 Agent 的配置。

源码是一款 Go + Wails 的本地应用，另有 `serve` 和带认证的 `web` 模式。配置为
JSON 文件，调用用量为 `usage.jsonl`。本仓库则有 SQLite 的 `api_keys`、
`usage_events`、`quota_usage_events` 等控制台表，不能直接重命名迁移。
依据：[Magpie Provider][provider]、[用量格式][usage]、本仓库
`server/db.ts` 和 `server/config.ts`。

## 多协议矩阵

| 入口 | Magpie 到 CPA 的路径 | 实测状态 | 不能据此承诺的能力 |
| --- | --- | --- | --- |
| OpenAI Chat | `/v1/chat/completions`，优先同协议 | 真实 SSE 调用通过 | 所有 header、developer role、reasoning 字段完全不变 |
| OpenAI Responses | `/v1/responses`，优先同协议 | 真实非流式调用通过 | WebSocket、compact、retrieve/delete/cancel、所有 built-in tools |
| Anthropic Messages | `/v1/messages`，优先同协议 | 真实非流式调用通过 | 完整 beta/document/cache/signature 语义跨协议等价 |
| Anthropic count | 可尝试 `/v1/messages/count_tokens` | 返回正数，通过 | 必定是上游官方 tokenizer；代码有估算降级 |
| Gemini generate | **先转 IR，再走 Chat/Responses/Messages** | 真实转换调用通过 | 原生 Gemini 直通、安全/grounding、多 candidate、全部媒体和结构化输出 |
| Gemini count | 本地估算 | 返回正数，通过 | 官方计数、计费精度或精确上下文上限 |
| Images generation/edit | 单独重建请求和响应 | 桥接路由契约通过，未实测付费生图 | mask、multipart、参数和故障语义全部等价 |
| 模型目录 | Magpie 自己的目录，来自共享 catalog 快照 | 48 个 Crosery 模型可见 | 可见/隐藏就是授权，或每个模型支持全部协议 |

这里的“同协议”只针对 Magpie 到 CPA 一跳。CPA 到实际供应商可能继续转换。
基础请求成功不等于整套协议规范都兼容。依据：[协议声明][provider]、
[路由与 native/转换分支][gateway]、[Gemini 转换][gemini]、
[Images 分支][draw]。

## 重要缺口

1. **普通 Provider 没有 Gemini 原生上游槽。** `Gemini` 枚举的注释明确为
   client-only，首选上游协议集合只有 Chat、Responses、Anthropic。Google
   登录的 CodeAssist adapter 是另一条专用链，不等同于普通 Gemini API key。
   依据：[provider.go:25][provider]。
2. **跨协议 tools/reasoning 不是无损表示。** Function tools 有实际实现，但
   freeform/custom/MCP/server tools、密封 reasoning 状态及一些结构化输出
   约束没有完整 IR 表示。交错并行工具参数可能受单个当前工具状态影响；
   此项是静态风险，不是本次已运行复现的漏洞。依据：[IR][ir]、
   [Chat decoder][chat]、[Responses decoder][responses]。
3. **流式 200 不保证语义完成。** Converter 对干净 EOF、缺少协议终止事件和
   部分错误的处理要单独验证。已验证的是正常 SSE 完整路径和桥接 timeout，
   没有宣称所有截断、交错工具或多轮工具结果路径均正确。依据：
   [SSE reader][sse]、[gateway 转换收集器][gateway]。
4. **不能作为公网多租户入口直接发布。** LAN key 是单个共享凭据，loopback
   调用可跳过它；显式指定非本机监听地址还有特殊放行行为。模型列表隐藏不
   是调用授权。固定 provider key 也会把外部调用者汇聚到同一个 CPA 身份。
   依据：[LAN guard][lan]、[model Resolve][models]。
5. **Images URL fetch 有 SSRF 风险，输入资源限制不完整。** 已静态核对其
   下载路径，没有在真实内网或 metadata 地址上做主动安全测试。本次只在
   loopback 部署，不把服务公开。依据：[draw.go 下载路径][draw]、
   [gateway.go 请求读取][gateway]。
6. **Web UI 是高权限控制面。** 有随机 bearer link/cookie 保护，不是无认证；
   但诊断可能包含 prompts/tool results 和自定义 headers。不能把 UI 整站
   当作公开 API 反代。依据：[webGuard][web]、[GUI provider state][gui-provider]。

## 数据与迁移

本次实际发现的旧 Magpie 配置记录为三个：ClinePass、Command Code 与 Codex。
ClinePass 的 provider ID、模型选择和 key slot 已保留；真实 Key 与 headers
从原文件在内存引用，不复制到新目录。显示设置和存在的 `quotas.json` 已复制，
其初始快照有 SHA-256 校验记录。

**Command Code 与 Codex 的 OAuth 不复制，保留选择记录但隐藏/停用，需要另行
授权才能在隔离实例使用。** 资源库、MCP、技能与原 Agent stash 留在原实例。
本次没有发现可复制的旧 profiles 或 usage JSONL，不把新服务生成的 smoke
记录当作已经迁完了历史数据。

当前仓库本地 `data/console.db` 的只读检查结果为：`api_keys=0`、
`usage_events=0`、`quota_usage_events=0`、`channel_states=0`、
`app_settings=0`、`audit_log=1`。这只是本地样本，**不是生产数据量**。
生产数据库、计费账本、账户凭据和公网入口没有迁移或修改。

如果最终目的是替换 CPA backend，而不只是把 Magpie 接到 CPA，下一阶段需要：
导出经授权的生产元数据、建立逐项字段与权限映射、冻结迁移水位、隔离回放、
核对 Key/额度/账本与原系统的一致性，再决定切流。原系统中的余额/成本不能
由 Magpie 的当前公开目录价格重新计算后冒充原账本。

## 已验证

- 固定源码的 gateway、provider、gui、usage、backup 五组 Go tests 通过。
- 同范围 `go vet -tags nogui` 通过，原样源码构建成功。
- 新增 10 项 bridge/migration 测试全部通过，覆盖三协议路径、body、工具/reasoning 字段、SSE
  提前交付、状态码、凭据不落盘、foreign Origin/Host、超限、timeout、
  原文件不变、重复迁移拒绝与敏感/软链接快照拒绝。
- `crosery/gpt-5.6-luna` 的真实 Chat SSE、Responses、Messages、Gemini
  generation 和两种 count smoke 均通过。四次生成请求每次只要求回复 OK。
- Ego 浏览器确认供应商页显示 ClinePass 12 个模型与 Crosery CPA 48 个模型；
  服务重启后重新鉴权成功。未登录直接访问 Web UI 返回 401。
- macOS 用户级 `com.crosery.magpie-local` 为 running。三个端口都只监听
  `127.0.0.1`，原 Magpie `0.1.439` 在 `3425` 继续运行。
- Console `npm run build` 通过，新增文件专项 lint 通过；全仓 lint 仅保留
  `server/nativeResponses.ts` 的两项既有 `no-control-regex` 警告。
  不含本次新增测试的原仓库基线为 444 项，423 通过、21 失败；加入最初 9 项
  新测试的全仓运行则为 453 项，432 通过、同样 21 失败。之后增加的第 10 项
  新测试在专项运行中通过。未为使基线变绿而修改无关业务代码，不声称全仓绿。

## 未验证与剩余风险

- 未做生产数据迁移、CPA 替换或 Agent 批量切换。
- 未完成旧 ClinePass 的真实付费调用与订阅 OAuth 在隔离实例中的重新授权。
- 未做付费 Images、native Gemini、WebSocket/compact、多轮交错工具、
  密封 reasoning、部分断流或完整 SDK/浏览器兼容矩阵。
- 未对本机运行的 CPA fork 与每个模型协议能力做完整源码或模型级验收；
  一次基础调用通过不证明所有 48 个模型在所有协议下均可用。
- 旧实例在运行中，其登录状态文件可以并发更新。没有写回或覆盖它；不把
  整个原目录在运行期间“所有文件 hash 恒定”当作迁移保证。
- 本地信任边界不等于多用户安全隔离；安全、计费和性能的生产验收仍需专门阶段。

运行、恢复和威胁模型见 `deploy/magpie/README.md`。本地停止命令为
`node scripts/magpie-service.mjs stop`，它保留数据且不影响原 Magpie 或 CPA。

[provider]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/provider/provider.go
[gateway]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/gateway/gateway.go
[gemini]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/gateway/gemini.go
[draw]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/gateway/draw.go
[usage]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/usage/usage.go
[ir]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/gateway/ir.go
[chat]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/gateway/chat.go
[responses]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/gateway/responses.go
[sse]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/gateway/sse.go
[lan]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/gateway/lan.go
[models]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/provider/models.go
[web]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/gui/web.go
[gui-provider]: https://github.com/yetone/magpie/blob/3fe2ff99587e17dfe0ea707ffd0eccc088824433/internal/gui/providers.go
