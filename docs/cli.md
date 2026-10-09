# cradmin：中转站管理 CLI

`cradmin` 是 crosery-api-console 的管理员命令行。它和公开分发的 `crapi` 是两个东西：`crapi` 给终端用户接入网关，`cradmin` 只给管理员用，代码在本仓库 `cli/`，和服务端同仓、同测。

- **只调控制台的 HTTP API**，复用服务端的校验、写队列、审计和冷却；不直接改 SQLite 或 JSON 数据文件。
- 只用 Node 内置模块，不新增依赖；要求 Node 24+。
- 默认目标是本地沙盒 `http://127.0.0.1:8791`。连生产必须显式 `--profile prod` 或 `--base <url>`。

## 安装

```bash
node cli/cradmin.mjs <命令>                                    # 不安装，直接运行
ln -s "$PWD/cli/cradmin.mjs" ~/.local/bin/cradmin             # 在仓库根目录执行一次；之后任意目录可用 cradmin
rm ~/.local/bin/cradmin                                        # 卸载
```

软链指向仓库里的文件，`git pull` 后自动是新版本；`#!/usr/bin/env node` 用 PATH 上的 node（仓库要求 Node 24，Node 26 也能跑，`doctor` 会标黄）。也可以在仓库里 `npm link`（package.json 的 `bin`），但 fnm 下全局 bin 跟着 Node 版本走，切版本后要重新 link。

无参数且在终端里运行时进入编号菜单；非交互环境无参数时打印帮助。`cradmin … | head` 这类提前关闭管道的用法安静退出 0。

## 目标与 profile

| 参数 / 环境变量 | 说明 |
|---|---|
| `--profile <名>` / `CRADMIN_PROFILE` | 内置 `local`（8791）与 `prod`（console.ai.crosery.com），默认 `local` |
| `--base <url>` / `CRADMIN_BASE` | 覆盖 profile 的地址 |
| `--user <名>` / `CONSOLE_USERNAME` | 管理员用户名（默认 `admin`） |
| `--keychain-service <名>` / `CRADMIN_KEYCHAIN_SERVICE` | 钥匙串 service（local 默认 `com.crosery.console-magpie.local`）。`--base` 指向 profile 以外的地址时不读 profile 的钥匙串条目，需要时显式指定 |
| `--env-file <路径>` | 指定 .env |

通用参数：`--json`（读命令只输出 JSON）、`-y` / `--yes`、`--dry-run`、`--no-color`（或 `NO_COLOR`）、`-h`、`-v` / `--version`。其它环境变量：`CRADMIN_GLYPHS=ascii`（终端不支持框线字符时）、`CRADMIN_KEYCHAIN=off`（不读写钥匙串）、`CRADMIN_NONINTERACTIVE=1` 或 `CI`（按非交互处理，不提示输入）。

可选配置文件 `$CRADMIN_HOME/config.json`（或 `$XDG_CONFIG_HOME/cradmin/config.json`、`~/.config/cradmin/config.json`）只允许 `defaultProfile` 与每个 profile 的 `base`、`username`、`keychainService`。CLI 从不创建或写入它；里面出现 `password`、`token`、`secret`、`apiKey` 之类的键直接退出 2。

非回环地址视为远程：每个写命令都会提示「目标是远程控制台」，并且所有写命令都要确认。远程地址必须是 `https://`，明文 `http://` 不会发送管理员密码（退出 2）。

## 凭据（第一个拿到值的档位胜出）

1. 环境变量 `CONSOLE_PASSWORD` 或 `CONSOLE_PASSWORD_FILE`（两者同时设置报错；`_FILE` 必须是权限 0600 级别的普通文件、≤16 KiB，规则与服务端一致）。
2. 控制台仓库的 `.env`（在仓库里运行时自动找，或 `--env-file`）。**只有目标是回环地址且端口等于这份 .env 的 `PORT` 时才使用**，免得拿开发密码去撞 8791 的登录限流。值以 `replace-with-` 开头视为未配置。
3. macOS 钥匙串：`security find-generic-password -s <service> -a <用户名> -w`。存密码：`cradmin login --save`（由 security 自己提示输入，密码不进命令行）。
4. 终端隐藏输入，最多 3 次。非交互环境拿不到凭据时退出 3。

空密码一律拒绝；登录失败不自动重试（服务端按 IP+用户名计数，第 5 次失败会把网页登录一起锁住）。被拒过的凭据本进程不再重发；终端输入最多试 3 次。`CONSOLE_USERNAME` 显式设为空等同 `admin`（与服务端一致）。

**会话缓存**：macOS 上登录后把会话 token 缓存进钥匙串（service `com.crosery.cradmin.session`，account `<用户名>@<地址>`，经 `security -i` 的 stdin 写入，不进 argv），到期前复用，避免每条命令都写一条 login 审计。`--no-session-cache` 或 `CRADMIN_SESSION_CACHE=off` 关闭；关闭时每个进程登录一次、结束时注销。`cradmin logout` 吊销并删除缓存。

密码、会话 token 从不出现在输出、日志、错误文本或 `--json` 里。

## 写操作分级与确认

| 级别 | 例子 | 本地目标 | 远程目标 |
|---|---|---|---|
| 只读 | ls / show / status / usage | 直接执行 | 直接执行 |
| 增加能力 | 启用、新建、同步 | 直接执行 | 先确认 |
| 收缩能力 / 改策略 | 停用、关模型、改 Key、改代理、RTK、rtk upgrade、config apply | 先确认 | 先确认 |
| 不可撤销 / 消耗额度 | 删除、prune、rotate、账号重置 | 先确认（红字「不可撤销」） | 先确认 |

- 确认默认「否」；`--yes`（`-y`）跳过确认。交互菜单里每个写动作都要确认；`cradmin --dry-run` 进菜单时所有动作只预览。
- **非交互环境需要确认却没给 `--yes`：退出 2，不发任何写请求。**
- 每个写命令都支持 `--dry-run`：照常读取、计算差异，打印计划和将调用的 `METHOD /path`，不写。
- 批量写按顺序执行，遇到第一个失败就停，汇报「已完成 n / 失败 1 / 未执行 m」。重跑会重新计算差异，幂等。
- 写请求超时报「结果未知」而不是「连不上」：服务端可能仍在执行，先用读命令确认再决定是否重试。`models sync` 触发后台任务 `model-discovery` 后轮询结果（最多 10 分钟）。

## 命令速查

```text
cradmin status                                   总览
cradmin channels ls | show <渠道>
cradmin channels models <渠道> [--enable p,…] [--disable p,…] [--only p,…]   模型开关（精确 id 或 * ? 通配）
cradmin channels enable|disable <渠道>
cradmin channels add <名称> --base-url <url> --api-key-stdin --models id[=别名],… [--protocol openai|claude|responses]   上游 Key 从 stdin 读
cradmin channels rm <渠道> | prune
cradmin models ls [--channel X] [--search s] [--unpriced] [--type chat|image|video|audio|embedding|rerank|other] [--all] | show <模型> | sync
                                                 类型按输出分（看图的对话模型仍是 chat），非对话模型带类型标签
cradmin keys ls | show <key>
cradmin keys create --name <名称> --groups a,b|all [--concurrency N --group-concurrency a=1] [--daily-usd 5]
cradmin keys update <key> [--add-groups x] [--remove-groups y] [--concurrency N] [--total-usd/--daily-usd/--weekly-usd] [--reset-spent daily]
cradmin keys enable|disable|delete|copy <key>
cradmin keys rotate <key> [--delete-old] [--slug s]       保留启停状态；自定义 slug 要再给一次
cradmin accounts ls [--quota] | show | pause|resume <账号…> | proxy <账号> <url|direct|none|inherit> | reset | rm
cradmin accounts add <provider> [--callback-url <url> --state <state>]
cradmin proxy ls [--tag t] | import <文件|订阅链接|-> [--tags a,b] | test <出口…>|--in-use
cradmin proxy assign <账号…> <出口|inherit|direct> | unassign <账号…> [--restore] | default <出口|inherit|direct>
cradmin proxy rm <出口> [--reassign <出口|inherit|direct|keep>] | migrate [--dry-run] | export [--out f] [--with-secrets] [--force]
cradmin proxy kernel status|start|stop|restart | subscriptions ls|refresh <订阅>|rm <订阅> [--keep-nodes]
cradmin usage [--days 1|7|30|90] [--key k] [--model m] [--channel c] [--top N]
cradmin sync ls | run <任务> [--wait]
cradmin rtk status | on | off | auto | upgrade [--dry-run] [--accept-breaking]
cradmin settings | audit [--limit N --action x --grep s]
cradmin config export [--out f] | apply <文件> [--dry-run] [--yes] [--create-keys]
cradmin login [--save] | logout | whoami | doctor | version
```

`channels ls` / `accounts ls` / `models ls` / `keys ls` 默认输出树（`├─` / `└─`，`CRADMIN_GLYPHS=ascii` 时 `|-` / `` `- ``），层级与命名同 Web 控制台：供应商 → API 渠道 / 订阅账号池；provider → 账号（运行 / 冷却 / 暂停 / 失效 / 异常，`--quota` 才有冷却与失效）；厂商 → 模型；全部 Key 按额度压力排序。`channels show` / `accounts show` / `keys show` 与 `usage` 的状态词、原因行和栏目名也照控制台（渠道 启用 / 降级 / 停用 / 残留，Key 启用 / 接近上限 / 超额停用 / 停用，额度窗口 日 / 周 / 累计，用量 请求 / Token / 花费 / 失败率 / 缓存命中 / 活跃 Key）；渠道的 异常 与按失败率的 降级 要读健康数据，CLI 不显示。`--json` 不变。

`<渠道>` 是兼容渠道名或账号池 provider（`codex`、`claude` …）。`<key>` 是唯一显示名称或 id 前缀（≥8 位十六进制）。`<账号>` 是凭据名或名称/标签里唯一的子串。所有读命令支持 `--json`（stdout 只有缩进 2 的 JSON）。

完整 Key 只在 `keys create` / `keys rotate`（以及 `config apply --create-keys`）时在 stdout 打印一次；`keys copy` 只放进剪贴板，从不打印。

## 一键配置

```bash
cradmin config export --out crosery.json         # 渠道开关与启用的模型、账号池模型、账号启停与代理、Key 元数据、RTK；不含任何秘密（代理地址的 user:pass@ 打码成 ***@）
cradmin config apply crosery.json --dry-run      # 对比并打印计划
cradmin config apply crosery.json --yes          # 按固定顺序应用
```

apply 只调和文件里出现的段和条目，**从不删除**；服务端不存在的渠道、模型、账号、Key 跳过并警告。Key 有 `id` 前缀时按前缀匹配，匹配不到再按唯一名称（跨控制台应用、重跑都不会重复新建）；要改成的名称已被另一把 Key 占用（例如轮换过）时跳过这一条。匹配不到的 Key 加 `--create-keys` 才会新建（`enabled:false` 的建完再停用）。打码的代理地址与服务端一致视为未改，不一致跳过并警告。执行顺序：启用渠道 → 渠道模型 → 账号池模型 → 账号 → Key → 停用渠道 → RTK。导出后立刻应用得到「没有需要改动的配置」。

## 代理池

```bash
cradmin proxy migrate --dry-run                  # 列出账号里已配置的代理出口（只读账号）
cradmin proxy migrate --yes                      # 收进代理池：新建出口、关联账号，不改任何账号设置
cradmin proxy import clash.yaml --tags 日本      # Clash 配置 / 订阅链接 / ss:// vmess:// … / Base64 / 导出文件，先预览
cradmin proxy test --in-use                      # 后台检测在用出口：出口 IP/国家 + Claude / OpenAI / Google（10 分钟冷却）
cradmin proxy assign claude-a claude-b <出口> --yes   # 最后一个参数是目标；原出口记下，unassign --restore 还原
cradmin proxy export --with-secrets --out pool.json   # 迁移到另一台控制台：含密码，写成 0600，不覆盖已有文件
```

- 账号自己的 `proxy_url` 始终是事实来源，代理池只是索引；只有 `assign` / `unassign` / `default` / `rm --reassign` 改账号，都要确认。
- 加密节点（ss / vmess / trojan / vless / hysteria2 / tuic / wireguard）由控制台自己托管的 mihomo 开成 `127.0.0.1` 上带认证的 socks5 端口（`PROXY_PORT_BASE`，默认 27890 起），不碰 Clash Party 的配置和端口；内核 `未安装` 时这类出口能导入、不能分配。CPA 不在本机时，本机端口类出口不能分配给 CPA 账号。
- 所有输出（含 `--json`）都是脱敏的；只有 `export --with-secrets` 的文件里有密码，终端只打印路径和数量。在另一台控制台 `proxy import <文件>` 即可导入，端口由目标控制台重新分配；文件里记着的「哪个账号走哪个出口」会列出来，确认（或加 `--yes`）后按文件恢复，目标控制台没有的账号跳过。网页「添加代理」粘贴同一个文件也会在导入后询问是否恢复。
- `default` 改 CPA 全局代理，继承全局的账号都跟着改。

## 自动更新

`cradmin rtk auto` 只读：列出 RTK 自动升级的开关和定时任务记下的上次结果。

`cradmin rtk upgrade --dry-run` 读 GitHub release，把资产下载到临时目录并校验，打印资产、sha256 来源、目标路径和备份位置，不替换。去掉 `--dry-run` 立即升级（先确认）：校验 sha256 → 备份 → 原子替换 → `rtk --version` 核对，失败自动换回。只有真的升到最新才算成功；停住（BREAKING，HTTP 409）或失败、回滚（HTTP 502）都以非零退出并打印原因。新版本声明 BREAKING 时停下，确认看过说明再加 `--accept-breaking`。Homebrew 装的 rtk 走 `brew upgrade rtk`。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（含 `-h`） |
| 1 | 运行时错误：连不上、5xx、404、409、部分失败、doctor 有 ✗ |
| 2 | 用法错误：未知命令或参数、缺参数、对象找不到或有歧义、非交互缺 `--yes`、模式没有匹配 |
| 3 | 鉴权失败：密码不对、会话过期、Key 会话不是管理员、拿不到凭据 |
| 4 | 被限流或冷却中 |
| 130 | 取消（确认选否、Ctrl+C） |

## 暂不支持

- 按 Key 单独的模型白名单：服务端没有这个概念，访问控制只到分组（渠道 / 账号池）；模型开关按渠道全局生效。
- 编辑渠道（URL、上游 Key、别名）、给渠道加第二把上游 Key：变通是 `channels rm` 后 `add`（会丢停用快照）。
- 系统设置的写入：都是部署环境变量，`settings` 只读，改完重启控制台（CPA 全局代理可用 `proxy default` 改）。
- 修改管理员密码、会话列表或批量吊销。
- 审计只能拿到最近 100 条，没有操作者字段（CLI 与网页操作无法区分）。
