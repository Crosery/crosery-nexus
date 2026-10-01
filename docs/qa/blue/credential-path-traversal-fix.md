# 凭据名 / provider 路径穿越修复（task-61，发布前必修）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依据：红队第十七轮「穷举写盘/执行/取路径入口」
证据：`docs/qa/red-team/evidence/write-path/`

与上轮 rollback 同类（同一套修法：**单点收口 + fail closed**）：F1 越界删/读、F2 越界写、F3 硬链接、F4 provider 反射。

---

## 1. 修前复现（我在**真正的修前代码**（HEAD）上跑出来的实际输出）

用生产模式参数起真实例（`GATEWAY_ENGINE=magpie` + `MAGPIE_CONTROL_PLANE=local`，临时 DATA_DIR），
脚本 `/tmp/wp-http-repro.mjs`（每轮跑完清理，只动临时目录）：

```
F1a DELETE /api/credentials/..%2F..%2Fwp-http-canary-38042.txt
    → 200 {"ok":true}
    → DATA_DIR 之外的哨兵还在: false          ← 越界删除成功（与红队 {"ok":true} 一致）

F1b GET /api/credentials/..%2F..%2Fwp-http-probe-38042.json/proxy
    → 200 {"proxyUrl":"http://OUTSIDE-PROXY:7890"}   ← 读到了 DATA_DIR 之外文件的内容

    （更早一次用 provider=../../../../tmp/… 时落盘报错）
    ENOENT: no such file or directory, open '/var/folders/mv/tmp/wp-http-oauth-37695-…json'
    → 恰好证明拼接后的路径确实跑到了 DATA_DIR 之外

F2  POST /api/cpa/oauth/callback（先 oauth/start 拿 state）
    provider=../../wp-http-oauth-38042 → 200 {"ok":true}
    → DATA_DIR 之外落盘: ["wp-http-oauth-38042-1790842594811.json"]   ← 越界写入成功
```

**代码事实**：`magpieControl.ts` 的 `saveLocalAuthFile` / `deleteLocalAuthFile` / `getLocalAuthFile`
直接 `path.join(authFilesDir(), name)`（零校验，`name` 来自 HTTP 参数）；
`cpa.ts:canonicalCPAProvider` 对未知 provider **原样返回**，`magpieOAuth.ts` 的
`norm = (provider || session?.provider || 'oauth')` 直接拼进 `${norm}-${Date.now()}.json` 与
`https://auth.${norm}.com/oauth/token`。

---

## 2. 修法

### 2.1 单点收口：`magpieControl.ts` 的 `authFilePath()`（所有调用方自动受保护）

| 校验器 | 作用 |
| --- | --- |
| `assertAuthFileName(name)` | **单段**白名单：非空、无 `/` `\`、无 NUL、非 `.`/`..`、非绝对路径 |
| `authFilePath(name)` | 形状 → `path.resolve` 前缀比较 → **realpath**（防软链逃逸）→ **`nlink > 1`**（防硬链接绕过 realpath） |

被改造的调用方（**单点**，不再逐个修）：`saveLocalAuthFile`、`deleteLocalAuthFile`、`getLocalAuthFile`、
`setLocalAuthFileStatus`、`setLocalAuthFileProxy`。
**顺序也是安全属性**：`deleteLocalAuthFile` 先校验名字、再碰文件系统（负向验证时发现顺序不对会出现
「先删掉、再抛错」的假拒绝，已改）。

### 2.2 入口校验（纵深）：两个路由 + provider 注册表白名单

| 位置 | 修法 |
| --- | --- |
| `/api/credentials/:name`（PATCH / DELETE / GET proxy / PATCH proxy） | `requireCredentialName()`：`assertAuthFileName` + `authFilePath` 提前跑一遍，非法直接 **400**，`reason` 分别为 `credential_name_invalid` / `credential_path_escape` / `credential_hardlink_rejected` |
| `POST /api/cpa/oauth/callback` 的 `provider` | 走 `isSupportedOAuthProvider()`（与 `startOAuthLogin` **同一份注册表** `OAUTH_PROVIDER_ENDPOINTS`），未知值 **400 `provider_not_supported`**，不再原样返回 |
| `magpieOAuth.startLocalOAuth` / `submitLocalOAuthCallback` | provider 进 URL/文件名之前先过同一张表 → **顺带修掉 F4**（`auth.${norm}.com` 只可能是注册表里的域名） |

### 2.3 F3 硬链接

`authFilePath()` 里 `fs.lstatSync(target).nlink > 1` → 拒绝（`credential_hardlink_rejected`）。
理由：路径确实在目录内、realpath 也看不出来，但它与目录外的文件是同一个 inode；
凭据文件本来就不该有多个链接（我们只用 `writeFileSync` 创建）。
同一条思路在 rollback 侧**未做**（`server/rtkService.ts` 不在本任务写范围）——见 §6 残余 ①。

### 2.4 `/v1` 白名单精确化（task-58 收尾）

`PUBLIC_PATHS` 的 `/^\/v1(\/|$)/` → `/^\/v1\/(?:usage|usage\/requests)$/`（**精确路径集合**），
将来在 `/v1` 下新增接口必须显式加进白名单，否则结构性断言测试会红。

---

## 3. 修后结果（同一脚本、同一实例参数）

```
F1a DELETE …..%2F..%2Fcanary.txt      → 400 {"error":"凭据名不合法或指向 auth-files 目录之外","reason":"credential_name_invalid"}
    → DATA_DIR 之外的哨兵还在: true
F1b GET …..%2F..%2Fprobe.json/proxy   → 400 credential_name_invalid（无任何越界内容）
F2  POST oauth/callback provider=../../evil → 400 {"error":"不支持的 OAuth 提供商：…","reason":"provider_not_supported"}
    → DATA_DIR 之外落盘: []
```

### 3.1 回归用例（三层）

| 文件 | 覆盖 |
| --- | --- |
| `server/magpieControl.test.ts` | 单点契约：越界删除（哨兵仍在且内容未变）、越界读取、绝对路径、**软链**（`credential_path_escape`）、**硬链**（`credential_hardlink_rejected`）、9 种非法形状、**合法名字仍可用**（存/取/删） |
| `server/magpieOAuth.test.ts` | provider 白名单：7 种穿越/非法值在 `startLocalOAuth` 与 `submitLocalOAuthCallback` 都拒绝、DATA_DIR 外无残留、**合法 provider 的本地回调仍落盘**（文件名单段） |
| `server/securityRoutes.test.ts` | **HTTP 端到端**（真子进程 + 生产参数）：越界 DELETE → 400 且哨兵完好；越界 GET → 400 且不返回数据；绝对路径 → 4xx 且不返回 `/etc/hosts`；软链 → 400 `credential_path_escape`；硬链 → 400 `credential_hardlink_rejected`；provider 穿越 → 400 `provider_not_supported` 且 `/tmp` 无残留；**合法 OAuth 全流程 200 且落在 auth-files 内**；合法凭据读取/删除 200 |

### 3.2 语义级负向验证

```
基线 shasum: b0b76bf82d821f0695155842ed06cd2a64b21b1e789f398f90efc255c610e240  server/magpieControl.ts

临时去掉 authFilePath 的内部断言：
  ① 单元用例 → ✖ ℹ pass 0 · fail 1
  ② 模块级复现 → 越界删除/读取重现（DATA_DIR 之外文件被删、越界内容被读出）
还原后：shasum 与基线**逐字节相同** → 用例恢复 ✔
```

另外，把 `magpieControl.ts` / `magpieOAuth.ts` / `cpa.ts` / `index.ts` 四个文件临时切回 **HEAD**，
在同样的生产参数实例上完整复现了 §1 的三条越界读写，然后按备份逐字节还原、shasum 逐一核对一致。

### 3.3 命令退出码

```
npm test run#1 → ℹ tests 666 · pass 665 · fail 0 · skipped 1（20.27s）  exit 0
npm test run#2 → ℹ tests 666 · pass 665 · fail 0 · skipped 1（17.22s）  exit 0
npm run test:magpie → ℹ tests 107 · pass 106 · fail 0 · skipped 1       exit 0
npx tsc -b --pretty false → exit 0
npm run build → ✓ built in 522ms                                        exit 0
npm run lint → 仅既有告警                                              exit 0
```

真实 4 个 agent 配置 sha256 **不变**（`.codex/hooks.json d234642427dd4c2e`、`.claude/settings.json c08f957851d68845`、
`.cursor/hooks.json 4734d152efa28ffb`、`.gemini/settings.json 196e2dca8dacab1b`）；所有用例只用 `mktemp` 的 HOME/DATA_DIR。

---

## 4. 对运行实例的抽验：**没能做成，原因如实报告**

任务要求「改完重启 `com.crosery.console-magpie` 并对运行实例抽验」。实际情况：

```
8790/8791 都没有监听（curl → 000）；plist 存在（~/Library/LaunchAgents/com.crosery.console-magpie.plist）
launchctl bootstrap gui/<uid> … → Bootstrap failed: 5: Input/output error
launchctl load -w …             → Load failed: 5: Input/output error
launchctl kickstart -k …        → Could not find service "com.crosery.console-magpie" in domain for user gui: 501
```

即：**服务当前未加载，而我这轮会话的权限范围不允许我把 launchd 服务拉起来**
（本会话是受限子会话，涉及 launchd 域的操作被拒绝；不再重试）。
所以「重启后对**用户那台**实例抽验」这一步**未完成**，需要 Lead 在自己会话里执行。

**替代证据（等价强度，且可复现）**：`server/securityRoutes.test.ts` 与 `/tmp/wp-http-repro.mjs`
都是**真起 `server/index.ts` 子进程**、用**与生产一致的模式参数**（`GATEWAY_ENGINE=magpie` +
`MAGPIE_CONTROL_PLANE=local`）、走**同一批 HTTP 路由**做抽验；服务恢复后 Lead 只需两条命令即可复核：

```sh
launchctl kickstart -k gui/$(id -u)/com.crosery.console-magpie
curl -s -o /dev/null -w '%{http_code}\n' -b <cookie> -X DELETE 'http://127.0.0.1:8791/api/credentials/..%2F..%2Fcanary.txt'   # 期望 400
curl -s -b <cookie> -X POST -H 'content-type: application/json' \
  -d '{"provider":"../../evil","redirectUrl":"https://example.com/cb?code=x","state":"x"}' \
  http://127.0.0.1:8791/api/cpa/oauth/callback                                                                                # 期望 400 provider_not_supported
```

---

## 5. 行为变化（对调用方可见）

1. 越界/非法凭据名：以前是 **200 + 真删/真读**，现在一律 **400** 且带 `reason`。
2. 未知 `provider` 的 OAuth 回调：以前 **200 + 落盘**，现在 **400 `provider_not_supported`**
   （错误文案里列出可选值，与 `oauth/start` 的既有文案一致）。
3. 凭据文件若是**软链**或**硬链**（`nlink > 1`）→ 读写删一律 400（含 `auth-files` 内的合法名字）。
4. `/v1` 白名单从「前缀」收紧为「两条精确路径」：`/v1/usage`、`/v1/usage/requests` 行为不变，
   其余 `/v1/*` 现在需要显式声明（未声明的会落到默认拒绝 → 401）。

---

## 6. 未做 / 残余

1. **rollback 侧的硬链接（F3 的另一半）未改**：`server/rtkService.ts` 不在本任务写范围。
   现状：备份根权限 0700、与 HOME 同 uid，能写备份根的攻击者本就能直接改 HOME，边际收益仅「把外部文件内容读进 HOME」，
   故判断为可接受。**触发条件**：备份根移到 HOME 之外、或多用户共享备份根 → 必须给
   `restoreRtkBackup` 的**源文件**加 `nlink > 1` 检查（一行）。需要的话我可以立即补。
2. **`RTK_HOME` / `DATA_DIR` 等环境变量**仍是运维面输入，不设白名单（与上轮一致）。
3. **TOCTOU**：`authFilePath` 的校验与随后的 `open/unlink` 之间仍有窗口（校验 realpath → 操作）。
   要彻底消除需要 `openat`/`O_NOFOLLOW` 等原子原语，Node 无原生支持（不新增依赖前提下）。
   窗口极小且需要同 uid 并发改链；`nlink` 检查已经把「硬链接」这条常态化路径堵上。
4. **`manager` 侧的 `/auth-files/download?name=` 等管理面入口**：现在同样被单点校验覆盖 ✓，
   但它们的错误会以 `MagpieManagementError(400, code)` 冒泡（HTTP 层文案取决于调用方），
   未逐个改成 400 reason（只有那两个 HTTP 路由做了明确的 reason 映射）。
