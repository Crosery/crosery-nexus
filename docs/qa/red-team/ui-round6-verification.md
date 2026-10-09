# Crosery API Console — 第六轮 UI 对抗复验（红队 B / task-24）

**被验对象**：`805ca80`（blue-ui 第五轮：字段级校验 / 术语统一 / libImports 自检修复）、`ce8ca22`（Lead：术语收尾 4 文件）、`849e5ff`（Lead：`--test-timeout` + 导航高亮）
**本地 HEAD** `ce8ca22`｜**实例** <http://127.0.0.1:8791>｜**dist 构建时间** `2026-10-01 10:49:30`｜dist 不早于 src 已核对：`find src index.html docs.html -newermt "$(stat -f '%Sm' dist/index.html)"` → **0 个**
**审计人** `ux-auditor` / task-24｜**实测时点** 2026-10-01 10:50–11:05｜浏览器 TaskSpace `spaceId=36`（D25 字段校验）与 `37`（导航高亮 + RTK 术语），均已 `finish({keep:[]})`；浏览器锁与构建锁均已释放
**写入边界**：只写 `docs/qa/red-team/**`（新目录 `shots-r6/`，9 张截图）。临时改动 **2 次**（1 个产品文件 + 1 个临时测试夹具），**全部逐字节还原 / 删除并附证据**（§6）。**生产零写入**（D25 全程用「非 GET 短路」安全网，未创建任何 Key）。

---

## 0. 结论速览

| # | 被验主张 | 判定 |
|---|---|---|
| 1 | **R5-B 已修**：多行重排不再触发自检假阳性；删 import 仍会红 | ✅ **已验证**（重排后 **10/10 绿**，删 import 后 **1 fail**） |
| 2 | **D25 字段级校验**可用 | ✅ **已验证（全部子项通过）**；Lead 三次没触发是**工具/时序**问题，不是设计差异（真实 blur 与程序化 blur **都触发**） |
| 3 | **D30 术语统一** | ⚠️ **基本达成**：词表漂移项在活代码 UI 中已清零；**但发现 1 处死代码残留**（§4.3）+ **1 处服务端文案造成的同屏混用**（§4.4） |
| 4a | `npm test --test-timeout=30000` 让挂起**有界失败且退出码非 0** | ✅ **已验证**（挂起夹具 → `cancelled 1`、**exit code = 1**） |
| 4b | `ConsoleNav` 未匹配路由不再高亮 | ⚠️ **代码正确，但经 URL 不可达**；且 Lead 指定的 `/nope` 验证法**不会**产生预期观测（原因是 catch-all 重定向，见 §5） |

**本轮独立新发现 3 条（均为真缺陷）**：
- **R6-A（中）**：表单级错误汇总在字段修好后**不消失**，持续宣称「还有 1 处需要修改」——**两个表单都中**。
- **R6-B（中）**：`最大总并发数` **留空可通过校验**，服务端把空串**静默变成 4**。
- **R6-C（中）**：客户端规则宣告 **1–1000**，服务端 `validatePolicy` 只收 **1–500** → **表单认证了服务端会拒绝的值**，且两侧错误文案互相矛盾。

---

## 1. R5-B 复验：重放我的「多行重排」手法

**基线**：`libImports.test.ts` = **10/10 绿**（1 条真守卫 + 9 条自检）。

### 1.1 重排 1：把那行 import 仅拆成多行（我第五轮用的原手法，语义不变）
```diff
-import { sortKeyForColumn, tableSortState } from '../lib/tableSort'
+import {
+  sortKeyForColumn,
+  tableSortState,
+} from '../lib/tableSort'
```
**结果：10/10 绿 ✅**，其中自检 2 就是专门为这个假阳性设的：
```
✔ 每个 .vue 脚本用到的本地模块导出都必须被 import（防 ReferenceError 白屏）
✔ 自检 2：import 被重排成多行（语义不变）→ 不报（上一版的假阳性来源）
```
→ **第五轮那个假阳性已消除。** 第五轮同一操作是「真守卫绿、自检红」，现在是全绿。

### 1.2 重排 2：把多行 import 整段删掉
```
✖ 每个 .vue 脚本用到的本地模块导出都必须被 import（防 ReferenceError 白屏）   ← 真守卫红
✔ 自检 1..9 全绿                                                          ← 自检不再依赖生产文件
ℹ tests 10  ℹ pass 9  ℹ fail 1
```
→ **守卫仍有牙齿**，且 9 条自检**不受生产文件改动影响**（说明自检真的自包含化了）。

**代码依据**：`server/libImports.test.ts` 现在导出 `findMissingImports(script, SYNTHETIC)` 形式的**纯函数**，自检传入**测试内构造的合成源码**，不再从 `ModelsPage.vue` 抠样本（对比第五轮 `:104` 的单行正则）。自检覆盖别名 / 本地声明 / 注释与字符串 / `type` 修饰 / 默认导入 / 命名空间导入，并**显式记录模板盲区**（自检 7）。这是我第五轮建议的形状。

**判定：R5-B 结案。**

---

## 2. D25 字段级校验：**做实了**（Lead 三次未触发的结论）

> 先说结论：**Lead 没触发不是设计问题**。我用真实交互与程序化 `blur()` 两条路径都稳定触发；他的失败更像 `page.click` 时序/选择器问题。我用的手法是：点开弹窗后 **`waitForSelector('[data-field="name"]')` 再操作**，并且用「点击另一个字段」制造**真实失焦**。

### 2.1 逐项实测（`/keys` → 创建 API Key）

| 项 | 实测结果 | 判定 |
|---|---|---|
| 弹窗可开、字段容器可定位 | `title='创建新 API Key'`，`[data-field]` = `name, note, groups, totalConcurrency` | ✅ |
| **名称留空 + 真实失焦** | 错误「请填写显示名称（1–40 个字符），它会显示在 API Key 列表里」；`aria-invalid="true"`；`role="alert"`；**`errBelowControl: true`**（错误在控件正下方） | ✅ |
| **名称留空 + 程序化 `blur()`** | **同样触发**（`el.blur()` + `dispatchEvent(new FocusEvent('blur'))` → 同一文案 + `aria-invalid="true"`） | ✅ **否定了「只有真实失焦才触发」的猜测** |
| 文案是否含「怎么改」 | 是：「请**填写**显示名称（1–40 个字符），**它**会显示在 API Key 列表里」 | ✅ |
| **重名**（填已存在的「张三」） | 「已有同名 API Key，**请换一个名称**（或先改掉那一个已有的）」；`aria-invalid="true"` | ✅ |
| **并发填 `0`** | 「并发数请填 1–1000 的整数；**不限速请打开「不限速」开关**」；`aria-invalid="true"` | ✅ |
| **额度填 `-5`**（额度弹窗） | 「单日额度请填 0–1000000 之间的数字；**留空表示不限制**」；`aria-invalid="true"`（仅该字段） | ✅ |
| **提交时汇总 + 焦点落到首个出错字段** | 名称合法 + 并发 `0` 时提交 → 汇总「**还有 1 处需要修改，已定位到第一个字段。**」；**`document.activeElement` = `INPUT[aria-label="最大总并发数"]`，最近的 `[data-field]` = `totalConcurrency`** | ✅ **焦点精确落在首个“出错”字段，而不是名称栏** |
| 同一测试在额度弹窗 | 汇总「额度数值需要修改，已定位到第一个字段。」；**`activeElement` = `INPUT[aria-label="单日额度（美元）"]` / `data-field="daily"`** | ✅ |
| **修正后字段错误消失** | 并发改 `8` → 字段错误与 `aria-invalid` 均消失；额度改 `100` → 同样消失 | ✅ |

**关于额度弹窗的一个中间误判（记录以免误导）**：我一度以为额度字段缺 `data-field`（首次打开的 Key 是「不限额度」，三个数值框被 `v-if` 隐藏，所以查不到）。换成**有限额的 Key**（「用户 A」）后 `[data-field]` = `daily, weekly, total` 全部存在，焦点定位正常。**该怀疑已被自己推翻，不是缺陷。**

### 2.2 验证过程中的安全网
全程在页面内把**所有非 GET 请求短路成假 200**（`window.__w` 记录），实际捕获到唯一一次 `POST /api/keys`（即 §4.2 的空并发用例），**服务端从未被触达**；验证后 `/keys` 列表仍为 **14 个 Key**，且不含我在表单里用的临时名 `r6-redteam-temp-name` ✓ **生产零写入。**

**判定：D25 结案（已修且可用）。**

---

## 3. D30 术语统一：独立全站扫描

**方法**：按 blue 词表（`docs/qa/blue/round5-fixes.md:74-85`）建立 8 个漂移词的正则，扫 `src/**` 全部活代码，并**把「允许的例外」做子串排除**（`上游账号池` 含 `账号池`、`渠道分组` 含 `渠道组`、`上游密钥` 含 `密钥`），分三组统计：活代码 UI / legacy 冻结副本 / server。

### 3.1 活代码 UI（排除 `src/ab/variants/legacy/`，50 个文件）
| 漂移词 | 应为 | 命中 | 逐条判定 |
|---|---|---|---|
| 配额 | 额度 | **0** | ✅ |
| 账号池 | 上游账号池 | **0** | ✅（例外生效） |
| 渠道组 | 渠道分组 | **0** | ✅（例外生效） |
| 服务渠道映射 | 渠道来源 | **0** | ✅ |
| 渠道账号 | 渠道 | **1** | 非 UI：`ab/flows.ts:140` 是 A/B 自检**标准文案**，它在**列举不该混用的词**（「渠道 / 渠道账号 / 中转站」），**假阳性** |
| 中转站 | 网关 / 远端网关 | **5** | 逐条见下 |
| 限额 | 额度 | **2** | 1 条**假阳性**（`KeysPage.vue:564` 实为「不限额度」，我的子串匹配误报）；1 条真命中（`ab/flows.ts:58`「总计**限额**」，A/B 任务说明文案，**低**） |
| 密钥 | API Key | **4** | 逐条见下 |

**「中转站」5 条逐条**：
- `RtkPage.vue:167`「按「内核 → **远端网关（即中转站）** → 本机」…」→ **有意对译**，主词已是「远端网关」，括注旧词属于**有益的双语桥接**，不是漂移。
- `HelpPage.vue:295`「把 RTK 装在**远端网关（中转站）**上…」→ 同上，**有意对译**。
- `HelpPage.vue:84`（`// ` 注释）、`router.ts:22`（`// ` 注释）→ **非用户可见**。
- `ab/flows.ts:140` → **假阳性**（列举反例）。
→ **用户可见的真漂移：0 条。**

**「密钥」4 条逐条**：
- `AbLabPage.vue:191`「不会记录 API Key / 密码 / Prompt 内容；粘贴到理由里的**疑似密钥**会被服务端替换成「[已隐去疑似密钥]」」→ 指的是**自由文本里长得像密钥的秘密串**，不是「本产品访问密钥」这个实体；且该字符串必须与 `server/abLab.ts:118` 的替换结果字面一致，**改反而会造成不一致**。**正当例外。**
- `ab/preference.ts:8`（注释）→ 非用户可见。
- **`gatewayStatus.ts:18-19`「密钥数据暂时不可用」「正在读取密钥数据」→ 不符合词表**，但见 §4.3：**是死代码**。

### 3.2 legacy 冻结副本（`src/ab/variants/legacy/`，4 文件）
命中：中转站 1、限额 2、账号池 1、渠道组 1、**密钥 25**。
**判定：正当例外，不是缺陷。** 依据：`src/ab/registry.ts:4-7` 明确写着 A 侧是 `git show 281c30e:<path>` 的**冻结页面副本**，其存在目的就是「迁移前」对照；`AbLabPage` 也自述「A = 迁移前（提交 281c30e 的冻结副本）」。改它们的文案会**破坏对照实验的唯一价值**。
**唯一提醒**：`/ab?flow=…&v=a` 是可达的，因此这些旧词**对用户可见**——但同页已标明它是「迁移前」且为只读对照，属**明示的历史快照**。

### 3.3 词表例外的核对
- 「上游密钥」：`ChannelsPage.vue` 表单标签已使用；活代码中**「密钥」的其余出现均非该实体或非 UI**（§3.1）→ **例外被正确使用** ✓
- 「上游账号池」：活代码 `账号池` 命中 0，说明旧写法已全部替换 ✓
- 「渠道来源」：`服务渠道映射` 命中 0 ✓

**判定：D30 基本达成**（活代码 UI 的漂移词已清零，例外使用正确）。残留见 §4.3 / §4.4。

---

## 4. 本轮独立发现

### 4.1 R6-A（中）表单级错误汇总在字段修好后**不消失**，持续给出**假陈述**（两个表单都中）
**现象**：提交触发的表单级汇总 `editorError` / `quotaError` 只在**下一次提交**时被清空；用户把字段逐个改对后，字段旁错误与 `aria-invalid` 都消失了，但汇总**仍然**显示「还有 N 处需要修改，已定位到第一个字段。」

**实测**：
| 表单 | 修正前 | 全部字段修好后 |
|---|---|---|
| 创建 API Key | 汇总「还有 1 处需要修改，已定位到第一个字段。」 | 字段错误 0 条、`aria-invalid` 全为 null，**汇总仍在**（跨脚本仍存在） |
| 额度弹窗 | 汇总「额度数值需要修改，已定位到第一个字段。」 | `fieldErrors: []`、`ariaInvalid: [null,null,null]`，**汇总仍在** |

**为什么是真缺陷**：此时表单**已经合法**，汇总却在断言还有 1 处错误。用户会去**找一个不存在的错误**；反复提交也只在“通过”的那次才把它清掉（`KeysPage.vue:283` `editorError.value = ''` 在成功路径上）。修法很小：在 `validateEditorField`/`validateQuotaField` 判定通过后，若已无任何字段错误则清空对应的汇总文案（或把汇总改成**从 `editorFieldErrors` 派生**的 computed，而不是独立 ref——派生就不会失同步）。

**证据**：`shots-r6/keys-字段校验-旧汇总残留-桌面.png`、`shots-r6/keys-额度校验-修正后旧汇总残留-桌面.png`

### 4.2 R6-B（中）「最大总并发数」**留空可通过校验**，服务端把空串**静默变成 4**
**证据链（两侧都实测/读码，并标注哪一步是推断）**：
1. **客户端规则允许空**：`src/lib/validation.ts:76-86` 的 `numberInRange` 与 `:88-97` 的 `integerInRange` 都有 `if (value.trim() === '') return true`。对**额度**这是对的（其文案就说「留空表示不限制」），但**并发数有独立的「不限速」开关**，其文案是「并发数请填 1–1000 的整数；**不限速请打开「不限速」开关**」——即空**不该**被接受。这两个规则被共用，语义被顺带继承了。
2. **实测表单行为**：名称为合法值、并发框清空 → 失焦**无字段错误**；点击「立即创建」→ **校验通过**，发出写请求。我截获到的请求体为：
   `{"name":"r6-redteam-temp-name","note":"","enabled":true,"groups":["openrouter"],"totalConcurrency":"", "groupConcurrency":{"openrouter":2}}`
   —— **`totalConcurrency` 是空字符串**。
3. **服务端读码 + 纯表达式验证**（`server/index.ts:464`）：
   `const totalConcurrency = req.body?.totalConcurrency === 0 ? 0 : Number(req.body?.totalConcurrency || 4)`
   我用同样的表达式验证：`"" → 4`、`"0" → 0`、`0 → 0`、`"8" → 8`。
4. **`validatePolicy` 事后拦不住**：`server/policy.ts:9-11` 只检查 `Number.isInteger && >=0 && <=500`，而空串已被**上一步折算成 4**（合法整数）→ 通过。

**净用户影响**：用户把「最大总并发数」留空（可能想表达“不限制”，也可能只是没填），**不会报错**，最终该 Key 的并发被**静默设为 4** —— 一个用户从未输入、也从未看到的数字。若用户本意是不限速，他得到的是一个隐藏的并发上限 4。
**诚实标注**：第 1、2 步是**实测**；第 3、4 步是**读码 + 纯函数/表达式验证**（我**没有真的创建 Key**，因此“库里最终是 4”是**代码推导**而非端到端观测）。
**最小修法**：给并发单独一条不允许空的规则，或让 `integerInRange` 增加 `allowEmpty` 选项（额度传 true、并发传 false）。

### 4.3 R6-E（低）`gatewayStatus.ts` 的 `emptyKeyListCopy` 是**死代码**，且其中文案不符合词表
- `emptyKeyListCopy`（`src/gatewayStatus.ts:15-20`）**没有任何 UI 调用者**；全仓库唯一引用是它自己的测试 `server/gatewayStatus.test.ts:18-21`。
- 其中的「**密钥**数据暂时不可用」「正在读取**密钥**数据」按词表应为「API Key 数据」。
- **诚实降级**：因为它不渲染，**这不是一个用户可见的术语缺陷**，而是「死代码 + 死代码里没跟上词表」。我把上一节的扫描结论按此修正（§3.1 的「密钥」命中里，只有这一条与词表冲突，但不可见）。
- **建议**：要么删除该函数（连带它的 4 条测试断言），要么在别处真正用起来并同时改词。**不要**只改文案而留着不用的函数。

### 4.4 R6-D（低）服务端文案造成 `/rtk` **同屏混用**「远端网关」与「中转站」
Lead 问「不改服务端字符串会不会留下用户可见矛盾」——**答案是：会，但仅限 RTK 一个面，且有缓解。**
- **用户可见的服务端字符串**（4 条，均为被序列化进响应并渲染的 `detail`/错误消息）：
  - `server/rtkPlane.ts:317` `detail: '管理密钥被中转站拒绝'`
  - `server/rtkPlane.ts:320` `detail: '中转站未暴露 /api/library/rtk（当前指向的可能是 CPA 主机）'`
  - `server/rtkService.ts:1306` `中转站没有可用的 RTK 写入面（…），控制台不发起写请求`
  - `server/rtkService.ts:1359` `中转站没有可用的 RTK 管理面（…），控制台不发起写请求`
- **确证它们真的上屏**：`src/components/RtkBoard.vue:94` 渲染 `<p class="plane-detail">{{ plane.detail }}</p>`；`planes` 是 `/api/rtk/status` 载荷的一部分（`server/rtkService.ts:54,521,537,550,564,584`）。**浏览器实测 `/rtk` 渲染文本**：
  - 出现「远端网关」**且**出现「中转站」（2 次）
  - 一条是第 167 行的对译「远端网关（即中转站）」
  - **另一条就是 plane detail**：`中转站未暴露 /api/library/rtk（当前指向的可能是 CPA 主机）`——与 `planeDetails` DOM 数组吻合
- **缓解程度**：同页第 167 行**已经把两个词显式等同**（「远端网关（即中转站）」）。所以用户看到的是「标签叫远端网关、详情里叫中转站」，但**紧接着就有对译**；对同一屏的读者不至于误解。**严重度：低（一致性/观感），不阻塞。**
- **我的建议**：**同意 Lead 的决定（不改服务端字符串）**，理由：① 这 4 条是**探测失败的原因说明**，改动面涉及 `rtkPlane/rtkService` 并有测试断言；② 唯一受影响的面（RTK）**已经**有对译兜底；③ 若将来要改，**优先在后端加一句对译**（如「远端网关（relay）」）而不是在 UI 里再塞一次旧词。**若要彻底一致**，最小改动是在 `rtkPlane.ts`/`rtkService.ts` 的这 4 条里把「中转站」替换成「远端网关」——纯文案、无逻辑影响，但**需你决定是否值得为此触服务端**。

---

## 5. Lead 的两处改动复核

### 5.1 `npm test --test-timeout=30000`：**已验证（有效）**
`package.json` 的 `test` / `test:magpie` / `test:backfill` 都带上了该参数（`:24,:40,:41`）。
- **（a）flag 语义（`/tmp` 夹具，零仓库写入）**：`node --test --test-timeout=30000 /tmp/r6-hang.test.mjs` → `'test timed out after 30000ms'`、`cancelled 1`、**node exit code = 1** ✓
- **（b）仓库脚本确实带上了该 flag**（临时在 `server/` 放一个挂起夹具，**随后删除**）：`npm test` → **`tests 579 / pass 577 / fail 0 / cancelled 1`，npm exit code = 1** ✓，且输出点名了出问题的文件。
- **结论**：R5-A 那条「无界挂死」已被修复为**有界失败 + 非零退出码**。
- **残留提醒（与我在第五轮的观察一致，且现在仍然成立）**：即使有超时，汇总里 **`fail` 仍是 0**、失败计入 **`cancelled`**。所以**门禁必须按退出码判定**；任何「grep `fail` 计数」的门禁仍会漏掉这类失败。这是**用法约定**问题，不是这次修复的缺陷，但值得写进 CI 说明。

### 5.2 `ConsoleNav` 未匹配路由不再高亮：**代码正确，但 `/nope` 无法验证它——且高亮是对的**
- **代码**：`src/components/ConsoleNav.vue:52-59` 已改为 `return found ? found.value : ''`（原来 `: 'dashboard'`）✓ 方向正确。
- **实测 `/nope`**：最终 URL = **`/dashboard`**，活跃项 **1 个 =「运行概览」**，`aria-current="page"`；与直接访问 `/dashboard` 的状态**完全相同**。
- **原因**：`src/router.ts` 有 catch-all `{ path: '/:pathMatch(.*)*', redirect: '/dashboard' }`。所以 `/nope` **先被重定向到 `/dashboard`**，随后高亮「运行概览」是**因为用户确实在运行概览页**——**不是幻影高亮**。
- **进一步核对**：把 `router.ts` 的子路由与 `navEntries` 的 `value` 做集合差 → **两边完全一致（13 == 13，差集为空）**。也就是说：**今天没有任何可达路径会落到 `found === undefined` 分支**。
- **判定**：D32 的修复**正确但当前是「潜伏性防御」**——它为「以后往 router 加了路由却忘了加导航项」这类未来错误兜底。**Lead 指定的验证方法（访问 `/nope` 期望“不高亮任何项”）在现有路由表下不可能产生该观测**，请改用：① 静态核对 `router.ts` 子路由 ⊆ `navEntries`（可用上面的差集命令，今天为空即通过）；② 或在新增路由时把这条差集检查做成测试。
- 附加观察：`ConsoleNav` 对 13 个导航项都设置了 `aria-current="page"`（实测 `ariaCurrent` 数组），语义正确 ✓

---

## 6. 还原证据（2 次临时改动，全部还原/删除）

| 对象 | 类型 | 基线 sha256 | 还原后 | `git diff` |
|---|---|---|---|---|
| `src/pages/ModelsPage.vue` | 产品代码（拆行 → 删 import） | `e7ef19f52490b06d966b44db8a7f04d732ec87605227ab973709cfdaa4896b3a` | **同左（一致）** | 空 |
| `server/zz-r6-temporary-hang.test.ts` | 临时测试夹具（新建） | — | **已 `rm` 删除** | 不出现于 `git status` |

**最终核对**：
```
$ shasum -a 256 src/pages/ModelsPage.vue
e7ef19f52490b06d966b44db8a7f04d732ec87605227ab973709cfdaa4896b3a   (== 基线)
$ git diff --stat -- src/pages/ModelsPage.vue     →  (空)
$ git status --short
?? docs/qa/blue/shots/lead-field-validation.png   ← 他人（blue）的产物
?? docs/qa/red-team/shots-r6/                     ← 我的本轮交付
?? public/tuffex-dashboard-preview.png            ← 本轮之前既存
$ npm test  →  tests 578 / pass 577 / fail 0 / cancelled 0 / skipped 1   (exit 0)
$ ls -d /tmp/cac-*.lock  →  不存在（两把锁均已释放）
```
（`npm test` 在删除夹具后回到 **578/577/0/0/1**，即基线；含夹具时为 579。临时文件已清理。）

---

## 7. 未验证项

1. **R6-B 的“库里最终是 4”是代码推导，不是端到端观测**：我**没有真的创建 Key**（生产零写入），因此 `"" → 4 → 存库` 的最后一跳未被实测；可安全验证的方式是让被测环境用一个临时库跑一次创建。
2. **R6-C 的“用户会看到服务端 400”未做端到端**：两侧规则与文案都是**读码 + 纯函数调用**（`validatePolicy` 我已直接调用验证），但「表单放行 600 → 提交被拒」的完整链路未实测（同样为避免真实写入）。
3. **对比度**：未量化，本报告**不含对比度结论**（沿用前五轮口径）。
4. **非 Chromium 浏览器**：只测 ego-lite Chromium。
5. **`/ab?flow=…&v=split`**：未测（本轮未涉及）。
6. **`/rtk` 的其余服务端文案**：我只核对了含「中转站」的 4 条；`detail` 里其他措辞是否符合词表未逐条审。
7. **服务端其他错误文案**（非 RTK）是否含漂移词：本轮的扫描只覆盖了 8 个漂移词；`server/` 范围外我按约定**只统计不判定**。

---

## 8. 判据速查（可原样复跑）

```bash
# 0) 基线
git log --oneline -1                       # ce8ca22
find src index.html docs.html -type f \( -name '*.vue' -o -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.html' \) \
     -newermt "$(stat -f '%Sm' dist/index.html)"        # 期望：空

# 1) R5-B 重放（构建锁内）
for i in $(seq 1 36); do mkdir /tmp/cac-build.lock 2>/dev/null && break || sleep 5; done
shasum -a 256 src/pages/ModelsPage.vue                  # 记基线
#   重排: 'import { a, b } from ...' -> 多行形式   => 期望 libImports 10/10 绿
node --test --import tsx server/libImports.test.ts
#   删除整段 import                                  => 期望 1 fail（真守卫红、9 条自检仍绿）
node --test --import tsx server/libImports.test.ts
cp <备份> src/pages/ModelsPage.vue; shasum -a 256 src/pages/ModelsPage.vue; git diff --stat -- src/pages/ModelsPage.vue
rmdir /tmp/cac-build.lock

# 2) 挂起用例是否有界失败（临时夹具，记得删）
printf "import test from 'node:test'\ntest('t', async () => { await new Promise(() => {}) })\n" > server/zz-tmp-hang.test.ts
timeout 150 npm test; echo "exit=$?"     # 期望 cancelled 1 且 exit=1
rm server/zz-tmp-hang.test.ts && git status --short     # 期望该文件不再出现

# 3) D32：路由 ⊆ 导航（今天应为空差集）
python3 - <<'PY'
import re
r=open('src/router.ts').read(); n=open('src/components/ConsoleNav.vue').read()
routes=set(re.findall(r"path:\s*'([^']*)'", r.split("children: [",1)[1].split("],",1)[0]))-{''}
navs=set(re.findall(r"\{ value: '([^']+)', label:", n))
print("router-not-in-nav:", sorted(routes-navs) or "none")
PY

# 4) 术语扫描（8 个漂移词 + 例外子串排除）见本报告 §3 的脚本
```

浏览器关键判据（`spaceId=36/37`，均已实测）：

| 项 | 操作 | 期望 |
|---|---|---|
| 字段错误 | `waitForSelector('[data-field="name"]')` 后清空 → 点 `[data-field="note"] textarea` | `[data-field="name"] .field-error` 出现、`aria-invalid="true"`、错误在控件下方 |
| 程序化 blur | `el.focus(); el.blur()` | **同样触发**（非“仅真实失焦”） |
| 提交定位 | 名称合法 + 并发 `0` → 点「立即创建」 | 汇总「还有 1 处…」+ `activeElement` 的 `[data-field] = totalConcurrency` |
| 额度 | 打开**有限额**的 Key → 日额度 `-5` → blur | 单字段错误 + `aria-invalid="true"`；提交后焦点 = `data-field="daily"` |
| 汇总残留 | 把所有字段改对 | **错误消失但汇总仍在**（R6-A） |
| `/nope` | 访问 | 落 `/dashboard`、高亮「运行概览」（**正确**，非幻影；因 catch-all 重定向） |
| `/rtk` | 访问 | 同屏出现「远端网关」与「中转站」，后者出现在 `.plane-detail`（R6-D） |

---

## 9. 给 Lead 的建议（按性价比）

1. **R6-C 最该先修（一行）**：把 `KeysPage.vue:86` 的 `integerInRange(1, 1000, …)` 改成 **`integerInRange(1, 500, …)`** 并同步文案（服务端 `server/policy.ts:9` 是 **0–500**）。现在表单会把 501–1000 判为合法、再由服务端拒绝，且两侧错误文案互相矛盾（1–1000 vs 0–500）。
2. **R6-B（小改）**：给并发字段加“不允许空”的规则（或给 `integerInRange` 加 `allowEmpty` 选项，额度传 `true`、并发传 `false`），否则留空会被服务端静默折算成 4。
3. **R6-A（小改）**：把 `editorError`/`quotaError` 改成**从字段错误派生**的 computed，或在字段全部通过与时清空；否则“已修好却仍宣称有错”会一直存在。
4. **R6-E（清理）**：删除死代码 `emptyKeyListCopy` 及其 4 条断言，或真正用起来并同时改词——不要只改文案留着不用。
5. **R6-D：同意你不改服务端字符串**（对译已兜底、改动面含测试）；若要彻底一致，那 4 条 `detail` 的措辞可整体替换为「远端网关」，属纯文案。
6. **D32 的验收方式要换**：`/nope` 走的是 catch-all 重定向，永远测不到 `found === undefined` 分支。改用「`router.ts` 子路由 ⊆ `navEntries`」的差集检查（今天为空）；或者干脆把这条差集做成测试，替代一次性的手工验证。
7. **`fail` vs `cancelled` 的 CI 约定**：超时修复已让退出码非 0，但汇总里 `fail` 仍为 0；请在 CI 说明里写明**按退出码判定**。

**结案项**：**R5-B ✅ 已修**（我的原手法不再假阳性、删 import 仍会红）；**D25 ✅ 已修且可用**（Lead 未触发是工具问题，真实/程序化 blur 都触发）；**D30 ✅ 基本达成**（活代码 UI 漂移词清零、例外使用正确）；**Lead 的测试超时 ✅ 有效**。
