# A/B 任务式对照：迁移前 vs 迁移后（task-5 Phase 2）

评估人：`ab-harness`（**唯一操作者，样本量 1**）｜日期：2026-10-01｜实例 <http://127.0.0.1:8791>｜实验台 `/ab`
A 侧 = `281c30e` 冻结页面副本；B 侧 = 当前真实页面（blue-ui `7593622` / blue-rtk 同期改动）
仪器：ego-browser Chromium，桌面视口；方法见 §4；所有数值都是单次任务走查的实测值。

> **样本量 1，不得外推。** 本篇是「1 名操作者用同一套任务脚本走 A/B 两侧」的记录，不是用户研究：
> 它能证明**哪些可观察的缺陷在 B 侧消失了 / 哪些还在**，不能证明「所有用户都会更喜欢 B」。
> 每张表都只是这一次走查的读数；换人、换数据、换视口都可能变。

---

## 1. 结论摘要（可核验的三条）

1. **flow 1（API Key 列表）B 侧全面更好，且差值可归因到具体缺陷**：步数 10 → 8，误操作 2 → 0；筛选/搜索进 URL（刷新保持、可分享，D13 修复）；删除确认只剩一层且写清目标 Key（D8 修复）；重置额度从「单击即执行」变成「必须确认」（D5 修复）。
2. **flow 2（接入与 RTK 配置）差异是结构性的**：A 侧主视图（OAuth 登录池）**0 处**提到 RTK，A 侧唯一的文档面（迁移前帮助页）也**0 处**提到 RTK —— 这条任务在 A 侧**不可完成**；B 侧同一页可展开 RTK 面，读到平面解析、rtk v0.50.0、节省 36.2%，帮助页第 8 节给出安装与 hook 命令。
3. **flow 3（运行概览首屏）数字都对，差别在「坏了的时候说不说实话」**：断掉 `/api/dashboard` 后，A 侧四张卡变 `—`，但页面**仍然写着「网关运行正常」「Magpie 内核可访问」**，且全页无「失败/错误/重试」字样；B 侧改成「网关状态不可用 / 连不上服务器 / 重试」。

**A 侧指标差是结构性的**（Lead 要求明确写出）：legacy 快照就是没有本轮新增的 URL 状态、统一确认框、持久错误态与受控加载态；A 侧的步数/误操作/可恢复性劣势来自「它没有这些交互」，不是操作者失误，也不是「A 更难看」。

---

## 2. 每个 flow 一张对照表

口径（先定后测）：**步数** = 完成任务脚本所需的用户可见动作数（点击/输入/刷新各记 1，纯阅读不记）；**点击数** = 其中的点击；**误操作** = 结果与预期不符、需要回退或重做的动作；**卡住点** = 停顿后必须重做或改道；**是否可恢复** = 破坏性路径是否有确认/可取消；**需要看文档次数** = 离开当前视图去文档的次数。

### 2.1 flow `keys-access` — API Key 列表：筛选 / 搜索 / 删除确认

任务脚本：数 Key 总数 → 搜索「非」+ 切一个筛选 → 刷新看是否保持、判断可否分享 → 读「用户 A」的额度 → 走到删除确认再取消。

| 指标 | A（迁移前，281c30e 冻结副本） | B（迁移后，当前 KeysPage） | 结论 |
| --- | --- | --- | --- |
| 步数 | **10** | **8** | B 少 2 步 |
| 点击数 | **7** | **5** | B 少 2 次 |
| 误操作 | **2**：① 点「删除密钥」后出现**第二层弹窗**，取消后仍停在编辑弹窗，需再找关闭入口；② 筛选 chip 标签写「已停用 (0)」但筛选结果是 **1 行**，计数与结果不一致 | **0** | B 修复 |
| 卡住点 | **2**：① 刷新后搜索词与筛选**全部丢失**，要重做一遍；② 取消删除后滞留在编辑弹窗 | **0** | B 修复 |
| 是否可恢复 | **部分不可恢复**：删除有确认（但叠层）；`重置今日/本周/总计用量` 三键**单击即执行、零确认**（含不可逆的累计总额） | **可恢复**：删除确认只有一层、写清「用户 A」将被彻底删除；点重置会先弹确认框（「今日已用额度（$2.36）将归零，操作不可撤销」），取消即退出 | B 修复 |
| 需要看文档次数 | 0 | 0 | 持平 |

**逐条判定标准（§flows.ts 的 k-c1…k-c6）**

| 标准 | A | B | 现场看到什么 |
| --- | --- | --- | --- |
| k-c1 删除确认不叠层 | ❌ | ✅ | A：点「删除密钥」后同时可见 **2 个 dialog**（`编辑 API Key` + `删除密钥确认`）；B：只有 **1 个**（`删除密钥`），正文点名「用户 A」 |
| k-c2 筛选/搜索进 URL | ❌ | ✅ | A：地址始终 `/ab?flow=keys-access&v=a`，刷新后搜索框空、行数 14 → 14，筛选回到「全部密钥 (14)」；B：地址变 `…&q=%E9%9D%9E` / `…&status=disabled`，刷新后仍是 1 行、搜索框仍是「非」 |
| k-c3 重置类动作有确认 | ❌ | ✅ | A：弹窗内三个重置按钮直接可点，无确认；B：点「重置今日用量」后出现确认框（未执行最终确认） |
| k-c4 主标识可点/可聚焦 | ⚠️ 部分 | ✅ | A：行内 4 个按钮全部 `aria-label=null`（只有 `title`），Key 名列是 `div` 死点击；B：行内按钮带 `aria-label`（`编辑密钥 用户 A` / `删除 用户 A` …），Key 名换成真按钮 |
| k-c5 失败留持久错误+重试 | ❌（静态判定） | ✅（静态判定） | 本流程未注入 `/api/bootstrap` 失败（见 §5 未验证项）；代码证据：A `Promise.allSettled` 吞错后无 error ref；B 用 `useResource` + `ErrorPanel` |
| k-c6 窄屏列不塌 | 未测 | 未测 | 本次为桌面视口；列宽塌陷（D4）由 blue-ui 用 `--table-min: 1120px` 单变量兜底（`KeysPage.vue:425`），未在 390px 复测 |

**截图**：A `docs/qa/ab/shots/f1-keys-a-列表.png`、`f1-keys-a-搜索后.png`、`f1-keys-a-额度弹窗.png`、`f1-keys-a-删除确认叠层.png`、`f1-keys-a-刷新后丢失.png`；B `f1-keys-b-列表.png`、`f1-keys-b-刷新后保持.png`、`f1-keys-b-删除确认.png`、`f1-keys-b-重置有确认.png`

**关键实测输出（原样）**

```
A 点「已停用」chip 后： {"rows":1,"url":".../ab?flow=keys-access&v=a","active":["已停用 (0)"]}
A 刷新后：            {"rows":14,"url":".../ab?flow=keys-access&v=a","active":["全部密钥 (14)"]}
B 点「已停用」chip 后： {"rows":1,"url":".../ab?flow=keys-access&v=b&status=disabled","active":["已停用 (0)"]}
B 刷新后：            {"rows":1,"url":".../ab?flow=keys-access&v=b&status=disabled","active":["已停用 (0)"]}
A 编辑弹窗：          {"visibleDialogs":1,"titles":["编辑 API Key"]}
A 点「删除密钥」后：   {"visibleDialogs":2,"titles":["编辑 API Key","删除密钥确认"]}
B 点行内删除：        {"visibleDialogs":1,"titles":["删除密钥"], footers:["/取消/删除密钥"]}
B 点重置今日用量：     {"visibleDialogs":2,"titles":["重置今日用量","额度限制 - 用户 A"]}
```

> 关于 B 侧最后一行：重置的确认框**确实叠在额度弹窗之上**（2 层可见）。它与 A 侧 D8 的区别是：A 是「第二个业务弹窗误叠」，B 是「同一动作的确认框」且**必须显式确认才会执行**。按 k-c1 的口径（删除路径）B 通过；但「确认框复用全局 host 时是否应先把业务弹窗收起」仍是一个**开放的残余问题**，已列入 §5。

### 2.2 flow `integration-rtk` — 接入与 RTK 配置

任务脚本：找到接入下一步命令 → 说出 RTK 是否开启/省了多少 → （若未开）开启并确认 → 找到连通性验证说明 → 判断失败时有没有解释。

| 指标 | A（迁移前） | B（迁移后） | 结论 |
| --- | --- | --- | --- |
| 步数 | **任务不可完成** | **1**（展开「B 侧新增面」；开关路径另有 1 次点击 + 1 次确认，本次未执行） | A 缺能力，不是步数问题 |
| 点击数 | — | 1 | — |
| 误操作 | — | 0 | — |
| 卡住点 | **1**：主视图与文档面都没有 RTK，任务在此终止 | 0 | A 结构性缺失 |
| 是否可恢复 | — | 可恢复：开关/install/upgrade/回退都走确认弹窗，远端写入默认关闭并如实返回 403/501 | — |
| 需要看文档次数 | **1**（打开 A 侧文档面）→ 仍然 0 命中 | 0（RTK 面与帮助页都在同一页可展开） | B 修复 |

**现场证据**
- A 主视图标题 `OAuth 授权登录`，8 个提供商卡片（OpenAI Codex / Anthropic / Antigravity / Kimi×2 / xAI / Devin / Meta），整页 `mentionsRtk: false`；
- A 文档面（迁移前帮助页冻结副本）静态核对：`grep -ic rtk src/ab/variants/legacy/HelpPage.legacy.vue` → **0**；
- B 侧新增面（当前 `RtkPage.vue`）实测文本：`权威平面：本机（回退）｜内核（沙箱 HOME）未提供该接口 kernel_rtk_seam_missing｜中转站未暴露 /api/library/rtk（当前实测 404）｜本机 已接通 local_host｜本机 rtk 已安装 (v0.50.0)｜Token 节省 36.2%`，且 `hasToggle: true`；
- B 侧文档面（当前 HelpPage）静态核对：`grep -ic rtk src/pages/HelpPage.vue` → **32**，含目录项 `8. 本机 RTK（可选，省 token）` 与 `rtk init -g --codex` / `rtk init -g --agent claude --auto-patch`。

**截图**：A `docs/qa/ab/shots/f2-rtk-a-主视图.png`、`f2-rtk-a-文档面.png`；B `f2-rtk-b-新增RTK面.png`

> 口径坦白：A/B 两侧的主视图**不是同一个页面的两版**（A 是当时的唯一接入面 OAuth 登录池，B 是当前接入面 + 新增 RTK 面）。这是刻意的选择——迁移前控制台里根本不存在 RTK 面，只有这样对照才反映真实情况；这也意味着本行的「步数」不构成同页性能对比。

### 2.3 flow `dashboard-overview` — 运行概览 Dashboard 首屏

任务脚本：10 秒内读出四个数字 → 判断健康与否 → 找最活跃 Key → 检查单位/缺值混用 → 判断故障时页面会不会说谎。

| 指标 | A（迁移前） | B（迁移后） | 结论 |
| --- | --- | --- | --- |
| 步数 | **0**（首屏即得） | **0**（首屏即得） | 持平 |
| 点击数 | 0 | 0 | 持平 |
| 误操作 | **1**：接口挂掉时页面仍宣称「网关运行正常 / Magpie 内核可访问」，把故障读成正常 | 0 | B 修复 |
| 卡住点 | **1**：故障态只有 `—` 与「暂无时序数据」，没有任何原因/下一步/重试 | 0 | B 修复 |
| 是否可恢复 | **不可恢复**（无重试入口，只能猜着刷新） | **可恢复**（错误面板带「重试」） | B 修复 |
| 需要看文档次数 | 0 | 0 | 持平 |

**逐条标准**

| 标准 | A | B | 现场看到什么 |
| --- | --- | --- | --- |
| d-c1 四个数字在首屏 | ✅ | ✅ | 两侧都是 `214 请求总量 / 7.7万 Token 消耗 / 14-14 活跃 API Key / 平均响应延迟`，无需滚动 |
| d-c2 数字与接口同源 | ✅ | ✅ | 页面内 `fetch('/api/dashboard?days=7')` → `{requests:214, tokens:76762, avgLatency:4842.57, errorRate:0.4159}`；两侧卡片与之一致（都显示「高错误率预警」） |
| d-c3 单位/缺值一致 | ⚠️ | ✅ | A 延迟写 `4843 ms`；B 归一为 `4.8s`（`lib/format.fmtLatency`）。Token 两侧都是 `7.7万` |
| d-c4 失败给错误+重试 | ❌ | ✅ | 断 `*/api/dashboard*` 后：A 无「失败/错误/重试/不可用」字样、无重试按钮、卡片全 `—`、**仍写「网关运行正常」**；B 显示「网关状态不可用 / 无法访问 Magpie 内核 / 连不上服务器 / 请检查网络或服务是否在运行，然后重试。/ 重试 / Failed to fetch」 |
| d-c5 加载态受控 | 未单独测 | 未单独测 | B 用 `LoadingBlock` + `showSkeleton = !data && !error`（有数据即消失）；A 无骨架组件 |

**截图**：A `docs/qa/ab/shots/f3-dash-a-首屏.png`、`f3-dash-a-失败态.png`；B `f3-dash-b-首屏.png`、`f3-dash-b-失败态.png`

**关键实测输出（原样）**

```
A 断 /api/dashboard 后： {"hasErrorWord":false,"hasRetryButton":false,
  "snippet":"… 运行概览 … | 网关运行正常 | Magpie 内核可访问 | — | 请求总量 | — | Token 消耗 | 14 / 14 | 活跃 API Key | — | 平均响应延迟 | … | 暂无时序数据 | …"}
B 断 /api/dashboard 后： {"hasErrorWord":true,"hasRetryButton":true,
  "snippet":"… 运行概览 … | 网关状态不可用 | 无法访问 Magpie 内核 | 连不上服务器 | 请检查网络或服务是否在运行，然后重试。 | 重试 | Failed to fetch"}
```

---

## 3. 三张表的横向小结

| flow | 步数 A→B | 误操作 A→B | 卡住点 A→B | 可恢复 | 结论（本次走查） |
| --- | --- | --- | --- | --- | --- |
| keys-access | 10 → 8 | 2 → 0 | 2 → 0 | 部分不可恢复 → 可恢复 | B 明显更好 |
| integration-rtk | 不可完成 → 1 | — → 0 | 1 → 0 | — → 可恢复 | B 结构性补上能力 |
| dashboard-overview | 0 → 0 | 1 → 0 | 1 → 0 | 不可恢复 → 可恢复 | B 在故障态更好，正常态持平 |

---

## 4. 复现步骤（可照着再走一遍）

```bash
# 0) 前置：服务在跑、UI 已构建（UI 改动需先 build）
for i in $(seq 1 36); do mkdir /tmp/cac-build.lock 2>/dev/null && break || sleep 5; done
npm run build && rmdir /tmp/cac-build.lock      # 仅在没人在用构建锁时

# 1) 浏览器锁（同一时间只允许一个成员驱动浏览器）
for i in $(seq 1 36); do mkdir /tmp/cac-browser.lock 2>/dev/null && break || sleep 5; done

# 2) 打开实验台（已登录的浏览器 profile 直接可进；未登录会跳 /login）
#    A 侧：http://127.0.0.1:8791/ab?flow=keys-access&v=a
#    B 侧：http://127.0.0.1:8791/ab?flow=keys-access&v=b
#    并排：http://127.0.0.1:8791/ab?flow=keys-access&v=split

# 3) 按 §2 各流程的任务脚本走一遍，逐项读：行数 / 地址栏 / 可见 dialog 数 / 按钮 aria-label
#    失败注入（只影响当前标签页，不动服务端）：
#      page.cdp('Network.setBlockedURLs', { urls: ['*/api/dashboard*'] })  → reload → 读页面文本
#      page.cdp('Network.setBlockedURLs', { urls: [] })                    → 恢复

# 4) 收尾（必须）
ego-browser nodejs -e 'const t = await taskSpace(<id>); await t.finish({ keep: [] });'
rmdir /tmp/cac-browser.lock
```

**禁止动作（本次全程遵守）**：未执行任何真实删除/剪枝/重置额度/切换 agent hook；未调用 `Network.clearBrowserCookies`、未清缓存或 profile；密码只在进程内存里使用（Keychain → `execFileSync`），未出现在 argv、文件、日志或截图。

---

## 5. 未验证项与残余风险

1. **样本量 1**：唯一操作者是我。所有「更快/更少误操作」都是单次走查读数。不得外推。
2. **A 侧 k-c5（接口失败留痕）未做浏览器注入**：flow 1 未注入 `/api/bootstrap` 失败；该条只有静态代码证据（A `Promise.allSettled` 吞错、无 error ref）。flow 3 的失败注入是实测的。
3. **移动端（390×844）未复测**：本次全部为桌面视口；D4 列宽塌陷的修复只有代码证据（`KeysPage.vue:425` 的 `--table-min: 1120px`），k-c6 记「未测」。
4. **破坏性动作的最终提交未执行**：删除 Key、重置额度、剪枝、RTK 开关都只走到「确认框出现」并取消。所以「确认之后的行为是否可回滚」仍是代码推断，未实测。
5. **flow 2 的开关路径未执行**：只读到状态（`hasToggle: true`）与确认弹窗代码，没有真的挂载/卸载 agent hook（会改本机真实配置）。
6. **B 侧重置确认框仍叠在额度弹窗上**（§2.1 末注）：这是本次唯一发现的 B 侧遗留交互问题，属「可接受但值得改」级别，未纳入缺陷计数。
7. **A 侧 chip 计数不一致**（「已停用 (0)」却筛出 1 行）只记录现象，未追根因（A 侧为冻结副本，不打算修）。
8. **`integration-rtk` 的 A/B 主视图不是同一页面**（见 §2.2 口径坦白）：该行结论只说明「迁移前无此能力」，不构成同页性能对比。
9. **只读闸门的覆盖边界**：闸门拦的是 api 模块方法、`fetch` 与 `XMLHttpRequest`（见 §7.2）。**未覆盖** `navigator.sendBeacon`、WebSocket 以及「GET 但会改状态」的端点（本仓库 4 个副本里都不存在这类调用，属推断而非实测）。

---

## 6. 真实用户通道与留痕证据

`/ab` 顶部写死只读说明 + 深链；底部投票「选 A / 选 B / 都不行 + 一句话理由（+ 可选卡点）」，落 `data/ab-preferences.jsonl`。
**现有 2 票都是 `ab-harness` 自测票**（用于证明链路，其中第二票同时验证了只读闸门的投票例外，见 §7.4），用户随时可自己再投。

入口与说明区（未投票时的样子，任何人打开都能自己上手）：`docs/qa/ab/shots/00-lab-入口.png`

```bash
$ tail -1 data/ab-preferences.jsonl
{"schema":1,"id":"abp_muoud1wc_96084090","at":"2026-10-01T01:14:25.884Z","flow":"integration-rtk","choice":"b",
 "note":"只看只读对照：A 侧控制台里根本没有 RTK 面，B 侧同屏能读到平面解析与节省率。",
 "blocker":"","userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
 "admin":true,"redacted":false}

$ node scripts/ab-report.mjs
A/B 偏好留痕汇总 · 文件：<repo>/data/ab-preferences.jsonl
共 2 票｜时间范围 2026-10-01T00:50:46.974Z → 2026-10-01T01:14:25.884Z

【① API Key 列表：筛选 / 搜索 / 删除确认】  样本量 1
  A 0 · B 1 · 都不行 0 （A:B = 0% : 100%）
  理由：
    - [选 B（迁移后）] 对比结论：B 的搜索/筛选进 URL，刷新不丢；删除确认只有一层且写清目标 Key，A 会叠在编辑弹窗上。

【② 接入与 RTK 配置】  样本量 1
  A 0 · B 1 · 都不行 0 （A:B = 0% : 100%）
  理由：
    - [选 B（迁移后）] 只看只读对照：A 侧控制台里根本没有 RTK 面，B 侧同屏能读到平面解析与节省率。

【③ 运行概览 Dashboard 首屏】  样本量 0
  A 0 · B 0 · 都不行 0
  理由：（无）

提醒：以上是主观偏好，样本量可能只有 1 人，不得外推成「所有用户都觉得 B 更好」。
```

UI 侧回执（投票成功态，截图 `docs/qa/ab/shots/01-lab-投票成功.png`、`docs/qa/ab/shots/r1-vote-通道恢复.png`）：
`已记录（abp_muotin26_78be4e56）…` / `已记录（abp_muoud1wc_96084090）…`

补充证据（未鉴权即被拒，证明接口不是「谁都能写」）：

```bash
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
    -d '{"flow":"keys-access","choice":"a","note":"probe"}' http://127.0.0.1:8791/api/ab/preference
401
$ curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8791/api/ab/preference
{"error":"请先登录"}
```

---

## 7. 实验台只读闸门（红队第二轮 R1 收口）

### 7.1 修前：R1 是什么（红队 `docs/qa/red-team/ui-round2-verification.md` §2.1）

A 侧是 `281c30e` 的冻结页面副本，但它们 import 的是**活的 api 模块**——A 侧不是沙箱，它写的是真实数据。
红队在 `/ab?flow=keys-access&v=a` 实测：点「重置今日用量」**没有确认框**，直接发出 `POST /api/keys/<id>/quota/reset`。
而 `/ab` 在侧栏一键可达、深链可分享，等于把本轮刚修好的「零确认重置」（D5）从后门重新打开了。

### 7.2 闸门实现：三层 + 唯一例外（`src/ab/readOnlyGate.ts`）

| 层 | 拦什么 | 为什么需要 |
| --- | --- | --- |
| **api 函数层** | 把活 `api` 上**不在只读白名单**的方法换成拒绝 stub | 最内层：不管是 fetch、XHR 还是以后改成别的传输，走 api 的写都出不去；白名单**穷举读接口**，新增方法默认被拦（fail-closed） |
| **fetch 层** | 非 `GET/HEAD` 一律拒绝 | 覆盖页面自己直接 fetch 的探索代码、第三方组件 |
| **XHR 层** | 非 `GET/HEAD` 的 `XMLHttpRequest.open` 直接抛错 | 覆盖手写/库内 XHR 这类非 fetch 路径 |

**唯一例外**：实验台自己的投票 `POST /api/ab/preference`（同源 + 精确路径 + POST）必须放行。
这一条例外是补上来的：**Lead 的第一版 fetch 拦截把投票一起拦了**，实测在页内 POST 该端点返回
`实验台为只读对照：写请求已被拦截，请到真实页面执行` —— 等于亲手废掉「真实用户参与」通道。
例外加上后，真实投票再次落盘（§7.4 的 `abp_muoud1wc_96084090`）。

每次拦截都会回调计数并显示在横幅上（`已拦截 N 次写请求（最近：api.<方法>()）`），避免「点了没反应」被误读成页面坏了。

**闸门逻辑自测**（`node --import tsx`，假 api/假 window，不碰浏览器、不碰真实服务）→ **19/19 通过**：写方法在函数层被拦且不调用原实现、读方法仍可用、
未来新增写方法默认被拦、投票 POST 放行、其它 POST 被拦、`Request` 对象的 method 也能识别、XHR 非 GET 被拦 / GET 放行、`release()` 精确还原。

### 7.3 修后：4 个 legacy 副本逐一实点验证

判据统一为三条：**(a) 页内 fetch 日志里没有非 GET**；**(b) 拦截计数按预期递增（或保持 0）**；**(c) 没有真实副作用**。
弹窗判据用 **DOM 存在性**（`.tx-modal__overlay` 计数），不用「可见性」——离场过渡约 1.2s 会误判。

| 副本 | 写路径 | 实点结果 | 判据 | 截图 |
| --- | --- | --- | --- | --- |
| `KeysPage.legacy` | 额度弹窗「重置今日用量」→ `api.resetQuota()` | ✅ 点到底 | 页内 fetch 日志 **0 条**；计数 `已拦截 1 次写请求（最近：api.resetQuota()）`；弹窗内「已用 $2.36 / $292.76 / $292.76」**点击前后完全一致**；弹窗仍在 DOM（未误判关闭） | `shots/r1-keys-a-重置被拦.png` |
| `OAuthPage.legacy` | 提供商卡片「开始登录」→ `api.startOAuth()` | ✅ 点到底 | 页内 fetch 日志 **0 条**；**CDP 协议层非 GET = 0**（只有 data: 图标与扩展 locale 的 GET）；计数 `已拦截 1 次写请求（最近：api.startOAuth()）`；未新开标签页（8 → 8）；页面自身弹出「发起登录失败 / 实验台为只读对照…」 | `shots/r1-oauth-a-开始登录被拦.png` |
| `DashboardPage.legacy` | **无 api 写路径**（只有站内导航与只读筛选） | ✅ 点 Key 选择器 | 读依然正常（首屏 `214 / 7.7万 / 14-14 / 4843 ms` 有数据）；fetch 日志 0 条；计数保持 **0** | `shots/r1-dashboard-a-无写路径.png` |
| `HelpPage.legacy` | **无 api 写路径**（复制走剪贴板） | ✅ 点「复制」 | fetch 日志 0 条；计数保持 **1**（未增加） | `shots/r1-help-a-复制无请求.png` |

> 第 1、2 行是「有写路径且被拦住」；第 3、4 行是**否定结果**（这两个副本根本没有 api 写路径），
> 按实测记录，不把它们算成「也拦住了写」。

### 7.4 投票通道复核（闸门例外）

```
点「选 B」→ 填一句话理由 → 提交 → 页面回执：
已记录（abp_muoud1wc_96084090）：这一票会出现在 data/ab-preferences.jsonl 里。   （类名 ab-lab__status--ok）
```

`data/ab-preferences.jsonl` 里确实出现该条（`flow=integration-rtk, choice=b, admin=true`），
`node scripts/ab-report.mjs` 现在读出 **共 2 票**（两条都是 `ab-harness` 自测票，用于证明链路；用户可随时自己再投）。
截图：`shots/r1-vote-通道恢复.png`

### 7.5 UI 上是否已明确告知「本页不会替你写数据」

已告知，且是**主动说明而非事后兜底**：视图切换器下方有一条常驻横幅（`role="note"`）：

> 本页是**只读对照**：A/B 两侧的写操作（删除、重置、剪枝、开关）都会被拦截，不会改到真实数据；要真的执行请到对应真实页面。

被拦后横幅右侧出现 `已拦截 N 次写请求（最近：api.<方法>()）`，同时 legacy 页面自己的错误提示也会弹出
（见 `shots/r1-oauth-a-开始登录被拦.png` 右下角「发起登录失败」），两条路径都不静默。
