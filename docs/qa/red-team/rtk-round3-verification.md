# RTK 第三轮对抗验证（红队 A / task-13，针对 task-11 的六条修复）

审计者：rtk-auditor（只读产品代码；写范围 `docs/qa/red-team/**`）· 生产零写入 · 不改真实 agent 配置
证据目录：`docs/qa/red-team/evidence/round3/` · 截图 `docs/qa/red-team/shots/round3/`

## 0. 时点与被测 revision（重要）

| 项 | 值 |
| --- | --- |
| 任务点名 revision | commit `f653bef`（`fix(rtk): reconcile cross-agent hook writes and make failure paths recoverable`，09:10:51） |
| 验证期间的 HEAD | `e0ac1ec`（工作区另有未提交改动） |
| **当前工作区** | `server/rtkService.ts` = `58a6af0e5f98`（09:32、09:38 两次测得相同；09:35 曾短暂出现 `cf596cc1adb4`，说明 blue-rtk 正在做 task-16 修复）<br>`src/pages/RtkPage.vue` = `3a214a0a5044` · `server/rtkPlane.ts` = `94b19d02d95e` |
| dist 构建时点 | `dist/index.html` mtime **09:34:54**，且无任何 `src/`、`server/` 的 `.vue/.ts` 比它新（满足「dist 不早于 src」） |
| 环境 | 隔离实例（PORT 8801/8803/8804/8805/8808/8809/8810/8831/8832/8833）+ 临时 HOME `/tmp/cac-r3/home`、`/tmp/cac-r5/home` + 假内核 socket + 假中转站；真实服务 8790/8791 未动 |

> ⚠️ **本轮审计横跨了两次代码变更**：前 3 小时我验的是 `f653bef` 一版（缺陷①②③④⑤ 均在该版复现），
> 09:31 之后 blue-rtk 的 task-16 修复落进工作区，我用同一批脚本重跑，**①–⑤ 全部不再复现**，但 ⑥⑦ 仍复现。
> 因此下文每条发现都给出「A) f653bef」与「B) 当前工作区」两列判定。

---

## 1. 逐条主张判定

| # | 主张 | 判定 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 连带写入双向化；响应带 `collateralReverted/Files`；UI 显示「已撤回…」；反向 `claude OFF` 仍 `collateralRestored:["cursor"]` | **已验证**（回归项也没改坏） | cursor ON 后 `.claude/settings.json` / `.claude/CLAUDE.md` 与操作前**逐字节相同**（`a02af8807dce`/`138ebabec6ce`），`RTK.md` 恢复为不存在，CLI 新建的 `.claude/settings.json.bak` 被清掉；`claude OFF` → `collateralRestored:["cursor"]`，cursor 条目保留 |
| 2 | local 平面 degraded：`state=degraded / local_rtk_missing`，不再出现「本机 rtk 已安装」；UI 琥珀色 | **已验证** | `RTK_BIN=/nonexistent/rtk` → `{"state":"degraded","reason":"local_rtk_missing","detail":"本机未安装 rtk…"}`，响应全文不含「本机 rtk 已安装」；UI 卡片 `可用但未装 rtk` + `rgb(245,158,11)` |
| 3 | 数据完整性：假 rtk 写垃圾 → 409 + `plane/reason/backup` + 文件字节回填；EACCES 不泄漏 `.rtk-*.tmp` | **已验证** | 409 `hook_file_unparsable`，target `768a06ea4420 → 768a06ea4420`（byte-identical=YES）；`chmod 500` → 500 `hook_write_failed`，无临时路径。注：`restoredByteIdentical` 只是蓝队脚手架里的断言字段，**不是 API 字段**（`docs/qa/blue/rtk-round2-fixes.md:122`） |
| 4 | 备份轮转 `RTK_BACKUP_KEEP`（默认 10）、toggle 响应不带历史清单、status 摘要瘦身 | **已验证**（基本语义） | keep=1 顺序 3 次 dirs 恒为 1、最新保留、rollback 200/restored=29；toggle 响应只有 `backupId/backupFileCount/backupKeep`（无 `backups[]`）；status.backups 只剩 `{id,at,fileCount}`。**但见发现 ③** |
| 5 | 失败提示常驻 | **已验证** | 「安装 rtk」→确认→501；`.tx-alert` 在 0.8s / 3.3s / 6.3s 三个采样点都在，文案完整（`HTTP 501 · 控制台不代为安装本机 rtk，请人工执行：curl -fsSL … · 平面=local · 原因=local_install_not_supported`） |
| 6 | 确认框改全局 `confirm()`：≥4 轮「打开→一次 Escape」全关，焦点回触发按钮 | **已验证** | 4/4 轮 `dialogAppeared=true, closedByOneEscape=true`（DOM `.confirm-actions` 存在性判据），`focusIsTrigger=true` 4/4；关闭耗时 1096/223/220/219 ms |
| +审计 | `collateral=…` 落库 | **已验证** | 实见 `collateral=none`、`collateral=restored:cursor`、`collateral=reverted:claude`（A 版）、`collateral=restored:claude`（B 版） |

---

## 2. 三条「必查」项判定

### 必查 A：`collateralReverted` 语义是否过宽？—— **是，按「文件」粒度；窗口外的改动不受影响**

最小复现（A 版 `f653bef`，假 rtk 在同一窗口同时写入 rtk 钩子与一条与 rtk 无关的合法条目）：

```
before: claude_sha=f9a5de2988ef  has_legit=0
$ POST /api/rtk/toggle {"agent":"cursor","on":true,...}   → 200
after : claude_sha=f9a5de2988ef  has_legit=0     ← 同一窗口的合法条目被一起抹掉（整文件回填）
对照（窗口外）：请求结束后手工加 echo user-late-edit → 再点 cursor OFF → 该条目仍在（1→1）
```

即：**只有「CLI 执行期间（毫秒级窗口）」对该文件的第三方写入会被静默丢弃**；窗口之外的用户改动安全。
本机有 Clawd on Desk / orca 等工具也会写 `.claude/settings.json`，属于低概率/高后果的丢更新。

B 版复验：同脚本下 `legit-concurrent-edit` **保留**（1），rtk 钩子被精准删除（0）→ 该问题在当前工作区已修（`minimalCollateralEdit` 条目级还原）。
**残余**：`collateralRestored` 的措辞仍不准（见发现 ①②）。

### 必查 B：轮转会删掉最近一次备份吗？并发下安全吗？—— **不会删「本次」的，但会删「同批其它请求已返回」的（A 版）；B 版已修**

```
F1 (keep=1) 2 并发（不同 agent，两个都 200）：
  round1: codex backupId=…432Z / claude backupId=…435Z
          dirs 只剩 […435Z]；referenced-but-missing: […432Z]   ← 已写进响应的备份被同批删掉
  round2: 同样复现
F2 (keep=2) 6 并发：4 个已返回 200 的 backupId 当场消失（两轮均复现）
G  (默认 keep=10) 12 并发：全部 200，但最早两个 backupId（…969Z、…975Z）在批次返回时已不在磁盘（两轮均复现）
缺失 id 调 rollback：404 {"error":"备份 … 不存在","reason":"backup_not_found"}   ← 错误清晰，但目标不可恢复
```

B 版复验：`pruneRtkBackups(home, keep, { protect: [backup.id] })`（当前 `server/rtkService.ts:1073`）+
备份 id 加随机后缀；12 并发后 `referenced-but-missing: []` → **该问题在当前工作区已修**。

### 必查 C：目标文件自身的 `.bak` 不在备份集 —— 确实会留下不一致状态（A 版）；B 版已修

```
before: target=da88f886b17a  target.bak=0dfaab26a87a（"echo OLD-BAK-SHOULD-STAY"）
假 CLI：target := "THIS IS NOT JSON"；target.bak := "GARBAGE-BAK-CONTENT"；exit 0
$ POST … {"agent":"codex","on":true,...}  → 409 hook_file_unparsable
after : target=da88f886b17a（回填正确）
        target.bak=c91d7c0efbb1 = "GARBAGE-BAK-CONTENT"   ← 与 target 不一致
        控制台备份目录里 .codex__hooks.json.bak 数量 = 0    ← 用户原 .bak 世代不可恢复
```

根因（A 版）：`targets = [spec.hookFile, ...extraFiles]`，目标自身的 `.bak` 既不在备份/快照，也不在清理逻辑。
B 版复验：`targets = [spec.hookFile, hookBak, ...]`（`:1063-1064`）+ `preserveUserBaks()`；
同场景下 **用户原 `.bak` 保留**（`cacb01d3cf01` 前后一致），target 字节一致 → **已修**。
附带：CLI 新建的 `.bak` 若覆盖了用户已有 `.bak`，B 版会还原并回传 `preservedBak`（UI 显示「已还原你原有的备份文件：…」）。

---

## 3. 仍存在的新发现（B 版复验）

### ⑥（P2，仍复现）宽并发下 rtk CLI 互相干扰，部分 agent 稳定 502

```
12 路并发（6 个 agent × 2 次 ON，默认 keep=10）：
批次1: gemini 502 ×2，其余 200
批次2/3（B 版）：pi 502 ×2，其余 200      ← 3/3 批次复现，失败集中在同一个 agent 的两次请求
错误体：502 {"error":"Pi coding agent 的钩子文件形状未经验证，且 rtk CLI 失败：rtk 执行成功但目标状态未生效；原文件已按备份回填","reason":"hook_cli_failed"}

单独复测同一 agent：single / sequential x2 / concurrent x2 全部 200   ← 只有「宽并发」才触发
```

判定：**并发场景下 rtk CLI 自身存在互相干扰**（多个 `rtk init -g` 并发跑在同一 HOME，写后校验偶发看不到目标状态）。
现有 per-agent 文件锁只序列化同一 agent 目录，跨 agent 的 CLI 调用仍并发。
建议：给 rtk CLI 调用加一个跨 agent 的全局串行闸（或串行重试一次），并在 502 时自动重试一次再报错。

### ⑦（次要，仍复现）无 manifest 的孤儿备份目录不会被轮转清理

```
mkdir <backupRoot>/zzz-orphan（无 manifest.json）→ 触发一次 toggle（会跑 pruneRtkBackups）
ls | grep -c orphan → 1（仍在）
```
`backupIds()` 只统计含 `manifest.json` 的目录；崩溃/中断留下的半成品目录永久堆积，也不会被 rollback 选中。
建议：轮转时清理「无 manifest 且超过 1 天」的目录。

### ⑧（措辞，P3）ON 方向的连带说明仍写成「被连带关掉」

当前工作区在「claude 原本 off、被 cursor ON 连带打开、随后被撤回」这一场景下回传 `collateralRestored:["claude"]`，
UI 因此显示「**已修复被 rtk 连带关掉的其他客户端：claude**」——实际发生的是「被连带打开后撤回」。
建议：按实际方向分别输出（如 `collateralReverted` 用于「本来开着被我们撤回」，`collateralRestored` 用于「本来关着被连带打开、已还原」），
或在文案里改为中性表述（「已还原被 rtk 连带改动的客户端」）。

---

## 4. 审计留痕与真实配置零改动自证

```
$ curl -s -b ck-8801.txt http://127.0.0.1:8801/api/audit
[{"target":"cursor","details":"on=true, plane=local, outcome=ok, mechanism=rtk-cli, collateral=reverted:claude"},
 {"target":"claude","details":"on=false, plane=local, outcome=ok, mechanism=rtk-cli, collateral=restored:cursor"},
 {"target":"cursor","details":"on=true, plane=local, outcome=ok, mechanism=rtk-cli, collateral=none"}]
```
实例 G（8810）24 行 toggle 全为 `collateral=none`；两个方向与 none 三种取值都实际落库。

真实配置 sha256（只读；本轮全部 toggle/rollback 都打在隔离实例与临时 HOME）：

| 文件 | 开始 | 结束 | 变化 |
| --- | --- | --- | --- |
| `~/.codex/hooks.json` | `d234642427dd4c2e` | `d234642427dd4c2e` | 无 |
| `~/.claude/settings.json` | `c08f957851d68845` | `c08f957851d68845` | 无 |
| `~/.claude/RTK.md` | `dc37dc6afdf51320` | `dc37dc6afdf51320` | 无 |
| `~/.claude/CLAUDE.md` | `5afc2f75a1f96a72` | `5afc2f75a1f96a72` | 无 |
| `~/.cursor/hooks.json` | `4734d152efa28ffb` | `4734d152efa28ffb` | 无 |
| `~/.gemini/settings.json` | `196e2dca8dacab1b` | `196e2dca8dacab1b` | 无 |

---

## 5. UI 实测（ego-browser，自建 space「redteam rtk round3 UI」，结束时 `finish({keep:[]})` 一次）

- 遵守 COORDINATION.md：未 adopt/close 他人 space、未清 cookie/存储/缓存、未动 profile；lead 于 09:23 明确放行后开自己的 space；`/tmp/cac-browser.lock` 属他人，未 rmdir（现已自然释放）。
- 加载的构建：`dist/index.html` mtime **09:31:40 → 09:34:54 之间的同一会话页面**（页面在 09:28 首次加载后未再重建；主张 5/6 的实测均在这一次会话内完成）。
- 主张 5：`.tx-alert` 在 0.8s/3.3s/6.3s 均存在，文案含完整 501 与 `reason`（截图 `03-install-501-persistent.png`）。
- 主张 6：4 轮 Escape 全部一次关闭 + 焦点回触发按钮（同一脚本用 DOM `.confirm-actions` 判据，未用可见 overlay 数，避开 1.2s 离场过渡误判）。
- 主张 2 的 UI 面：隔离 degraded 实例上卡片为 `可用但未装 rtk` + 琥珀 `rgb(245,158,11)`，页面无「本机 rtk 已安装」（截图 `04-degraded-amber.png`）。
- 连带提示文案：实见 `cursor 已挂载；机制=rtk-cli；已修复被 rtk 连带关掉的其他客户端：claude（.claude/RTK.md、.claude/CLAUDE.md、.claude/settings.json）；已还原你原有的备份文件：.cursor/hooks.json.bak；本次备份 …（30 个文件）`（截图 `05-collateral-notice.png`）→ 印证发现 ⑧ 的措辞问题。
- 另：lead 在 `0e27b9e` 加的「改完需要重启对应客户端才生效 / 首次触发需允许信任 hook」提示已在页面上实见（回归了第一轮反例 T17）。

---

## 6. 未验证 / 限制

1. **revision 抖动**：`server/rtkService.ts` 在 09:32–09:38 间出现过 `58a6af0e5f98` 与 `cf596cc1adb4` 两个值。B 版结论对应实例启动时（09:34）载入的那一版；blue-rtk 定稿后应按本文判据复跑一次。
2. **⑥ 的根因**：只证明「宽并发时 rtk CLI 写后状态不稳」，未深入到 rtk 内部（无源码级取证）；单 agent 并发/顺序均 200。
3. 未对真实中转站发起任何写操作，也未做真机抓包（沿用第二轮结论）。
4. 未在真实 HOME 上执行任何 toggle；主张 1/3/4 的写行为全部在临时 HOME 复现。

---

## 7. 处置建议（按 lead 指定优先级）

| 优先级 | 事项 | 状态 |
| --- | --- | --- |
| P0 | ③ 轮转不排除在飞请求 | **B 版已修**（`protect:[backup.id]`，12 并发零缺失）— 建议补一条并发回归测试 |
| P0 | ⑤ OFF 路径写后校验只看 marker | **B 版已修**（`hookFileIntegrity`：OFF + 坏文件 → 409 + 回填）— 建议补 OFF 方向单测 |
| P1 | ② 整文件替换抹掉窗口内合法改动 | **B 版已修**（条目级还原，legit 条目保留）— 建议保留该反例为回归用例 |
| P1 | ④ 目标自身 `.bak` 不在备份集 | **B 版已修**（`hookBak` 进 targets + `preserveUserBaks`） |
| P2 | ① 同一 agent 同时进 reverted/restored | **B 版已修**（矛盾消失，audit 单值）— 但留下 ⑧ 措辞问题 |
| **P2（新增）** | ⑥ 宽并发下 rtk CLI 互相干扰 → agent 稳定 502 | **仍复现（3/3 批次）**，建议加跨 agent 串行闸或 502 自动重试一次 |
| **次要（新增）** | ⑦ 无 manifest 的孤儿备份目录不会被清理 | 仍复现 |
| P3 | ⑧ `collateralRestored` 在 ON 方向措辞不准 | 仍存在 |

## 8. 证据索引

| 文件 | 内容 |
| --- | --- |
| `evidence/round3/01-collateral.txt` | 主张 1 双向复验 + 必查 A 最小复现 + 矛盾字段复现 |
| `evidence/round3/02-integrity-degraded.txt` | 主张 2/3 复验 + 必查 C（`.bak`）+ OFF 只校验 marker |
| `evidence/round3/03-rotation.txt` | 主张 4 + 必查 B（顺序/并发/默认 keep=10）+ 孤儿目录 |
| `evidence/round3/04-audit-and-real-config.txt` | 审计三种取值 + 真实配置 sha256 自证 |
| `evidence/round3/05-reverify-current-revision.txt` | A/B 两版对照表与 B 版复验输出 |
| `evidence/round3/probe-rotation.mjs` | 我写的轮转/并发探测器 |
| `docs/qa/red-team/shots/round3/*.png` | 5 张浏览器实测截图 |
