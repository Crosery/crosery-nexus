# 网关二进制自动更新：CPA 与 RTK（预发布 → 正式）

两样东西会自动更新：接流量的 CPA 网关二进制（CLIProxyAPI，带我们的补丁）和服务器上的 `rtk`。规则一样：**新版本先在预发布装上、跑满浸泡时长、验收过两次，正式才装同一个文件**；任何一步失败都保留上一个能用的版本，并在控制台写明原因。

仓库公开：本文和入库文件里没有主机名、地址、端口、账号或密钥。这些只在各主机的 env 文件里（见 §4）。

## 1. 角色

每台机器的角色只来自 `/etc/crosery/autoupdate.env`（不入库）：

```sh
AUTOUPDATE_ROLE=preview            # 或 production；没有这个文件、写错 → 按正式处理（最严格）
# 可选，两台机器要一致：
AUTOUPDATE_SOAK_HOURS=24           # 浸泡时长，至少 1
AUTOUPDATE_RECORD_MAX_AGE_DAYS=7   # 正式接受的预发布记录最长多少天，1–30
```

构建机不是角色：它构建、上传、跑验收、转交记录，从不安装。

## 2. CPA

```
构建机（cpa-pipeline.timer，30 分钟一轮）
  补丁系列（见下）→ deploy 分支 → 合并上游最新正式 release → docker go build + go test → cpa-smoke → 本机候选库
  └ tools/cpa-coordinator.mjs round（每轮最后）
      ├ 预发布空闲 → 上传候选（cpa-upload / cpa-stage / cpa-report）
      ├ 预发布装上了 → cpa-acceptance 对预发布公网 API 验收一次 → cpa-accept
      ├ 浸泡满了   → 再验收一次 → cpa-accept
      └ 预发布记录为 accepted → 同一个二进制（sha256 对过）+ 预发布的记录 → 正式（cpa-promote）
预发布 crosery-kernel-update（10 分钟一轮 + 网关投递后立即）
  校验 sha256 与 --version → 不等时段，直接经 cpa-install-binary.sh 安装 → 试运行
  首次验收过 → 浸泡 → 浸泡后验收过 → accepted，写 <data>/kernels/cpa-promotion.json
  任一验收没过 / 连续两次检查不在运行 → 自动换回上一个版本，记下原因，这个版本作废
正式 crosery-kernel-update
  只暂存与晋级记录一致的二进制 → 记录检查 → 安静时段（默认 05:00–07:00 北京时间）→ cpa-install-binary.sh
  换上后每类 OAuth 账号并行发一个真实请求 → 25 秒内没全过就换回旧版本（换回在换上后 30 秒内完成）
```

### 补丁系列

构建机的 deploy 分支由补丁目录决定，不是固定清单：

- 目录 `CPA_PATCH_DIR`（默认 `~/cpa-pipeline/patches/`），从控制台仓库的 `deploy/kernels/cpa-patches/` 同步过去（`*.patch` 不入库，只在本机和构建机上）。
- 用版本最高的 `<上游 tag>/` 子目录。里面有几个 `*.patch` 就按文件名顺序打几个；`SHA256SUMS` 必须和补丁文件一一对上、校验通过。
- 系列一变（加补丁、换基底），就从那个 tag 重建 deploy：每个提交的提交者用补丁作者、提交时间用作者时间，所以同一串补丁总是同一个 HEAD（移植仓库也这样提交时，就和移植仓库的 HEAD 一样）。旧分支留作 `deploy-prev`。
- 校验不过、补丁打不上、源码目录有未提交改动：这一轮停住并报告原因，deploy 不动。
- 没有补丁目录时沿用构建机上现有的 deploy 分支。
- 候选的 `candidate.json` 记下 `series` 和 `patches`（补丁个数）。

### 接入预发布上手工装的二进制

二进制不是构建机这一轮构建的（比如在别处构建、已经手工装上预发布），也可以走同一条晋级路径：

```sh
# 预发布：核对运行中的版本和 sha256，开始试运行；给了上一个版本和它的备份，验收不过就自动换回去
node /opt/crosery-api-console-current/scripts/kernel-applier.mjs adopt --version <版本> --sha256 <sha256> \
  --previous <上一个版本> --backup <备份文件>
# 构建机：把同一个文件收进候选库，晋级时送正式的就是它
node ~/cpa-pipeline/tools/cpa-coordinator.mjs adopt --root ~/cpa-pipeline --binary <文件> --version <版本> --sha256 <sha256>
```

之后协调者照常做首次验收、浸泡后验收、送正式。试运行期间构建机自己的新构建排队等着。

### 正式的保护规则

正式装一个版本之前，`promotionProblems` 逐条检查，任一不满足就不装，控制台显示原因：

| 检查 | 不满足时 |
| --- | --- |
| 有预发布的晋级记录 | 「等预发布两次验收的记录」（这是正常等待，不算错误） |
| 记录的版本、sha256 与暂存的二进制一致 | 不暂存、不安装 |
| 首次验收、浸泡后验收都通过 | 不安装 |
| 浸泡时长（浸泡后验收时间 − 预发布装上时间）不少于 `AUTOUPDATE_SOAK_HOURS` | 不安装 |
| 记录不超过 `AUTOUPDATE_RECORD_MAX_AGE_DAYS` 天，且不是未来时间 | 不安装 |

通过之后还有原来的规则：只在时段内、每个版本只试一次、一个时段只换一次、补丁锁（`/etc/cli-proxy-api/auto-update.hold`）存在就不装。

### 验收（`scripts/cpa-acceptance.mjs`）

对一个公网 API 跑：`/v1/models` 列表、每个模型一次 JSON 回复、一次 SSE（要有增量和 `[DONE]`）、一次工具调用往返。Key 只从环境变量 `CPA_ACCEPT_KEY` 读，输出里会被遮掉。退出码 0 通过、1 不通过、2 用法错。

```sh
CPA_ACCEPT_KEY=… node scripts/cpa-acceptance.mjs --base-url <公网地址> --models a,b [--expect-version V]
```

### 换装后的真实请求

`cpa-install-binary.sh` 在换装前（baseline）、换装后（verify）、换回后（restored）各调一次 `kernel-applier.mjs probe`：

- 账号类型来自 CPA 凭据目录里各凭据的 `type`（停用的跳过）。
- 每类用 `<data>/system-keys.json` 里只绑定那一个服务的探测 Key；没有 Key 的类型记为「跳过」，不算失败。
- 模型来自 `CPA_PROBE_MODELS`（`<服务>=<模型>,…`，写在 `autoupdate.env`），没有就从 `/v1/models` 挑。换装后用和基线相同的模型。
- 基线就没过：不替换，线上不动，30 分钟后再试，不消耗这个版本的唯一一次机会。

结果写在 `/var/lib/crosery-kernels/cpa/probes/<时间>-<版本>/probe-*.json`（只保留最近 10 次，不含 Key）。

## 3. RTK

`crosery-rtk-autoupdate.timer` 每天一次（随机延迟最多 2 小时），跑 `scripts/rtk-autoupdate.mjs auto`：

- **预发布**：从 GitHub releases 列表取最新正式版 → 下载、核对 sha256 → 备份 → 原子替换 → `rtk --version` 和一个小的 `rtk json` 功能检查，不过就换回。之后每次运行都再检查一次；满浸泡时长且一直通过 → `accepted`。中途检查不过 → 换回备份。
- **构建机**：协调者把预发布的 `accepted` 记录（版本、tag、归档 sha256、asset）转给正式（`rtk-promote`）。
- **正式**：只装记录里的那个版本；下载的归档 sha256 和 asset 名必须与记录一致，记录要满足同样的浸泡和时效规则。
- 状态在 `RTK_STATE_DIR/autoupdate-rtk.json`（默认 `/opt/crosery-api-console/data/rtk`）。网络失败按退避重试；校验不过的版本不再自动重试。
- Mac 上没有 `autoupdate.env` 时保持原来的单机行为（读本机上游检查的结果）。

## 4. 每台机器要装的东西

**预发布和正式（相同）**

| 文件 | 装到 |
| --- | --- |
| `deploy/kernels/relay/cpa-install-binary.sh` | `/usr/local/sbin/cpa-install-binary.sh`（唯一的安装入口） |
| `deploy/kernels/relay/cpa-pipeline-gate.sh` | `/usr/local/sbin/cpa-pipeline-gate.sh` |
| `deploy/kernels/relay/crosery-kernel-update.{service,timer}`、`crosery-kernel-request.path` | `/etc/systemd/system/` |
| `deploy/systemd/crosery-rtk-autoupdate.{service,timer}` | `/etc/systemd/system/` |
| `/etc/crosery/autoupdate.env` | 见 §1，root 600 |
| `/etc/cli-proxy-api/install.env`（可选） | `CPA_EXTRA_GATES`、`CPA_WATCH_FILES`、`CPA_VERIFY_BUDGET` 等，见脚本开头，root 600 |
| `<data>/system-keys.json` | 由控制台的系统 Key 功能写入，这里只读 |

构建机公钥用 forced command 限制，按机器的角色写：

```
command="/usr/local/sbin/cpa-pipeline-gate.sh preview",restrict <构建机公钥>      # 预发布
command="/usr/local/sbin/cpa-pipeline-gate.sh production",restrict <构建机公钥>   # 正式
```

网关只放行固定的几个操作（见脚本开头），其他一律 `denied`。

**构建机**（`~/cpa-pipeline/`）

| 文件 | 装到 |
| --- | --- |
| `deploy/kernels/cpa-builder/{run.sh,build-in-container.sh}` | `~/cpa-pipeline/` |
| `scripts/{cpa-coordinator.mjs,cpa-acceptance.mjs,autoupdate-common.mjs,cpa-smoke.mjs}`、`deploy/kernels/cpa-builder/smoke-config.yaml` | `~/cpa-pipeline/tools/` |
| `deploy/kernels/cpa-patches/<上游 tag>/`（含本机的 `*.patch`） | `~/cpa-pipeline/patches/<上游 tag>/` |
| `pipeline.env` | `~/cpa-pipeline/pipeline.env`，600，不入库，格式如下 |

```sh
CPA_PIPELINE_PREVIEW="ssh -o BatchMode=yes <预发布 SSH 别名>"
CPA_PIPELINE_PRODUCTION="ssh -o BatchMode=yes <正式 SSH 别名>"
CPA_ACCEPT_BASE_URL=<预发布 API 公网地址>
CPA_ACCEPT_KEY=<预发布的验收 Key>
CPA_ACCEPT_MODELS=<逗号分隔的模型>
```

缺任何一项 `run.sh` 直接失败，没有默认值。主机名、地址、端口和 SSH 用户只写在构建机的 `~/.ssh/config`（别名）里，不进仓库。

## 5. 控制台

- **设置 → 网关**（`server/kernels.ts`、`KernelsPanel.vue`）：CPA 一行「流水线」写明候选走到哪（预发布试运行 → 浸泡到几点 → 两次验收通过 → 正式已暂存、等时段 → 已装上 / 没过、换回了哪个版本），「检查」写上次和下次检查、最近一次错误。
- **同步中心**（Linux）：「RTK 自动升级」一行显示上次、下次运行，预发布的试运行或正式等验收的状态，失败原因和退避。

## 6. 需要人工处理的情况

| 控制台显示 | 怎么办 |
| --- | --- |
| 回滚没开始 / 回滚也没成功 · 需要人工处理 | 在那台机器上看 `journalctl -u crosery-kernel-update` 和 `/var/backups/cpa/`，用 `cpa-install-binary.sh <备份> <版本>` 装回 |
| 配置在换装期间变了，没有自动换回 | 先确认 config.yaml 的改动，再决定装哪个版本 |
| 预发布的记录不能用（过期、不一致） | 正式不会装；等下一个候选在预发布重新走完，或查构建机日志 |
| RTK 校验不过 | 这个版本不再自动重试；换新版本或人工核对发布 |
