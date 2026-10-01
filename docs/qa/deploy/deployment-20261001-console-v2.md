# 上线记录：20261001-console-v2（2026-10-01）

**结论：已上线并验收通过。** 对外入口 `https://console.ai.crosery.com`（nginx → `127.0.0.1:8787`）。

## 1. 发布身份

| 项 | 值 |
| --- | --- |
| release id | `20261001-console-v2` |
| 源码 commit | `aeb0357`（已 push 到 `origin/main`） |
| 组装物 | 446 文件 / 7.31 MB，MANIFEST **445** 条 |
| 生产目录 | `/opt/crosery-api-console-releases/20261001-console-v2` |
| **回退目标** | `/opt/crosery-api-console-releases/20260928-reset-clears-cooldown` |
| 切换时间 | 2026-10-01 10:29:18 EDT |

## 2. 上线前（本地/工作站）

- `npm test` → 712 / 711 pass / 0 fail；`tsc -b` → 0；`build` → ✓
- 组装 PASS（0 个生产文件缺失）；发布包**启动演练**：页面 200、默认拒绝 401、压缩 gzip 94,675 / br 78,239、三类穿越回归全 4xx
- 四个扫描器：冒烟 14 路由 0 错误、对比度 0 失败、可访问性 25/25、响应式 112 组合 0 失败

## 3. 上线步骤与验收（在 VPS 上）

```
§1 预检        current → 20260928-reset-clears-cooldown；服务 active；磁盘余 9.5G；node v24.20.0
§2.1 基底复制  cp -a 当前 release → 新目录（203M，含 node_modules ✓）
§2.2 叠加      rsync --checksum --exclude node_modules（禁止 --delete）
§3 校验        sha256sum -c MANIFEST.sha256 → MANIFEST OK（445 条）；id="app" ×1（Vue 入口）
§4 第二实例    H1 session=200 ｜ H2 vue-index=1 ｜ H3 /keys=200 ｜ H4 asset=200 → **硬失败 0**
§5 原子切换    ln -s + mv -T（同文件系统 rename）；systemctl restart
```

**切换后验收（对外 `https://console.ai.crosery.com`）**：

| 检查 | 结果 |
| --- | --- |
| 14 条路由（含新 `/credentials`、`/docs`） | **全部 200** |
| Vue 产物 | `id="app"` ×1 |
| 压缩（经 nginx） | identity 641,606 ／ gzip 94,675 ／ br 78,239 |
| 默认拒绝 | 未认证 `/api/model-index` **401**、`/api/magpie/update-status` **401**、`/api/session` 200 |
| 服务稳定性 | 运行 6 分钟 `active/running`，日志 **ERROR 计数 0** |
| 内存 | 501 MB |

## 4. ⚠️ 过程中的一次事故（已恢复，如实记录）

**我把生产服务打停过一次（约 1 分钟）**。经过：§4 第二实例检查脚本用 `kill $PID` 停临时实例，但 `npm run start` 会派生 node 子进程，`kill` 只杀到 npm 包装进程 ⇒ 临时实例仍占着 18787。我随后用 `pgrep -f "server/index.ts"` 清理，**这个模式同时匹配到了生产进程树**（`sh -c tsx` / `node .bin/tsx` / 真正的 node），而我的白名单只跳过了 `MainPID`、没跳过它的子进程 ⇒ 生产 child 全被杀，systemd 因 **`Restart=on-failure`** 且退出码为 0（干净退出）**不会自动拉起**，服务停在 `inactive/dead`。

**恢复**：`systemctl start crosery-api-console.service` → 8 秒内 active，`https://ai.crosery.com/` 与 `console.ai.crosery.com/keys` 均 200，审计日志显示正常的启动 reconcile。**数据无损**（只杀进程，未动库与配置）。

**教训（写进 runbook 待办）**：
1. **禁止在生产主机上用宽泛的 `pgrep -f` 做批量 kill**；要杀临时实例就按端口/临时目录精确定位，或 `kill -- -PGID` 杀整个进程组。
2. 清理脚本应记录**进程组**而不是单个 PID（`setsid` 启临时实例，杀 `-PGID`）。
3. 任何"停在别的服务旁边"的操作前，先记下生产 `MainPID` **及其子进程 PID 列表**，逐个比对。
4. `Restart=on-failure` ⇒ **SIGTERM 干净退出不会自动重启**，这类"看起来会自动恢复"的假设必须实测。

## 5. 生产上的两个能力缺口（如实报告，非缺陷）

| 能力 | 生产现状 | 原因 |
| --- | --- | --- |
| **模型双源价格**（OpenRouter / models.dev） | 界面会显示**可见的降级**（`shared-pricing-missing`），模型标「未收录」 | VPS 上**没有** `~/.agents/crosery/catalog.json`：共享同步实现与它的产物目前只在本机。要在中转站也看到价格，需要在 VPS 部署同一份共享实现 + 一个定时任务（**待批准**） |
| **magpie 内核更新面板** | 如实报 `capability:false`（按钮禁用并说明原因） | VPS 上没有 magpie 内核安装根（`~/.agents/crosery/magpie-console/bin`）；生产是 **CPA 模式**（`.env` 未设 `GATEWAY_ENGINE`），本来就不跑 magpie 内核 |

## 6. 回退（随时可执行）

```bash
ln -s /opt/crosery-api-console-releases/20260928-reset-clears-cooldown /opt/crosery-api-console-current.rollback && \
mv -T /opt/crosery-api-console-current.rollback /opt/crosery-api-console-current && \
systemctl restart crosery-api-console.service && sleep 8 && systemctl is-active crosery-api-console.service
```
