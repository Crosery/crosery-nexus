# 中转站发布：一句话决策页

日期：2026-10-01 ｜ 状态：**已准备完毕，未执行任何生产写入** ｜ 详版：[release-plan.md](release-plan.md) · 执行步骤：[release-runbook.md](release-runbook.md)

---

## 要决定什么

把本地这一批工作（Vue 界面重构 + RTK 控制面 + 生产补丁回移）发布到中转站的生产控制台，需要你选**一**个：

| | **A：全量（含 Vue 新界面）** | **B：只发服务端（保留现在的 React 老界面）** |
| --- | --- | --- |
| 用户看得到的变化 | 全站换成 Vue/Tuffex 界面；新增「RTK 优化」页与「A/B 实验台」；侧栏「凭据导入」入口消失（`92a0835` 有意下线） | 界面与今天**完全一样** |
| 装机内容 | 416 文件 / 7.10 MB（dist 74 个文件整体替换生产 49 个） | 342 文件 / 5.88 MB（沿用生产 dist） |
| 服务端能力 | 清冷却事故修复 + 凭据导入安全收口 + bootstrap 并发读 + 新增 `/api/rtk/*`、`/api/ab/preference` | **完全相同** |
| 回退 | `ln -s`+`mv -T` 切回旧 release + `systemctl restart`，**秒级** | 同 A |

**我的建议：A。** 关键论据：本地**已经构建不出生产在用的 React 控制台**（`vite.config.ts` 的 React 插件只作用于 docs，`index.html` 入口已是 `main.ts`），选 B 等于把界面永久冻结在 2026-09-28 那份 minified 产物上，以后任何 UI 修改都无法上线；A 的回退是原子的、秒级的。

## 为什么这次是安全的

- **数据库不会迁移**：`server/db.ts`、`quotaLedger.ts`、`usageRollup.ts` 与生产**逐字节相同** → 3.7 GB 的 `console.db` 不触发新 schema。
- **Magpie/RTK 路径在生产默认休眠**：生产 `.env` 没有 `GATEWAY_ENGINE`/`MAGPIE_*`（实测 0 命中），实际生效的只有上表那四项服务端能力。
- **深链接不会 404**：`server/index.ts` 已有 SPA catch-all，Vue history 路由可用。
- **两种模式都通过校验、缺失生产文件 0**；组装**只叠加不删除**（25 个本地删掉的 React 死文件在 release 里保留 BASE 版本，零风险）。
- **本地同构预演已过**：`session=200 / vue-index=1 / deeplink=200 / asset=200`，假 CPA 不可达时按预期降级。

## 已知风险与触发线

- 唯一没在真机跑过的是「第二实例首启」（§4）——它失败**不影响线上**，但意味着 §5 也悬。
- 切换后三条回退触发线（任一命中立即回退）：**`NRestarts` 增长 / `/api/session ≠ 200` / `vue-index = 0`**。
- 构建用本机 Node v26、生产 runtime 是 v24（`engines: >=24 <25`）：判为可接受；**若出现只在本地构建产物上复现的异常（白屏/路由异常/chunk 404），当场停手改走 VPS 上用 pinned Node 重建**。

## 你只需要回一句

- 选 A：`我批准执行：把 /opt/crosery-api-console-current 原子切换到新 release 并 restart`（我用 `--frontend=vue`）
- 选 B：同上但加一句「只发服务端」（我用 `--frontend=keep-prod`）
- 或者：**先不发布** —— 那就保持现状，本地继续迭代。

（切换前的 §1–§4 都是只读/新增目录，不碰运行中的服务与数据库；我会在 §5 之前把回退锚点和三条触发线再复述一遍给你确认。）
