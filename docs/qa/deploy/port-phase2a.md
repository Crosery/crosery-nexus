# Phase 2A：生产安全补丁回移报告（task-7）

- **日期**：2026-10-01 ｜ **执行**：deploy-reconciler ｜ **状态**：完成（11 个文件已回移，全部与生产 release 逐字节一致）
- **依据**：[divergence-report.md](<docs/qa/deploy/divergence-report.md>)（Phase 1，task-6）§1.2 / §1.3 / §8.1 的逐文件 diff 与哈希，**按字节复制而非凭印象重写**
- **来源 release**：`/opt/crosery-api-console-current` → `/opt/crosery-api-console-releases/20260928-reset-clears-cooldown`（取其 `MANIFEST.sha256` 作为目标哈希）
- **未触碰**（task-8 范围，禁改）：`server/index.ts`、`server/cpa.ts`、`src/api.ts`、`src/pages/MonitorPage.tsx`

---

## 0. 结论

1. **R1 已消除**：`server/credentialUpload.ts` 已与生产 release **逐字节一致**（`5c9b74b060eb…a35c`），本地运行中的「伪造凭据可把 token / 请求转去任意域名」的未收口版本已被替换（见 §1）。
2. 11 个文件全部 `sha256` 与生产 release 相同（§2），**无一处需要改写**：这 10 个已存在文件在本地都等于两侧共同基线，生产侧补丁是纯增量。
3. **7 个原本全红的测试文件全部转绿**（16 个用例名，§3）：隔离运行 + 完整 `npm test` 两次独立验证。
4. **完整 `npm test` 仍红 2 个文件 / 3 个用例名，全部有明确归因，且都不在 task-7 可写范围内**（§5）：
   - `server/cooldownClear.test.ts`（2 例）——**预期内**：它依赖的 `clearAuthFileCooldown()` 在 `server/cpa.ts`，属 task-8。按 Lead 要求「先落文件」，文件已落且与生产一致。
   - `server/reportRouteWiring.test.ts`（1 例）——**回移前就红，不是本次引入**：该测试断言 `server/index.ts` 的 bootstrap 段不含 `await Promise.all([`（`server/reportRouteWiring.test.ts:71`），而本地 `server/index.ts:420` 正是生产已修掉的那处；修复属于 task-8。**这条是 Phase 1 没发现的第 8 个红测试文件**（Phase 1 只单跑了 7 个 P 类测试文件）。
5. `npm run lint` 通过（仅 2 条既存 warning，在 `server/nativeResponses.ts`，非本次文件）；`npx tsc -b` 本次回移的文件**零错误**（全项目唯一错误在他人未提交的 `src/ab/registry.ts:48`，见 §4）。

---

## 1. R1 单独确认（最高优先级项）

**`server/credentialUpload.ts` 已与生产 release 完全一致。**

| 项 | 值 |
| --- | --- |
| 回移前本地 sha256 | `2be546b3fbb88a19a5fe60ea3b82f42afb07ad3decc640d83d712121c0cfde40`（110 行，09-25 未收口版本） |
| **回移后本地 sha256** | **`5c9b74b060eb79878ed67d4f237bae6231b8fb8475487ec80ae37d9ad7e3a35c`（167 行）** |
| 生产 release sha256 | `5c9b74b060eb79878ed67d4f237bae6231b8fb8475487ec80ae37d9ad7e3a35c` |
| 结论 | **逐字节一致（MATCH）** |

收口内容（来自生产 20260926-fix-failing-tests-upload-guard，`RELEASE.json` 原文：*「恢复凭据导入端点校验（09-25 通用导入删掉后，伪造 xAI/Antigravity 凭据可把 token 与请求转到任意域名）」*）：

- 新增 `assertTrustedCredential()`，在 `prepareCredentialUpload()` 解析后立即调用；
- xAI/Grok：`token_endpoint` / `base_url` 必须是 `https:` 且主机为 `x.ai` 或 `x.ai` 子域（`notx.ai` 这类后缀相似域被拒；`new URL()` 解析失败即拒），并要求 `access_token` + `refresh_token` 同时非空；
- Antigravity：`base_url` 必须是 `googleapis.com` 或子域；
- `auth_kind` 与 provider 类型对不上（拼接过文件）→ 按伪造拒绝。

> 备注：`data/auth-files/` 是否已存在伪造文件**未验证**（未读取真实凭据目录）。本次只是把「接收端校验」补上；如需确认历史影响面，是另一个任务。

---

## 2. 逐文件回移清单（sha256 对照）

来源全部为 `20260928-reset-clears-cooldown` 内的文件（其哈希同时记录在该 release 的 `MANIFEST.sha256`）。`回移后本地` 为工作区实测 `sha256`。

| # | 文件 | 回移前本地 sha256 | 回移后本地 sha256 = 生产 release sha256 | 行数 | 分类 | 引入 release |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `server/credentialUpload.ts` | `2be546b3fbb8…` | `5c9b74b060eb79878ed67d4f237bae6231b8fb8475487ec80ae37d9ad7e3a35c` | 110→167 | P（安全） | 20260926-fix-failing-tests-upload-guard |
| 2 | `server/credentialUpload.test.ts` | `835eb3c2ce12…` | `27d1ea80de2b66db41e575d1c13e644cec0bb5231437f8990c4d1f9ab5362711` | 103→129 | P | 同上 |
| 3 | `server/keyModelAccess.ts` | `b94fe7f4ee0c…` | `a1b08bce500000c551de46bc94d4cfa1ad442cc7b830c1b44ca380a78467ac8a` | 60→83 | P | 20260926-fix-failing-tests-upload-guard |
| 4 | `server/keyModelAccess.test.ts` | `3e020dd32129…` | `d67f09a24f728fc6572c3cd092e54afd2de16f268471147657bd64d2dfb3d614` | 42→65 | P | 同上 |
| 5 | `server/keyChannelAccess.ts` | `b79db39644d9…` | `e13a1c640b01ee9eec90ef1af8367b49dc22301471d012449b296a3e952aa6c4` | 64→69 | P | 20260926-default-open-gpt-image |
| 6 | `server/keyChannelAccess.test.ts` | `3a7575e56877…` | `1aa76dd9ebc6d235555fca0fe9c92abe9157de279bd51d1a3ef4476e37c1723c` | 81→87 | P | 同上 |
| 7 | `server/keyPoolReconcile.test.ts` | `a79ba694ee5c…` | `4b3d3487a6df8def943890a5c8afe467734e08a9b7929f9d2e917cccf8aa9150` | 75→80 | P | 20260926-fix-failing-tests-upload-guard |
| 8 | `server/cacheStats.test.ts` | `62f2ce8f3591…` | `b56f7106b7b2eeec4935c1fcd0139711248877f26318cb03fb23c8c623afed7a` | 108→117 | P | 同上 |
| 9 | `server/liveStream.test.ts` | `4f34c2cf8779…` | `d96bf9c640a07a53dddd858de51fd684c78b00b62904b9816a2fbb1c8f526414` | 281→282 | P | 同上 |
| 10 | `server/modelIndex.test.ts` | `922f9ea9a039…` | `b64d4f9d34828f3ff4280541f36910c4cb09d34e151078b3f49c834b43dbd805` | 92→96 | P | 同上 |
| 11 | `server/cooldownClear.test.ts`（**新增**） | 不存在 | `cb60cff75b395c4cbc0bd1027626161988574557ee6a635b01c2c6362b1cb671` | 0→48 | P-ONLY | 20260928-reset-clears-cooldown |

改动统计（`git diff --stat`，不含新增文件）：**10 files changed, 189 insertions(+), 30 deletions(-)**，另 `?? server/cooldownClear.test.ts`。

**语义要点（用于 task-8 复审）**：

- `keyModelAccess.ts`：新增 `DEFAULT_OPEN_MODEL_PREFIXES = ['gpt-image-']` 与 `defaultOpenModels(groups)`；默认开放项**只取实时分组里真实存在的型号**，取不到时仍回落到 `DENY_ALL_MODEL`（2026-08-20 事故约束）。
- `keyChannelAccess.ts`：`DEFAULT_OPEN_CHANNELS` 由 `['claude']` 改为 `['claude', 'codex']`（注释写明「刻意写死、不按 gpt-image 反推渠道」，避免中转渠道被连带放开）。
- 4 个测试文件的改动是**钉日期 / 钉阶梯价 / 钉默认开放集合**，与上面的行为改动配套；单独回移测试而不回移行为会转红，反之亦然——本次两者一起回移，因此一起转绿。

---

## 3. 测试前后对照（实跑）

命令（每次都在 `/tmp/cac-build.lock` 内串行，`DATA_DIR` 指向临时目录，`HOME` 指向临时目录）：

```bash
for i in $(seq 1 36); do mkdir /tmp/cac-build.lock 2>/dev/null && break || sleep 5; done
DATA_DIR=/tmp/cac-deploy-recon/<phase>-data HOME=/tmp/cac-deploy-recon/fakehome \
  node --test --import tsx server/<name>.test.ts
rmdir /tmp/cac-build.lock
```

| 测试文件 | 回移前 | 回移后 | 回移前失败的用例名（回移后全部通过） |
| --- | --- | --- | --- |
| `server/cacheStats.test.ts` | exit=1，1 例红 | **exit=0，pass=12 / fail=0** | `gpt 缓存段不再重复计费` |
| `server/liveStream.test.ts` | exit=1，1 例红 | **exit=0，pass=19 / fail=0** | `openai 请求的 cached 内含于 input，不重复计费` |
| `server/modelIndex.test.ts` | exit=1，1 例红 | **exit=0，pass=9 / fail=0** | `attaches public per-million pricing to a model even without recorded usage` |
| `server/keyPoolReconcile.test.ts` | exit=1，2 例红 | **exit=0，pass=2 / fail=0** | `并发对账排队后重读授权，旧快照不能在撤权完成后写回 Mox`；`模型权限接口故障不能阻止撤销 Mox 渠道权限` |
| `server/keyModelAccess.test.ts` | exit=1，3 例红 | **exit=0，pass=9 / fail=0** | `duplicate groups do not duplicate models`；`no live groups means deny all instead of legacy unrestricted access`；`only selected live groups contribute models` |
| `server/keyChannelAccess.test.ts` | exit=1，6 例红 | **exit=0，pass=11 / fail=0** | `面板开了 codex 组，渠道白名单就补上 codex`；`分组与网关不一致时以分组为准，多余渠道被收回`；`网关里没有条目的 Key 也要按分组写入，不能留成不限渠道`；`空候选池必须独立拒绝，不能写会被网关归一化为不限渠道的空数组`；`只有明确开启 Mox 的 Key 才能把 Mox 放进候选池`；`已经一致时不产生写操作` |
| `server/credentialUpload.test.ts` | exit=1，2 例红 | **exit=0，pass=10 / fail=0** | `rejects JSON null and xAI lookalike endpoints`；`rejects non-xAI JSON and missing refresh tokens` |
| **合计** | **7 文件红 / 16 用例名** | **7 文件全绿（72 例通过）** | — |
| `server/cooldownClear.test.ts`（新文件） | 不存在 | exit=1，2 例红（**预期，见 §5.1**） | `clearAuthFileCooldown toggles disable_cooling true then false on the same credential`；`the restore patch is not attempted when the clear itself fails` |

「回移前」是把**当时的工作区**（这 10 个文件与 `HEAD` 逐字节相同，`git hash-object` 已核对）实跑得到的结果，不是引用 Phase 1 的隔离副本数据。

---

## 4. lint / typecheck

```bash
npm run lint          # oxlint src server apps packages scripts
npx tsc -b --pretty false
```

- **lint 通过**（exit=0）。输出仅 2 条既存 warning，均在 `server/nativeResponses.ts:200,203`（`no-control-regex`），不是本次回移的文件。
- **tsc**：本次回移的 11 个文件**零错误**。整个项目当前有 **1 个错误**，在**他人未提交的新文件**里：
  `src/ab/registry.ts(48,7): error TS6133: 'currentRtk' is declared but its value is never read.`
  （`src/ab/` 是工作区未跟踪目录，属 blue-ui 在途工作；`npm run build` 目前会因它失败，与本任务无关，未修改。）

---

## 5. 回移后本地测试的**真实**状态（不美化）

完整套件实跑：`DATA_DIR=<tmp> HOME=<tmp> npm test`（`node --test --import tsx server/*.test.ts apps/data/src/*.test.ts packages/contracts/*.test.ts scripts/*.test.mjs`），**exit=1**，顶层 `✔` 508 行、失败用例 3 个（分布在 2 个文件）。

### 5.1 仍红 #1：`server/cooldownClear.test.ts`（2 例，**预期内、属 task-8**）

```
✖ clearAuthFileCooldown toggles disable_cooling true then false on the same credential
✖ the restore patch is not attempted when the clear itself fails
TypeError: clearAuthFileCooldown is not a function
```

- **原因**：该测试 `import('./cpa.ts')` 后解构 `clearAuthFileCooldown`，而该函数定义在 `server/cpa.ts`（生产 20260928 补丁），`server/cpa.ts` 被本任务明令禁改，属 task-8。
- **本任务已完成的**：文件本身已按生产逐字节落盘（sha256 见 §2 #11），task-8 把 `cpa.ts` 的回移做掉后此文件即可转绿。
- **风险登记**：在 task-8 完成前，`npm test` 会**多出一条确定性的红**（原本就红，不是新增回归）。若有人把 `npm test` 当门禁，请以「这 2 例 = task-8 未完成」为准。

### 5.2 仍红 #2：`server/reportRouteWiring.test.ts`（1 例，**回移前就红**）

```
✖ bootstrap keeps local keys and quota states when the control plane fails
AssertionError: The input was expected to not match the regular expression /await Promise\.all\([/
```

- **归因（已验证）**：`server/reportRouteWiring.test.ts:71` 对 `server/index.ts` 的 bootstrap 段做**源码文本断言** `assert.doesNotMatch(segment, /await Promise\.all\(\[/)`，而本地 `server/index.ts:420` 仍是 `const [cpaVer, consoleVer] = await Promise.all([...])`。生产正是用 20260926 的补丁把这段换成 `Promise.allSettled` + `cpaVersionResult`（Phase 1 §2.2 冲突点表已记录）。
- **不是本次引入**：`git archive HEAD` 导出的**纯净 HEAD 副本**（不含任何本次回移）里同一条用例同样失败、同一条断言信息（复现：`cd <HEAD导出> && node --test --import tsx server/reportRouteWiring.test.ts`）。
- **修复归属**：task-8（`server/index.ts`）。这也是 Phase 1 未覆盖到的第 8 个红测试文件——Phase 1 只单跑了 7 个 P 类测试文件，未跑完整套件。
- 结论：**R4（本地测试门禁红）在本任务后从「8 个文件红」收敛到「2 个文件红、3 个用例名，且归因明确、全部指向 task-8」**。

### 5.3 未验证

- 完整套件里的失败**只是这 2 个文件**是本次实跑结论；但工作区同时含其他成员未提交改动（`server/index.ts`、`src/ab/**` 等），所以「完整套件在**纯 HEAD + 本次回移**下是否同样只有这 2 个红」**未验证**（不做 `git stash` 以免动到他人工作）。
- 生产侧对应测试是否通过仍**未验证**（禁止在生产跑测试，会碰 SQLite）。

---

## 6. 未回移项（交接给 task-8）

| 文件 | 分类 | 内容 | 阻塞原因 |
| --- | --- | --- | --- |
| `server/cpa.ts` | C | `setAuthFileCoolingDisabled()` / `clearAuthFileCooldown()`；另含 `api-key-entries` 的 `proxy-url` 收窄 | 与 blue-rtk（task-3）冲突 |
| `server/index.ts` | C | 两个 reset 端点清冷却 + `cooldownCleared`；bootstrap 并发读（**同时修好 §5.2 的红**）；审计标签 | 同上 |
| `src/api.ts` | C | `resetCodexQuota` / `resetClaudeQuota` 返回类型加 `cooldownCleared` | 同上 |
| `src/pages/MonitorPage.tsx` | P | React 版重置提示（本地对应 Vue 侧需另行适配） | 同上 |
| `RELEASE.json` | P（元数据） | 本地的是 20260925 那次 release 的记录 | 发布元数据，随新 release 重新生成 |
| `build/packages/contracts/index.js{,.map}` | P-ONLY（生成物） | 生产 20260901 起未变的编译产物 | 不回移，由 `npm run build` 重新产出 |

---

## 7. 生产侧动作（仅删除我自曝的遗留物）

Lead 已授权清理。过程与结果（全部记录在案）：

```
$ ssh -o ControlMaster=no -o ControlPath=none cpa-vps \
    'ls -l /tmp/prod-files.txt; wc -l < /tmp/prod-files.txt; head -2 /tmp/prod-files.txt'
-rw-r--r-- 1 root root 7432 Sep 30 20:26 /tmp/prod-files.txt      # 属主 root、时间戳与本次会话早期一致
246                                                              # 行数与我 Phase 1 生成的 find 清单一致
./.env.example
./.gitignore                                                     # 确认只是路径清单，无生产内容

$ ssh … cpa-vps 'rm -f /tmp/prod-files.txt; ls -l /tmp/prod-files.txt'
ls: cannot access '/tmp/prod-files.txt': No such file or directory

$ ssh … cpa-vps 'readlink -f /opt/crosery-api-console-current; systemctl is-active crosery-api-console.service'
/opt/crosery-api-console-releases/20260928-reset-clears-cooldown
active                                                           # symlink 与服务均未受影响
```

- 除这一次**经批准的删除**外，本任务对生产**零写入**：未改 symlink、未重启服务、未碰 SQLite/.env、未移动或删除任何其他远端文件。
- 删除前未读取该文件以外的任何生产文件内容；`rm -f` 的目标是绝对路径 `/tmp/prod-files.txt`，已先经 `ls -l` 确认存在、属主 root、行数与内容特征与我创建的一致。

---

## 8. 复现命令

```bash
# 1) 取生产对应文件（只读，写本地 /tmp）
ssh -o ControlMaster=no -o ControlPath=none cpa-vps \
  'cd /opt/crosery-api-console-current && tar -cf - server/credentialUpload.ts server/credentialUpload.test.ts \
   server/keyModelAccess.ts server/keyModelAccess.test.ts server/keyChannelAccess.ts server/keyChannelAccess.test.ts \
   server/keyPoolReconcile.test.ts server/cacheStats.test.ts server/liveStream.test.ts server/modelIndex.test.ts \
   server/cooldownClear.test.ts' | tar -xf - -C /tmp/port-src

# 2) 校验每个文件与生产 MANIFEST 一致（不做任何改写）

# 3) 逐字节回移（本次即用 cp；本地这 10 个文件此前与 HEAD 逐字节相同，已在 §2 前的核对中确认）
cp /tmp/port-src/server/<file> server/<file>

# 4) 回移后对照
shasum -a 256 server/<file>            # 与本报告 §2 的「生产 release sha256」逐一比对

# 5) 测试（串行锁 + 临时 DATA_DIR）
for i in $(seq 1 36); do mkdir /tmp/cac-build.lock 2>/dev/null && break || sleep 5; done
DATA_DIR=/tmp/port-test-data HOME=/tmp/port-test-home npm test
rmdir /tmp/cac-build.lock

# 6) lint / typecheck
npm run lint && npx tsc -b --pretty false
```

**方法声明**：回移采用 `cp`（逐字节复制）而不是手抄重写，理由是本任务的验收标准就是「与生产 release 逐字节一致」，手抄会引入转录风险。回移前已用 `git hash-object` 逐个确认这 10 个文件与 `HEAD` 相同（无他人未提交改动），因此不存在覆盖他人工作的风险。

**提交状态**：改动目前**留在工作区、未提交**（`git status` 见 §2 末尾）。是否由我打一个本地 Conventional Commit（例如 `fix(server): port release 20260928 security and access patches`）请 Lead 指示；在此之前不动 git 历史，避免与其他成员的在途改动纠缠。

---

## 9. 锁使用记录

`/tmp/cac-build.lock` 共取用 4 次，每次命令结束都 `rmdir` 释放：
1. 回移前测试（7 个文件）；
2. `npx tsc -b`；
3. 回移后测试（7 个文件 + `cooldownClear.test.ts`）；
4. 完整 `npm test`。

`npm run lint` 按 COORDINATION.md 属可并发命令，未取锁。测试的 `DATA_DIR` 全部指向 `/tmp/cac-deploy-recon/*`，跑完后目录为空——**未创建、未写入仓库内 `data/`**。
