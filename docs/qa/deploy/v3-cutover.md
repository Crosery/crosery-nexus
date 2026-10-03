# 中转站控制台切换到 v3（cutover runbook）

- **对象**：`cpa-vps` · `crosery-api-console.service` · `console.ai.crosery.com`
- **状态**：已在 `sj-4837-new` 上按生产路径和 unit 全量演练（2026-10-03）。**生产切换未执行，需要用户明确批准**
- **回退目标**：`/opt/crosery-api-console-releases/20260928-reset-clears-cooldown`（当前线上 = BASE）
- **组装物**：`20261003-console-v3`，源码 `cdb9eb4`，970 条 MANIFEST（`MANIFEST.sha256` 的 sha256 前缀 `58ea8cd731f15306`）
- 通用步骤（复制 BASE、rsync 叠加、`ln -s` + `mv -T`）沿用 [release-runbook.md](release-runbook.md)。本文只写 v3 的差异和证据。

## 1. 兼容性结论

| 面 | 结论 | 证据 |
| --- | --- | --- |
| 数据库 | 不迁移、不新增表 | `db.ts` 与生产逐字节相同；演练用 1.1 GB 库，旧 → 新 → 旧 → 新，无写失败 |
| 线上热修 | 已包含 | `cpa.ts` / `index.ts` 的冷却清除修复在 v3 中 |
| 会话 | 双向保留 | 旧版签发的 admin Cookie 在 v3 下是 `role:admin`；v3 签发的 Cookie 回退后仍有效 |
| Key 用户 | 不变 | 同一把 Key 在切换前后：`/api/public/model-catalog` 200（6 个模型）、`/v1/usage` 200、`/v1/usage/requests` 200 |
| 外部轮询 | 不变 | 状态栏与 Pi 页脚读的账号字段（`label`/`disabled`/`unavailable`/`email`/`provider`/`quota.*`）都在；v3 只去掉了它们不读的字段 |
| CPA 配置 | 零扰动 | 三次切换前后 `config.yaml`、auth 文件、14 个 api-key 的哈希都不变 |
| 账号代理迁移 | 只增不改 | 启动 2 分钟后把 `PROXY_PRESETS` / 账号已有代理导入代理池（演练中导入 2 个）；auth 文件哈希不变 |
| 凭据批量导入 | 恢复 | deflate ZIP 中 3 个文件：上传 2、跳过 1，凭据不回显，审计写入 `upload_credentials` |
| nginx 不限速同步 | 不变 | `nginxUnlimited*.ts` 与生产逐字节相同；applier 跑的是 `/opt/crosery-api-console` 源码，不跟 release 走 |
| 数据桥 | 不变 | `dataPlane.ts` 与生产逐字节相同 |
| 依赖 | 不新增 | 服务端的裸依赖只有 `express` / `cookie-parser` / `busboy` / `yauzl`，版本与 BASE 的 `node_modules` 相同；`tsx` 4.23.1 |
| 停机 | 约 3 s | 从 `systemctl restart` 到重新监听：2.3–2.9 s；`NRestarts` 始终是 0 |

**v3 的行为变化**（都是 v3 的新功能，不影响现有调用方）：

- 模型发现在 CPA 模式下只能在同步中心手动触发。原因：发现到的新模型会写进渠道表，而这张表就是线上路由。如果要恢复定时发现，设置 `MODEL_DISCOVERY_SCHEDULE=true`。
- 代理巡检每 6 h 一轮，只检查在用的出口：每次最多 8 个、并发 4，向 `cloudflare` / `anthropic` / `openai` / `google` 发不带凭据的请求。
- 设置页在 CPA 模式下不显示「网关功能」和「RTK」；Linux 主机上不显示 launchd 外部任务。

## 2. 切换前要确认的配置

**`.env` 需要新增一行**（控制台不读 `.env`，所以可以在切换前加；旧版会忽略这个变量）：

```
PUBLIC_GATEWAY_BASE_URL=https://ai.crosery.com/v1
```

不加这一行的话，Key 用户「接入」页显示的是本机地址 `http://127.0.0.1:8317/v1`。旧版的地址是写死在页面里的 `https://ai.crosery.com/v1`。

**mihomo**：

- 已安装：`/usr/local/bin/mihomo` → `/opt/crosery-mihomo/current` → `mihomo-v1.19.32-compatible`。sha256 与 GitHub release digest 一致；只装了二进制，没有建服务。
- 7 个 `*-egress` unit 都用显式路径 `/usr/local/bin/mihomo-codex`，这次安装不影响它们。
- **但 v3 拒绝以 root 启动 mihomo**，而线上 unit 是 `User=root`。因此代理池里加密协议的节点（ss/vmess/…）可以保存，但用不了；URL 型代理（http/socks）不受影响。设置页会如实显示这个原因。
- 演练证明，mihomo 在这个 unit 的沙箱里可以正常运行：uid 0、`CapEff=0`、`NoNewPrivs=1`，7 个线程，44 MB；不下载 geodata；未认证的 socks 连接被拒，经 ss 节点能出网。要不要放开 root 限制，是一项待决定的安全取舍，见交付说明。

## 3. 步骤

```bash
SSH='ssh -o ControlMaster=no -o ControlPath=none cpa-vps'
NEW=/opt/crosery-api-console-releases/20261003-console-v3
ASM=<本地组装目录>/release-20261003-console-v3        # assemble-release.mjs 产物，见文首

# §1 预检（只读）：同 release-runbook §1；确认 current → 20260928-reset-clears-cooldown
# §2 造新目录（新增目录，不动在跑的服务）
$SSH "test ! -e $NEW && mkdir -p $NEW && cp -a /opt/crosery-api-console-current/. $NEW/"
rsync -a --checksum --exclude 'node_modules/' --exclude 'assembly-report.md' "$ASM/" "cpa-vps:$NEW/"   # 禁止 --delete
# §3 MANIFEST + 第二实例（setsid 启动，只按记录的进程组清理；绝不 pgrep -f）
$SSH 'NEW=/opt/crosery-api-console-releases/20261003-console-v3 bash -s' < docs/qa/deploy/v3-second-instance.sh   # 期望「硬失败计数: 0」
# §4 env（生产配置变更）
$SSH "grep -q '^PUBLIC_GATEWAY_BASE_URL=' /opt/crosery-api-console/.env || echo 'PUBLIC_GATEWAY_BASE_URL=https://ai.crosery.com/v1' >> /opt/crosery-api-console/.env"
# §5 原子切换 + 重启 + §6 验收（服务中断约 3 s）
$SSH 'bash -s 20261003-console-v3' < docs/qa/deploy/v3-switch.sh
```

`cp -a` 会带上 BASE 里旧 React 的源码和产物（75 个文件），它们都不会被加载。保留旧的 hashed assets，开着旧页面的标签页可以继续懒加载，等刷新后再切到新页面。

**验收**（`v3-switch.sh` 的输出，再加上对外检查）：

- `ActiveState=active`，`NRestarts` 不增长；
- `session=200`、`app-index=1`、`root-index=0`、`keys=200`、未登录 `/api/monitor` 返回 401；
- `https://console.ai.crosery.com/` 返回 200；
- `journalctl` 里没有 `EADDRINUSE` 或数据库锁错误；
- 状态栏和 Pi 页脚的额度在下一个轮询周期正常刷新。

## 4. 回退

和切换是同一个脚本，约 3 s。回退后旧版接受 v3 签发的会话，数据库也不需要任何动作：

```bash
$SSH 'bash -s 20260928-reset-clears-cooldown' < docs/qa/deploy/v3-switch.sh   # 期望 root-index=1
```

`PUBLIC_GATEWAY_BASE_URL` 这一行可以留着，旧版会忽略它。

## 5. 已知风险

- **[residual risk] 内存**：
  - 旧版常驻时 anon 约 325 MB。
  - v3 打开 90 天的性能、缓存等新报表后，anon 约 610 MB（演练库 1.1 GB）。
  - 生产库有 3.7 GB，预计更高。生产机 4 GB，没有 swap，可用内存约 1.27 GB，CPA 占 694 MB。
  - 切换后观察 `systemctl show crosery-api-console -p MemoryCurrent -p MemoryPeak`（当前 BASE 的 peak 为 1.25 GB，含页缓存）。
- **[residual risk] dist 构建环境**：dist 由本机 Node v26 构建，生产运行时是 v24.20.0（同 v2 的 WARN）。dist 是纯静态产物；在 Node 24.20.0 下演练全部通过。
- **[已有行为] 凭据导入只接受 deflate 压缩的 ZIP**：存储方式（不压缩）的 ZIP 会报「压缩包无法读取」，`zipEntries.ts` 与生产相同。线上那 201 个文件的 ZIP 是正常的。
