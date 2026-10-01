# 第五轮整改：libImports 自检假阳性 + 字段级校验 + 术语统一（task-23 / blue-ui）

日期：2026-10-01 · 依据：`docs/qa/red-team/ui-round5-verification.md`
构建：`npm run build` ✓ 624ms（本轮最后一次）；截图 `docs/qa/blue/shots/r6-*.png` 3 张。

**一句话**：把守卫的自检改成**完全自包含**（不再从生产文件抠样本）并把扫描面扩到所有本地模块、如实标注盲区；给 `创建/编辑 API Key` 与 `额度编辑` 两个表单补**失焦即校验 + 字段旁错误 + 提交定位首个错误**；按一份明确的词表统一了 9 个文件的 UI 文案。

---

## ① R5-B：`server/libImports.test.ts` 自检假阳性 + 覆盖扩面

### 改前（红队复现的假阳性）
自检用「单行正则从**生产文件** `ModelsPage.vue` 里抠 import 行」造样本：
```ts
const withoutImport = source.replace(/^import \{ sortKeyForColumn, tableSortState \}.*$/m, '')
```
把该 import **仅重排成多行**（语义不变）后，正则不再命中 → `assert.notEqual(withoutImport, source)` 失败 → **真守卫绿、自检红**。等于「名为测自己有牙齿，实在断言别人的单行写法」，长期会训练团队忽略这道守卫。

### 改后
1. **扫描逻辑抽成纯函数** `findMissingImports(script, catalogue)`，自检直接喂**合成源码**，不再读任何生产文件：
   - 合成样本覆盖：单行 import、**多行重排**（红队场景）、删掉 import（有牙齿）、别名导入、本地同名声明、注释/字符串噪声、内联 `type` 修饰、默认导入、命名空间导入 → 共 **9 条自检**全绿。
2. **扫描面扩到所有本地相对模块**：`src/lib/*.ts`、`src/api.ts`、`src/types.ts`、`src/chartTheme.ts`、`src/clientLabels.ts`、`src/channelLabels.ts`、`src/gatewayStatus.ts`、`src/components/*.vue`（按文件名当默认导入名）。
3. 扩面过程中**顺手抓到两个真实假阳性源并修掉**：内联 `type Foo` 修饰被当成标识符整体、`PageHeader.vue` 自有的 `type Crumb` 被当成未导入。

### 实测
- 红队手法重放：把 `ModelsPage.vue` 的 `import { sortKeyForColumn, tableSortState } from '../lib/tableSort'` 改成多行 → 守卫 **10/10 全绿**（修复前会红）；
- 删掉 import（合成样本 / 生产文件皆同）→ 守卫红。

### 覆盖不到的盲区（写进测试文件头注释，如实标注）
1. **模板**里的未导入引用（只扫 `<script setup>`；模板里的组件、调用不在扫描面内）；
2. 类型/参数/prop 不匹配（那是 `vue-tsc` 的活）；
3. 拼写与大小写差异（`useResourse`）；
4. 动态引用（`import(变量)`、`defineAsyncComponent('路径')`、`app.component`）；
5. 第三方包导出名用错（只认本地模块）；
6. 跨文件重命名后的语义漂移。
→ 它的定位是「补上工具链盲区的一道**窄**守卫」，不是类型检查。

## ② D25：两个表单的字段级校验

### 实现
- 新增 `src/lib/validation.ts`：纯函数校验器（`fieldError` / `validateAll` / 规则构造器 `required`/`maxLength`/`numberInRange`/`integerInRange`/`custom`），文案一律写「怎么改」；配 **8 条行为级测试** `server/libValidation.test.ts`（含边界值、留空语义、多字段同时出错时的 `firstInvalid` 顺序）。
- `KeysPage.vue` 两个表单接入：
  - **失焦即校验**（`@blur` → `validateEditorField` / `validateQuotaField`），只有失焦或提交过的字段才显示错误（避免一打开弹窗满屏红）；
  - 错误渲染在**字段正下方**（`.field-error` + `role="alert"`），并在控件上给 `aria-invalid`；
  - 提交时跑 `validateAll`：底部给汇总「还有 N 处需要修改，已定位到第一个字段。」，同时 **`focus()` 到首个出错字段** 并滚动到可视区；
  - 规则：名称必填/≤40 字/**重名检查（排除自身）**、备注 ≤100 字、渠道分组至少选一个、并发数 1–1000 整数、额度三项 0–1000000（留空 = 不限制）。

### 实测（浏览器，`/keys`）
| 步骤 | 结果 |
| --- | --- |
| 名称留空 + 失焦 | 字段旁出现「请填写显示名称（1–40 个字符），它会显示在 API Key 列表里」，`aria-invalid="true"` |
| 填已存在的名称「龚翰林」+ 失焦 | 「已有同名 API Key，请换一个名称（或先改掉那一个已有的）」 |
| 改成合法名称 + 失焦 | 错误消失、`aria-invalid` 移除 |
| 并发数填 `0` + 失焦 | 「并发数请填 1–1000 的整数；不限速请打开「不限速」开关」 |
| 额度填 `-5` + 失焦 | 「单日额度请填 0–1000000 之间的数字；留空表示不限制」，`aria-label="单日额度（美元）"`、`aria-invalid="true"` |
| 额度改成 `5` + 失焦 | 错误消失 |
| 取消勾选全部分组 + 点「立即创建」 | 弹窗不关闭、底部「还有 2 处需要修改，已定位到第一个字段。」、**焦点落在 `data-field="groups"`**、字段旁显示两条错误 |

截图：`r6-keys-field-validation.png`、`r6-keys-quota-validation.png`。

## ③ D30：术语统一

### 扫描表（改前，12 个页面 + 组件，排除 `HelpPage`/`RtkPage`/`AbLabPage`/`ConsoleNav`）
| 概念 | 漂移写法（出现次数） | 涉及文件 |
| --- | --- | --- |
| 本产品的访问密钥 | **密钥 34** / API Key 39 混用 | Keys、Dashboard、Analytics、Channels |
| 渠道 | 渠道、**渠道账号 1**、**账号池 3** | ConsoleNav（范围外）、Models、OAuth |
| 上游 OAuth 账号 | 账号池 3、上游账号 3 | Models、OAuth、Monitor |
| 渠道分组 | 渠道分组 6、**渠道组 1** | Keys、Charts |
| 额度 | 额度 46、**配额 3**、**不限额 1** | Keys、Monitor |
| 数据面服务 | 网关 17、**中转站 8** | RtkBoard、VersionWidget |
| 模型↔渠道映射 | **服务渠道映射 1**、渠道映射 10 | Models、Channels |

### 词表（每个概念一个主词）
| 概念 | 主词 | 说明 / 允许的例外 |
| --- | --- | --- |
| 本产品的访问密钥 | **API Key** | 列表、按钮、标题、空态、toast 一律用它；中文里两侧留空格（「在 API Key 列表里」） |
| 上游供应商的凭据 | **上游密钥** | 仅指渠道表单里粘贴的第三方 key（`ChannelsPage` 表单标签），与本产品的 API Key 区分 |
| 渠道 | **渠道** | channel 对象；不再叫「渠道账号」 |
| 上游 OAuth 账号 | **上游账号** | 集合叫 **上游账号池**；不再叫「账号池」 |
| 分组 | **渠道分组** | 不再叫「渠道组」；授权语义写「授权渠道分组」 |
| 额度 | **额度** | 不再叫「配额/限额」；「不限额度」「额度规则」 |
| 数据面服务 | **网关** | 不再叫「中转站」；RTK 平面里要区分主机时用 **远端网关**（relay 平面） |
| 模型 ↔ 渠道 | **渠道映射** / 表头 **渠道来源** | 不再叫「服务渠道映射」 |
| 代码标识符 / API 字段 | **不动** | `key`、`keys`、`quota`、`channel`、`relay`、`planes[]` 等保持原样 |

### 逐文件改动清单（计数字面量：改前 → 改后）
| 文件 | 改动 |
| --- | --- |
| `src/pages/KeysPage.vue` | 密钥 → API Key（含空态/toast/确认框/表头/aria-label）；「限额规则」→「额度规则」；「不限额」→「不限额度」；「渠道组」→「渠道分组」 |
| `src/pages/DashboardPage.vue` | 活跃密钥/有效密钥/密钥健康 → API Key 对应写法；空态文案 |
| `src/pages/AnalyticsPage.vue` | 「无 Key 使用数据」→「无 API Key 使用数据」等 |
| `src/pages/ChannelsPage.vue` | 表单标签「API Key 访问密钥」→「上游密钥」 |
| `src/pages/ModelsPage.vue` | 「账号池」→「上游账号池」；表头「服务渠道映射」→「渠道来源」；kindLabel 同步 |
| `src/pages/MonitorPage.vue` | 「窗口配额」→「窗口额度」（确认框、aria-label 同步） |
| `src/pages/OAuthPage.vue` | 「查看渠道与账号池」→「查看渠道与上游账号池」 |
| `src/components/VersionWidget.vue` | RTK 平面标签与文案「中转站」→「远端网关」 |
| `src/components/RtkBoard.vue` | 同上（`relay` 平面标签、说明与按钮） |

**计数对照**（我的写范围内）：密钥 34 → **1**（仅 `上游密钥`，有意保留）；配额 3 → **0**；渠道组 1 → **0**；中转站 8 → **0**；API Key 39 → **73**。

### 需要 Lead 处理的（不在我写范围）
1. **7 行术语问题**在 `src/pages/HelpPage.vue`、`src/pages/RtkPage.vue`、`src/pages/AbLabPage.vue`、`src/components/ConsoleNav.vue`（含「中转站」「密钥」「渠道账号」）。
2. **范围外仍含「中转站」**：`src/router.ts`、`src/ab/**`（ab-harness）、`server/cpa.ts`、`server/rtkService*.ts`、`server/rtkPlane.ts`、`server/rtkService.test.ts`。是否要一并统一由你决定——**注意服务端文案会进 API 响应**，改动面比 UI 大。

## ④ 命令与数字（最终一次）

```
$ npx tsc -b        → exit 0
$ npm run lint      → 仅 2 条既存 server/nativeResponses.ts no-control-regex warning
$ npm test          → ℹ tests 578 · pass 577 · fail 0 · cancelled 0 · skipped 1   （含 --test-timeout=30000，未回退）
$ npm run build     → ✓ built in 624ms
```

## ⑤ 过程记录：两次「钝替换」教训（附本次自查方式）

1. 术语替换把 `label="…密钥"` 的**闭合引号**一起吃掉了（`密钥"` → `API Key “`），Vue 编译器报 `Attribute name cannot contain U+0022` —— **是构建挡住了**，即刻修正；
2. 另一处把 `:aria-label="'weekly'"` 写成了字面量英文标签（可访问名变成 "weekly"），已改为 `aria-label="每周额度（美元）"`。
   现在交付前统一自查：`grep -rn '“' src/pages src/components | grep -E '<[a-zA-Z-]+[^>]*“'`（属性内中文引号 → 空即通过）+ `npx tsc -b` + `npm run build`（模板语法）+ 浏览器实拍。

## ⑥ 交付清单

- 新增：`src/lib/validation.ts`、`server/libValidation.test.ts`（8 条）
- 重写：`server/libImports.test.ts`（1 条真守卫 + 9 条自包含自检）
- 修改：`src/pages/KeysPage.vue`（校验 + 术语）、`src/pages/{Channels,Models,Monitor,OAuth,Dashboard,Analytics}Page.vue`、`src/components/{VersionWidget,RtkBoard}.vue`（术语）
- 截图：`docs/qa/blue/shots/r6-keys-field-validation.png`、`r6-keys-quota-validation.png`、`r6-models-glossary.png`
- 未触碰：`src/router.ts`、`src/components/ConsoleNav.vue`、`src/api.ts`、`src/types.ts`、`server/index.ts`、`server/rtkService*.ts`、`server/testDataDir.ts` 与其余测试文件、`src/ab/**`、`package.json`、`MANIFEST.sha256`、`RELEASE.json`
- 未验证：屏幕阅读器对 `aria-invalid`/`role="alert"` 的**实际播报**（无辅助技术）；额度表单的「无额度限制」开关状态下的校验跳过逻辑只在代码层（实测时该 Key 已是有限额，走的是数值校验分支）。
