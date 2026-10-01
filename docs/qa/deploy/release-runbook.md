# 中转站生产控制台 发布/回退 runbook

- **日期**：2026-10-01 ｜ **任务**：task-15 ｜ **执行**：deploy-reconciler ｜ **状态**：**本轮未执行任何上机步骤**，本文供 Lead/用户按步执行
- **配套**：[release-plan.md](<docs/qa/deploy/release-plan.md>)（发布内容清单与前端决策）、[assemble-release.mjs](<docs/qa/deploy/assemble-release.mjs>)（本地组装+校验）
- **对象**：`cpa-vps`（`root@45.192.104.163:39822`）上的 `crosery-api-console.service`

## 0. 关键事实（task-6/task-15 实测）

| 项 | 值 |
| --- | --- |
| 当前 release | `/opt/crosery-api-console-current` → `/opt/crosery-api-console-releases/20260928-reset-clears-cooldown`（下称 **BASE**，203 MB 含 `node_modules`） |
| 服务 | `crosery-api-console.service`：`active`，`ExecStart=/opt/crosery-node-current/bin/npm run start`，`WorkingDirectory=/opt/crosery-api-console-current`，`EnvironmentFile=/opt/crosery-api-console/.env`，`Restart=on-failure`，`TimeoutStartSec=60s`，`ProtectSystem=strict` |
| Node | `/opt/crosery-node-current` → `crosery-node-v24.20.0-ba849c60`（**v24.20.0**）；`package.json engines` = `>=24 <25` |
| 监听 | 服务监听 `127.0.0.1:8787`；nginx 站点 `/etc/nginx/sites-enabled/crosery-api-console` → `proxy_pass 127.0.0.1:8787`，`server_name console.ai.crosery.com` |
| 数据 | `/opt/crosery-api-console/data/console.db` = **3.7 GB**（+ 6.9 MB WAL，属主 root）——**任何步骤都不得写它** |
| 配置 | `/opt/crosery-api-console/.env`（root 600）：**不改**。其变量名里**没有** `GATEWAY_ENGINE`/`MAGPIE_*`/`NATIVE_RESPONSES_*`/`RTK_*` → 生产实际是 `gatewayEngine=cpa`（默认），Magpie/RTK 代码路径休眠 |
| 磁盘 | `/` 剩余 9.3 GB（复制 BASE 需约 203 MB） |
| 现存 release | 26 个目录（回退余量充足） |

> `.env` 只在 systemd 单元里通过 `EnvironmentFile` 注入；应用自身**不读 `.env`**（`server/config.ts` 无 dotenv）——这是 §4 第二实例能安全隔离的依据。

**执行前请确认**：`<NEW>` = 新 release 目录（建议 `/opt/crosery-api-console-releases/20261001-tuffex-rtk`），`<ASSEMBLY>` = 本地组装目录（如 `/tmp/cac-deploy-recon/release-20261001-tuffex-rtk`）。

---

## 0.5 运维事实（红队第二十七/二十八轮实测，发布后会用得上）

- **被 OOM 或重启不会坏数据**：`usage_events` 与 `usage_hourly_rollup` 的触发器**同事务**，崩溃后零漂移（实测：写到一半 kill → `1610/1610`、0 行漂移；未提交事务原子回滚）。agent 配置写入有"备份 + 跨进程锁 + fencing"，死锁会被自动接管（三种陈旧态都实测过），fencing 实测拦下过一次**真实的丢更新**。launchd `KeepAlive=1 + ThrottleInterval=10` ⇒ **约 10 秒自动恢复**。
- **唯一可能需要人工的情形**：某个被写入的文件停在**半写**状态（控制台会检测到并拒绝：`409 hook_file_unparsable`）。恢复用 **`POST /api/rtk/rollback` + 崩溃那次操作的 backupId**，实测可**逐字节**还原。
  **注意**：真实的 `rtk` CLI **不会**修复半写文件（它遇到非法 JSON 直接退出 1）——不要指望"重试一次就好了"。好消息是**真 CLI 的写是原子的**（temp+rename，每次换 inode），所以真 CLI 中途被杀**不会**留下半写文件；半写只可能来自非原子写入者、IO 错误或人工编辑。
- **排查备份内容用 `ls -a`**：备份目录里的副本可能以 `.` 开头（原始文件名如此），`ls` 看不到。
- **别让两个实例共用同一个 `DATA_DIR`**：会直接 `database is locked (261)`（单实例设计）。重启前先确认旧进程退出。
- **`/v1/usage` 在网关/管理面不可用时会降级而不是 500**：响应带 `X-Usage-Degraded` header 与 `degraded{…}` 字段（写明"未按 provider 过滤"）。看到这个标记说明**上游有问题**，不是用户数据的错。
- **长期运行**：只读采样器 `docs/qa/red-team/evidence/r28/read-only-sampler.mjs` 可挂长期任务（`--port 8791 --label prod`）；判读先看 **FD 长期斜率**，heap 看**每窗口低点基线**而不是瞬时值。
- **告警可信度**：空窗口下 `rollup-health` 与 `scripts/rollup-rebuild.mjs check` 现在**同判 ok**（曾经一条报 alert 一条报 ok，夜间无流量必然误报）。

---

## 1. §1 预检（只读，无风险）

```bash
SSH='ssh -o ControlMaster=no -o ControlPath=none cpa-vps'
$SSH 'set -e
  echo "current -> $(readlink -f /opt/crosery-api-console-current)"
  systemctl is-active crosery-api-console.service
  systemctl show crosery-api-console.service -p NRestarts -p ExecMainStartTimestamp
  /opt/crosery-node-current/bin/node --version
  df -h /opt | tail -1
  cd /opt/crosery-api-console-current && sha256sum -c MANIFEST.sha256 --quiet && echo "BASE MANIFEST OK"
  ss -ltn | grep -c ":8787 " ; ss -ltn | grep -c ":18787 "   # 第二个应为 0（端口空闲）
  ls -d /opt/crosery-api-console-releases/* | wc -l'
```

**记录回退锚点**（写进变更记录，供 §5 使用）：

```
ROLLBACK_TARGET=/opt/crosery-api-console-releases/20260928-reset-clears-cooldown
```

> 幂等提示：`sha256sum -c` 只读；若 `NRestarts` 非 0 或 `ExecMainStartTimestamp` 与预期不符，先查清再继续。

---

## 2. §2 造新 release 目录（**生产写入（新增目录），需批准**；不影响运行中的服务）

### 2.1 在 VPS 上以 BASE 为基底复制（**包含 `node_modules`**）

```bash
NEW=/opt/crosery-api-console-releases/20261001-tuffex-rtk
$SSH "test ! -e $NEW && mkdir -p $NEW && cp -a /opt/crosery-api-console-current/. $NEW/ && du -sh $NEW && echo COPIED"
```

- 遵循 `deploy/edge/README.md:37-44`：**从当前 release 复制**，不用本地树整体替换。
- 磁盘：约 203 MB；`cp -a` 会保留属主/权限（release 内多为 `501:staff`，`dist` 为 root；服务以 root 运行可读）。
- **回退**：`$SSH "rm -rf $NEW"`（只删这个新建目录；本轮其余步骤都不删任何文件）。

### 2.2 从工作站叠加组装物（**不含 `node_modules`，严禁 `--delete`**）

```bash
rsync -av --checksum --exclude 'node_modules/' \
  <ASSEMBLY>/ \
  "$(printf '%s' cpa-vps):$NEW/"
```

- `--exclude 'node_modules/'`：保留 2.1 复制来的依赖（约 197 MB），只覆盖约 7 MB 源码/产物。
- **禁止**加 `--delete`：它会把 `node_modules` 删掉，服务立刻起不来。
- 组装物里已包含 `MANIFEST.sha256` 与 `RELEASE.json`（由 [assemble-release.mjs](<docs/qa/deploy/assemble-release.mjs>) 生成）。
- **回退**：重跑 2.1（先 `rm -rf $NEW` 再重建）。

### 2.3 备选模式 V：在 VPS 上用 pinned Node 重新构建（可选，**需批准**）

只有需要「dist 由生产 Node 构建」时才走这条（对应 release-plan §7.2 的 WARN）：

```bash
$SSH "cd $NEW && /opt/crosery-node-current/bin/npm ci && /opt/crosery-node-current/bin/npm run build && \
      find . -type f -not -path './node_modules/*' -not -name '.DS_Store' -not -name 'MANIFEST.sha256' | LC_ALL=C sort | \
      while IFS= read -r f; do printf '%s  %s\n' \"\$(sha256sum \"\$f\" | cut -d' ' -f1)\" \"\$f\"; done > MANIFEST.sha256"
```

- **前提未验证**：生产主机到 npm registry 的网络可达性、`npm ci` 是否成功、耗时。
- `npm ci` 会按**新的 package-lock.json** 重装依赖（含 vue/unocss 等 197MB+）；失败会留下半成品目录 → 用 §2.1 重建。

---

## 3. §3 校验新目录（只读）

```bash
$SSH "cd $NEW && sha256sum -c MANIFEST.sha256 --quiet && echo 'MANIFEST OK' && \
      node -e \"const m=require('./dist/.vite/manifest.json');console.log('vite entries',Object.keys(m).length)\" 2>/dev/null || true; \
      grep -c 'id=\"app\"' dist/index.html; ls dist/assets | wc -l"
```

期望：`MANIFEST OK`；`dist/index.html` 里 `id="app"` 命中 1 次（Vue 入口；React 旧产物是 `id="root"`）。

**回退**：无（只读）；若校验失败 → 回到 §2 修组装物，或 `rm -rf $NEW` 放弃本次。

---

## 4. §4 第二实例 loopback 健康检查（**在 VPS 上起一个额外进程，需批准**；不碰生产数据/端口/symlink）

设计要点：**独立 `DATA_DIR`（临时目录）+ 空闲端口 `18787` + 假 CPA 网关（`127.0.0.1:9`）**。应用不读 `.env`，因此 `env -i` 能保证它与生产网关、生产 SQLite、生产端口完全隔离——**不会对 CPA 网关产生任何写操作**（`startSync()` 的写路径会全部失败在不可达地址上）。

### 4.1 粘贴即用的检查脚本（含超时与失败判据；建议整段复制）

> 用 `ssh … 'bash -s' <<'REMOTE'` 把本地 heredoc 原样喂给远端 bash —— 避免多层引号转义出错（上机时**不要**用一行式的 `$SSH "…\"…\"…"` 版本）。

```bash
SSH='ssh -o ControlMaster=no -o ControlPath=none cpa-vps'
$SSH 'bash -s' <<'REMOTE'
set -u
NEW=${NEW:-/opt/crosery-api-console-releases/20261001-tuffex-rtk}
PORT=${PORT:-18787}
FAIL=0
note(){ printf '%s\n' "$*"; }
hard(){ printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL+1)); }
soft(){ printf 'EXPECTED-DEGRADED  %s\n' "$*"; }

STAGE_DATA=$(mktemp -d /tmp/crosery-staging-data-XXXX)
STAGE_HOME=$(mktemp -d /tmp/crosery-staging-home-XXXX)
cd "$NEW" || { echo "FAIL  $NEW 不存在"; exit 9; }

env -i PATH=/opt/crosery-node-current/bin:/usr/bin:/bin HOME="$STAGE_HOME" \
    DATA_DIR="$STAGE_DATA" HOST=127.0.0.1 PORT="$PORT" \
    CPA_BASE_URL=http://127.0.0.1:9 CPA_MANAGEMENT_KEY=staging-not-real \
    SESSION_SECRET=staging-not-real-0123456789abcdef0123 \
    CONSOLE_USERNAME=staging CONSOLE_PASSWORD=staging-not-real \
    nohup /opt/crosery-node-current/bin/npm run start > /tmp/crosery-staging.log 2>&1 &
PID=$!
echo "$PID" > /tmp/crosery-staging.pid

# ---- 等待监听：最多 20s（每次 2s 超时） ----
UP=0
for i in $(seq 1 20); do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/session"; then UP=1; break; fi
  kill -0 "$PID" 2>/dev/null || { hard "进程已退出（见日志末尾）"; break; }
  sleep 1
done
[ "$UP" = 1 ] || hard "20s 内未开始监听 $PORT"

# ---- H 组：硬断言（必须全 PASS） ----
code=$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://127.0.0.1:$PORT/api/session" || echo 000)
[ "$code" = 200 ] && note "PASS  H1 session=200" || hard "H1 /api/session=$code（期望 200）"

vue=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/" | grep -c 'id="app"' || true)
[ "$vue" = 1 ] && note 'PASS  H2 vue-index=1（新 Vue dist 生效）' \
  || hard "H2 根路径不是 Vue 入口（id=\"app\" 命中 $vue；React 旧产物是 id=\"root\"）"

dl=$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://127.0.0.1:$PORT/keys" || echo 000)
[ "$dl" = 200 ] && note "PASS  H3 deeplink /keys=200（SPA 回退可用）" || hard "H3 /keys=$dl（期望 200）"

entry=$(grep -oE '/assets/[^"]+\.js' "$NEW/dist/index.html" | head -1)
if [ -n "$entry" ]; then
  ac=$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://127.0.0.1:$PORT$entry" || echo 000)
  [ "$ac" = 200 ] && note "PASS  H4 asset $entry = 200" || hard "H4 asset $entry = $ac"
else
  hard "H4 dist/index.html 里找不到入口 chunk"
fi

# ---- E 组：假 CPA 不可达时**本就应该降级**，不计入失败 ----
bk=$(curl -s --max-time 8 "http://127.0.0.1:$PORT/api/bootstrap" || true)
printf '%s' "$bk" | grep -q '"degraded":true' \
  && soft 'E1 /api/bootstrap degraded=true（网关不可达的预期降级）' \
  || note 'NOTE  E1 bootstrap 未标 degraded（可能仍从缓存算出，非失败）'
grep -qE 'sync\.failed|fetch failed' /tmp/crosery-staging.log \
  && soft 'E2 日志含 sync.failed/fetch failed（假 CPA 不可达的预期结果）' \
  || note 'NOTE  E2 日志未见 sync 失败（可能还没到首个同步周期，非失败）'

# ---- 收尾（必做，否则留下临时进程） ----
kill "$PID" 2>/dev/null; sleep 2
rm -rf "$STAGE_DATA" "$STAGE_HOME"
ss -ltn 2>/dev/null | grep -q ":$PORT " && note "WARN  端口 $PORT 仍在监听，请手动确认" || note "PASS  临时实例已关闭、临时目录已清理"
echo "----"
echo "硬失败计数: $FAIL（>0 = 不要进入 §5）"
exit "$FAIL"
REMOTE
```

**H 组四项必须全 PASS**；E 组两项**失败是预期**（假网关不可达），把它们算作失败就会误判，反过来把 H 组当"预期降级"就会掩盖真实故障。

| 断言 | 判据 | 假 CPA 不可达时的期望 |
| --- | --- | --- |
| H1 `/api/session` | `200` | **PASS**（不依赖网关） |
| H2 根路径 | `id="app"` 命中 1 次 | **PASS**（静态产物） |
| H3 `/keys` | `200` | **PASS**（SPA 回退，不依赖网关） |
| H4 入口 asset | `200` | **PASS**（静态产物） |
| E1 `/api/bootstrap` | `"degraded":true` | **EXPECTED-DEGRADED**（网关读失败→如实降级，仍是 200） |
| E2 日志 | 含 `sync.failed` / `fetch failed` | **EXPECTED-DEGRADED**（写路径被隔离在死端口） |

**回退**：脚本自带收尾（kill + 清理临时目录）；不涉及任何生产对象。

### 4.2 旧版一行式命令（仅供对照，建议用 4.1）

```bash
$SSH "set -e
  NEW=/opt/crosery-api-console-releases/20261001-tuffex-rtk
  STAGE_DATA=\$(mktemp -d /tmp/crosery-staging-data-XXXX)
  STAGE_HOME=\$(mktemp -d /tmp/crosery-staging-home-XXXX)
  cd \$NEW
  env -i PATH=/opt/crosery-node-current/bin:/usr/bin:/bin HOME=\$STAGE_HOME \
      DATA_DIR=\$STAGE_DATA HOST=127.0.0.1 PORT=18787 \
      CPA_BASE_URL=http://127.0.0.1:9 CPA_MANAGEMENT_KEY=staging-not-real \
      SESSION_SECRET=staging-not-real-0123456789abcdef0123 \
      CONSOLE_USERNAME=staging CONSOLE_PASSWORD=staging-not-real \
      nohup /opt/crosery-node-current/bin/npm run start > /tmp/crosery-staging.log 2>&1 &
  echo \$! > /tmp/crosery-staging.pid
  sleep 8
  echo -n 'session='   ; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18787/api/session
  echo -n 'vue-index=' ; curl -s http://127.0.0.1:18787/ | grep -c 'id=\"app\"'
  echo -n 'deeplink='  ; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18787/keys
  echo -n 'asset='     ; curl -s -o /dev/null -w '%{http_code}\n' \$(grep -oE '/assets/[^\"]+\.js' \$NEW/dist/index.html | head -1 | sed 's|^|http://127.0.0.1:18787|')
  tail -5 /tmp/crosery-staging.log"
```

**关闭与清理（必做）**：

```bash
$SSH 'kill "$(cat /tmp/crosery-staging.pid)" 2>/dev/null; sleep 2; pkill -f "PORT=18787" 2>/dev/null; \
      rm -rf /tmp/crosery-staging-data-* /tmp/crosery-staging-home-*; ss -ltn | grep -c ":18787 "'
```


> **这一节验证什么/不验证什么**：验证「新代码在 **生产 Node 24** + 新 dist 下能启动、能服务 Vue 页面、SPA 回退可用」；**不验证**生产 3.7 GB 库上的启动耗时，也不验证真实 CPA 网关连通（故意隔离）。

**本地预演（2026-10-01，macOS + 本地 Node，非 VPS）**：把同一套断言跑在本地组装树 `/tmp/cac-deploy-recon/release-20261001-tuffex-rtk` 上（`node_modules` 软链到工作区、`DATA_DIR`/`HOME`/`PORT` 与上面同构、`CPA_BASE_URL` 指向死端口），结果：

```
session=200          # /api/session 正常返回
vue-index=1          # 根路径返回 Vue 产物（<div id="app">），不是 React 的 id="root"
deeplink=200         # /keys 走 SPA 回退，未 404
asset=200            # dist/index.html 引用的入口 chunk 可取
--- 日志尾 ---
{"category":"[ERROR]","event":"sync.failed","stage":"reconcile","code":"SYNC_FAILED","outcome":"error","cause":"fetch failed"}   # 假 CPA 不可达 → 预期
Crosery API Console listening on http://127.0.0.1:18787
```

即：**命令形态与四项断言已被验证可用**（隔离设计也确实挡住了对真实网关的写路径）。VPS 上仍需按 §8.1 复核端口/`/tmp`/依赖解析。

---

## 5. §5 原子切换 + 重启（**生产变更，必须用户明确批准**）

```bash
NEW=/opt/crosery-api-console-releases/20261001-tuffex-rtk
$SSH "ln -s $NEW /opt/crosery-api-console-current.new && \
      mv -T /opt/crosery-api-console-current.new /opt/crosery-api-console-current && \
      readlink -f /opt/crosery-api-console-current && \
      systemctl restart crosery-api-console.service && sleep 8 && \
      systemctl is-active crosery-api-console.service"
```

- `ln -s` + `mv -T`（GNU coreutils）在**同一文件系统内 rename**，是原子替换；不要用 `ln -sfn`（它先删后建，有短暂空窗）。
- `systemctl restart` 会走 `TimeoutStartSec=60s`；若 60 s 内没起来，systemd 判定失败（此时**旧 release 仍在磁盘上**，按 §6 回退）。

**一句话批准（把上面整段交给用户确认即可执行）**：

> 我批准执行：把 `/opt/crosery-api-console-current` 原子切换到 `/opt/crosery-api-console-releases/20261001-tuffex-rtk` 并 `systemctl restart crosery-api-console.service`；如验收失败，立即按 runbook §6 切回 `20260928-reset-clears-cooldown`。

**回退（随时可执行）**：

```bash
ln -s /opt/crosery-api-console-releases/20260928-reset-clears-cooldown /opt/crosery-api-console-current.rollback && \
mv -T /opt/crosery-api-console-current.rollback /opt/crosery-api-console-current && \
systemctl restart crosery-api-console.service && sleep 8 && systemctl is-active crosery-api-console.service
```

### 5.1 回退演练（干跑说明：**现在不执行**，切换前建议先演练一次）

目的：在真正需要回退之前，先证明「一条命令能在 10 秒内回到 React 版」，并且知道**回退后该看到什么**——尤其是 `vue-index` 应当**从 1 变回 0**。

**演练前置**：只在 §5 已批准并执行、且新 release 已上线后做（演练本身会重启一次生产服务，属生产变更）。若只想验证命令语法，可在**本地**对组装树做同构演练（把 `systemctl` 部分去掉）。

**演练步骤（逐条）**：

```bash
# 1) 记录演练前基线（只读）
$SSH 'systemctl show crosery-api-console.service -p NRestarts -p ExecMainStartTimestamp; \
      readlink -f /opt/crosery-api-console-current; \
      curl -s -o /dev/null -w "session=%{http_code}\n" http://127.0.0.1:8787/api/session; \
      echo -n "vue-index="; curl -s http://127.0.0.1:8787/ | grep -c "id=\"app\""'

# 2) 回退（原子换 symlink + 重启；与 §5 回退块完全相同）
$SSH 'ln -s /opt/crosery-api-console-releases/20260928-reset-clears-cooldown /opt/crosery-api-console-current.rollback && \
      mv -T /opt/crosery-api-console-current.rollback /opt/crosery-api-console-current && \
      systemctl restart crosery-api-console.service && sleep 8 && \
      systemctl is-active crosery-api-console.service'

# 3) 三项验收（回退成功的判据）
$SSH 'set -u
  systemctl show crosery-api-console.service -p NRestarts -p ExecMainStartTimestamp -p ActiveState
  echo -n "session=";      curl -s -o /dev/null --max-time 5 -w "%{http_code}\n" http://127.0.0.1:8787/api/session
  echo -n "react-index=";  curl -s --max-time 5 http://127.0.0.1:8787/ | grep -c "id=\"root\""
  echo -n "vue-index=";    curl -s --max-time 5 http://127.0.0.1:8787/ | grep -c "id=\"app\""'
```

| # | 回退后应当验证 | 期望值 | 判据 |
| --- | --- | --- | --- |
| R1 | `GET /api/session` | `200` | 服务确实在提供请求 |
| R2 | 入口 HTML | `react-index=1` 且 **`vue-index=0`** | 已回到 React 入口（`<div id="root">`）；若 `vue-index` 仍为 1，说明 symlink 没换成功 |
| R3 | `NRestarts` | 与演练前**一致**（只应因本次 restart 更新 `ExecMainStartTimestamp`，计数不增长） | `Restart=on-failure` 没在反复拉起；若计数增长 → 老版本也起不来，立即查 `journalctl` |
| R4 | `ActiveState` | `active` | 单元处于运行态 |

**演练后**：

- **不要删除任何 release 目录**；若要切回新版（修好之后）：把 §5 的 `ln -s <NEW>` 再执行一次即可（新的 release 目录仍在盘上，MANIFEST 未变）。
- 演练会多一次重启，请挑低峰时段；回退不需要额外批准（故障恢复路径），但**演练本身**属于生产变更，需要用户同意时间窗。
- 数据库：`deploy/edge/README.md:32-35` 明确「应用回退只还原 symlink 与 unit，不还原 SQLite 备份」；本方案下 `server/db.ts` 等 schema 文件与生产逐字节相同（release-plan §7.1），因此**不需要**任何数据库动作。

**停止服务（仅在需要人工介入时，需批准）**：`systemctl stop crosery-api-console.service`（回退成功后如需恢复：`systemctl start …`；不要 `disable`）。

---

## 6. §6 验收（只读）与判定

```bash
$SSH 'set -e
  systemctl show crosery-api-console.service -p NRestarts -p ExecMainStartTimestamp -p ActiveState
  curl -s -o /dev/null -w "loopback-session=%{http_code}\n" http://127.0.0.1:8787/api/session
  echo -n "vue-index=" ; curl -s http://127.0.0.1:8787/ | grep -c "id=\"app\""
  echo -n "rtk-status=" ; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/api/rtk/status
  echo -n "deep-link=" ; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/keys
  curl -s -o /dev/null -w "public=%{http_code}\n" https://console.ai.crosery.com/
  journalctl -u crosery-api-console.service -n 30 --no-pager | tail -30'
```

| 检查 | 期望 | 不满足时 |
| --- | --- | --- |
| `ActiveState` | `active` | 立即 §5 回退 |
| `NRestarts` | 与 §1 记录一致（不增长） | 观察 1 分钟；持续增长则回退 |
| `loopback-session` | `200` | 回退 |
| `vue-index` | `1`（新前端已生效） | 若为 `0` 说明仍在服务旧 dist → 回退排查 |
| `/api/rtk/status` | `200`（`relay:not_configured` 等诚实降级；CPA 模式下 RTK 未配置属预期） | 5xx 则回退 |
| `deep-link` `/keys` | `200` | 若 404 说明 SPA 回退失效 → 回退 |
| `public` | `200`（nginx + TLS） | 查 nginx/certbot，不必回退应用 |
| `journalctl` | 无 `Error`/`EADDRINUSE`/数据库锁错误 | 有则回退并留证 |

**验收通过后**：把 `<NEW>` 与 BASE 都保留（**不要删除任何 release 目录**）；在 `RELEASE.json` 之外另记一条发布流水（谁、何时、commit、两种 SHA）。

**回退判定**：任何一项核心检查失败 → 执行 §5 的回退命令（一条命令，10 秒内恢复）。

---

## 7. 生产变更清单（哪些步骤需要批准）

| 步骤 | 性质 | 影响面 | 是否需要批准 |
| --- | --- | --- | --- |
| §1 预检 | 只读 | 无 | 不需要 |
| §2.1 复制 BASE → `<NEW>` | 生产写入（**新增目录**） | 磁盘 +203 MB；不动在跑的服务 | 需要（低风险） |
| §2.2 rsync 叠加 | 生产写入（只改 `<NEW>`） | 同上 | 需要（低风险） |
| §2.3 `npm ci` + 构建（可选） | 生产写入 + 网络 | 同上 + 依赖下载 | 需要 |
| §3 校验 | 只读 | 无 | 不需要 |
| §4 第二实例健康检查 | 生产写入（临时进程 + `/tmp`） | 不碰生产数据/端口/symlink | 需要（低风险） |
| **§5 切 symlink + restart** | **生产变更（服务中断数秒）** | **线上控制台重启** | **必须用户明确批准** |
| §6 验收 / 回退 | 只读 / 生产变更（回退同 §5） | 同上 | 回退不需要额外批准（故障即恢复） |

**本轮（task-15）没有执行以上任何一条**；仅完成 §1 所需的只读取证与本地演练。

---

## 8. 未验证项（执行前请当作已知风险）

1. **第二实例在 VPS 上能否跑起来**：端口 `18787` 在取证时刻空闲（`ss` 计数 0）；**`/tmp` 可写已实测**（2026-10-01 用 1 KB 探针写入后立即删除，见 §10 变更记录）；命令形态与四项断言已在**本地**同构预演通过（§4）；`npm run start` 用**生产 era 的 `node_modules`** 跑**新代码**在模块解析上应当可行（新 server 代码只新增相对导入，外部裸依赖仍是 prod 已装的 `express`/`busboy`/`cookie-parser`/`yauzl`/`adm-zip`），但**未在 VPS 上实跑**。
2. **生产 3.7 GB `console.db` 的启动耗时**：`server/db.ts`、`server/quotaLedger.ts`、`server/usageRollup.ts` 与生产**逐字节相同**（release-plan §7.1），因此预期不触发新迁移；但**未实测**，若启动超过 `TimeoutStartSec=60s` 会被 systemd 判失败——回退一条命令即可。
3. **模式 V 的网络**：VPS 能否 `npm ci`（registry 可达性、耗时）**未验证**。
4. **dist 构建 Node 版本偏差**：本地 v26.7.0 构建 vs 生产 v24.20.0（release-plan §7.2），打包产物**未逐字节比对**。
5. **`.env` 的 `DATA_DIR` 实际值**：未读 `.env`（禁令），按部署布局推定指向 `/opt/crosery-api-console/data`；切换步骤复用同一 `.env`，因此不影响安全性。
6. **UI 替换的产品接受度**：见 release-plan §1，属产品决策。

---

## 9. 变更记录（本轮只读动作的自我披露）

- 2026-10-01：本 runbook 与 release-plan 的全部取证均为**只读**（`ls`/`cat`/`grep`/`du`/`df`/`ss`/`readlink`/`pgrep`/`ps`/`tar -cf -`/`curl` GET 到 `/dev/null`）。
- **唯一一次写动作（已披露）**：为验证 §8.1 的「`/tmp` 是否可写」，在生产机 `/tmp` 写入过一个 1 KB 探针文件并**立即删除**（`mktemp /tmp/probe-XXXX` → `echo ok >` → `rm -f`）。它不在 `/opt` 下、不涉及生产数据/配置/服务，也未留下任何文件。
- 未做：未改 `/opt/crosery-api-console-current` 或任何 symlink、未启停 `crosery-api-console.service`、未读写 `/opt/crosery-api-console/data`、未改 `.env`、未删除任何远端文件。

## 10. 回退速查（贴墙版）

```bash
# 一切都出问题 → 10 秒回到 2026-09-28 的版本
NEW=/opt/crosery-api-console-releases/20261001-tuffex-rtk
OLD=/opt/crosery-api-console-releases/20260928-reset-clears-cooldown
ln -s $OLD /opt/crosery-api-console-current.rollback && \
mv -T /opt/crosery-api-console-current.rollback /opt/crosery-api-console-current && \
systemctl restart crosery-api-console.service && sleep 8 && \
systemctl is-active crosery-api-console.service && \
curl -s -o /dev/null -w 'session=%{http_code}\n' http://127.0.0.1:8787/api/session

# 只想放弃本次准备（不影响线上）：删掉新建目录（需批准）
# rm -rf $NEW
```
