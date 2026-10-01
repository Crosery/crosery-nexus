# SSE 并发上限：唯一无界项收口（task-76）

日期：2026-10-01 · 结论：**已加上限并给显式拒绝**；连满→拒绝→**异常断开**释放→再连成功 有端到端用例；计数与上限进只读诊断载荷；生产实例单条连接抽验通过（0 → 1 → 0）。

---

## 1. 为什么改：不是"已经漏了"，而是"没有上限保护"

红队句柄泄漏审计（`docs/qa/red-team/runtime-leaks-and-real-cli.md` ⑨）结论：9 个长期结构里 **8 个已有上界**（压缩缓存 128 项/64MB、`revokedSessions` 10k、限流桶 10k、`inflightBackups` 在 finally 清理、读池固定 2 worker、定时器全 `unref`），
soak（100 万次 API + 25 万次 SSE 连断）实测 **FD 平直、静置回 30 基线、零泄漏**；
**只有 `server/liveStream.ts` 的 `clients` 集合没有上限**，只受 OS 句柄限制 —— 一个卡住的客户端、或一个反复连而不断开的脚本就能把句柄吃光。

**默认 16 的理由**：这是**单管理员**控制台，正常只有 **1–2 个页面**在订阅（每个标签页一条 `/api/cache-live`）；16 给了约 8–16 倍余量覆盖多标签/多设备/重连窗口，同时把最坏情况封在 16 条连接以内。可用 `SSE_MAX_CLIENTS` 覆盖（非法值回落默认）。

## 2. 改动（三点）

| 文件 | 改动 |
| --- | --- |
| `server/liveStream.ts` | 新增 `sseClientLimit()`（env `SSE_MAX_CLIENTS`，默认 16）与 `hasClientCapacity()`；`registerClient` 在满员时**返回 `null`**（结构性拒绝，调用方必须回 503）；`addClient`/`addBufferedClient` 相应地返回 `… | null` |
| `server/index.ts` | `/api/cache-live` 在**写 SSE 头之前**检查容量：满员 → **`503` + `Retry-After: 5` + 可读中文原因 + `clients/limit`**（绝不静默丢弃——静默丢弃会让客户端以为连上了却永远收不到事件）；注册兜底分支同样 503。`/api/cache-live/status` 载荷加上 `limit` |
| `server/liveStream.test.ts` | 4 处注册调用加非空断言（测试内容量充足） |

检查与注册在**同一个 tick** 内完成（中间没有 `await`），不存在"检查通过但注册时已满"的竞态。

## 3. 断开释放 + 异常断开（最容易写错的地方）

`req.on('close')` 里调用 `client.remove()`（原有代码路径，本轮加注释与测试钉住）。**`close` 在正常关闭与异常断开（客户端进程被杀 / 网络 RST / 页面崩溃）两种情况下都会触发**——端到端用例用 `request.destroy()` 模拟粗暴断开并断言计数回落。

## 4. 测试（`server/liveStreamCap.test.ts`，7/7 通过）

| 用例 | 内容 |
| --- | --- |
| 上限可配置 | `SSE_MAX_CLIENTS` 生效；未设置 = 16；`abc`/`0` 回落 16 |
| **① 超上限被拒** | 限 3 时前 3 条成功、第 4 条 `addClient` 返回 **null**、计数不增加；缓冲注册路径同样受限 |
| **② 连满 → 拒绝 → 断开 → 再连成功** | 限 2：满员时拒绝 → `first()` 释放后 `clientCount()` 回落 → 第 3 条成功 |
| ③ ≤上限多路订阅 | 限 4 时 3 条并存，`broadcast` 到达 3 个客户端 |
| **负向验证 A（去掉上限必红）** | 上限放到 10^6（= 无上限）时 `addClient` **永不返回 null** ⇒ 用例①的断言必然失败，显式断言这一点 |
| **负向验证 B（去掉释放必红）** | 不调用释放就再连 ⇒ 计数永远占着、再连被拒 ⇒ 用例②"断开后回落并可再连"必然失败 |
| **端到端（真起服务）** | `SSE_MAX_CLIENTS=1`：第 1 条 200 且 `status.clients=1` → 第 2 条 **503 + `Retry-After` + 可读原因**（且不计入）→ **`destroy()` 粗暴断开** → 轮询到 `clients=0` → 第 3 条 200 |

（顺带记录我自己的一个测试卫生问题：第一条版本里用例③断言失败后**没有撤销订阅**，残留 3 个客户端把后面的用例搞红了 ⇒ 已改成 `try/finally` 撤销；这类"测试自身泄漏"会伪装成产品 bug。）

## 5. 可观测（不引入高频轮询）

`GET /api/cache-live/status`（只读，已有接口）现在返回：

```json
{ "clients": 0, "limit": 16, "usageCollectIntervalMs": 1000, "syncIntervalMs": 15000 }
```

运维一眼能看出"是不是连满了"，不需要新增轮询。

## 6. 生产抽验（只连一条，未压测）

重启（`launchctl kickstart -k`，未用 bootout）后：

```
初始:     {"clients":0,"limit":16,…}
连接中:   {"clients":1,"limit":16,…}      ← 单条 curl -N /api/cache-live?limit=3
断开后:   {"clients":0,"limit":16,…}
```

SSE 帧本身照常（捕获到 `retry: 2000` 与 `event: history`）；**只连了一条**，未做任何并发压测。
命令与结果：`tsc -b` 0 · `lint` 0（2 条既存 `server/nativeResponses.ts` warning）· `build` 0 · `npm test` **0**（`692 / 691 / 0 / 1 skipped`；本轮新增 7 条）。
顺带清掉三个遗留死代码 warning（`scripts/rollup-rebuild.mjs` 的 `severityOf`、`perf-cpa-stub.mjs` 的 `res500`、`perf-seed.mjs` 未用的 `path` 导入），并验证 CPA stub 仍按设计工作（`/api-keys` 500 = fail-closed 有意行为、`/api/channels` 500）。

## 7. 未验证清单

1. **上限未在生产上真正触发**（需要连满 17 条，属压测，任务明确要求别做）——503 路径只在端到端测试与临时实例上验证。
2. **`SSE_MAX_CLIENTS` 未在生产环境显式设置**（用默认 16）；如需按部署调整，改环境变量即可，无需改代码。
3. 未测**慢客户端写阻塞**场景（`res.write` 返回 false 时只是丢弃该客户端并计数释放，未做背压队列）；生产 nginx 侧的超时配置未一并核对。
4. 未验证多进程/多实例部署下的"全局"上限（当前上限是**单进程**语义；若将来水平扩展，需要改成跨进程配额）。
