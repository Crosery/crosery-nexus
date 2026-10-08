# Crosery API Console — 第八轮复验：(A) 蓝队服务端收口 + (B) 对比度专项（红队 B / task-29）

**被验对象**：`89e47da`（R7-B/C/D：并发文案单一真源、额度空值不再静默改写、`days` 非数字兜底）、`8478022`（Lead 对比度专项）
**本地 HEAD** `f0c7bcd`｜**实例** <http://127.0.0.1:8791>｜**dist 构建时间** `2026-10-01 11:40:06`｜dist 不早于 src：`find src index.html docs.html -newermt "$(stat -f '%Sm' dist/index.html)"` → **0 个**
**审计人** `ux-auditor` / task-29｜**实测时点** 2026-10-01 11:46–12:10｜浏览器 TaskSpace `58`（已 `finish({keep:[]})`）；浏览器锁与构建锁均已释放
**写入边界**：只写 `docs/qa/red-team/**`（新目录 `shots-r8/`，4 张截图）。临时改动 **1 次**（`server/index.ts`），**已逐字节还原**（§9）。**生产零写入**——所有发给运行实例的输入都是**必然被拒**的。

---

## 0. 结论速览

| # | 被验主张 | 判定 |
|---|---|---|
| A1 | 并发文案单一真源 + `policyCopy.test.ts` 有牙齿 | ✅ **已验证**（重新内联副本 → **红**，文案精确） |
| A2 | 额度 `""`/`"abc"`/`-3` → 400 | ✅ **已验证**（三条都在真实实例上 400，文案分层正确，**零状态变更**） |
| A3 | `days=abc`/`days=`/`days=7` 响应体逐字节一致 | ⚠️ **前提有误**：该路由默认是 **30**，所以 `abc`/`=` 与 **`days=30`** 逐字节一致（而非 `days=7`）。**兜底本身是对的** |
| A3b | `days=7.9` 取整 | ✅ **已验证**（→ 7，与 `days=7` 逐字节一致）；**floor 是正确行为** |
| A4 | 「服务端改动 ⇒ 重启 + 抽验」是否被遵守 | ✅ **本次已遵守**（行为探针证明运行实例含最新服务端代码）。判据见 §4 |
| B1 | 对比度修后「除 /channels 5 个外全部 0」 | 🔴 **被推翻**：我用独立实现测得 **86 个不达标节点**（`/cache` 38、`/rtk` 29、`/channels` 6、`/help` 4、其余每页 1、`/docs` 0） |
| B2 | `/docs` 深色代码块未被方向性改坏 + section 标签变深 ≥4.5 | ✅ **已验证**（代码 13.19:1、head 8.36:1；section 标签 2.92 → **5.14:1**）。**没有任何方向性错误** |
| B3 | 调色板变深只发生在文字位置 | ✅ **已验证**（图形用途全部保留原亮色；`chartTheme` 独立色板未被触碰） |
| B4 | `/docs` 缓存坑 | ✅ 已处理（cache-buster + 核对 `document.styleSheets` href == `dist/` 实际产物） |

**本轮独立新发现 4 条**：
- **🔴 R8-A（高）扫描器盲区**：Tuffex `TxTag` 的文字计算色是 **`color(srgb …)`** 语法，只认 `rgb()/rgba()` 的实现**完全看不到这些节点**——这极可能就是「全部 0」的来源（**推断**，Lead 的脚本未入库、我无法验证其实现）。
- **🟠 R8-B（中）深色化只在「白底」上验证过**：标签实际坐在 **12–20% 同色 tint** 上，实测把 `#047857` 从「白底 5.48」压到 **4.30**、`#ef4444` 从「白底 3.76」压到 **3.12** → 仍不达标。
- **🟠 R8-C（中）遗漏点**：`CachePage.hitToneColor` 仍返回亮色且用在**两处文字位**（`/cache` 31 个失败节点）；`RtkBoard.STATE_COLOR.unauthorized` 仍 `#ef4444`（5 个兄弟都改了，漏了它；当前为**潜伏**）。
- **⚪ R8-D（低）** 每个 Vue 页面都有 1 个 **3.14:1** 的节点：VersionWidget 的 `/` 分隔符。

---

## 1. (A)1 并发文案单一真源 ✅ **已验证**

**判据**：在 `server/index.ts` 里**再内联一份完全相同的字面量**（导入与运行时都不动，语义不变），跑 `server/policyCopy.test.ts`。
```
✔ validatePolicy 抛出的消息就是导出的那份唯一真源          ← 运行时断言：不受影响
✖ 并发规则字面量在 server/** 里只有一处（真源在 policy.ts）
   AssertionError: 并发规则文案出现多处，说明又抄了一份副本（真源只应在 policy.ts）：index.ts ×1、policy.ts ×1
✔ 自检：把字面量再抄一份进别的文件会被抓出来（合成样本，不依赖生产文件）
ℹ tests 3  ℹ pass 2  ℹ fail 1
```
- 真源：`server/policy.ts:15` `export const TOTAL_CONCURRENCY_RULE = …`；`server/index.ts:14` 改为 `import { TOTAL_CONCURRENCY_RULE, validatePolicy } from './policy.js'`，且 `:490/:493/:496` 三处报错都**引用该常量**（不再内联）✓ 唯一的字面量已收敛。
- 该测试第 3 条自检用**合成样本**、**不读生产文件** ✓ 符合我在 R5-B 立的标准（与第六轮 `libImports` 早期版本形成对照）。
- **判定：R7-B 结案。**

---

## 2. (A)2 额度空值/非数字/负数 ✅ **已验证**

先确认运行实例**已含最新服务端代码**（§4），再发**必然被拒**的输入（PATCH `/api/keys/:id/quota`，目标 `张三`，其 quota 为 `{0,0,0}`）：

| 请求体 | 状态 | 文案 | 来源层 |
|---|---|---|---|
| `{totalUsd: ''}` | **400** | 额度不能为空：填 0 表示不限额 | `parseQuotaAmount` |
| `{totalUsd: 'abc'}` | **400** | 额度必须是数字：0 表示不限额，上限 1000000 | `parseQuotaAmount` |
| `{totalUsd: -3}` | **400** | 总额度必须是 0 或正数，0 表示不限额 | `validateQuota`（`server/quota.ts:39`） |
| `{dailyUsd: ''}` | **400** | 额度不能为空：填 0 表示不限额 | `parseQuotaAmount` |
| `{weeklyUsd: 'x'}` | **400** | 额度必须是数字：… | `parseQuotaAmount` |

**读回验证**：目标 Key 的 quota 仍为 `{totalUsd:0, dailyUsd:0, weeklyUsd:0}` → **零状态变更** ✓
**三层文案各司其职**（空 / 非数字 / 负数分别由不同层给出）✓ —— 这是 R7-C 那个「`""`/`"abc"` 静默变成 0 = 不限额」的正面修复。
成功路径（`{}` 保持原值、显式 `0` 合法）我**没有**在真实实例上发（会写库）；改由 e2e 覆盖核对：`server/totalConcurrencyRoutes.test.ts:206-212` 断言 `{}` → **200** 且保持原值、显式 `0` → **200** ✓

---

## 3. (A)3 `days` 兜底 ✅ 行为正确，但**任务给出的对照基线是错的**

### 3.1 我先踩了一次坑（记录以免误导）
第一次我拿 `days=`/`days=abc` 去和 **`days=7`** 比，得到 `8361 vs 12793` 字节、不同 → 一度得出「**进程是旧的**」。**这是我的基线假设错了**：`/api/usage-overview` 的默认值是 **30**，不是 7：
```js
// server/index.ts:562
app.get('/api/usage-overview', async (req, res) => {
  const days = boundedInteger(req.query.days, 30, 1, config.usageRetentionDays)   // ← 默认 30
```
**任务里「`days=abc`/`days=`/`days=7` 应逐字节一致」这个预期本身不成立**——它们应当与 **`days=30`** 一致。若照字面验收会得到**假失败**。

### 3.2 修正后的实测（cache-busted + `cache: 'no-store'`）
| 请求 | 响应 `days` | 字节数 | 与谁逐字节一致 |
|---|---|---|---|
| `?days=7` | 7 | 8361 | — |
| `?days=30` | 30 | 12793 | — |
| `?days=` | **30** | 12793 | ✅ **与 `days=30` 完全一致** |
| `?days=abc` | **30** | 12793 | ✅ **与 `days=30` 完全一致** |
| `?days=7.9` | **7** | 8361 | ✅ **与 `days=7` 完全一致** |

- 实现：`server/publicUsage.ts:7-12` 的 `boundedInteger(value, fallback, min, max)`：`undefined/null/''` → fallback；`!Number.isFinite` → fallback；否则 `Math.max(min, Math.min(max, Math.floor(parsed)))`。
- **它是既有工具**（来自开源基线 `2b96f37`，`index.ts` 里改动前就已用 7 次）→ **复用而非新造** ✓ 好实践。

### 3.3 `days=7.9` 的取整判断：**符合预期**
- 旧实现 `Math.max(1, Math.min(retention, Number(7.9)))` = **7.9**（小数天数被直接传进报表查询）；新实现 floor → **7**。
- **判断依据**：① `days` 语义是「天数窗口」，必须是整数；② 旧值 7.9 会把小数带进 SQL 的时间窗计算，属未定义行为；③ UI 只发整数（`TxSelect` 的 `[1,7,30,90]`），所以这个变化**只影响手写 URL / API 调用**，把原来的隐式未定义行为变成确定行为。**属改进，非回归。**

---

## 4. (A)4 「服务端改动 ⇒ 重启 + 抽验」这条规则**本次已被遵守** ✅

### 4.1 可复跑的判据（我用的方法）
`ps` 在本机沙箱下被拒（`/bin/ps: Operation not permitted`），`launchctl print` 也不给启动时间戳。因此我用**行为探针**替代时间戳比较——它其实比时间戳更直接地回答「运行的是不是最新代码」：

```bash
# 判据：days=abc 必须回退到该路由的默认值（30），且响应体与 days=30 逐字节一致
# 旧代码：Number('abc'||30) = NaN → Math.max(1, Math.min(R, NaN)) = NaN → 报表拿到 NaN
# 新代码：boundedInteger('abc', 30, 1, R) = 30
# 浏览器内（带 cookie，必须 cache-bust，见 4.3）：
#   GET /api/usage-overview?days=abc&_=<ts>  与  ?days=30&_=<ts>  →  body 字符串相等
```
**结果：相等 ⇒ 运行实例包含 `89e47da` 的服务端改动 ⇒ 重启确实做了。**
（时间维度的旁证：最新 `server/**` 提交 `89e47da` = **11:33:07**；我的探针在 11:46 之后测到新行为 ⇒ 进程在 11:33 之后启动过。）

### 4.2 ⚠️ 时间戳不可用作判据（我实测到的坑）
`server/index.ts` 的 **mtime 是 11:44:17**，晚于 `89e47da`(11:33:07) 甚至晚于 HEAD(11:42:20)——因为**那是我自己还原备份时写下的 mtime**。所以：
**判据请用「提交时间 `git log -1 --format=%ci -- server/`」或行为探针，不要用文件 mtime。**

### 4.3 另外两个测量坑（都会造成假结论）
1. **HTTP 缓存**：`/api/usage-overview` 带 `Cache-Control: private, max-age=20, stale-while-revalidate=300` —— 连续探测可能在 20s 内拿到同一份缓存体，让「两者相等」变成假阳性。我统一加了 `&_=<ts>` 且 `fetch(..., {cache:'no-store'})`。
2. **路由默认值不同**：`/api/usage-overview` 默认 **30**、`/api/dashboard` 默认 **7**（`index.ts:168,215,563,573,583,593,632,642`）——**对照基线必须取该路由自己的默认值**，否则会得到 §3.1 那种假失败。

---

## 5. (B)1 对比度扫描：**独立实现 + 与 Lead 数字对照**

### 5.1 我的实现（与 Lead 的差异点，也是结论差异的来源）
遍历 `body *`，取**含直接非空文本节点**且可见的元素；`color` 与**整条祖先背景栈按 alpha 从底向上合成**（不是「取第一个 alpha>0.95」）；字号 ≥24px 或 ≥18.66px+700 视为大字（阈值 3，否则 4.5）；跳过 `aria-hidden="true"` 子树；`disabled` 类节点单独归类。

**两处关键差异**：
1. **解析 `color(srgb r g b / a)` 语法** —— Tuffex `TxTag` 的文字计算色就是这种语法（§6.1）。只认 `rgb()/rgba()` 的实现会**静默跳过这些节点**。
2. **合成半透明背景**（12%/20% tint）——「取第一个 alpha>0.95」会把 tint 跳过、用更亮的底色，从而**高估**对比度。

### 5.2 每页结果（含 disabled 分类）与 Lead 对照

| 路由 | 我的失败数（不含 disabled） | 其中 disabled | Lead 声称（修后） |
|---|---|---|---|
| `/dashboard` | 1 | 0 | 0 |
| `/keys` | 1 | 0 | 0 |
| `/channels` | **6** | 0 | 5（禁用态豁免） |
| `/oauth` | 1 | 0 | 0 |
| `/models` | 1 | 0 | 0 |
| **`/rtk`** | **29** | 0 | 0 |
| `/charts` | 1 | 0 | 0 |
| `/analytics` | 1 | 0 | 0 |
| `/usage` | 1 | 0 | 0 |
| **`/cache`** | **38** | 0 | 0 |
| `/monitor` | 1 | 0 | 0 |
| **`/help`** | **4** | 0 | 0 |
| `/ab` | 1 | 0 | 0 |
| `/docs` | **0** | 0 | 0 ✅ |
| **合计** | **86** | 0 | ≈5 |

**逐类明细**：
- **每页都有 1 个**：`rgb(138,144,176)` on white，**3.14:1**，12px，文本 `/`，元素 `.version-trigger-divider`（VersionWidget 的版本分隔符）→ 见 R8-D。
- **`/channels` 6 = 5 + 1**：5 个 `rgb(169,174,200)` on `rgb(245,245,248)`，**2.02:1**，11px/600，`.tx-tag__content`，内容是**被停用的模型映射名**（`cline-deepseek-v4-flash` 等）+ 版本分隔符 → 见 §5.3。
- **`/rtk` 29 = 1 + 28**：`rgb(4,120,87)` on `rgb(215,231,232)` → **4.30:1**（8 个）与 on `rgb(208,225,229)` → **4.06:1**（1 个）；`rgb(91,107,133)` on `rgb(226,229,238)` → 若干（19 个）。全部是 `.tx-tag__content`，11px，**刚过不了的近阈值失败**。
- **`/cache` 38 = 1 + 37**：`color(srgb 0.868863 0.253804 0.26698)` on `rgb(246,213,216)` → **3.12:1**（16 个）与 on `rgb(252,218,218)` → **3.13:1**（15 个）；`color(srgb 0.504471…)` on `rgb(232,233,239)` → **2.92:1**（1 个）。内容为命中率标签（`0.0%`、`n/a`）。
- **`/help` 4 = 1 + 3**：`rgb(4,120,87)` on `rgb(215,231,232)` → **4.30:1**（2 个：编号 `02`/`05` 的标签）+ `rgb(180,83,9)` on `rgb(236,226,223)` → 4.3:1（1 个）+ 分隔符。

### 5.3 对 `/channels` 那 5 个的独立判断（WCAG 豁免是否成立）
实测这 5 个是 `<span class="tx-tag__content">`，`aria-disabled` 为 **null**、无 `disabled` 属性 —— 它们是**展示「哪些模型映射被停用」的文本标签**，**不是不可用的交互组件**。
- WCAG 1.4.3 的豁免原文针对「**inactive user interface components**」（例如灰掉的、点不动的按钮）。**把模型名当内容读的场景不属该豁免**。
- 我的判断：**豁免在这里是「可辩护但不应作为通行证」**——它确实承载信息（「这些映射存在但停用」）。而且用**低对比的弱化色**来表达「停用」还触及 **1.4.1 Use of Color**（此处有 `variant` 差异作为非颜色线索，所以 1.4.1 只是**部分**缓解）。
- **建议**：要么把这类信息性标签提到 ≥4.5，要么明确写进审计结论「按域内不可用语义豁免，并保留 variant 形态差异作为非颜色线索」——**不要只写「全部 0」**。
- 另：我实测是 **2.02:1**（Lead 未给单值），与我在第七轮测到的 2.19 不同，原因是本轮我做了**背景合成**（tint 叠在卡片底上）——这正是两套实现会给出不同数字的地方。

### 5.4 关于「Lead 的 0 从哪来」——标注为**推断**
`color(srgb …)` 不是 `rgb()`，一个只匹配 `rgb()/rgba()` 的解析器会把这些节点整类跳过；而 `/cache`(38)、`/rtk`(29)、`/help`(3 个标签) 的失败**恰好全部是 `.tx-tag__content`**。这与「解析器盲区」高度吻合。
**但 Lead 的脚本未入库**（`ls scripts/ | grep contrast` 为空、`git log -S contrast` 无该文件），**我无法验证其实现**，所以这只能作为**最可能的解释**，不作为已证事实。

---

## 6. (B)2 `/docs` 方向性复核 ✅ **没有任何方向性错误**

### 6.1 深色代码块**仍达标**（且方向正确）
| 选择器 | 前景 | 背景 | 对比度 | 要求 | 判定 |
|---|---|---|---|---|---|
| `.docs-code code` | `rgb(231,226,218)` = `#e7e2da` | `rgb(30,28,25)` = `#1e1c19` | **13.19:1** | 4.5 | ✅ |
| `.docs-code-head` | `rgb(188,181,170)` = `#bcb5aa` | `#1e1c19` | **8.36:1** | 4.5 | ✅ |

- `git show 8478022 -- src/docs.css` 证实：**只有 `--docs-quiet` 从 `#99938a` 改成 `#6f6a63`**，`--docs-code:#1e1c19` 与 `.docs-code code` 的前景色**未变**。
- 所以**「一度按浅底改深、随后 checkout 回退」的恢复是干净的**：深色块依旧是**浅字落深底**，且余量很大（13.19）。**没有方向性错误。**

### 6.2 `/docs` section 标签**确实变深且 ≥4.5**
| 选择器 | 前景 | 背景 | 修前 | 修后 | 判定 |
|---|---|---|---|---|---|
| `.docs-sidebar > p`（「文档目录」） | `rgb(111,106,99)` = `#6f6a63` | `#fbfaf7` | `#99938a` = **2.92:1** | **5.14:1** | ✅ |
| `.docs-hero > p`（「API DOCUMENTATION」） | 同上 | 同上 | 2.92:1 | **5.14:1** | ✅ |

**顺带纠正一个归因**：Lead 把「读到 2.92」归因为**过期 bundle**。我独立计算 **`#99938a` on `#fbfaf7` 恰好 = 2.92** —— 也就是说那个读数**很可能就是修前的真实值**，而非缓存假象。（两种可能我都无法回溯证明，但数值巧合到小数点后两位，倾向于「读数正确」。）本次我用 cache-buster 复测，读到的是新值 5.14。

### 6.3 缓存坑已按你的提示处理 ✅
- 用 `?_cb=<ts>` 打开 `/docs`；
- 核对**实际加载的样式表**：`document.styleSheets` → `http://127.0.0.1:8791/assets/docs-BbH6Q35z.css`，与 `dist/assets/docs-BbH6Q35z.css`（8300 B，11:40 构建）**同名同源**；
- 从**已加载的那张表**读取自定义属性：`--docs-quiet: #6f6a63`、`--docs-code: #1e1c19` → 确认拿到的是**新**产物，不是 `max-age=300` 的旧副本。

---

## 7. (B)3 调色板**只动了文字位**，没有误伤非文字用途 ✅

我把所有残留的亮色十六进制逐条分类（`grep` + 上下文判定）：

| 亮色残留位置 | 用途 | 判定 |
|---|---|---|
| `UsagePage.vue:453,454,472,473,474` | `.output-bar/.cache-bar/.output-dot/.cache-dot/.cache-write-dot` 的 **background** | ✅ 图形，保留正确 |
| `CachePage.vue:244,245,251` | SVG `stop-color` / `stroke`（面积图渐变与描边） | ✅ 图形，保留正确 |
| `ModelsPage.vue:740`、`MonitorPage.vue:373,377,380` | **background**（状态条/圆点） | ✅ 图形，保留正确 |
| `MonitorPage.vue:134` | `.provider-dot { background: color }` | ✅ 图形 |
| **`chartTheme.ts`** | 独立色板 `#2a78d6…#e87ba4`、`STATUS {#1baf7a,#c0392f,#eda100}`、`AXIS` | ✅ **完全未被触碰**（与被打深的 `#10b981/#f59e0b/#ef4444` 无交集） |

**结论：图形描边 / 状态圆点 / 背景全部保持原样 ✓，没有误伤。** 这部分 Lead 做得干净。

**只有一处「界定模糊」**：`MonitorPage.vue:144` `acc-avatar { background: color+'1a', color: color }` —— 把 provider 色同时用作**字母头像的文字色**（`#10b981` / `#d97757`）。这属**文字位**，理论上应随调色板变深；但 `/monitor` 当前无上游账号（空态），**实测未渲染**，所以我**无法判定**它是否超标（列为未验证项）。

---

## 8. 本轮独立新发现

### 8.1 🔴 R8-A（高，测量方法学）`color(srgb …)` 盲区让整类节点从对比度审计里消失
Tuffex `TxTag` 的文字计算色是 **`color(srgb 0.868863 0.253804 0.26698)`** 这种语法（不是 `rgb()`）。实测受影响的是**所有用 `:color` 传色的标签**：
- `/cache` 的命中率标签（37 个）、`/rtk` 的状态标签（28 个）、`/help` 的编号标签（3 个）、`/channels` 的模型标签（5 个）。
- 只认 `rgb()/rgba()` 的解析器会把它们**全部静默跳过**——`getComputedStyle` 不报错，扫描结果看起来「干净」。
- **建议**：任何对比度工具都必须解析 `color(srgb …)`（以及 `color(display-p3 …)`）并把**半透明背景按栈合成**；否则结论会系统性偏乐观。**这条比具体数字更重要**，因为它是「为什么两套实现差异 86 vs ~5」的根因候选。

### 8.2 🟠 R8-B（中）深色化在「同色 tint 背景」上不够 —— 白底达标 ≠ 实际达标
| 颜色 | 白底对比度 | **实际 tint 底** | 实测对比度 |
|---|---|---|---|
| `#047857`（原 `#10b981`） | 5.48 ✅ | `rgb(215,231,232)` | **4.30 ❌** |
| `#b45309`（原 `#f59e0b`） | 5.02 ✅ | `rgb(236,226,223)` | **4.30 ❌** |
| `#ef4444`（**未改**） | 3.76 ❌ | `rgb(246,213,216)` | **3.12 ❌** |
| `#10b981`（**未改**）/ `#f59e0b`（**未改**） | 2.54 / 2.15 ❌ | — | — |
**机制**：标签底是**同色 12–20% tint**，它压暗了有效背景，把「白底 5.48」吃掉约 1.2，落到 4.30。**这解释了为什么按白底挑色会在真实标签上差一点点。**
**建议**：选色时用**目标 tint 底**（而不是白底）算比值；或把 tint 从 12% 降到 ~8%，或把文字再压深一档（例如 `#036647` / `#8a3d07`）。

### 8.3 🟠 R8-C（中）两处遗漏
1. **`src/pages/CachePage.vue:62-67` `hitToneColor` 仍返回亮色 `#10b981/#f59e0b/#ef4444`**，且用在**两处文字位**：
   - `:216` `<strong class="stat-value mono" :style="{color: hitToneColor(totalHitRate)}">` → 24px/700，实测 **3.48:1**，**仅靠「大字阈值 3.0」通过**（余量很薄）；
   - `:306` `:color="hitToneColor(row.hitRate)"` 的 `TxTag` → **2.92–3.13:1，不达标**（共 31 个节点）。
   → 这是本页 38 个失败里的主体。
2. **`src/components/RtkBoard.vue:48` `STATE_COLOR.unauthorized: '#ef4444'`** —— 同一张映射表里 `available: '#047857'`、`degraded/unreachable/not_supported: '#92400e'`、`not_configured: '#5b6b85'` **都改深了，只漏了 `unauthorized`**；它在 `:88` 被用作 `TxTag :color`（文字位）。当前三个平面都不是 `unauthorized` 状态，所以**潜伏未显**——一旦出现「凭据被拒」就会露出亮红。

### 8.4 ⚪ R8-D（低）每页 1 个 `3.14:1` 的装饰性分隔符
`VersionWidget` 的 `/`（`.version-trigger-divider`，12px，`rgb(138,144,176)` on white = **3.14:1**），出现在**所有 13 个 Vue 路由**上。
- 它是 `Magpie 3fe2ff9 / v0.1.0` 中间的分隔符，**纯装饰**；WCAG 1.4.3 对「pure decoration」有豁免，所以**可以不改**。
- **但建议加 `aria-hidden="true"`**：一是让装饰符不再进无障碍树（现在屏幕阅读器可能念出「斜杠」），二是让任何合规扫描器都能明确豁免它，**从而让「0」这个结论真正可复现**。**一行改动。**

---

## 9. 还原证据（1 次临时改动，逐字节还原）

| 文件 | 用途 | 基线 sha256（= 还原后） | `git diff` |
|---|---|---|---|
| `server/index.ts` | 重新内联一份相同的规则字面量（验证单一真源守卫） | `dc0013537aa3c6261bddee2f1f837b01a0f6841f73cb9803e1cbe4b0dc92e000` | **空** |

```
$ shasum -a 256 server/index.ts
dc0013537aa3c6261bddee2f1f837b01a0f6841f73cb9803e1cbe4b0dc92e000   (== 基线)
$ git diff --stat -- server/index.ts     →  (空)
$ npm test                               →  exit=0  tests 588 / pass 587 / fail 0 / cancelled 0 / skipped 1
$ git status --short
?? docs/qa/red-team/shots-r8/            ← 我的本轮交付
?? public/tuffex-dashboard-preview.png   ← 本轮之前既存
$ ls -d /tmp/cac-*.lock → 不存在（两把锁均已释放）
```
临时备份与扫描脚本均已删除。**产品代码零残留；数据零写入（所有发给实例的输入都被 400 拒绝，且读回确认未变）。**

---

## 10. 未验证项

1. **Lead 的扫描器实现未验证**（脚本未入库）：`color(srgb …)` 盲区是**推断**，不是已证事实。若你愿意把脚本放进 `scripts/`，我可以直接复跑并给出逐节点 diff。
2. **`MonitorPage.vue:144` 的字母头像文字色**：`/monitor` 当前空态未渲染，**无法实测**其 `#10b981`/`#d97757` 文字对比度。
3. **`RequestDetail.vue:73` 的 HTTP 状态 `TxTag`**（`:color="success ? '#10b981' : '#ef4444'"`）：我在 `/analytics` 点行打开弹窗后**没找到该标签**（选择器未命中，可能该行 `statusCode` 为 null 或结构不同）→ **未测**。按同族推断它也会偏低（`#ef4444` 白底 3.76），但**我不做未测结论**。
4. **`RtkBoard.STATE_COLOR.unauthorized` 的实测**：当前无此状态，**潜伏未显**（结论来自读码 + 同表其它项已改深的事实对照）。
5. **`index.css:21 --success-color: #10b981`**：全仓只有定义、**无任何使用** → 判为**死变量**，不构成对比度问题（我没把它计入失败数）。
6. **对比度之外的 WCAG 项**（键盘序、ARIA、缩放、1.4.4 文本缩放等）**不在本轮范围**。
7. **非 Chromium 浏览器**：只测 ego-lite Chromium；`color(srgb …)` 的序列化形式在不同引擎可能不同，跨浏览器未验证。

---

## 11. 判据速查（可原样复跑）

```bash
# 0) 基线
git log --oneline -1                       # f0c7bcd
find src index.html docs.html -type f \( -name '*.vue' -o -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.html' \) \
     -newermt "$(stat -f '%Sm' dist/index.html)"        # 期望：空

# A1) 单一真源有牙齿（构建锁内）
for i in $(seq 1 36); do mkdir /tmp/cac-build.lock 2>/dev/null && break || sleep 5; done
shasum -a 256 server/index.ts
# 在 index.ts 里加一行 const X = '总并发必须是 0 到 500 的整数，0 表示不限速'
node --test --import tsx server/policyCopy.test.ts    # 期望 1 fail「index.ts ×1、policy.ts ×1」
cp <备份> server/index.ts && shasum -a 256 server/index.ts && git diff --stat -- server/index.ts
rmdir /tmp/cac-build.lock

# A2) 额度：只发必然被拒的输入（浏览器内带 cookie）
#   PATCH /api/keys/<id>/quota  {"totalUsd":""}   -> 400「额度不能为空」
#   PATCH /api/keys/<id>/quota  {"totalUsd":"abc"}-> 400「额度必须是数字」
#   PATCH /api/keys/<id>/quota  {"totalUsd":-3}   -> 400「总额度必须是 0 或正数」
#   随后 GET /api/bootstrap 读回该 Key 的 quota，确认未变

# A3+A4) days 兜底 + 「运行实例是否最新」（必须 cache-bust；对照基线取该路由自己的默认值）
#   注意 /api/usage-overview 默认 30，/api/dashboard 默认 7
#   GET /api/usage-overview?days=abc&_=<ts>  ==  ?days=30&_=<ts>   （逐字节相等 ⇒ 新代码在跑）
#   GET /api/usage-overview?days=7.9&_=<ts>  ==  ?days=7&_=<ts>    （floor 生效）
#   时间维度只用提交时间，不要用文件 mtime：
git log -1 --format='%ci' -- server/      # 期望早于你观测到新行为的时刻

# B) 对比度（要点：解析 color(srgb …) + 合成半透明背景 + 大字阈值 3）
#   我的实现要点（可直接抄）：
#     parse: /rgba?\(...\)/  以及  /color\(srgb\s+([^)]+)\)/   （分量 0..1 ×255）
#     bg  : 从元素向上收集所有 alpha>0 的背景，从最底向上 over() 合成
#     font: px>=24 或 (px>=18.66 且 weight>=700) -> 阈值 3，否则 4.5
#     skip: aria-hidden="true" 子树；disabled 节点单独计数
#   /docs 缓存：用 ?_cb=<ts>，并核对 document.styleSheets 的 href == dist/assets/docs-*.css
```

---

## 12. 给 Lead 的判断与建议

### 12.1 对「对比度修法有没有过度/不足」的独立判断
**方向对、没过度、但明显不足；且「全部 0」这个结论不成立。**

**做对的部分（应保留）**：
- 帮助页代码块按 TUF `.pre` 改成「浅底 + 正文色」——修掉了 1.18:1 的真问题；
- **深色代码块没有被改坏**：13.19:1，方向正确，`git checkout` 的回退是干净的；
- `--docs-quiet` 2.92 → 5.14，精准且只动一处变量；
- **图形一律没动**：bar/dot/SVG stroke/stop-color/background 全部保留原亮色，`chartTheme` 的独立色板完全未被触碰 → **没有过度**。

**不足（按优先级）**：
1. **测量方法**：必须解析 `color(srgb …)` 并合成半透明背景（R8-A）。这是 86 vs ~5 的根因候选；不修工具，后续每次审计都会得出偏乐观的「0」。
2. **选色基准**：白底达标 ≠ 实际达标，要在**目标 tint 底**上算（R8-B）。`/rtk` 28 个、`/help` 3 个都是 4.06–4.3 的**近阈值失败**，差一点点。
3. **补两个漏点**：`CachePage.hitToneColor`（31 个失败，且 `#ef4444` 白底就只有 3.76）、`RtkBoard.STATE_COLOR.unauthorized`（漏改，潜伏）。
4. **把豁免写清楚**：每页 1 个装饰分隔符（3.14）建议加 `aria-hidden="true"`；`/channels` 5 个信息性标签的「不可用组件豁免」应作为**判断**写明，并保留 `variant` 作为非颜色线索（1.4.1）。

### 12.2 服务端（A）侧的建议
1. **A2/A3 可以结案**；`days=7.9 → 7` 判为改进。
2. **纠正一处验收描述**：`days` 那条的对照基线应是「该路由的默认值」（`/api/usage-overview` = **30**，不是 7），否则会得到假失败（我本人先踩了一次）。
3. **A4 的规则本次已被遵守** ✅，建议把判据固化为**行为探针**（§4.1）而不是时间戳比较，因为 **mtime 会被任何工具/还原动作污染**（我自己就把 `server/index.ts` 的 mtime 写到了 11:44）。
4. 两个测量坑请写进流程：API 的 `max-age=20`（探针必须 cache-bust）、以及**各路由默认值不同**。
