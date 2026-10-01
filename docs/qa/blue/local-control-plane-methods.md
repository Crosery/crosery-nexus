# local 控制面的方法/路径方言修齐（task-66 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依据：红队第十八轮副作用发现（结论 E）+ 我自己的能力矩阵实测

---

## 1. 现象与定位

**用户可见的功能坏掉**：本机控制台（local 控制面）里「凭据启用/禁用」与「凭据级代理」**100% 失败**。

### 1.1 修前复现（临时实例、生产模式参数、真实 HTTP 路由）

`GATEWAY_ENGINE=magpie` + `MAGPIE_CONTROL_PLANE=local`，`/tmp/af-repro.mjs`：

```
PATCH /api/credentials/<临时凭据>            {enabled:false} → 400 {"error":"This CPA management operation is not supported by the Magpie kernel"}
     meta.disabled = null                                  ← 状态没变
PATCH /api/credentials/<临时凭据>            {enabled:true}  → 400（同上），meta.disabled = null
PATCH /api/credentials/<临时凭据>/proxy      {proxyUrl}     → 400（同上），meta.proxy_url = null
GET   /api/credentials/<临时凭据>/proxy      （回读）        → 200 {"proxyUrl":""}
DELETE /api/credentials/<临时凭据>            （清理）        → 200 {"ok":true}
```

### 1.2 根因：**远端方言 vs 本地方言的翻译缺失**，不是路由层的问题

| 层 | 事实 |
| --- | --- |
| 路由层 | `/api/credentials/:name`(PATCH)、`/:name/proxy`(PATCH) 正常匹配、鉴权正常、入参校验正常 |
| `cpa.ts` 调用点 | 按**远端 CPA** 的管理面发 `PATCH /auth-files/status`、`PATCH /auth-files/fields` |
| `cpaRequest` 的 local 分支 | **原样透传** `path`/`init` 给 `magpieManagementRequest`（没有任何方法/路径翻译） |
| 本地 shim | 只认 `PUT /auth-files/status`、`PUT /auth-files/proxy`；未命中就 `throw MagpieManagementError(501, 'This CPA management operation is not supported by the Magpie kernel')` |
| 路由 catch | 把该错误统一压成 **400** → 用户看到的就是那条内核文案 |

⇒ 红队说的「PATCH/PUT 与路径双重不匹配」核实为：
- `setAuthFileDisabled`：**方法**不匹配（PATCH vs PUT），路径一致；
- `setAuthFileProxy`：**方法 + 路径**都不匹配（`PATCH /auth-files/fields` vs `PUT /auth-files/proxy`）。

---

## 2. 修法（单点，不动两个调用点）

`server/cpa.ts` 的 local 分支加一层**方言适配**（唯一的翻译点，任何调用方都经过它）：

```ts
const LOCAL_MANAGEMENT_ALIASES = {
  'PATCH /auth-files/status': { method: 'PUT', path: '/auth-files/status' },
  'PATCH /auth-files/fields': { method: 'PUT', path: '/auth-files/proxy' },
}
// cpaRequest 的 local 分支：
const local = adaptLocalManagementRequest(path, init)
return magpieManagementRequest<T>(local.path, local.init)
```

要点：
- **只改 local 分支**：远端 cpa 模式的请求一个字节都没变（§3② 用录制型 stub 证明）。
- 未命中翻译表 → **原样放行**（既有行为不变）。
- `PATCH /auth-files/fields` 带 `disable_cooling` 时**不翻译**：本地内核没有「冷却开关」这个概念，
  明确抛错（见 §4 表），而不是让它落到含糊的 501 再被压成 400。
- `POST /api-call`、`GET /latest-version` 这两个本地确实没有的操作，也改成**明确报错**（说明原因 + 替代路径）。

### 2.1 顺带修掉的**第二处**不一致：写进 meta、读的是原始文件

修完方法/路径后，"设置代理"能写进去了，但**回读仍返回空串**：

```
PATCH .../proxy {proxyUrl:"http://127.0.0.1:7890"} → 200  meta.proxy_url = "http://127.0.0.1:7890"
GET   .../proxy                                    → 200 {"proxyUrl":""}      ← 写进去了却读不出来
```

原因：本地面把 `disabled`/`proxy_url` 存在 `auth-files-meta.json`（见 `listLocalAuthFiles`），
而 shim 的 `/auth-files/download`（`getAuthFileProxy()` 的数据源）只回**原始凭据文件**。
远端 CPA 把这两个字段存在凭据文件本身，所以下载分支必须给出**同一语义**。

修法：新增 `localAuthFileView(name)` = 文件内容 + meta 覆盖（**meta 优先**），
`/auth-files/download` 与 `listLocalAuthFiles` 共用它（列表页显示的也必须是用户实际设置的值）。
网关侧不受影响：`magpieRuntime` 本来就走 `listLocalAuthFiles()`（meta 已合并）⇒ **代理真的会生效**。

---

## 3. 验证

### 3.1 ① local 模式：200 且状态真的变了（修后同一脚本）

```
PATCH enabled=false → 200 {"ok":true}   meta.disabled = true
PATCH enabled=true  → 200 {"ok":true}   meta.disabled = false
PATCH proxyUrl      → 200 {"ok":true,"proxyUrl":"http://127.0.0.1:7890"}   meta.proxy_url = "http://127.0.0.1:7890"
GET   proxy（回读）  → 200 {"proxyUrl":"http://127.0.0.1:7890"}            ← 与写入一致
DELETE（清理）       → 200 {"ok":true}   文件已删 = true
```

### 3.2 ② cpa（远端）模式未回归

`server/localControlPlane.test.ts` 用**录制型 CPA stub** 断言：同样的两个 HTTP 请求，
远端收到的仍是 **`PATCH /v0/management/auth-files/status`**（body `{name, disabled:true}`）与
**`PATCH /v0/management/auth-files/fields`**（body `{name, proxy_url:"…"}`）——方法、路径、body 逐字节不变。

### 3.3 ③ 回归测试与负向验证

`server/localControlPlane.test.ts`（**真子进程 + 生产参数 + 真实 HTTP 路由**）三条：

1. `local 控制面：凭据启用/禁用与凭据级代理写入 200 且状态真的变了（含回读）` —— 含"临时凭据必须能删掉"。
2. `cpa 模式未回归：发往远端的仍是 PATCH /auth-files/status 与 PATCH /auth-files/fields`。
3. `通用错误体带上已知 reason：invalid_json / payload_too_large`。

**语义级负向验证**（临时把方言翻译关掉 → `if (true) return { path, init }`）：

```
✖ local 控制面：… 200 且状态真的变了        ← 必红
✔ cpa 模式未回归：…                        ← 仍绿（证明远端路径不依赖这层翻译）
✔ 通用错误体带上已知 reason：…
还原后 cpa.ts shasum = aedec221… 与基线**逐字节相同** → 三条全绿
```

### 3.4 命令退出码

```
npm test run#1 → ℹ tests 669 · pass 668 · fail 0 · skipped 1（19.48s）  exit 0
npm test run#2 → ℹ tests 669 · pass 668 · fail 0 · skipped 1（16.69s）  exit 0
npm run test:magpie → ℹ tests 107 · pass 106 · fail 0 · skipped 1       exit 0
npx tsc -b --pretty false → exit 0
npm run build → ✓ built in 459ms                                        exit 0
npm run lint → exit 0
```

### 3.5 现网抽验（重启后，**临时凭据**，不碰真实凭据）

`launchctl kickstart -k gui/$(id -u)/com.crosery.console-magpie`（**没有 bootout**）。

> 定位小坑记录：运行实例的 `DATA_DIR` 是**仓库内**的 `<repo>/data`
> （launcher 里 `DATA_DIR: process.env.DATA_DIR || path.join(root, 'data')`，`root` = 仓库根），
> 不是 `~/.agents/crosery/magpie-console/data`。下次做现网抽验直接看 `<repo>/data/auth-files`。

```
创建临时凭据（OAuth 回调）→ 200 {"ok":true}
PATCH enabled=false → 200 {"ok":true}｜meta.disabled=True
PATCH enabled=true  → 200 {"ok":true}｜meta.disabled=False
PATCH proxyUrl      → 200 {"ok":true,"proxyUrl":"http://127.0.0.1:7890"}
GET   proxy（回读）  → 200 {"proxyUrl":"http://127.0.0.1:7890"}
DELETE（清理）       → 200 {"ok":true}｜文件已删=是
POST /api/login 畸形 JSON → 400 {"error":"请求格式不正确","reason":"invalid_json"}   ← 线上生效
残留核对：auth-files 空、auth-files-meta.json = {}
（三个临时凭据都是我这两轮造的探针，全部删干净；真实凭据未触碰）
```

---

## 4. 同类核对：管理面「方法 + 路径 + local 是否支持」全表

方法：用 `/tmp/shim-capability.mjs` **逐个调用** `magpieManagementRequest(method, path)` 实测（不是读代码猜）；
"cpa.ts 调用点"一列来自 `grep cpaRequest`。

| # | cpa.ts 调用点 | 远端（cpa）方言 | 本地 shim | local 结果 |
| --- | --- | --- | --- | --- |
| 1 | `getCPAKeys` / `replaceCPAKeys` | GET / PUT `/api-keys` | ✓ GET/PUT（SQLite 才是真源） | ✓ 支持 |
| 2 | key-model-access / key-channel-access | GET / PUT `/api-key-*-access` | ✓（返回 `{}` / `{ok:true}`，不落盘） | ✓ 支持（空实现） |
| 3 | `listAvailableModels` | GET `/available-models` | ✓ | ✓ 支持 |
| 4 | `popUsage` | GET `/usage-queue?count=` | ✓ | ✓ 支持 |
| 5 | `listAuthFiles` | GET `/auth-files` | ✓ | ✓ 支持 |
| 6 | `downloadAuthFile` / `getAuthFileProxy` | GET `/auth-files/download?name=` | ✓（**task-66 起返回「有效视图」**） | ✓ 支持 |
| 7 | `getAuthFileModels` | GET `/auth-files/models?name=` | ✓ | ✓ 支持 |
| 8 | `deleteAuthFile` | DELETE `/auth-files?name=` | ✓ | ✓ 支持 |
| 9 | **`setAuthFileDisabled`** | **PATCH `/auth-files/status`** | 只认 **PUT**（实测：PATCH → 501） | ✗ **本次修复：翻译为 PUT** |
| 10 | **`setAuthFileProxy`** | **PATCH `/auth-files/fields`** | 只认 **PUT `/auth-files/proxy`** | ✗ **本次修复：翻译为 PUT /auth-files/proxy** |
| 11 | `setAuthFileCoolingDisabled` | PATCH `/auth-files/fields {disable_cooling}` | **无对应能力** | ✗ **明确拒绝**（本地凭据没有"冷却开关"概念） |
| 12 | `getCompatChannels`/`putCompatChannels`/`deleteCompatChannel` | GET/PUT/DELETE `/openai-compatibility` | ✓ | ✓ 支持 |
| 13 | provider key 端点（`claude-api-key` 等） | GET / PUT `/…-api-key` | GET → 空列表；PUT → 501「Add a Magpie channel with an explicit protocol and credential reference」 | ✗ **有意拒绝**（文案可操作，引导去配 Magpie 渠道） |
| 14 | `getExcludedModels`/`putExcludedModels` | GET/PUT `/oauth-excluded-models` | ✓ | ✓ 支持 |
| 15 | `getGlobalProxy` | GET `/proxy-url` | ✓（固定返回 ''） | ✓ 支持 |
| 16 | OAuth start / status / callback / cancel | GET `/<provider>-auth-url`、GET `/get-auth-status`、POST `/oauth-callback`、DELETE `/oauth-session` | ✓ 全部支持 | ✓ 支持 |
| 17 | `apiCall`（用量/额度/资料/渠道探测） | POST `/api-call` | **无** | ✗ **本次改为明确报错**（见 §5 残余①） |
| 18 | 版本 | GET `/latest-version` | **无** | ✗ **本次改为明确报错**，指向 `/api/version` |
| 19 | `uploadAuthFile` | POST `/auth-files`（multipart） | 本地面走自己的分支（`saveLocalAuthFile`） | ✓ 支持（不经 shim） |

**结论**：唯一的"静默坏掉"就是第 9、10 两项（本次修好）。第 11、13、17、18 属于**本地确实没有的能力**，
现在都以**明确文案**失败（第 11、17、18 由本次新增的显式清单给出；第 13 原本就有可操作文案）。

---

## 5. 残余（明确登记，含触发条件）

1. **`POST /api-call` 在 local 模式不可用**（不是方法/路径问题，是**能力缺口**）：
   受影响的功能包括 Claude 用量/资料、Codex 重置额度、渠道模型探测、Antigravity 订阅查询
   （`server/index.ts:735/736/752/829/837`、`channels.ts:237`、`antigravityQuota.ts`）。
   本次只把它从"含糊的 400"改成"明确的错误 + 替代路径"，**功能仍未打通**——这需要产品决策
   （要么在本地模式走网关端口直连上游，要么本地面不提供这些面板）。
   **建议**：单独立项，别塞进本轮的"方法/路径"修复里。
2. **`GET /latest-version` 在 local 模式不可用**：控制台版本请看 `/api/version`；若将来本地也要显示
   "CPA 版本"，需要一个本地来源（内核/网关版本）。
3. `PATCH /auth-files/fields {disable_cooling}`（第 11 项）：本地无对应语义；若将来内核支持冷却开关，
   应在 `LOCAL_MANAGEMENT_ALIASES`/shim 里补上并在本表更新。
4. 方言翻译表是**静态映射**：远端 CPA 若再改管理面路径/方法，需要同步更新 `LOCAL_MANAGEMENT_ALIASES`
   并重跑 `server/localControlPlane.test.ts`（该用例会把"远端收到了别的方言"直接判红）。
