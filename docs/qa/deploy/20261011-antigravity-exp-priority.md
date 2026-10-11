# Antigravity 实验组优先 + 上游实际模型落库（2026-10-11）

主机只写 `<正式机>`、`<预发布机>`；账号记作 A1–A9（A1–A3 为实验组候选），不对应任何真实标识。

## 1. 背景数据（用户提供，10-10/11 实测）

`gemini-3.8-flash-high` 的上游返回分布（按账号）：

| 账号 | auth_index | exp-a | -n（基线） | 实验组占比 |
| --- | --- | --- | --- | --- |
| A1 | 43279dbe9950f275 | 81 | 39 | 93.1% |
| A2 | 14031c28c9c4b88f | 79 | 38 | 90.8% |
| A3 | adb68264ed999561 | 50 | 6 | 94.3% |
| A4–A9 | 其余 | 0 | 各 5–136 | 0%（全基线） |

## 2. 改动：实验组账号提优先级

- CPA 选号语义：**先取优先级最高的一档**（`priority` 是账号 JSON 顶层字段；同档内按 `routing.strategy` 轮转），该档全冷却时自动落到下一档。
- 通过管理面热改（无需重启、不动凭据内容）：
  `PATCH /v0/management/auth-files/fields {"name":"antigravity-<账号>.json","priority":1100}`，读回确认 1000→1100。
- 改后档位：**1100** = A1 / A2 / A3（实验组）；**1000** = A4 / A5；**950** = A6–A9。
- 生效验证（2026-10-11 03:34 EDT）：
  - `selector.go:1228 session-affinity: LCP cache miss, new binding | auth=antigravity-<A1 凭据>.json model=gemini-3.8-flash-high`
  - 同刻真实请求 `POST /v1/chat/completions {model:gemini-3.8-flash-high}` → 200，响应体 `"model":"gemini-3.8-flash-exp-a"`（2.8 s）
- 注意：`routing.session-affinity: true`（TTL 1h）——**已绑定**的会话不会因为改优先级而迁移，改动体现在新会话/新绑定上。
- 回滚：把三个账号的 `priority` 写回 1000 即可。

## 3. 记录：上游实际模型（response_model）

- **CPA 本来就在发**：usage 队列事件结构 `internal/redisqueue/plugin.go` 带
  `ResponseModel string \`json:"response_model,omitempty"\``（上游响应帧里观测到的模型；v8.0.23 的 `UsageReporter.ObserveResponseModel` 采样点覆盖 antigravity/claude 等执行器）。
- 控制台此前把它丢了。本次接住：
  - `server/db.ts`：`usage_events` 新列 `response_model TEXT NOT NULL DEFAULT ''`（建表 + ALTER 迁移）；
  - `server/cpa.ts`：`UsageRecord.response_model?: string`；
  - `server/sync.ts`：`persistUsageRecords` 落库。
- 读侧（同一批次）：请求明细显示「上游模型」+ `GET /api/models/:model/upstream-models?days=7` 聚合 + `cradmin models upstream <模型>`；
  模型详情抽屉里的「上游实际模型」面板（分布 + 账号维度 + 空态/未改写文案）随 0.2.5 上线。
- 语义：空串 = 上游没报（例如非流式且未观测到）；请求模型与上游模型相同也照记，展示时只在不同时才提示。

## 4. 后续（未做）

- **自动降级**：当实验组连续一段时间不再返回 `exp-a`（数据现在有了），自动把优先级改回去——需要一个定时对账（可挂在控制台的 account-quota 同步里）。
- 实验组效果用新面板/`models upstream` 直接观察，不再需要手写 SQL。
