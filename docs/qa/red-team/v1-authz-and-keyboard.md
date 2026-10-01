# Crosery API Console — 第二十六轮：`/v1` 跨 Key 越权 + provider 补验 + 键盘可达性（红队 B / task-70）

**审计人** `ux-auditor` / task-70｜**取证 HEAD** `8fc7cd2`（工作树**干净**，task-67 已提交）
**边界**：只写 `docs/qa/red-team/**`；**生产只读**；**未重启/未停任何服务**；临时实例用 `mktemp` + 备用端口 + **干净副本**（`git archive HEAD`）+ 临时 `DATA_DIR`；浏览器锁用后即释放，TaskSpace **恰好 1 次** `finish({keep:[]})`，**未清 cookie/存储**。

---

## 0. 结论速览

| # | 项 | 判定 |
|---|---|---|
| A | `provider` 穿越（`start` + `callback` × 8 变体） | ✅ **已验证**：无效 provider 全部被拒、**无文件残留**；但发现 **`/start` 与 `/callback` 状态码不一致**（R26-A，低） |
| B | `/v1/usage` **跨 Key 越权（本轮重点）** | ⚠️ **数据隔离未能验证**：`/v1/usage` 对**两个合法 Key 都返回 500**，根因 `CPA_MANAGEMENT_KEY 未配置`（环境/耦合问题，**不是越权**）⇒ 正向隔离无法测；但**负向鉴权全部已验证**，并发现 **R26-B（中低）：`/v1/usage` 硬依赖管理面** |
| C | 键盘可达性/焦点管理 | ✅ **2 条已确认**（焦点完全不可见 = WCAG 2.4.7 失败；无 skip link）｜⚠️ **对话框/错误 aria 未能验证**（我的登录提交探针失败，见 §C.3） |

**新发现 3 条**：**R26-A**（低）`/start` 对非法 provider 返回 500 而非 400｜**R26-B**（中低）`/v1/usage` 在管理面不可用时对其**终端用户**返回 500，而同族 `/v1/usage/requests` 正常｜**R26-C**（中）**焦点指示器完全缺失**。

---

## A. provider 穿越补验（路由形状已由 Lead 给出）

**方法**：干净副本起临时实例，`POST /api/cpa/oauth/start` 与 `/api/cpa/oauth/callback`，body 里 `provider` 各 8 个变体。

| provider 变体 | `/callback` | `/start` |
|---|---|---|
| `CODEX`（大小写） | 500 `CPA_MANAGEMENT_KEY 未配置` | 500 同 |
| `"  codex  "`（前后空格） | 500 同 | 500 同 |
| `..%2f..%2fevil` | **400 不支持的 OAuth 提供商** | **500** 含同句错误 |
| `/etc/passwd`（绝对路径） | **400** | **500** |
| `%00codex` | **400** | **500** |
| `../../evil` | **400** | **500** |
| `\u202eetc`（RTL 覆盖符） | **400** | **500** |
| 500×`A`（超长） | **400** | **500** |

**判读**：
- ✅ **穿越不成立**：所有路径型/编码型/Unicode 型 provider 都被 **400 拒绝**，报文含可选值列表；**`/tmp` 下 0 个 `evil|passwd` 文件，data 目录只有 `console.db*` 与 `gateway-pricing.json`** ⇒ **没有越界写文件** ✓
- ✅ `CODEX` / `"  codex  "` 通过校验是**合理的**（provider 名校验大小写不敏感且 trim，解析到合法 provider `codex`，不是路径）——但它们随后因缺管理密钥而 500，**与 provider 无关**。
- 🟡 **R26-A（低）**：**同一非法输入，`/callback` → 400，`/start` → 500**。500 会让客户端与监控误判为"服务端故障"，而 5xx 也被某些重试策略放大。**触发条件**：任何非法 provider 打 `/start`。**建议**：`/start` 与 `/callback` 共用同一个校验→400 的出口。

---

## B. `/v1` 跨 Key 越权（本轮重点）

**判据**（按任务）：本控制台是单管理员模型，但 `/v1/*` 是**给别人用的 Key 级面** ⇒ 判据是「**Key 只能看自己的数据**」。

**方法**：临时实例（干净副本）直写临时库造 **3 个 Key**（A、B、一个 `enabled=0` 的 D），各带**互不相同**的 `usage_hourly_rollup` 行，标记模型 `MODEL-ONLY-A/B/D`，用**返回集合**（是否出现别的 Key 的标记模型）而不是条数来判定。

### B.1 已 ✅ 验证的部分（负向鉴权）
| 请求 | 结果 |
|---|---|
| 无 `Authorization` | **401** `invalid_api_key`，**无数据** |
| 错 Key（`sk-NOPE`） | **401**，无数据 |
| **已禁用 Key D**（`enabled=0`） | **401**，无数据 |
| 管理员**会话 cookie** 打 `/v1/usage` | **401**（会话不能提升为 Key 级接口）|
| `Authorization: Bearer <session secret>` / `Bearer admin` | **401** |
| `Bearer KeyA` + **cookie** 同时带 | 500（环境，见 B.2），**未变成管理级** |
⇒ **无 Key/错 Key/禁用 Key 一律 401 且不返回数据** ✓；**没有把 Key 级提升成管理级** ✓

### B.2 ⚠️ 未能验证的部分（正向数据隔离）+ 由此发现 R26-B
**两个合法 Key（A 与 B）打 `/v1/usage?days=30` 都返回 500 `{"error":"服务器内部错误"}`。** 我抓了服务端日志定位根因：
```
[error] GET /v1/usage?days=30 → 500
Error: CPA_MANAGEMENT_KEY 未配置
```
⇒ **500 是环境/依赖造成的，不是越权、也不是 Key 鉴权缺陷**；但它**同时也挡住了我验证"A 只能看到 A 的数据"**（数据路径根本没跑起来）。**因此 B 的正向隔离结论：未验证。**

**参数注入式越权（A 的 Bearer + B 的标识）**：7 个变体 `keyId=hashB`、`key=hashB`、`hash=hashB`、`key_hash=hashB`、`keyHash=hashB`、`keyId=sk-BBB-key-B`、`key=sk-BBB-key-B` → **全部 500、返回集合里没有任何 B 的标记模型** ⇒ **未观察到越权**，但因为响应同为 500（环境），**这不构成"干净拒绝"的证据**，只能记为"**未观察到泄露**"。

**代码旁证（不是验证，仅说明期望形状）**：`server/index.ts:224-236` 的 `publicUsageKey()` 用 `Bearer` token 查 `api_keys WHERE key_value = ?` 取出该 Key 行，随后 SQL 用 `WHERE key_hash = ?` 绑定**该 Key 自己的 hash**，且**没有读取任何 `req.query` 里的 key 标识** ⇒ 结构上只可能返回自己的数据。**但读码 ≠ 验证，仍需在能跑通的环境里补测。**

🟡 **R26-B（中低，新发现）**：**`/v1/usage` 硬依赖 CPA 管理面**（`activeProviderPredicate(await listGroupsForReporting(), 'provider')`），于是**管理密钥缺失或网关短暂不可用时，面向终端用户的自助用量接口直接 500**；而**同族的 `/v1/usage/requests` 在同一环境返回 200**（52 B 正常空结果）⇒ **同族两端点可用性不一致**。
**影响**：这是给外部用户用的接口，网关抖动会把"查自己的用量"变成 500，且用户无从得知原因。**建议**：管理面不可用时降级为"不做 provider 过滤"（或缓存上次分组），至少不要 500；并对齐两个端点的依赖。
**触发条件**：`CPA_MANAGEMENT_KEY` 未配置 / 管理面不可达。

---

## C. 键盘可达性 / 焦点管理（从未做过）

**方法**：ego 真浏览器，`http://127.0.0.1:8791/login`，读 `getComputedStyle` 在 **focus 前 / blur 后 / focus 后**三态对比。

### C.1 ✅ 已确认问题 #1（中）：**焦点指示器完全不可见**（WCAG 2.4.7 失败）
```
input[type=password]: before=none|3px|rgb(21,27,69)|none|rgb(21,27,69)|transparent
                      blurred= 同上            focused= 同上        changes=false
button:               before=none|3px|rgb(51,70,200)|none|...       changes=false
```
- **`outline-style: none`**（即使声明了 `outline-width: 3px` 也不会绘制）+ **`box-shadow: none`** + **边框色与背景色在 focus 前后完全相同** ⇒ **键盘用户看不到焦点在哪**。
- **操作步骤**：打开 `/login` → 用 `Tab` 移动焦点 / 对输入框与按钮分别 `focus()` → 读三态计算样式。
- **证据**：上方数值 + 截图 `shots-r26/focus-ring-login.png`（无可见环）。
- **级别**：**中**（登录页是唯一入口；WCAG 2.4.7 属 A 级）。
- **建议**：`*:focus-visible { outline: 2px solid <高对比色>; outline-offset: 2px }`，并保留 `:focus` 的降级样式。

### C.2 ✅ 已确认问题 #2（低-中）：**没有 skip link / 导航 landmark 缺失**
- 登录页匹配"跳过/跳到/skip"的元素 **0 个**；`<main>`/`[role=main]` **存在**，但 `main+nav` 类 landmark **合计只有 1 个**（无 `nav`）。
- **影响**：键盘/读屏用户无法跳过重复内容或按 landmark 快速跳转；在登录这种短页面上影响小，**但应用页（多区块）未复测**（见 C.3）。
- **建议**：加 `<a href="#main" class="skip-link">跳到主内容</a>` 作为首个可聚焦元素；导航加 `<nav>` landmark。

### C.3 ⚠️ 未能验证（我的探针失败，如实说明）
- **`Tab` 顺序**：只确认**前 3 个可聚焦元素顺序合理**（账号输入框 → 密码输入框 → 「进入控制台」按钮）。我原来的"模拟 Tab"循环**卡在同一个按钮上重复 8 次**，是**探针缺陷**，不构成 Tab 顺序证据。
- **对话框 focus trap + Esc + 焦点归还**：**未运行**（`opened:false`，因为仍在登录页，找不到触发按钮）。
- **表单错误可被读屏感知**：**未能验证**——我观察到 `aria-invalid=0`、`role=alert` **0 个**、只有一个 `aria-live="polite"` 空区域、页面无可读错误文案；**但同一探针用「正确密码」也没能登录成功**（`location.pathname` 仍是 `/login`）⇒ **探针的提交机制（直接赋 `value` + `dispatchEvent('input')` 驱动不了 Vue 的 v-model）本身是坏的**，所以**不能据此断言"登录失败无反馈"**。
- **修复方式（给后续复跑）**：用 `page.keyboard.type()` 逐字符输入 + `page.keyboard.press('Enter')`（或点真实的 submit 按钮后再等待网络空闲），不要直接赋 `value`；这样正确密码能登录后再测对话框与错误 aria。
- **应用页的 skip link / 焦点可见性**：**未测**（同样被登录失败挡住；C.1/C.2 的结论**仅对登录页成立**）。

---

## D. 未验证清单（本轮）

1. **`/v1/usage` 的正向数据隔离**（A 只能看 A）——被 `CPA_MANAGEMENT_KEY` 挡住；**需在有 CPA stub 或管理密钥的实例上补测**（这是本轮最该补的一条）。
2. `/v1/usage/requests` 的**内容级**隔离：两个 Key 都返回 200/52 B 且都不含标记模型，但因为我只在 rollup 造了数据、没在 `usage_events` 造数据，**返回本就是空的** ⇒ **该端点几乎无判别力，需造 events 数据后重测**。
3. **登录失败的错误可被读屏感知**（probe 坏了）。
4. **对话框 focus trap / Esc / 焦点归还**（未运行）。
5. **应用页**的 skip link、Tab 顺序、焦点可见性（仅登录页验过）。
6. `/v1/*` 是否还有其他鉴权头（如管理密钥）能提权：我试了会话 cookie 与两个伪 token（都 401），但**没有枚举真实的其它鉴权头**。

---

## E. 总判

> **provider 穿越：已证实无效（8 变体全拒、零文件残留）。`/v1` 的负向鉴权（无/错/禁用 Key、会话与伪 token 都不能提权）已证实；正向数据隔离本轮未能验证，因为 `/v1/usage` 对合法 Key 也 500（`CPA_MANAGEMENT_KEY 未配置`）——由此暴露 R26-B：面向外部用户的自助用量接口硬依赖管理面，而同族 `/v1/usage/requests` 正常。键盘方面确认了"焦点完全不可见"（WCAG 2.4.7 失败）与"无 skip link"两条，对话框与错误 aria 因我的登录探针失效而未验证。**

**复跑入口**：干净副本 = `git archive HEAD | tar -x -C $(mktemp -d)` + `ln -s <repo>/node_modules`；`/v1` 需在**有 `CPA_MANAGEMENT_KEY`/stub** 的实例上做，Key 用 `mktemp` DATA_DIR 直写 `api_keys` + `usage_events`（**两个表都要造**，否则端点无判别力）。
