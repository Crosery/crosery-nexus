# 写盘 / 执行 / 取路径类入口的穷举排查（红队 A / task-60，第十七轮）

审计者：rtk-auditor · 时点 2026-10-01T07:18–07:35Z（本地 15:18–15:35）
范围：`spawn/exec` 全部调用点、`fs` 写/删/改全部调用点、所有从请求取名字/路径/id 的端点、透传（magpie/CPA 管理面）、`JSON.parse` 用户可控输入处，以及最近三轮新增代码（`security.ts`、默认拒绝守卫、`compression.ts`、`usageReports`、`rtkService` 校验器）
环境：临时实例（`mktemp` HOME/DATA_DIR，端口 8860 / 8862，跑完删除）；生产零写入；真实 agent 配置未触碰
**结论：找到 2 条高危（同一类缺陷的两个新入口）+ 1 条低危残留；上一轮那条 rollback 穿越已独立验证修复。**

---

## 0. 结论摘要

| # | 现象 | 级别 | 状态 |
| --- | --- | --- | --- |
| **F1** | `DELETE /api/credentials/:name` 与 `GET /api/credentials/:name/proxy` 的 `:name` **无校验**直达本地管理面 → `path.join(authFilesDir, name)` → **越界任意文件删除 + 越界 JSON 读取**。生产模式（`GATEWAY_ENGINE=magpie` + `MAGPIE_CONTROL_PLANE=local`）实测成立 | **高** | **新发现** |
| **F2** | `POST /api/cpa/oauth/callback` 的 `provider` 未白名单 → 拼进凭据文件名 → **越界任意文件写入**（内容为控制台生成的 JSON，`type`/`provider` 字段受攻击者影响） | **高** | **新发现** |
| F3 | `assertInsideDir` 的 realpath 校验挡不住**硬链接**：备份目录里放一个指向 HOME 外文件的硬链接 → 回滚把该文件内容复制进 HOME（读原语） | 低 | 残留 |
| F4 | `provider` 被反射进返回的 `authUrl`（`https://auth.${norm}.com/...`）→ 管理员被诱导访问任意 `.com` 子域 | 信息级 | 观察项 |
| — | 上一轮 rollback 穿越（`backupId` + `manifest.rel`）：**4 类绕过 + symlink + manifest 结构校验全部拦住**，合法回滚不误伤 | — | **已验证修复** |
| — | `spawn`/`exec`：全仓库无 `shell: true`，唯一 spawn 的命令名/参数都来自注册表白名单，`RTK_BIN` 不走 PATH；「运维面受信输入」定性**成立**（有权限取证） | — | 未发现 |
| — | `compression.ts`、默认拒绝守卫、`usageReports`、`rtkService` 的 `rel` 校验器覆盖：**未发现新问题**（1 条结构性提示见 §7） | — | 未发现 |

---

## 1. 面 1：`spawn` / `exec` / 环境变量信任边界

### 1.1 调用点（穷举）

```
$ grep -rn "from 'node:child_process'" server/*.ts scripts/*.mjs
server/nginxUnlimitedApplyCli.ts:1   execFile     ← CLI（只被测试与 systemd 单元引用，见 1.3）
server/rtkService.ts:5               execFile, spawn
scripts/*.mjs                        execFileSync/spawn ← 部署脚本，不在 HTTP 面
$ grep -rn "spawn(\|execFile(" server/*.ts | grep -v test
server/rtkService.ts:1707: const child = spawn(bin, ['init', '-g', ...args], {...})
$ grep -rn "shell: true" server/ scripts/     → 空
```

唯一 HTTP 可达的进程执行点：`server/rtkService.ts:1707`。
- `bin` 来自 `findRTKBinary()`（`server/rtkPlane.ts`）：`RTK_BIN`（**存在才用**）或固定绝对路径 `~/.local/bin/rtk`、`~/.cargo/bin/rtk`、`/usr/local/bin/rtk`、`/opt/homebrew/bin/rtk` —— **不做 PATH 查找**，因此 PATH 劫持不成立。
- `args` 来自 `RTK_AGENT_SPECS` 注册表（`initFlags`）+ `--uninstall`；`agent` 参数先过注册表（实测 `agent="codex; touch /tmp/x"`、`agent="$(touch …)"` → `404 unknown_agent`，`plane="kernel; …"` → `400 unknown_plane`，注入产物 0 个）。
- 无 `shell: true` → 参数不会进 shell。

### 1.2 「`RTK_BIN`/`MAGPIE_*` 是运维面受信输入」定性复核（只读取证）

```
$ ls -l ~/Library/LaunchAgents/com.crosery.console-magpie.plist
-rw-------  1 crosery  staff  3734 …            ← 仅属主/root 可写
$ grep -c RTK_BIN ~/Library/LaunchAgents/com.crosery.console-magpie.plist
0                                                ← plist 未设置 RTK_BIN
$ sed -n '91p' scripts/magpie-console.mjs
  const env = Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR']… )   ← 白名单，RTK_BIN 不会被转发
$ ls -ld ~/.agents/crosery/magpie-console ~/.agents/crosery/magpie-console/bin
drwx------ … magpie-console / drwx------ … bin
```

**定性成立**：要改 `RTK_BIN`/`MAGPIE_*`，必须能以管理员身份写 plist 或改启动环境——而那个能力已经等价于「以同一用户执行任意代码」，所以经由控制台的 `RTK_BIN` 不是提权路径。
**前提条件（需运维保持）**：plist 保持 `0600`、runtime 目录保持 `0700`、不要在环境里塞外来 `RTK_BIN`。若 `RTK_BACKUP_DIR` 被指到共享可写目录，F3 的风险会上升（见 §2.4）。

### 1.3 `nginxUnlimitedApplyCli.ts`

`execFile` 只在该 CLI 入口使用；HTTP 面没有任何引用（`grep` 仅命中测试与 systemd 单元文本）→ **未发现**可经请求触发的执行路径。

---

## 2. 面 2：写文件调用点与 `rel` 校验覆盖

### 2.1 穷举（`server/`，非测试）

```
$ grep -rnE "fs\.(writeFileSync|writeFile|appendFileSync|copyFileSync|renameSync|rmSync|unlinkSync|mkdirSync|chmodSync|createWriteStream)" server/*.ts
abLab.ts:175                mkdir(dirname(file))            ← 固定路径（ab 偏好 jsonl）
db.ts:9                     mkdirSync(config.dataDir)       ← env
magpieControl.ts:130-132    tmp+rename（channels 文件）      ← 固定路径 + validateMagpieChannels
magpieControl.ts:149-150    writeFileSync(file)             ← 固定路径（meta/excluded）
magpieControl.ts:203-211    path.join(dir,name) 写/删        ← **F1（无校验）**
modelCatalog.ts:410-414     tmp+rename（缓存）               ← 固定路径
nginxUnlimitedApply/Policy  nginx 配置文件                  ← CLI/部署面，非 HTTP
rtkService.ts:451/500-514   lock/temp 文件                   ← 内部名
rtkService.ts:808-817       createRtkBackup                 ← id 内部生成、rel 过校验（见 2.2）
rtkService.ts:926/939/962   prune/list                       ← 名来自 readdir
rtkService.ts:1036-1039     restore 提交                    ← 计划化校验后写入（见 2.2）
rtkService.ts:1270/1481     atomic write / rmSync           ← homeRelPath（见 2.2）
rtkService.ts:1663/1812-1813/1869  bak/目录/回填            ← homeRelPath 或注册表
```

### 2.2 `homeRelPath`/`assertInsideDir` 覆盖度独立复核

`assertRelShape`（非空/相对/无 NUL/无空段·`.`·`..`/无反斜杠）+ `assertInsideDir`（resolve 包含性 + 对最近存在祖先做 realpath）调用点：
`811,812,989,1023,1027,1028,1056,1057,1448,1611,1661,1779,1784,1795,1812,1868`。

独立枚举剩余 `path.join(root|dir|home, X)`：`X` 全部来自 `fs.readdirSync`（868/878/884/896/926/939/962）、内部生成的 id（807）或注册表 `spec.dir`（1813）→ **未找到漏网的 `rel` 消费点**，蓝队「10 处」的说法与我的枚举一致（我数到 16 个校验调用点，覆盖更宽）。

### 2.3 修复验证：rollback 穿越（commit `1084b88`）——4 类绕过全部被拦

| 绕过尝试 | 结果 |
| --- | --- |
| `backupId` = `../evil` / `../../etc` / `/etc` / `..` / `.` / `a/../b` / `2026-…Z/../../evil` | 全部 `400 backup_id_invalid`（正则 + 无 `/`·`\`·`..`） |
| 备份根内 symlink 指向根外（蓝队自报的那类） | `400 backup_path_escape`（realpath 判包含），canary 未被删 |
| `manifest.rel` 经 home 内 symlink 逃逸到 `/tmp` | `400 manifest_rel_outside_home`，目标文件未被写 |
| 备份侧 source 是 symlink（→ `/etc/passwd`） | `400 backup_path_escape`，未写入 home |
| `manifest.id` 与请求不一致 / `manifest.home` 不匹配 | 均 `400 manifest_invalid` |
| **合法回滚**（id/home/rel 全匹配） | `200 {"ok":true,"restored":[".claude/settings.json"]}`，内容按备份恢复；未带 `confirm` → `403` |

### 2.4 F3（低）：硬链接绕过 realpath

```
$ ln /tmp/cac-wp-XXXX/secret.txt  /tmp/cac-wp-XXXX/backups/2026-…-006Z/leaked.txt
$ curl -b ck.txt -X POST /api/rtk/rollback -d '{"backup":"2026-10-01T00-00-00-006Z","confirm":true}'   → 200
$ cat /tmp/cac-wp-XXXX/home/leaked.txt
SECRET-OUTSIDE-HOME          ← HOME 之外的文件内容被复制进 HOME
```
原因：硬链接的 `realpath` 就是它自身，因此 `assertInsideDir` 判不出越界。
**触发条件**：攻击者能往备份根写文件（默认备份根 `~/.agents/…/backups` 为 `0700`、位于管理员 home 内 → 需同用户；若 `RTK_BACKUP_DIR` 指向共享/可写目录则任何能写该目录的人都能用）。
**修法建议**：`fs.lstatSync(source).nlink > 1` 时拒绝；或要求 source 的 `ino` 在本次备份创建时记录过（manifest 里存 ino/size/hash 更稳）。

---

## 3. 面 3：从请求取「名字/路径/id」的端点（三段式）

| 入口 | 取值 | 校验 | 去向 | 判定 |
| --- | --- | --- | --- | --- |
| `POST /api/rtk/rollback` | `body.backup` | `BACKUP_ID_PATTERN` + `assertInsideDir(root,id)` + manifest 全量结构校验（id/home/rel/existed） | `fs.copyFileSync` / `fs.rmSync`（plan-then-commit） | ✓ 已修 |
| `POST /api/rtk/toggle` | `body.agent` / `body.plane` | 注册表白名单（`unknown_agent` 404 / `unknown_plane` 400） | `spawn(bin, [init,-g,…])` | ✓ |
| **`DELETE /api/credentials/:name`** | **`params.name`** | **无** | `deleteLocalAuthFile` → `path.join(authFilesDir,name)` + `fs.unlinkSync` | ✗ **F1 任意删除** |
| **`GET /api/credentials/:name/proxy`** | **`params.name`** | **无** | `getLocalAuthFile` → `path.join(dir,name)` + `readFileSync`（返回其中 `proxy_url`） | ✗ **F1 越界读取** |
| `PATCH /api/credentials/:name` | `params.name` + `body.enabled` | 无（name 只作 JSON 键） | `setLocalAuthFileStatus` → 写 meta JSON | 低（键污染） |
| `PATCH /api/credentials/:name/proxy` | `body.proxyUrl` | `normalizeProxyUrl`（http/https/socks5 或 direct） | 存 meta（**非路径**） | ✓ |
| **`POST /api/cpa/oauth/callback`** | **`body.provider`** | `canonicalCPAProvider` 只做 lower/trim（未知原样） | `saveLocalAuthFile(\`${norm}-${Date.now()}.json\`)` → `path.join(dir,name)` + 写入 | ✗ **F2 任意写入** |
| `POST /api/cpa/oauth/start` | `body.provider` | 无白名单 | 拼 `https://auth.${norm}.com/oauth/authorize`（返回给前端，不 fetch） | F4 反射 |
| `POST /api/cpa/oauth/callback` | `body.redirectUrl` | `new URL()` 解析 + 取 `code`/`state` | 不 fetch，仅解析 | ✓ |
| `POST /api/cpa/credentials/api-key` | `body.provider`/`apiKey` | provider → `canonicalCPAProvider`；key 走上游 body | 上游 HTTP | ✓ |
| `/api/keys/:id`（GET/PATCH/DELETE/reveal/quota） | `params.id` | 参数化 SQL（`?`） | SQLite | ✓ |
| `/api/channels/:name`、`/:name/models/:model` | `params.*` | 注册表/SQL 参数 | SQLite / 上游 | ✓ |
| `/api/model-index/:model/sources/:channel` | `params.*` | SQL 参数 | SQLite | ✓ |
| `POST /api/ab/preference` | `body.flow`/`choice`/`note`/`id` | flow 白名单、choice 白名单、note ≤500 字 | **jsonl 内容**（非路径） | ✓ |
| `/api/accounts/:authIndex/reset-*` | `params.authIndex` | 查本地 auth-files 元数据后使用 | 上游 HTTP | ✓ |
| 查询参数 `days/limit/hours` 等 | `req.query.*` | `boundedInteger` 夹取 | SQL 参数 | ✓ |

### F1 复现（高）

```
# 环境：临时实例 8862，GATEWAY_ENGINE=magpie MAGPIE_CONTROL_PLANE=local（= 生产启动器同一模式）
$ echo CANARY-CONTENT > /tmp/cac-wp-XXXX/canary.txt                 # DATA_DIR 之外
$ curl -b ck2.txt -X DELETE "http://127.0.0.1:8862/api/credentials/..%2F..%2Fcanary.txt"
{"ok":true} [200]        → 删除后 canary 存在: NO（已被越界删除）

$ printf '{"proxy_url":"READ-CANARY-VALUE"}' > /tmp/cac-wp-XXXX/probe.json
$ curl -b ck2.txt "http://127.0.0.1:8862/api/credentials/..%2F..%2Fprobe.json/proxy"
{"proxyUrl":"READ-CANARY-VALUE"} [200]        → 越界读取成功
```

调用链（每一跳都是我们自己的代码）：
`index.ts:1042 DELETE /api/credentials/:name` → `removeCredential(name)` → `cpa.ts:219 deleteAuthFile(name)` →
`cpaRequest(\`/auth-files?name=${encodeURIComponent(name)}\`, DELETE)` →
`cpa.ts:56-59`（magpie + local）→ `magpieManagementRequest()` → `magpieControl.ts:287-291 /auth-files DELETE` →
`deleteLocalAuthFile(name)` → **`magpieControl.ts:202-205 path.join(authFilesDir(), name)` + `fs.unlinkSync`**（无校验）。
读取路径同理：`/api/credentials/:name/proxy` → `/auth-files/download` → `getLocalAuthFile(name)`（`magpieControl.ts:231-238`）。

> 上一轮我把 `getLocalAuthFile` 判为"不可达"是**错的**：我只查了 `magpieManagementRequest` 的直接调用者，漏了 `cpaRequest()` 的 local 分支这条链路（`server/cpa.ts:56-59`）。本轮的教训写进 §8。

**修法建议**：在 `magpieControl.ts` 的入口处统一校验 name（`path.basename(name) === name && !name.includes('..') && !name.includes('\0')`，或复用 `assertRelShape`），并且在 `cpaRequest` 的 local 分支上对 `/auth-files*` 的路由参数做同样校验；同时给 `saveLocalAuthFile`/`deleteLocalAuthFile`/`getLocalAuthFile` 加一层"必须落在 authFilesDir 内"的断言（与 `assertInsideDir` 同款）。

### F2 复现（高）

```
$ curl -b ck2.txt -X POST http://127.0.0.1:8862/api/cpa/oauth/callback -H 'Content-Type: application/json' \
    -d '{"provider":"../../../../tmp/wp-oauth-canary","redirectUrl":"https://example.com/cb?code=abc123","state":"x"}'
{"ok":true} [200]
$ ls -l /tmp/wp-oauth-canary-*
-rw------- 1 crosery wheel 393 … /tmp/wp-oauth-canary-1790839394428.json      ← 落在 DATA_DIR 之外
（对照：provider=codex → DATA_DIR/auth-files/codex-<ts>.json）
```

调用链：`index.ts:1114 POST /api/cpa/oauth/callback` → `submitOAuthCallback(provider,…)` →
`canonicalCPAProvider(provider)`（未知值**原样返回**）→ `magpieOAuth.ts submitLocalOAuthCallback` →
`norm = provider.toLowerCase().trim()` → **`magpieOAuth.ts:186 const filename = \`${norm}-${Date.now()}.json\``** →
`magpieControl.ts:201-206 saveLocalAuthFile(filename, …)` → `path.join(dir,name)` + `fs.writeFileSync`（无校验）。

内容受控程度：写入的是控制台生成的凭据 JSON（`type`/`provider` = 攻击者字符串，token 随机），因此这是**任意路径写入 + 部分内容可控**（例如在 `~/Library/LaunchAgents/` 放文件需要 `.plist` 后缀与内容可控性，攻击者只能写 `.json` 结尾的本内容 → 直接 RCE 链不完整，但**越界写 + 覆盖同名文件**已经足够破坏/投毒）。
**修法建议**：`norm` 必须过 provider 白名单（与 `canonicalCPAProvider` 合并成"未知即拒绝"），并且 `saveLocalAuthFile` 内部断言落在 authFilesDir 内。

---

## 4. 面 4：透传端点 / SSRF

- `cpaRequest`（`server/cpa.ts:55-70`）：URL = `config.cpaBaseUrl`（env，运维面）+ **代码常量 path**；本仓库所有调用点的 path 都是字面量，只有 `name` 进 query（已 `encodeURIComponent`）。**未发现请求可影响主机名/协议**。
- local 分支 `magpieManagementRequest`：`new URL(route,'http://local')` —— 主机名固定为 `local`，攻击者无法借它打内网；但**路由参数（name）没校验** → 就是 F1（问题不在 URL，而在它把参数当路径用）。
- 接受 URL/主机名的端点只有「凭据级代理」：`PATCH /api/credentials/:name/proxy`（`normalizeProxyUrl` 限定 http/https/socks5）与全局代理设置。它们把代理地址写进网关配置，**管理员可借此让网关走内网代理**——这是产品能力（需要管理员会话），记为设计取舍而非漏洞。
- `/api/cpa/oauth/callback` 的 `redirectUrl`：只解析、不 fetch（`magpieOAuth.ts` 全文无 `fetch(`）。**未发现 SSRF**。
- `authUrl` 反射：见 F4。

---

## 5. 面 5：反序列化

| 位置 | 输入来源 | 解析后校验 | 判定 |
| --- | --- | --- | --- |
| `rtkService.ts:999-1030` manifest | **文件（可被本地攻击者布置）** | 对象类型、`id` 匹配、`home` 匹配、`files` 非空数组、每项 `rel:string`+`existed:boolean`、rel 形状 + 落在 home 内 | ✓ 已修（上一轮的洞正是"解析后不校验"） |
| `credentialUpload.ts:118` 上传凭据 | **请求（压缩包内文件）** | 必须为对象、`assertTrustedCredential`、条目数/大小上限、重名拒绝 | ✓ |
| `magpieControl.ts:280/314` channels / excluded-models | 请求（管理面 PUT） | `validateMagpieChannels` / `writeExcludedModels` | ✓ |
| `magpieControl.ts:297/301/326` auth-files status/fields、oauth-callback | 请求 | 结构断言为 `{name, disabled}` 等 → **但 `name`/`provider` 未做路径/白名单校验** | ✗ 见 F1/F2 |
| `index.ts:737/813/821/831`、`magpieEngine.ts:103/126/158`、`claudeQuotaCache.ts:51` | **上游/内核响应** | try/catch + 字段级判断（`typeof`/`Array.isArray`），失败即报错 | ✓ |
| `cpa.ts:510/518` 包元数据 | 磁盘上的包文件 | 只取版本号 | ✓ |
| `channels.ts/channelView.ts/index.ts:198 parseJson` | DB JSON 列 | `try/catch` + fallback | ✓ |

**结论**：除 F1/F2 的"参数字符串直接进路径"外，**未发现新的"解析后即信任"结构问题**。

---

## 6. 新代码（最近三轮）专项

| 模块 | 检查 | 判定 |
| --- | --- | --- |
| `server/security.ts`（137 行） | 只做 Cookie `Secure` 推导、登录限流（滑动窗口 + 指数退避 + `MAX_KEYS=10000` 上限）、通用错误体；**不含任何路径/文件操作** | ✓ 未发现 |
| `server/auth.ts` 默认拒绝（`PUBLIC_PATHS`/`createSessionGuard`） | 5 条白名单全部带锚点；守卫顺序「白名单 → 会话 → `/api` 前缀 → 已注册路由 → 放行静态/SPA」；**复跑 59 条路由矩阵：57×401 + `/api/session` 200 + `/api/logout` 200**，与改造前一致 | ✓（1 条结构性提示见下） |
| `server/compression.ts`（223 行） | `decodeURIComponent` 后 `path.resolve(resolvedRoot, '.'+urlPath)`，并做 `startsWith(resolvedRoot+sep)` 包含性检查；NUL 拒绝；扩展名白名单；不满足则 `next()`。**无写盘** | ✓ 未发现穿越 |
| `server/usageReports.ts` | `grep writeFile\|createWriteStream\|mkdir` → 空（纯读 + 内存聚合） | ✓ |
| `server/rtkService.ts` 校验器 | 见 §2.2：`assertRelShape`/`assertInsideDir`/`homeRelPath` 覆盖到位；`realPathOf` 对不存在路径会回溯到最近存在的祖先（这点是对的），但硬链接绕过（F3） | F3 |

**结构性提示（信息级）**：`PUBLIC_PATHS` 里 `/^\/v1(\/|$)/` 是**前缀级**白名单——将来若新增 `/v1/anything` 路由会**默认公开**；另外 `matchesRegisteredRoute()` 依赖 Express 内部 `app.router.stack`，Express 大版本升级时该分支可能静默失效（届时 `/api` 前缀规则仍在，风险可控）。建议给 `/v1` 写成精确路径集合，并加一条"新增路由必须显式声明公开/受保护"的断言测试（类似现有那条）。

---

## 7. 未验证 / 不做的部分

1. **F2 的完整利用链**（能否升级为代码执行）：我只验证了"任意路径写入 + 内容部分可控（`.json` 后缀、`type`/`provider` 为攻击者字符串）"；能否写出可被系统执行的文件（如 launchd plist）需要另找内容可控面，**未继续深挖**。
2. **生产实例上的 F1/F2**：**未在生产验证**——两者都是写/删类操作，按约束只在临时实例做。生产的可达性由代码路径 + 生产启动参数（`GATEWAY_ENGINE=magpie`、`MAGPIE_CONTROL_PLANE=local`，`scripts/magpie-console.mjs:106-111`）推定。
3. **硬链接在跨卷/权限受限时的可行性**：F3 中我用的是自己拥有的文件；对 root 拥有的可读文件建立硬链接在 macOS 上受目录权限限制，**未逐案验证**。
4. **`RTK_ALLOW_KERNEL_WRITE`/`RELAY` 打开时的内核/中转站侧写路径**：内核二进制当前没有 RTK seam（前几轮已证），也未对真实中转站发过写请求。

---

## 8. 上一轮结论的更正（自我纠正）

第十五轮报告 §9 写「`getLocalAuthFile(name)` 有 `path.join(dir,name)` 未校验，但其调用方 `magpieManagementRequest` 无任何 HTTP 调用点 → 当前不可达（潜在项）」。**该结论是错的**：漏掉了 `cpaRequest()` 在 magpie+local 模式下会转到 `magpieManagementRequest` 这条链路（`server/cpa.ts:56-59`），
因此它是**生产可达**的，且同时存在删除原语 → 本条升级为本轮 F1（高）。教训：**判断"不可达"时必须从 HTTP 路由出发正向追到底**，而不是只看被调用函数的直接引用者。

---

## 9. 处置建议（按优先级）

| 优先级 | 事项 | 位置 |
| --- | --- | --- |
| **P0** | 凭据 `name` 统一校验（basename/无 `..`/无 NUL），并在 `saveLocalAuthFile`/`deleteLocalAuthFile`/`getLocalAuthFile` 内部加"落在 authFilesDir 内"断言 | `server/magpieControl.ts:201-238` |
| **P0** | OAuth `provider` 白名单化（未知即拒绝），`filename` 不接受自由字符串 | `server/cpa.ts canonicalCPAProvider`、`server/magpieOAuth.ts:186` |
| P1 | 在 local 管理面入口（`magpieManagementRequest`）对 `/auth-files*` 的 `name` 统一校验 | `server/magpieControl.ts:265+` |
| P2 | rollback：拒绝 `nlink>1` 的 source（或在 manifest 记录 ino/hash） | `server/rtkService.ts restoreRtkBackup` |
| P3 | `PUBLIC_PATHS` 的 `/v1` 规则精确化 + 新增路由断言测试；`authUrl` 反射改为白名单 provider 后再拼 | `server/auth.ts:151+`、`server/magpieOAuth.ts:104` |

---

## 10. 证据索引

| 文件 | 内容 |
| --- | --- |
| `evidence/write-path/01-credential-name-traversal.txt` | F1：越界删除 + 越界读取的完整复现与调用链 |
| `evidence/write-path/02-oauth-provider-traversal.txt` | F2：provider → 文件名穿越 → 越界写入 |
| `evidence/write-path/03-hardlink-escape.txt` | F3：硬链接绕过 realpath |
| `evidence/write-path/04-rollback-fix-verification.txt` | rollback 修复的 4 类绕过验证 + 合法回滚不误伤 |
| `evidence/write-path/05-exec-and-trust-boundary.txt` | spawn 调用点 + `RTK_BIN` 信任边界只读取证 |
| `evidence/write-path/06-new-code-and-coverage.txt` | 新代码（compression/默认拒绝/usageReports/校验器）检查记录 |
