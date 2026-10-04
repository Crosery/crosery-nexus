# 中转站网关内核自动更新（CPA 接流量 + Magpie 备用）

> 状态：本地实现完成，sj-4837-new 已演练 v7→v8 自动升级和一键回滚；AGY 使用替身，真实账号和出口业务验收尚未完成。**本功能未部署到生产。** 每一步上线都要站长批准，见 §5。

## 1. 现状（2026-10-03 只读核实）

CPA 原本就有一条「跟上游」流水线，只是停住了：

| 环节 | 位置 | 现状 |
| --- | --- | --- |
| 构建机 | ibuki-wsl-crosery `~/cpa-pipeline`，用户级 `cpa-pipeline.timer` 每 30 分钟跑一次 | 每轮都报 `minor_hold v7.3.16 -> v8.0.12` 后停住，不再往下跟 |
| 构建机 deploy 分支 | v7.3.16 + 我们的补丁 + registry 修复 | 版本比生产新，但从来没装上去 |
| 生产安装事务 | `/usr/local/sbin/cpa-install-binary.sh`。管理 API/Console 门禁 + AGY 门禁；备份二进制、config.yaml、AGY 凭据；配置没变才回滚 | 可用，原样保留 |
| 生产补丁锁 | `/etc/cli-proxy-api/auto-update.hold`（2026-09-30） | 拦住一切安装，包括流水线。它本来是为了挡原版 `cpa-auto-update.sh`，但那个 timer 已经 masked |
| 生产 CPA | `7.3.15-patched.498fcc2b` | 上游最新是 v8.0.12 |
| **生产控制台门禁** | `/usr/local/sbin/cpa-management-console-compat-check` 检查首页有没有 `id="root"` | **今天 v3 上线后首页是 `id="app"`，这一项一定不过。** 门禁的规则是「基线已降级就不许升级」，所以现在任何安装都会被拒绝。修复版在 `deploy/kernels/relay/` |

所以这次不另起一条流水线，沿用现有的构建机和安装事务，只补上缺的部分：

- 跟上游最新正式版
- 安静时段替换，每个版本只试一次
- 上线前冒烟
- 控制台里看得见、能一键回滚
- Magpie 备用内核

## 2. 拓扑

```
ibuki-wsl-crosery（构建机，30 分钟一轮）            站长 Mac（Magpie 已有的检查→演练→替换之后）
  合并上游最新正式 release → docker go build/test       本机内核正在跑的修订 → linux/amd64 构建
  → cpa-smoke（生产形状假配置）                          │
  │ cpa-upload / cpa-stage / cpa-report                │ magpie-upload / magpie-report
  ▼ （forced-command：cpa-pipeline-gate.sh）           ▼ （forced-command：magpie-standby-gate.sh）
中转站 /var/lib/crosery-kernels/<kernel>/inbox
  │  crosery-kernel-update.service（timer 10 分钟 + 网关上传后 + 控制台回滚请求的 path unit）
  ▼  scripts/kernel-applier.mjs auto
  ├ CPA：校验 sha256 与 --version → 暂存 → 安静时段、每版本一次、没有补丁锁
  │      → cpa-install-binary.sh（门禁、备份、失败回滚）
  └ Magpie：校验 sha256 → 控制台同款沙箱单独启动、/internal/health 修订一致 → current 指向新版本
  ▼  <data>/kernels/{cpa,magpie}.json
控制台「设置 → 网关」：两个内核的版本、上游、候选、自动更新开关、时段、上次结果、一键回滚（只排队）
```

从此构建机**不再安装**：网关去掉了 `cpa-install`，安装只由中转站在时段内完成。

## 3. 规则

- **CPA 保持最新**：构建机每轮把上游最新的正式 release（`vX.Y.Z`）合进 deploy 分支，patch、minor、major 一视同仁。合并冲突时就停在原版本，报「要人工移植补丁」，控制台「上游」一栏能看到。移植好的补丁系列放进 `deploy/kernels/cpa-patches/<上游 tag>/`。
- **替换时段**：默认 **05:00–07:00 北京时间**，控制台可以改，时区固定。选这一段，是因为近 15 天按小时统计，北京时间 05–07 点每小时平均 171–271 次请求，是全天最低的一段（全天平均 625）。
- **CPA 替换条件**：只装演练通过、并且比正在跑的版本新的候选。
  - 每个版本只试一次，回滚后不再自动重试。
  - 一个时段只换一次。
  - 安装脚本拒绝时（比如基线门禁没过），线上什么都没动，30 分钟后在时段内重试。
- **配置格式**：v8 能直接读旧布局，也不会改写文件；控制台用 /v0 写回时也保持旧布局。只有通过 v8 自己的管理接口写配置（`/v8/management` 或上游自带面板），config.yaml 才会迁移成 `config-version: 8`，之后 v7 就起不来。applier 每轮记录一次 `configLayout`。
- **一键回滚**：只回到上一次自动替换之前的版本，走同一个安装事务。跨大版本的回滚只在 config.yaml 仍是旧布局时提供，面板和 applier 各检查一次。
- **Magpie 备用**：不接流量，没有时段限制，每个修订只换一次，启动检查不过就不换。

## 4. 文件

| 仓库文件 | 装到 |
| --- | --- |
| `scripts/kernel-applier.mjs` | 随控制台 release（`/opt/crosery-api-console-current/scripts/`） |
| `server/kernels.ts`、`src/features/settings/KernelsPanel.vue` | 控制台 release |
| `deploy/kernels/relay/crosery-kernel-update.{service,timer}`、`crosery-kernel-request.path` | 中转站 `/etc/systemd/system/` |
| `deploy/kernels/relay/cpa-pipeline-gate.sh` | 中转站 `/usr/local/sbin/cpa-pipeline-gate.sh`（替换 v1） |
| `deploy/kernels/relay/cpa-management-console-compat-check` | 中转站 `/usr/local/sbin/`（替换现有版本，只改一处：首页 `id="root"` 或 `id="app"` 都算通过） |
| `deploy/kernels/relay/magpie-standby-gate.sh` | 中转站 `/usr/local/sbin/`，配 Mac 专用公钥的 forced command |
| `deploy/kernels/cpa-builder/{run.sh,build-in-container.sh}` | 构建机 `~/cpa-pipeline/`（替换 v1） |
| `scripts/cpa-smoke.mjs`、`deploy/kernels/cpa-builder/smoke-config.yaml` | 构建机 `~/cpa-pipeline/tools/` |
| `deploy/kernels/cpa-patches/v8.0.12/` | 构建机 deploy 分支的来源：v8.0.12 + 7 个补丁，HEAD `5552cbaf` |
| `scripts/magpie-standby.mjs` | Mac：launchd 任务环境里设了 `MAGPIE_STANDBY_SSH` 才启用 |

## 5. 上线（每一步都要站长批准，并写明环境）

1. **控制台 release**：按 `v3-cutover.md` 的组装 / 第二实例 / 切换流程，发一个带 applier 和面板的新 release。
2. **中转站**：
   - 装两个网关脚本、修复版控制台门禁、三个 unit。
   - 建目录：`install -d -m 700 /var/lib/crosery-kernels /opt/crosery-api-console/data/kernel-requests`。
   - 启用：`systemctl enable --now crosery-kernel-update.timer crosery-kernel-request.path`。
   - 这时补丁锁还在，applier 只记录，不安装。
3. **构建机**：
   - 把 `~/cpa-pipeline/src` 的 deploy 分支换成 `cpa-patches/v8.0.12` 那串补丁（原分支保留为 `deploy-v7`）。
   - 换上 v2 的 `run.sh`、`build-in-container.sh` 和 tools。
   - 第一轮会构建 `8.0.12-patched.5552cbaf`，冒烟后暂存；applier 看到补丁锁，停住。
4. **移除补丁锁**：改名留档为 `auto-update.hold.20260930`。之后第一个时段，applier 经 `cpa-install-binary.sh` 把 v8 装上（门禁、备份、失败自动回滚）。只要 config.yaml 还是旧布局，面板就提供一键回到 7.3.15。
5. **Magpie 备用**：中转站加 Mac 专用公钥（forced command 指向 `magpie-standby-gate.sh`），Mac 的 launchd 任务加上 `MAGPIE_STANDBY_SSH`。

升级到 v8 后，**不要用上游自带面板或 `/v8/management` 改配置**：那会把 config.yaml 迁移成新格式，一键回滚就不再提供了。真到那一步要人工回 v7，`/var/backups/cpa/cli-proxy-api.<旧版本>.<时间>.state/config.yaml.before` 里有升级前的配置，迁移之后的改动要先人工合并进去。

## 6. 演练记录（sj-4837-new，2026-10-03）

演练机按生产路径装了同一套 unit、网关脚本和安装事务（`cpa-install-binary.sh`，只把 AGY 凭据路径换成演练机的）。控制台门禁用生产脚本加上 `id="app"` 修复。AGY 门禁用替身，原因是演练机没有真实的 AGY 账号。

| # | 场景 | 结果 |
| --- | --- | --- |
| G | 两把网关 key 要 shell / 跑任意命令 | 均拒绝（`denied`） |
| S1 | 构建机报告 + 暂存，时段外 | 已暂存，面板显示「演练通过 · 等 时段 替换」 |
| S2 | 控制台把时段改到当前时间 | applier 经安装事务替换，用时 4 s；面板显示「HH:MM 替换到 X」 |
| S3 | 控制台一键回滚（不带 confirm 返回 403，带了返回 202） | path unit 接手，回到 498fcc2b；面板显示「已手动回滚 · 不再自动换上这个版本」 |
| S4 | 坏候选（原版 v7.3.15，门禁不过） | 安装脚本自动回滚；面板标红「替换失败，已自动回滚 · 不再自动重试这个版本」 |
| S6 | Magpie 备用 3fe2ff9（sha 7b1bb96f…，可复现） | 沙箱启动检查通过 → current；没有残留 unit 和目录 |
| S7 | v8 linux 二进制在演练机上跑 `cpa-smoke` | 42/42 通过（解决 R10：这个二进制之前从没在 linux 上启动过） |
| S8 | 生产控制台门禁原样运行 | v3 首页 `id="app"` 导致 `console.page` 不过，基线判为已降级 → 修复后 v7 基线全过 |
| S9 | v7→v8 自动升级（时段内，applier → 安装事务） | 16:13 完成，用时约 5 s；门禁全过；config.yaml 哈希没变，仍是旧布局；面板显示 v8、可回滚到 7.3.15 |
| S10 | v8 下通过控制台新建、删除 Key（/v0 写回） | 仍是旧布局；`api-key-model-access`、`api-key-channel-access` 都在、没被注释；门禁全过。接口返回 400/500，原因是演练机没配 nginx 不限速同步，这个错误在 v7 下同样出现，和 v8 无关 |
| S11 | 控制台一键回滚 v8→v7 | 202 → 回到 7.3.15-patched.498fcc2b 并通过门禁；面板显示「已手动回滚」，不会再自动装 v8 |
| S12 | v2 构建机在 ibuki-wsl 的独立目录 `~/cpa-pipeline-rehearsal-v2` 里跑（deploy = v8 补丁串，目标指向演练机） | docker 构建 + `go test ./...` + 冒烟 42/42 通过；上传、暂存、报告成功，面板显示候选与最新上游。已回滚过的同一版本没有再次安装 |
| S13 | 独立构建目录临时使用旧 deploy（812b66af）跟 v8.0.12 | 报 `merge-conflict`，`git merge --abort` 后保留原 HEAD，未上传候选；恢复 v8 补丁分支后复用暂存候选。两次临时 fetch 失败也只报告 `fetch-failed`、未进入构建 |

单元测试另外覆盖：

- config.yaml 是 `config-version: 8` 时，跨大版本回滚会被拒绝（「已被 … 迁移成新格式」），改回旧布局后才放行。
- 新 major 和普通版本走同一条路径：在时段内、经安装事务、受补丁锁约束。空锁文件或锁不可读也不进入安装；实际替换与手动回滚入口再次检查锁。
- 带注释、引号、BOM 的 `config-version` 不会被误判为旧布局；配置缺失、空文件、重复或无法识别的版本标记拒绝跨大版本回滚。安装完成后立即重新读取布局，面板不沿用安装前的判定。
- 构建机跟随 patch/minor/major 最新正式 tag，不选预发布 tag；合并、构建、冒烟、上传失败不继续暂存或安装；无法切到 deploy 分支时保留本地未提交改动，不构建其他分支。

## 7. 验收边界与本地证据

风险等级：**R3**（线上接流量内核、权限、配置格式和回滚）。完成条件是兼容语义不退化、失败不扩大影响、既有锁和安装事务不被绕过，而不只是版本号变新。

| 验收项 | 已验证证据 | 未覆盖的边界 |
| --- | --- | --- |
| 渠道与模型权限 | v8 移植测试含 `TestChannelAccessSingleChannelPinsCaller`、`TestChannelAccessMultipleChannelsStillSpread`、模型白名单管理测试；linux 冒烟验证 `/v1/models` 过滤、越权模型 403、未知 Key 401 | 真实渠道请求、全部协议入口的生产权限行为 |
| 账号 | 管理接口 `auth-files`、假凭据加载与重启；`TestUploadAuthFile_BatchMultipart_InvalidJSONDoesNotOverwriteExistingFile` | 真实 OAuth 登录/刷新、账号可用性 |
| 额度与冷却 | `TestCredentialQuotaKeepsHealthyCatalogAcrossRestart`、并发成功不清除有效冷却、更新保留有效冷却等 Go 测试；旧/新布局字段保持测试 | 真实上游扣费、配额耗尽和冷却业务验收 |
| 代理出口 | per-key `proxy-url` 读写保持；`TestNewAntigravityHTTPClientSharesTransport/auth_http_proxy` 等本地测试 | 生产 mihomo 各账号出口、AGY native function calling/websearch 的真实请求 |
| 更新/回滚 | S1–S4、S9、S11–S13；applier 17 项、builder 9 项离线回归、控制台 routes/view 6 项均通过 | 生产 unit/SSH gate/首轮 v8 的安装及观察期 |

2026-10-03 本地收口检查：

- `[verified]` `npm test`：**1554 pass / 0 fail / 3 skip**。跳过项是实际 Magpie headless kernel、两项 `PROXY_E2E=1` mihomo 集成测试；没有因此声明真实代理出口验收通过。
- `[verified]` `node --test scripts/kernel-applier.test.mjs scripts/cpa-builder.test.mjs`，`npx tsx --test server/kernels.test.ts`：更新保护与路由测试通过。builder 测试用临时 Git 仓库，Docker/SSH/smoke 为替身，不访问远端。
- `[verified]` v8 补丁工作区 HEAD `5552cbaf`：`GOPROXY=off GOSUMDB=off CGO_ENABLED=0 GOFLAGS=-buildvcs=false go test -count=1 -json ./internal/config ./internal/api/handlers/management ./sdk/cliproxy/auth ./internal/runtime/executor`，**5574 pass / 0 fail / 0 skip**。
- `[verified]` 既有 v8 全量移植证据：**16031 pass / 0 fail / 8 skip**；纯净上游 **15969 pass / 0 fail / 8 skip**，共有测试没有状态变化。补丁 `SHA256SUMS` 全部核验通过。
- `[verified]` `npm run build`、`bash -n deploy/kernels/cpa-builder/run.sh`、`git diff --check`、`npm run qa:bundle` 通过。`npm run lint` 经 `rtk proxy` 核实 exit 0，有两条无关既有 `server/nativeResponses.ts` 的 `no-control-regex` 警告（200、203 行）。
- `[verified]` 当前构建产物通过纯本地、合成数据的 HTTP fixture 渲染，1440px/390px 均显示「跟随最新正式版」，无横向溢出；截图为 `/tmp/console-v3/kernels-rehearsal/panel-latest-{desktop,mobile}.png`。复用现有 Tuffex / Switch / Sheet 和主题 token，未改变样式。`[unverified]` 改时段对话框完整键盘往返验证（浏览器脚本错误后原 TaskSpace 不可访问，未另开空间绕过；未声明 focus 恢复通过）。本地 fixture 进程已按记录的 task ID 停止。

证据位置（本机、假数据/统计，不含真实凭据）：

- `/tmp/console-v3/kernels-rehearsal/closure-npm-test.log`、`closure-build.log`。
- `/tmp/console-v3/cpa/compat-closure-tests.jsonl`（本次四包回归）、`work/final-port.json`、`work/full-pristine.json`（既有全量移植对照）。
- `/tmp/console-v3/kernels-rehearsal/report-v8.json`（演练候选报告）、`/tmp/console-v3/cpa/PORT-REPORT.md`（移植明细与已知缺口）。

## 8. 未验证、残余风险与批准项

- `[unverified]` **真实账号、额度/冷却、代理出口/AGY 业务尚未完成生产前后对照**。演练机的 AGY 门禁只输出成功标记，不能作为真实 AGY 兼容证据；S10 创建/删除 Key 返回 400/500，也不能算完整控制台业务成功。
- `[verified]` 账号状态界面的证据边界（纯本地 view-model 研究，33/33 测试）：额度默认显示「已用」，只有剩余模式明确写「剩 N%」（`CpaAccountsPage.vue:86`、`QuotaCell.vue:15`、`server/accountQuota.ts:219`）；Antigravity 出口绿灯是未认证 Google HTTP 可达性检查，不是账号授权或推理成功（`server/proxyCheck.ts:23`）。冷却状态按 `payload.at` 判定，倒计时按实时时钟，到期刷新又可能拿到 monitor SWR 旧快照，所以 `00:00` 仍标冷却可复现（`CpaAccountsPage.vue:65`、`model.ts:446`、`server/requestCoordinator.ts:67`）。
- `[unverified]` 「429 限流 · Retry-After」是文本匹配后的固定翻译（`src/features/accounts/model.ts:270`），不是实际 `Retry-After` 响应头证据；「唯一可用时仍会被尝试」是所有冷却行统一加的文案（同文件 `:463`），不能据此认定真实 CPA selector fallback 已被验证。没有因此修改账号、代理或路由。
- `[residual risk]` v0 管理接口已被上游标记 deprecated；未来正式版若移除，构建机 smoke 应失败并停留在原版本，不能跳过它改走 v8 写接口，否则配置迁移会影响回滚。
- `[residual risk]` 既有 fork 缺口未扩大也未在本次修复：Gemini Interactions 入口未执行模型白名单；api-keys PATCH 改名不迁移渠道白名单（控制台当前用 PUT）；部分内置模型定义会覆盖上游 Home catalog 元数据。不能据本次测试声明所有协议授权完整。
- `[residual risk]` 配置可被外部写入者同时修改：applier 的布局检查不是跨进程事务锁。生产安装事务保留快照/停止前后比对与冲突停止；上线窗口需协调禁止并发配置迁移，出现冲突时不得强制回滚或覆盖文件。
- `[verified]` 已记录的上传、WSL 演练等待任务结束，本地相关 PID 不再存活。WSL 独立演练目录清理不完整，残留 root/只读 Go 缓存；不再继续远端清理。原 `~/cpa-pipeline` deploy 仍为 `812b66af`，未切换。
- **待真实用户批准**：生产控制台 release、生产门禁/units/gates、移除 hold 与首轮 v8、WSL 正式流水线切换、Mac standby 接入；本地修改未提交、未 push、未 merge。本轮 CPA 更新适配仅只读核实生产，已有远端写入限于 sj-4837-new 演练机及 WSL 独立演练目录，恢复通知后无新增远端写操作。
