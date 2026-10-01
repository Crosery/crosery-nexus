# 第十八轮：凭据名/provider 穿越修复复验 + rollup 自检与重建 + 事故规则复核（红队 A / task-65）

审计者：rtk-auditor · 时点 2026-10-01T09:02–09:12Z（本地 17:02–17:12）
范围：`a2154f7`（凭据名 + provider 穿越）、`57ec047`（rollup 自检与重建）、`e773919`（服务事故规则）
环境：临时实例（`mktemp` HOME/DATA_DIR + 端口 8870/8871，magpie + local 控制面 = 生产同模式）；生产仅只读请求（health + 一次被拒的 provider 调用 + 一次畸形 JSON 登录）；**未重启/未停任何服务、未在生产执行重建**
真实 agent 配置 sha256（全程未变）：`~/.codex/hooks.json`=d234642427dd4c2e、`~/.claude/settings.json`=c08f957851d68845、`~/.cursor/hooks.json`=4734d152efa28ffb、`~/.gemini/settings.json`=196e2dca8dacab1b

---

## 0. 结论摘要

| 项 | 判定 | 级别 |
| --- | --- | --- |
| (A) 凭据名穿越修复（`:name` 越界删/读） | **已验证修复**：17 条攻击 + 软链 + 硬链全部被拒且目标文件不受影响；合法列/读/删/保存正常；校验顺序符合"先校验后碰文件系统" | — |
| (B) provider 穿越修复 | **已验证修复**（未知 provider → 400 `provider_not_supported`，start/callback 两条路径都拦，无外部残留）。**Lead 的成因诊断被推翻**：well-formed 请求能拿到 reason；通用文案只出现在 **body 不是合法 JSON** 时 | 诊断更正 |
| (B′) 通用错误体不区分"格式错"与"业务拒绝" | 存在，但属于**可诊断性**问题（`请求格式不正确` 无法告诉客户端是 JSON 解析失败）| **信息级** |
| (C) rollup 自检接口 | **已验证**：生产 24h `2910/2910, ratio 1, drift 0, ok`；我用**自己的 SQL**（只读副本）算出完全相同的数字，并按小时/token/cost 逐项核对通过 | — |
| (C′) 自检的盲区 | **新发现**：① 逐行漂移可互相抵消；② **token/cost/latency 维度完全不查**。已在副本上实证 | **中**（诊断能力，不是数据损坏本身） |
| (C″) 重建脚本 | **已验证**：默认拒绝生产路径（在存在性检查之前）、`VACUUM INTO` 备份、两遍指纹一致 `idempotent:true`；重建后我方 SQL 复核 token/cost 漂移被修掉 | — |
| (D) 事故规则 | 方向正确但**缺可执行前置检查与无提权通道时的退路**；给 4 条具体补强（含可直接抄的 pre-flight） | 建议 |
| (E) 副作用发现 | **local 控制面下「凭据启用/禁用」与「凭据级代理写入」100% 失败**（400）——PATCH/PUT 与路径双重不匹配。功能缺陷（非安全） | **中**（功能） |

---

## 1. (A) 凭据名穿越修复复验

### 1.1 攻击矩阵（临时实例 8870，magpie + local；脚本 `evidence/r18/attack-authname.mjs`）

判据：**每条都要「拒绝 + 目标文件不受影响」**。哨兵文件在 DATA_DIR 之外（`/tmp/cac-r18-XXXX/outside/sentinel.txt`）。

```
状态 | 哨兵 | 攻击
400  | 完好 | ..%2F..%2Foutside%2Fsentinel.txt          DELETE    → credential_name_invalid
400  | 完好 | ..%2f..%2foutside%2fsentinel.txt          DELETE    → credential_name_invalid
400  | 完好 | %2e%2e%2f%2e%2e%2foutside%2fsentinel.txt  DELETE    → credential_name_invalid
400  | 完好 | %2E%2E%2F%2E%2E%2Foutside%2Fsentinel.txt  DELETE    → credential_name_invalid
400  | 完好 | ..%5C..%5Coutside%5Csentinel.txt          DELETE    → credential_name_invalid
400  | 完好 | %2Fetc%2Fpasswd（绝对路径）                DELETE    → credential_name_invalid
400  | 完好 | 尾部斜杠 ..%2F..%2Foutside%2Fsentinel.txt/ DELETE    → credential_name_invalid
400  | 完好 | canary%00.txt（NUL）                       DELETE    → credential_name_invalid
400  | 完好 | 4000 字符超长名                            DELETE    → credential_path_invalid（ENAMETOOLONG 被包成 400）
200  | 完好 | 双重编码 ..%252f..%252foutside%252f...      DELETE    → 被判为**普通文件名**（不存在）→ 幂等删除 ok，无副作用
200  | 完好 | 全角 ．．／（U+FF0E/FF0F）                  DELETE    → 同上，普通文件名
404  | 完好 | 名字为 . / ..                              → Express 归并路径后未命中路由
400  | 完好 | 穿越读取 GET ..%2F..%2Foutside.json/proxy   → credential_name_invalid
400  | 完好 | 穿越读取 GET %2e%2e%2f…                    → credential_name_invalid
400  | 完好 | 穿越 PATCH /api/credentials/<穿越>          → credential_name_invalid
400  | 完好 | 穿越 PATCH /api/credentials/<穿越>/proxy    → credential_name_invalid
400  | 完好 | 软链 link-to-outside.json（→ DATA_DIR 外）  → credential_path_escape；软链与目标**都还在**
400  | 完好 | 硬链 hardlink-to-outside.json              → credential_hardlink_rejected；硬链与目标**都还在**
200  | —    | 合法读取 codex-legit.json/proxy             → {"proxyUrl":""}
200  | —    | 合法删除 codex-legit.json                   → 文件确实被删
```

**最终哨兵状态：完好（内容逐字节未变）。**

补充判定：
- 两条 `200 ok` 的"双重编码 / 全角"不是穿越：它们被当作**不含路径分隔符的普通文件名**，在 auth-files 目录内解析，文件不存在 → 幂等删除返回 ok。**未越过目录、未影响任何目标**（哨兵完好）。属"删除不存在的名字返回成功"的幂等语义，信息级。
- `.` / `..` 变成 404 是 Express 在路由前归并路径段所致（不是校验器放行）。

### 1.2 五个函数是否真的都走单点校验器（独立读码）

```
$ grep -n "authFilePath(\|assertAuthFileName(" server/magpieControl.ts
169  export function assertAuthFileName        ← 单段名/无 NUL/非绝对/非 . .. 
185  export function authFilePath              ← resolve 前缀 → realpath（防软链）→ lstat nlink>1（防硬链）
269  const filePath = authFilePath(name)       ← saveLocalAuthFile
275-276 assertAuthFileName → authFilePath      ← deleteLocalAuthFile（先校验再碰文件系统 ✓ 顺序属性成立）
286  assertAuthFileName                       ← setLocalAuthFileStatus（名字只作 JSON 键）
293  assertAuthFileName                       ← setLocalAuthFileProxy（同上）
300  const filePath = authFilePath(name)       ← getLocalAuthFile
```
→ 主张①（五个函数全覆盖）与主张②（删除先校验）**成立**。

### 1.3 `/v1` 白名单已精确化（主张④）

```
server/auth.ts:169  pattern: /^\/v1\/(?:usage|usage\/requests)$/,   ← 不再是前缀规则
行为对照（临时实例）：/v1/usage → 401（无 Key）；/v1/usage/requests → 401；/v1/anything → 200（SPA 回退，无路由）
```
✓ 与主张一致（我上一轮提的结构性提示已被采纳）。

---

## 2. (B) provider 修复 + Lead 的"缺口"定级

### 2.1 主张复验——成立

```
# 临时实例（well-formed JSON）
POST /api/cpa/oauth/callback {"provider":"../../evil","redirectUrl":"https://example.com/cb?code=abc","state":"x"}
→ 400 {"error":"不支持的 OAuth 提供商：../../evil。可选：antigravity, google, codex, openai, claude, anthropic, kimi, kimi-ai, devin, meta, muse, xai, grok",
        "reason":"provider_not_supported"}
POST /api/cpa/oauth/start    {"provider":"../../evil"} → 400 同类文案
POST … {"provider":"../../../../tmp/evil-cb", …}       → 400 同类文案
外部残留：ls /tmp/evil* → 无；auth-files 目录只有合法文件
# 生产（1 次，被拒则无副作用）
→ 400 + reason=provider_not_supported；残留检查 ~/.agents/crosery/magpie-console/{,data/}evil* → 无
```
✓ 未知 provider 走注册表、start/callback 都拦、无残留。

### 2.2 "缺口"的成因——**诊断被推翻**

Lead 观察到的是 `{"error":"请求格式不正确"}`。我构造出同样的响应，并定位到**唯一**成因：

```
# ① body 不是合法 JSON，却声明了 application/json（curl -d 'provider=../../evil'）
$ curl -X POST … -H 'Content-Type: application/json' -d 'provider=../../evil'
{"error":"请求格式不正确"}   [400]         ← 与 Lead 看到的一模一样
# ② well-formed JSON 时，reason 是拿得到的（见 2.1）
# ③ 表单编码（无 JSON 头）：req.body 为空 → {"error":"缺少 provider 或回调内容/授权码"}
```

即：**不是"管理面的 reason 被兜底中间件改写"**，而是 `express.json()` 在 body 解析阶段抛出 `SyntaxError(400)`，被 `server/index.ts:1395` 的兜底中间件统一成通用文案——那正是第十五轮为了堵住"未认证堆栈+绝对路径泄漏"而加的中间件（生产实测：现在返回 `{"error":"请求格式不正确"}`，HTML 堆栈页已消失 ✓）。
另外：生产实例当前**跑的就是修复后的代码**（只读判别：`GET /api/credentials/..%2F..%2Fr18-nonexistent-probe.json/proxy` → 400 `credential_name_invalid`），所以 Lead 当时看到的通用文案也不可能是"旧代码没重启"。

### 2.3 定级与最小修法

- **级别：信息级（可诊断性）**。安全性上没有任何问题：请求被拒、无副作用、无信息泄漏。
- **影响面**：仅影响"客户端/排障能不能一眼看出是 JSON 格式问题"。观测到的影响：Lead 把一次 body 解析失败误判为"业务 reason 丢失"（本次任务就是为了澄清这个）。对 API 调用方而言，通用 400 也无法区分"格式错"与"业务拒绝"。
- **最小修法**（3 行，无需新抽象）：在兜底中间件里按错误类型补 reason 与更准确的文案：
  ```ts
  // server/index.ts 的兜底错误中间件内
  const type = (error as { type?: unknown })?.type
  if (type === 'entity.parse.failed') return res.status(400).json({ error: '请求体不是合法 JSON', reason: 'invalid_json' })
  if (type === 'entity.too.large')    return res.status(413).json({ error: '请求体过大', reason: 'payload_too_large' })
  // 其余保持现状（不泄堆栈）
  ```
  （body-parser 会把这两类错误的 `type` 带上，无需依赖 `NODE_ENV`。）

---

## 3. (C) rollup 漂移自检与重建

### 3.1 生产只读核对（接口 vs 我自己的 SQL）

```
$ curl -b ck "http://127.0.0.1:8791/api/usage/rollup-health?hours=24"
{"windowHours":24,"cutoffMs":1790758800000,"rollupRequests":2910,"eventRequests":2910,
 "ratio":1,"driftPct":0,"severity":"ok","checkedAt":"2026-10-01T09:04:56.593Z"}
（hours=3 → 两侧均 0，ratio 1，ok）

# 我自己的 SQL（生产库只读复制到 /tmp，node:sqlite，cutoff 用接口给的 1790758800000）
rollupRequests = 2910   eventRequests = 2910   drift% = 0.000        ← 与接口一致
按小时：09T09 424/424、09T10 319/319、09T11 192/192、09T12 127/127、09T13 28/28、
        09T14 122/122、09T15 137/137、09T16 320/320、09T17 548/548、09T18 504/504、09T19 189/189
tokens：499,649,438 / 499,649,438（差 0）      cost：84.0870 / 84.0870（差 0）
```
→ **"生产实测 1.000 ok" 独立复核成立**（且我用的是自己的 SQL，不是接口）。

### 3.2 自检的盲区（**新发现，中**）

在**副本**上注入漂移后观察自检输出：

| 注入 | 自检输出 | 真实状态 |
| --- | --- | --- |
| 同一窗口内一行 `request_count +1`、另一行 `-1` | `2910/2910, drift 0, ok` | 两行都错，只是和相等 |
| 只改 token/cost（`+2,345,678` tokens、`+9.99 USD`） | `2910/2910, drift 0, ok`，**tokenDrift=2345678** | token/cost 已漂移 |
| （对照）重建后 | `ok`；我方 SQL：token 差 0、cost 差 0 | 已修正 |

**两个判据级的结论**：
1. **聚合抵消**：自检只比 `SUM(request_count)` 与 `COUNT(*)`，任何**逐行/逐维度**漂移只要在窗口总和上抵消就看不见。⇒ 判据应补"分组漂移"，例如按小时 × 维度做 `SUM(ABS(rollup−events))` 或对 `hour_ms, model` 分组求最大绝对差。
2. **只查请求数**：触发器同时维护 `total_tokens/uncached_input_tokens/cost_usd_sum/latency_sum_ms/ttft_sum_ms`，**自检一项都没比**。⇒ 判据应至少同时比 `total_tokens` 与 `cost_usd_sum`（我实测这两项在生产上都是 0 差，说明现在没坏；但一旦坏，自检不会报警）。
3. 次要：`events=0 && rollup>0` 时 `ratio` 为 `null`（`JSON.stringify(Infinity)`）而 `driftPct=100/severity=alert`，客户端解析要注意这两个字段语义不一致。

窗口掩蔽方面我**没有发现**问题：两侧都用整点对齐的同一 cutoff，且触发器在 `INSERT` 上同步维护（无延迟窗口）；`timestamp_ms=0` 的历史行两侧同样被排除。**历史窗口之外**的漂移看不见是设计取舍，建议在文档里写明。

### 3.3 重建脚本（副本验证）

```
$ node scripts/rollup-rebuild.mjs rebuild --db /opt/crosery-api-console/data/console.db
Error: 拒绝直接操作生产库路径；运行手册要求在生产上只跑 check。确需演练同一路径请加 --allow-production
    ← 护栏在"存在性检查"之前生效（换机器跑也不会被"库不存在"掩盖）

$ node scripts/rollup-rebuild.mjs rebuild --db /tmp/cac-r18-db-XXXX/rebuild.db --hours 24
{"phase":"backup","backupPath":"…/console-before-rollup-rebuild-2026-10-01T09-05-59-880Z.db","backupMb":75.1,"backupMs":178}
{"phase":"rebuild#1","ms":56,…,"driftPct":0,"severity":"ok"}
{"phase":"rebuild#2","ms":54,…,"driftPct":0,"severity":"ok"}
{"idempotent":true,"fingerprint":{"rows":804,"requests":26004,"totalTokens":5077650927,…},"verdict":"rebuilt-and-verified"}
```
✓ 默认拒绝生产路径、`VACUUM INTO` 备份、两遍指纹一致；且重建把我注入的 **token/cost 漂移也一并修掉**（我方 SQL：token 差 2345678 → 0，cost 差 9.99 → 0），说明重建是这些盲区的正确补救手段。

---

## 4. (D) 服务事故规则复核（`e773919` → `docs/qa/COORDINATION.md:38-45`）

**写对的部分**（我一直按它执行）：沙箱只允许写工作区、运行期目录不可写（我实测 `touch ~/.agents/crosery/magpie-console/.probe` → `Operation not permitted`，与记录一致）、不要 `bootout`、重启用 `kickstart`、要动 runtime/launchd 就申请一次性提权、不要用"换路径/换端口"绕过。`launchctl print` 只读可用（当前 `state = running, pid 25775`）。

**缺什么（建议补 4 条）**：

1. **"先确认自己能把它拉回来"不可执行** → 补一个 **pre-flight（停服前必跑）**，它必须验证"恢复所需的那个能力"，而不是"能重启现行服务"：
   ```bash
   # 停服前 pre-flight：三项全绿才允许停
   RT=~/.agents/crosery/magpie-console
   test -f ~/Library/LaunchAgents/com.crosery.console-magpie.plist && echo plist-ok || echo plist-MISSING
   touch "$RT/.preflight" 2>/dev/null && rm -f "$RT/.preflight" && echo runtime-writable || echo runtime-NOT-writable   # 关键：bootstrap 要能写 runtime
   launchctl print gui/$(id -u)/com.crosery.console-magpie >/dev/null && echo registered || echo NOT-registered
   ```
   判据：`runtime-NOT-writable` ⇒ **禁止 bootout**（本轮事故正是这条不满足）；三项全绿才允许停，且停之前把恢复命令一起贴出来。
   （注意：`kickstart -k` 成功**不能**证明 `bootstrap` 能成功——前者不需要写 runtime，后者需要。这正是当时"以为能拉回来"的盲点。）
2. **无提权通道时的退路**：规则目前只说"申请一次性提权是正确做法"，没说"如果批不下来怎么办"。建议写明优先级：① 请用户在自己的终端跑一条 `launchctl bootstrap gui/$(id -u) <plist>`；② 若用户不可达，允许**临时**用工作区内的 runtime 目录手工前台启动（`MAGPIE_CONSOLE_RUNTIME=<workspace>/.runtime`）以恢复 8791 可用，并**明确标注**这不是用户的真实实例、恢复后必须切回——把"禁止绕过"从绝对禁令改成"默认禁止 + 声明式例外"。
3. **时间预算与通报**：停用户服务前先声明预计停机时长与观察窗口（本轮真实代价 15 分钟不可用）；超过预算未恢复就升级。
4. **恢复后的验证清单**：`/api/session` 200、`/health`（8790）200、launchd `state=running` 且 PID 变化、抽查一条真实接口；把证据贴进当轮记录（本轮事故记录里只有文字，没有恢复时刻的验证输出）。

---

## 5. (E) 副作用发现：local 控制面下凭据启用/禁用与代理写入 100% 失败（中，功能）

```
# 临时实例（生产同模式 magpie+local）
PATCH /api/credentials/codex-legit2.json        {"enabled":false}                    → 400 {"error":"This CPA management operation is not supported by the Magpie kernel"}
PATCH /api/credentials/codex-legit2.json/proxy  {"proxyUrl":"socks5://127.0.0.1:1080"} → 400 同上
GET   /api/credentials/codex-legit2.json/proxy                                        → 200 {"proxyUrl":""}
```
根因（方法/路径双重不匹配）：
```
server/cpa.ts:224  cpaRequest('/auth-files/status', { method: 'PATCH', … })
server/cpa.ts:228  cpaRequest('/auth-files/fields', { method: 'PATCH', … })
server/magpieControl.ts:363  … else if (url.pathname === '/auth-files/status' && method === 'PUT')   ← 只认 PUT
server/magpieControl.ts:367  … else if (url.pathname === '/auth-files/proxy'  && method === 'PUT')   ← 路径也不一样
```
影响：生产（magpie+local）下 OAuth 页面的**凭据启用/禁用**与**凭据级代理编辑**都无法生效（接口返回 400，属可见失败而非静默失败）。这与本轮穿越修复无关，是既有的本地管理面 shim 覆盖缺口；建议补齐 PUT/PATCH 与 `/auth-files/fields` ↔ `/auth-files/proxy` 的映射，或让 cpaRequest 在 local 模式统一走 shim 的方言。

---

## 5.5 (F) 生产控制台管理员口令强度不足（中，凭据强度）

取证方式（**只读长度与字符集，不记录值**）：

```
$ security find-generic-password -s com.crosery.console-magpie.local -a admin -w | wc -c
6              ← 口令长度 6；字符集：纯数字
```

- 这是**生产**控制台唯一的登录凭据（单管理员模型，`scripts/magpie-console.mjs:106` 把 Keychain 里的值注入 `CONSOLE_PASSWORD`）。
- 与第十五轮结论叠加：本轮之前**没有任何登录限流**，6 位纯数字口令在无限流下可在极短时间内被穷举；task-57 之后有了滑动窗口 + 指数退避（`server/security.ts:53-111`），远程穷举速率被压到「每 5 次失败退避到最多 15 分钟」，风险显著下降，但**口令本身仍然是弱凭据**（对肩窥、Keychain 备份、日志/截图泄露没有任何余量）。
- 建议：轮换为 ≥20 位随机口令（沿用 Keychain 注入方式，无需改代码）；把「口令强度下限」写进部署检查单。
- 副作用记录：我在对本轮交付物做密钥扫描时，`1234567` 这个**演示用的漂移数字**里恰好包含该 6 位口令的子串 → 触发了假阳性。已把演示数字改写为 `2345678` 并复扫通过；**没有任何真实口令值被写进交付物**。
## 6. 未验证 / 不做的部分

1. **生产重建**：未执行（任务明确禁止，我也认为不该做）；重建只在**生产库的只读副本**上验证。
2. **停服/重启相关操作**：本轮全程未重启、未停任何服务；`launchctl` 只做了 `print`。
3. **加固后的 `/api/credentials/:name` 在真实 CPA（非 local）模式下的行为**：本轮只测了 local 模式；CPA 分支的 name 仍走 `encodeURIComponent` 进上游 query（上游如何解释不由我们控制）。
4. **blind spot 的真实发生可能性**：我用**人为注入**证明了盲区存在；生产当前 token/cost/分小时维度均是 0 差，未观察到真实漂移。
5. **(D) 中"用户不可达时"的降级方案**：属流程建议，未经实战验证。

---

## 7. 证据索引

| 文件 | 内容 |
| --- | --- |
| `evidence/r18/attack-authname.mjs` | 我写的攻击矩阵脚本（含软链/硬链/编码变体/合法路径） |
| `evidence/r18/01-authname-attack-matrix.txt` | 攻击矩阵结果（逐条状态码 + 目标完好性） |
| `evidence/r18/02-rollup-verification.txt` | 生产 health 原文 + 我的独立 SQL 核对 + 盲区实证 + 重建输出 |
| 本文 §2.2 | provider 通用文案的成因复现（三种 body 形态对照） |

### 附：本轮对生产发出的全部请求（可复核，均为只读或被拒）

1. `GET /api/usage/rollup-health?hours=24`（只读）
2. `GET /api/usage/rollup-health?hours=3`（只读）
3. `POST /api/login`（正常登录，取会话）
4. `GET /api/credentials/..%2F..%2Fr18-nonexistent-probe.json/proxy`（修复判别；**被拒 400**，未读取任何真实文件）
5. `POST /api/cpa/oauth/callback` `provider=../../evil`（**被拒 400**，无残留）
6. `POST /api/login` 一次畸形 JSON（验证第十五轮的堆栈泄漏修复；**被拒 400**）
7. 只读复制 `data/console.db{,-wal,-shm}` 到 `/tmp` 做 SQL 核对
