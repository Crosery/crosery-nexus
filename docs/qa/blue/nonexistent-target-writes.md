# 对不存在的目标做写操作：静默成功 + 孤儿状态（task-68 交付）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 来源：Lead 在复验 task-66 时自己撞出来的一条

---

## 1. 现象（修前复现，临时实例 + 生产参数 + 真实 HTTP 路由）

```
meta 初始 = (不存在)

PATCH /api/credentials/ghost-cred        {"enabled":false}      → 200 {"ok":true}
    meta = {"ghost-cred":{"disabled":true}}                      ← 凭据根本不存在
PATCH /api/credentials/ghost-cred/proxy  {"proxyUrl":"http://127.0.0.1:1"} → 200 {"ok":true,"proxyUrl":"…"}
    meta = {"ghost-cred":{"disabled":true,"proxy_url":"http://127.0.0.1:1"}}
GET   /api/credentials/ghost-cred/proxy                          → 200 {"proxyUrl":""}   ← 写进去却读不出来
DELETE /api/credentials/ghost-cred                               → 200（幂等删除，这条本身没问题）
```

**两个问题**：
1. **静默成功 + 垃圾积累**：拼写错误、过期 UI 行、被删掉后残留的前端状态，都会往
   `auth-files-meta.json` 塞一个永远不会被读到的孤儿键。
2. **读写不对称**：写返回 ok，读返回空 —— "成功的写不可观测"，对客户端与排障都是陷阱。

**根因**：`setLocalAuthFileStatus` / `setLocalAuthFileProxy` 无条件写 meta（只看名字合法不合法），
而读路径（`localAuthFileView` / `/auth-files/download`）要求**文件存在**。两套判据不一致。

---

## 2. 修法（单点，读写同一判据）

| 位置 | 修法 |
| --- | --- |
| `magpieControl.ts`（**单点**） | 新增 `requireExistingAuthFile(name)`：`assertAuthFileName` + `fs.existsSync(authFilePath(name))`，不存在 → `MagpieManagementError(404, 'credential_not_found')`。`setLocalAuthFileStatus` / `setLocalAuthFileProxy` 都改走它（**不写 meta**） |
| `cpa.ts`（读侧对齐） | 本地 shim 对不存在的凭据返回 `null` → 新增 `ManagementNotFoundError`（带 `status = 404`，message 即 reason），`downloadAuthFile` / `getAuthFileProxy` 把 `null` 翻译成同一个 404。远端模式本来就是 404（由 `cpaRequest` 抛出）⇒ **两种模式语义一致** |
| `index.ts`（路由层） | 凭据路由的 catch 用 `errorStatusOr`（4xx/5xx 原样透出）+ `reasonField`（纯代码形态的 message 作为 `reason`）。顺带给 `PATCH /api/channels/:name`、`/api/channels/:name/models/:model`、`/api/model-index/:model/sources/:channel` 加**存在性检查** → 404 `channel_not_found`（原来一律 400「渠道不存在或已停用」/「渠道未启用，无法调整模型」，把"不存在"和"存在但停用"混成一条） |
| DELETE | **保持幂等**（不存在的目标也 200），这是有意保留的契约；它同时会清掉同名 meta 键 |

修后（同一脚本）：

```
PATCH /api/credentials/ghost-cred        → 404 {"error":"credential_not_found","reason":"credential_not_found"}   meta 仍不存在
PATCH /api/credentials/ghost-cred/proxy  → 404（同上）                                                              meta 仍不存在
GET   /api/credentials/ghost-cred/proxy  → 404（同上）                                              ← 读写同语义
DELETE /api/credentials/ghost-cred       → 200 {"ok":true}                                          ← 幂等保留
合法凭据：PATCH 200 → GET 回读与写入一致 → DELETE 后 meta = {}（无残键）
```

---

## 3. 全路由核查：「目标不存在时返回什么」（实测，临时实例逐个打）

| # | 路由 | 修复前 | 现在 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `PATCH /api/credentials/:name` | **200 + 孤儿 meta** | **404 `credential_not_found`** | ✅ 本次修复 |
| 2 | `PATCH /api/credentials/:name/proxy` | **200 + 孤儿 meta** | **404 `credential_not_found`** | ✅ 本次修复 |
| 3 | `GET /api/credentials/:name/proxy` | 200 `{"proxyUrl":""}` | **404 `credential_not_found`** | ✅ 本次修复（读写对称） |
| 4 | `DELETE /api/credentials/:name` | 200 | 200 | ✅ 幂等，**有意保留** |
| 5 | `PATCH /api/keys/:id` | 404「Key 不存在」 | 404 | ✅ 本来就对 |
| 6 | `PATCH /api/keys/:id/quota` | 404 | 404 | ✅ |
| 7 | `POST /api/keys/:id/quota/reset` | 404 | 404 | ✅ |
| 8 | `POST /api/keys/:id/reveal-token` | 404 | 404 | ✅ |
| 9 | `DELETE /api/keys/:id` | 404 | 404 | ✅（keys 的 DELETE 不幂等，非 2xx，无静默成功） |
| 10 | `GET /api/keys/:id/reveal` | 410「复制令牌已失效」 | 410 | ⚠️ 非 2xx ✓；文案对"key 不存在"略不精确，未改（见 §6） |
| 11 | `PATCH /api/channels/:name` | 400「渠道不存在或已停用」 | **404 `channel_not_found`** | ✅ 本次收紧（不存在 vs 停用分开） |
| 12 | `PATCH /api/channels/:name/models/:model` | 400「渠道未启用，无法调整模型」 | **404 `channel_not_found`** | ✅ 本次收紧 |
| 13 | `PATCH /api/model-index/:model/sources/:channel` | 400「渠道未启用，无法调整模型」 | **404 `channel_not_found`** | ✅ 本次收紧 |
| 14 | `DELETE /api/channels/:name` | 200 | 200 | ✅ 幂等，保留 |
| 15 | `POST /api/accounts/:authIndex/reset-codex-quota` | 404「凭据不存在」 | 404 | ✅ |
| 16 | `POST /api/accounts/:authIndex/reset-claude-quota` | 404「凭据不存在」 | 404 | ✅ |
| 17 | `GET/PATCH /api/groups/:group` | 404「接口不存在」 | 404 | ✅ 没有按 id 的 groups 路由（落到 API 404 兜底） |
| 18 | `POST /api/ab/preference` | 400（flow 校验） | 400 | ✅ A/B 偏好不是"按 id 定位对象"，是白名单 flow |

**结论**：真正"对不存在对象返回 2xx"的只有 #1、#2（以及与之对称的读 #3），已修；
`PATCH/PUT` 类没有第二个静默成功点；DELETE 的幂等（#4、#14）按约定保留。

---

## 4. 测试与负向验证

`server/localControlPlane.test.ts` 新增三条（**真子进程 + 生产参数 + 真实 HTTP 路由**）：

1. `写不存在的凭据必须 404 credential_not_found 且不留孤儿 meta；读写语义一致`
   —— 两个 PATCH → 404 + meta 文件**压根不被创建**；GET → 404；DELETE 幂等 → 200 且不产生 meta；
   随后在同一实例上验证**合法凭据**：写 200 → 回读一致 → 删除后 `meta == {}`。
2. `孤儿 meta 不会积累：连续写不存在的凭据 N 次，meta 始终不变` —— 20 轮幽灵写 + 幂等删，前后 meta 逐字节相同。
3. `渠道类路由：目标不存在返回 404 channel_not_found` —— 三条渠道/模型路由各断言 404 + reason。

**语义级负向验证**（临时把 `requireExistingAuthFile` 的存在性判断关掉）：

```
✔ local 控制面：…
✔ cpa 模式未回归：…
✔ 通用错误体带上已知 reason：…
✖ 写不存在的凭据必须 404 credential_not_found 且不留孤儿 meta；读写语义一致
✖ 孤儿 meta 不会积累：连续写不存在的凭据 N 次，meta 始终不变
✔ 渠道类路由：目标不存在返回 404 channel_not_found
还原后 magpieControl.ts shasum = e803cb0d… 与基线**逐字节相同** → 六条全绿
```

---

## 5. 命令退出码 + 现网抽验

```
npm test run#1 → ℹ tests 672 · pass 671 · fail 0 · skipped 1（14.51s）  exit 0
npm test run#2 → ℹ tests 672 · pass 671 · fail 0 · skipped 1（14.15s）  exit 0
npm run test:magpie → ℹ tests 107 · pass 106 · fail 0 · skipped 1       exit 0
npx tsc -b --pretty false → exit 0 ｜ npm run build → ✓ built in 499ms ｜ npm run lint → exit 0
```

现网抽验（`launchctl kickstart -k` 重启，**未 bootout**；只碰我自己造的临时凭据）：

```
复核 Lead 的清理：auth-files 0 个文件、meta = {}
① 幽灵写：PATCH /api/credentials/ghost-cred → 404 credential_not_found（+ proxy 写、proxy 读同样 404）
          DELETE ghost-cred → 200（幂等）｜ghost 之后 meta = {}（未变）
② 20 轮幽灵写 → meta = {}（未变）
③ 合法凭据（临时）：PATCH proxy → 200 {"ok":true,"proxyUrl":"…"}｜GET 回读 → 200 同值｜DELETE → 200 且文件已删
终态：auth-files 空、meta = {}      ← 真实凭据未触碰
```

---

## 6. 孤儿键：会不会积累、要不要清理钩子（要求 ④ 的判断）

**修复后不会再产生孤儿键**，三条判据（都有实测支撑）：
1. 写入必须**文件存在**（§2 单点守卫）→ 幽灵写一律 404，不碰 meta；
2. `DELETE` 会一并删掉同名 meta 键（`deleteLocalAuthFile` 里本来就有）→ 合法凭据删除后不留残键（§4 用例 1 断言 `meta == {}`）；
3. 现网 20 轮幽灵写 + 幂等删之后 meta 逐字节未变。

**已有孤儿键（历史遗留）不需要清理钩子**，理由：
- `listLocalAuthFiles()` 是**遍历目录**再合并 meta（`meta[name] || {}`），孤儿键永远不会被读到、
  也不会出现在任何列表里 —— 它们只是 `auth-files-meta.json` 里的几行死数据；
- 该文件只在「凭据数量」量级上增长（每个真凭据至多 2 个字段），没有内存/性能压力；
- 相反，**读路径上自动清理是有害的**：`readAuthFilesMeta()` 在热路径上被调用，边读边写会与并发写请求
  抢同一个文件（本地面唯一的状态文件），且"文件暂时不存在"与"对象已删除"在崩溃/半写状态下无法区分。

**触发条件（届时再加清理钩子，一次性、显式）**：
① 若将来出现批量导入/迁移路径会**直接写 meta**（绕过单点守卫）；
② 若 meta 文件增长到明显尺寸（例如 >100 个键或 >64KB），
   则加一个 **admin 触发**的一次性 prune（`/api/credentials/prune-orphan-meta`），
   语义是「键名对应的凭据文件不存在 → 删除该键」，并在审计里留痕；
③ 若将来 `auth-files-meta.json` 换成数据库表，则顺手在迁移里清一次。
手工应急（不改代码）：
```sh
python3 - <<'PY'
import json, os
d = 'data/auth-files'
mp = os.path.join(d, 'auth-files-meta.json')
meta = json.load(open(mp)); files = set(os.listdir(d))
pruned = {k: v for k, v in meta.items() if k in files}
json.dump(pruned, open(mp, 'w'), indent=2)
print('removed:', sorted(set(meta) - set(pruned)))
PY
```

---

## 7. 未做 / 残余

1. `GET /api/keys/:id/reveal` 对不存在的 key 返回 **410**「复制令牌已失效」而**不是 404**：
   非 2xx、无静默成功，属于文案精确度问题；改成 404 需要区分"令牌过期"与"key 不存在"，
   而该端点的语义本来围绕一次性复制令牌，改动价值低。**触发条件**：若客户端要根据它区分这两种情况。
2. `DELETE /api/keys/:id` 对不存在的 key 返回 404（而 channels/credentials 是 200）：
   两者都非 2xx、都没有静默副作用，属于一致性差异，**未改**（改它会破坏现有前端对 404 的处理）。
3. 渠道 404 的判定用 `listChannels()` 先查一次（多一次读），在本机量级可忽略；
   若将来渠道列表需要远程拉取，应改为由业务层抛出带状态的错误（避免路由层多一次 IO）。
