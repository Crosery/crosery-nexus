# rollback 路径穿越修复（task-56，发布前必修）

日期：2026-10-01 · 蓝队 A（blue-rtk） · 依据：红队第十五轮控制台 HTTP 安全面审计
证据：`docs/qa/red-team/evidence/security/04-traversal-rollback.txt`

---

## 1. 漏洞：`POST /api/rtk/rollback` 两侧路径都无校验

**代码事实**（修复前）：

| 位置 | 问题 |
| --- | --- |
| `BACKUP_ID_PATTERN` | **已定义，但只在 `listRtkBackups()` 里当「recognized」标记用**，没有任何校验入口 |
| `restoreRtkBackup()` | `const dir = path.join(root, id)` —— `id` 来自请求体，**直接拼接** |
| 同函数 | `const target = path.join(home, file.rel)` —— `rel` 来自备份目录里的 `manifest.json`，**直接拼接** |

### 1.1 修前复现（我这边跑出来的实际输出）

```
① backup="../../etc"                     → 拒绝 status=404 reason=backup_not_found（只做了存在性判断）
② backup="../evil" + manifest {"files":[{"rel":"pwned-canary.txt","existed":false}]}
                                         → 返回 {"id":"../evil","restored":["pwned-canary.txt"]}
                                         → canary 是否仍在: false          ← 越界删除成功
③ backup="../escape" + manifest {"files":[{"rel":"../cac-sec-write-canary.txt","existed":true}]}
                                         → 返回 {"id":"../escape","restored":["../cac-sec-write-canary.txt"]}
                                         → home 之外的文件被创建: true
                                           内容="ARBITRARY-WRITE-PROOF\n"  ← 任意写成功
④ 备份根内 symlink `2026-…-abcdef` → 根外目录 + manifest
                                         → 返回 {"id":"2026-…-abcdef","restored":["pwned-canary.txt"]}
                                         → canary 是否仍在: false          ← 软链接逃逸成功
```

复现脚本：`/tmp/traversal-repro.mjs`（只用临时 `RTK_HOME`/`RTK_BACKUP_DIR`，跑完删除）。

---

## 2. 修法：单点路径校验器 + fail closed

在 `server/rtkService.ts` 新增「路径收口」段（三个导出函数，**一处实现**）：

| 校验器 | 作用 |
| --- | --- |
| `assertRelShape(rel, reason)` | 形状白名单：非空、**相对**、无 NUL、无空段 / `.` / `..`、无反斜杠 |
| `assertInsideDir(parent, child, reason, what)` | 解析后必须落在允许目录内；**并对「最近的已存在祖先」做 `realpath`**，防软链接逃逸（已存在的文件/目录被换成指向外部的软链） |
| `homeRelPath(home, rel, reason)` | `home` 下的 rel → 绝对路径；**所有消费 rel 的地方都必须走它** |

### 2.1 `restoreRtkBackup()`：先全量校验出「计划」，再动手（fail closed）

1. **backupId**：`BACKUP_ID_PATTERN` 白名单 + 不得含 `/` `\` `..` → 否则 `400 backup_id_invalid`；
   再 `assertInsideDir(备份根, id)` → 越界/软链接逃逸为 `400 backup_path_escape`。
2. **manifest**：必须是合法 JSON 对象；`manifest.id` 必须等于请求的 id；`manifest.home` 必须与当前 home
   指向同一处（先比 `path.resolve`，再比 `realpath`，兼容软链接过的 home）；`files` 必须是非空数组，
   每项必须是 `{ rel: string, existed: boolean }` —— 任一不满足 → `400 manifest_invalid`。
3. **每个 rel**：`assertRelShape`（`..`/绝对路径 → `400 manifest_rel_invalid`）+ `assertInsideDir(home, rel)`
   （含 realpath → `400 manifest_rel_outside_home`）+ 备份侧文件 `assertInsideDir(备份目录, backupFileName(rel))`
   → `400 backup_path_escape`。
4. **只有整个清单都通过后才开始写**：任何一条不合法都整单拒绝，**不存在部分还原**。

### 2.2 同类路径单点收口（不只堵 rollback）

| 位置 | 修前 | 修后 |
| --- | --- | --- |
| `createRtkBackup()` 的 rel | `path.join(home, rel)` | `assertRelShape` + `assertInsideDir`（写清单前就拒绝） |
| `restoreTargetsRaw()` / `preserveUserBaksRaw()` / `reconcileCollateral()` | `path.join(home, rel)` | `homeRelPath(home, rel)` |
| `applyLocalAgentHook()` 的快照 / mkdir / JSON 兜底写入 | `path.join(home, …)` | `homeRelPath(home, …)` |
| `hookFileIntegrity()` / `detectAgentHooks()` | `path.join(home, …)` | `homeRelPath(home, …)` |
| `listRtkBackups()` | 列出**所有**有 manifest 的目录 | 只列 `recognized`（白名单 id）的目录，rogue 目录不会被当成「可用备份」 |

### 2.3 该函数族的**全部**路径输入审计（红队要求「顺手列一遍」）

| # | 输入 | 来源 / 信任级别 | 现在如何处理 |
| --- | --- | --- | --- |
| 1 | `backup`（rollback 请求体） | **不可信** | 白名单 + 归属 + realpath（§2.1①） |
| 2 | `manifest.files[].rel` | **不可信**（备份目录内容可被写入） | 形状 + 归属 + realpath（§2.1③） |
| 3 | `manifest.id` / `manifest.home` | **不可信** | 与请求 id / 当前 home 一致性校验（§2.1②） |
| 4 | `agent`（toggle 请求体） | **不可信** | `rtkAgentSpec(agent)` 注册表查找，未知 agent 直接 400（既有行为，本轮复核） |
| 5 | `plane`（toggle/rollback 请求体） | **不可信** | 与平面集合比对（既有行为，本轮复核） |
| 6 | `rel`（注册表里的 `spec.hookFile` / `extraFiles` / `spec.dir`） | 可信（我们自己的静态注册表） | 仍然过 `homeRelPath`（纵深防御，成本可忽略） |
| 7 | `RTK_HOME` / `RTK_BACKUP_DIR` / `RTK_BIN` | 运维输入（环境变量） | 视为**受信**：控制台不代运维做路径白名单；文档写明这是运维面 |
| 8 | `backupFileName(rel)` 的产物 | 派生 | 归属校验到备份目录内（§2.1③） |
| 9 | 锁文件路径 / 备份根 | 派生（home + env） | `path.resolve` 派生，无外部输入 |
| 10 | `rtk` 二进制调用 | `spawn(bin, ['init','-g',...args])` | **数组形式，无 `shell:true`**（已核对 `grep -c "shell: true"` = 0），args 全部来自注册表；`install/upgrade` 本机路径固定 501 |

**结论**：该函数族里唯二真正不可信且能影响路径的输入就是 #1 与 #2，#3 是配套一致性检查；其余要么受信、要么已收口。
另外 `/api/rtk/rollback` 的 `backup` 只影响「回滚哪一份备份」，**没有**其它入口能到达 `restoreRtkBackup`。

---

## 3. 修后证据

### 3.1 同一复现脚本（四条全部被拒、哨兵完好）

```
① backup="../../etc"                    → 400 backup_id_invalid
② backup="../evil"                      → 400 backup_id_invalid     canary 仍在: true
③ rel="../cac-sec-write-canary.txt"     → 400 backup_id_invalid     home 之外未创建: false
④ 备份根内 symlink → 根外                → 400 backup_path_escape     canary 仍在: true
```

### 3.2 服务端级用例（HTTP，真子进程）

`server/rtkService.test.ts` 新增两条：

- `路径收口单元契约：assertRelShape / assertInsideDir / homeRelPath`（9 组非法输入 → 400 `rel_path_invalid`；软链接逃逸 → `path_escape`/`rel_path_invalid`）。
- `安全：POST /api/rtk/rollback 的路径穿越利用链全部被拒（红队 ①②③ + symlink 变体）`：
  - ① `../../etc` → 400 `backup_id_invalid`；② `../evil` → 400 `backup_id_invalid` **且哨兵文件内容不变**；
  - ③ 形似合法 id + `rel="../…"` → 400 `manifest_rel_invalid` **且 home 之外未创建文件**；
  - ③b **symlink 变体**：`rel='link-out/written.txt'`（形状合法，中间目录是指向 home 之外的软链）→ 400 `manifest_rel_outside_home`，且软链目标目录内未被写入；
  - ③c 备份目录本身是软链 → 400 `backup_path_escape`；
  - ④ manifest 结构类（home 不一致 / id 不一致 / files 为空 / 项类型错）→ 全部 400 `manifest_invalid`，哨兵不变；
  - ⑤ **审计留痕**：`/api/audit` 里存在 `reason=(backup_id_invalid|manifest_invalid|manifest_rel_invalid|manifest_rel_outside_home|backup_path_escape)` 的失败记录；
  - ⑥ 合法备份的 rollback 仍然 200（没把正常路径堵死）。

### 3.3 语义级负向验证（两处校验各自都是「拆掉就红」）

```
基线 shasum: 7bae050843b88b423c71d5e25e8c5cd1aa71168b56020dcb2497e18d73e69305  server/rtkService.ts

① 临时去掉 backupId 白名单+归属校验 → ✖ ℹ pass 0 · fail 1
② 临时去掉 manifest.rel 形状+归属校验 → ✖ ℹ pass 0 · fail 1
还原后：shasum 与基线**逐字节相同**（7bae0508…）→ 用例恢复 ✔
```

### 3.4 重启后现网抽验（必然被拒绝的输入，无副作用）

```
session=200
backup=../../etc          → 400 backup_id_invalid
backup=../evil            → 400 backup_id_invalid
backup=/etc/passwd        → 400 backup_id_invalid
backup=..                 → 400 backup_id_invalid
backup=valid-but-missing  → 400 backup_id_invalid
备份目录数 before=2 after=2（无副作用）
审计：rollback_rtk_hook | ../../etc | outcome=error, status=400, reason=backup_id_invalid（每条都有）
/api/rtk/status → 200（正常路径未被堵死）
```

### 3.5 命令退出码与真实配置自证

```
npm run test:magpie → ℹ tests 105 · pass 104 · fail 0 · skipped 1     exit 0
npm test #1         → ℹ tests 641 · pass 640 · fail 0 · skipped 1（9.66s）  exit 0
npm test #2         → ℹ tests 641 · pass 640 · fail 0 · skipped 1（9.65s）  exit 0
npx tsc -b --pretty false                                            exit 0
npm run build       → ✓ built in 488ms                               exit 0
npm run lint        → 仅既有 nativeResponses.ts:200/203 告警         exit 0
```

真实 6 个 agent 配置 sha256 不变（`d234642427dd4c2e` / `c08f957851d68845` / `4734d152efa28ffb` /
`196e2dca8dacab1b` / `d1555e0af5872a30` / `d1555e0af5872a30`）；所有用例只用临时 `RTK_HOME`/`RTK_BACKUP_DIR`。

---

## 4. 行为变化（对调用方可见）

1. **非法 `backup` 的状态码从 404 变 400**，且 `reason` 从 `backup_not_found` 变为 `backup_id_invalid`
   （形似合法但不存在、且不在白名单的 id 也是 400；白名单内但目录不存在的仍是 404 `backup_not_found`）。
   严格说 404 更"少泄漏"，但白名单本身不是秘密，400 + 明确 reason 更利于排障与告警。
2. **非白名单 id 的目录不再出现在 `status.backups` 里**（`listRtkBackups` 只列 recognized），
   因此手工放进备份根的目录不会被当作「可用备份」。
3. 备份根内**软链接目录**不再可用作备份（`backup_path_escape`）——这是有意的 fail closed。
4. 真实历史备份**仍可正常回滚**（实测：`manifest.id === 目录名`、`manifest.home === ~`、
   `rel` 全部是干净相对路径；既有 `一键回退` / `P0-1` 用例全绿）。

---

## 5. 未做 / 残余（明确登记）

1. **没有把 `rel` 白名单到注册表**（例如只允许 `.codex/hooks.json`、`.claude/RTK.md` 这类 RTK 自己管理的路径）。
   理由：备份可能跨越注册表变更（某个 agent 下线后老备份仍应能回滚），一旦按当前注册表白名单就会让老备份整体拒回；
   而能写备份根的攻击者本就能以同一 uid 直接改 `home`，边际收益低。**触发条件**：若将来备份根被移到 home 之外、
   或出现多用户共享备份根的场景，就必须把 `rel` 收窄到「注册表 + 备份清单交集」。
2. **`RTK_HOME` / `RTK_BACKUP_DIR` / `RTK_BIN` 仍是运维面输入**，不设白名单（控制台不替运维决定路径）。
   触发条件：若这些变量将来可由非运维角色（例如控制台 UI/API）设置，必须一并纳入校验。
3. **TOCTOU**：校验与写入之间仍有窗口（校验 `realpath` → 复制/删除）。要彻底消除需要 `openat`/`O_NOFOLLOW`
   级别的原子操作，Node 无原生支持（不新增依赖的前提下）。窗口极小且需要攻击者能在同一 uid 下并发改软链，
   已在 `assertInsideDir` 的注释里写明。触发条件：若将来把备份根放到共享可写目录。
4. `manifest` 的 `at` 字段未参与校验（只用于展示）——不构成路径风险。
