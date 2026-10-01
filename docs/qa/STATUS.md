# crosery-api-console 红蓝对抗进度总表

最后更新：2026-10-01（第 4 轮结束）｜维护：Lead ｜约定见 [COORDINATION.md](COORDINATION.md)

## 一句话现状

两条主线都已完成第一批并经过红队多轮对抗验证；**生产（中转站）尚未发布**，发布包已准备完毕、等待一句话批准（见 [deploy/DECISION.md](deploy/DECISION.md)）。

## 主线 A：RTK 与中转站/内核控制面同步

| 结论 | 状态 |
| --- | --- |
| 「中转站/内核已有 RTK 接口但控制台自己另写一份」 | ✅ 已核清：内核 `/internal/rtk` **未编译进运行二进制**；中转站是 CLI Proxy API，`/api/library/rtk` **实测 404** |
| 控制台现在按「内核 → 远端网关 → 本机」三层解析并**如实上报**，写入只落本机，远端默认只读 | ✅ 已实现并经 5 轮对抗验证 |
| 手写 hook 形状错误（缺 `matcher`/嵌套 `hooks[]`） | ✅ 已修 |
| **破坏性写入：整体覆盖 `PreToolUse`，实测把 3 条第三方 hook 删成 1 条** | ✅ 已修（只增删自己那条 + 写前备份 + 失败回填 + 坏 JSON 拒写） |
| `--claude/--cursor/--omp` 非法 flag、`--uninstall` 无 `-g`、缺 `--auto-patch` 时 exit 0 却不写文件 | ✅ 已修（改用经核实的 flag 矩阵） |
| `cursor ON` 静默改写 Claude 配置且不还原 | ✅ 已修（条目级最小差异还原 + `collateral` 真源） |
| 轮转删掉「已返回 200 的 backupId」→ rollback 404 | ✅ 已修 |
| 12 路跨 agent 并发最终只剩最后一个 agent 挂载 | ✅ 已修（进程内串行闸；Lead 独立复现 12/12 200、6/6 挂载） |
| 跨**进程**并发（多实例共用 HOME） | ⚠️ 未修，仅靠 120s 备份窗口兜底 |
| 中转站那台机器上的 RTK（层 D） | ⚠️ 无通路：中转站没有 RTK 接口、没有 agent、`HOME=/tmp`；控制台如实显示「未接通」 |
| 帮助页接入片段是否带 RTK | ✅ 已补（安装/挂载/`--auto-patch` 警告/「写完 ≠ 生效需重启客户端」/验证与卸载） |

审计与验证：[red-team/rtk-sync-audit.md](red-team/rtk-sync-audit.md)（12 份证据）、[red-team/rtk-round2-verification.md](red-team/rtk-round2-verification.md)、[red-team/rtk-round3-verification.md](red-team/rtk-round3-verification.md)；交付：[blue/rtk-control-plane.md](blue/rtk-control-plane.md)、[blue/rtk-round2-fixes.md](blue/rtk-round2-fixes.md)、[blue/rtk-round3-fixes.md](blue/rtk-round3-fixes.md)。

## 主线 B：按 TUF 交互逻辑重构

- 共享原语已落地并被复用：`useResource` / `confirm()`+`ConfirmHost` / `PageHeader` / `ErrorPanel`（含 `inline` 陈旧数据横幅）/ `LoadingBlock` / `EmptyState` / `format` / `listState`（URL 状态）/ `validation`（字段级校验）。
- 已迁移 9 个数据页：Dashboard、Keys、Channels、Models、Analytics、Usage、Cache、Charts、Monitor。
- **尚未迁移：`OAuthPage`**（唯一仍是手写弹窗/无 URL 状态的数据页）。
- 已修的代表性缺陷：观测页把真实 41.6% 错误率显示成「0.0% 健康稳定」（调错接口 + 类型断言说谎）、接口失败退化成 7 秒消失的 toast、`/charts` 永久加载、390px 表格列宽塌成 0、6 处破坏性操作零确认、`/models` 527 行裸渲染（→ 分页/搜索/排序/列显隐/批量）、确认框 Escape 不稳定、导航幻影高亮。
- 删掉整套 React 死树（27 → 2 个 `.tsx`，只留 `/docs` 入口），并把「读源码文本」的守卫测试改为**行为级测试**。

审计与验证：[red-team/ui-interaction-audit.md](red-team/ui-interaction-audit.md)（32 条缺陷）、[ui-round2](red-team/ui-round2-verification.md)～[ui-round6](red-team/ui-round6-verification.md)；A/B 对照：[ab/comparison.md](ab/comparison.md)。

## 顺带修掉的生产级问题（超出原诉求但更要紧）

- **本地跑的是未收口的凭据导入**（生产 20260926 安全补丁：xAI/Antigravity 端点必须官方 https 域名）→ 已回移，与生产**逐字节一致**。
- 生产 20260928「重置额度后清冷却」（2026-09-27 冷却挂 5.6 天的事故修复）→ 已回移，前端补 `cooldownCleared=false` 的降级提示。
- 本地仓库与生产 release **双向分叉**已盘点：[deploy/divergence-report.md](deploy/divergence-report.md)。
- `npm test` 偶发 `database is locked` → 每进程独立 `DATA_DIR`；**挂起类回归会让套件无界挂死** → 已加 `--test-timeout`，门禁改为**按退出码**判定。

## 待用户决定

1. **发布**：A 全量含 Vue / B 只发服务端 / 暂不发布 → [deploy/DECISION.md](deploy/DECISION.md)。
2. **是否允许加 `vue-tsc`**（devDependency）：仓库没有它，`.vue` 完全不进类型检查；红队两次独立复现（一个未定义标识符能让整页不渲染而 tsc/build/test 全绿），且 TUF 参考实现本身就把 `vue-tsc --noEmit` 放进 build。

## 未验证 / 残余风险（不许当结论用）

- 破坏性操作的**最终提交**一律未执行（只走到确认框即取消）；批量操作「部分失败」的服务端语义未实测。
- 中转站真机未做抓包（只读探测 + 隔离实例外推）；发布相关的「第二实例首启」未在真机跑过。
- 内核 plane 未重编（需按 pinned revision 重新 clone；且内核跑在沙箱 HOME，写它的 agent 配置对真实用户无意义）。
- 屏幕阅读器实际播报、非 Chromium 浏览器、对比度量化均未做。
- 跨进程 RTK 并发、`collateralSkipped` 一键强制还原未做。

## 怎么读这一堆报告

- **想决策** → [deploy/DECISION.md](deploy/DECISION.md)
- **想看问题清单** → 两份首轮审计（RTK / UI）的「结论在前」章节
- **想看某轮改了什么、被什么推翻** → 对应 `*-roundN-verification.md`（红队）与 `blue/*-fixes.md`（蓝队）
- **想看 A/B 新旧对照** → [ab/comparison.md](ab/comparison.md)（样本量 1，不可外推）
