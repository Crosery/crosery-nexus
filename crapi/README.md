<div align="center">

# crapi

### Crosery CPA 一键接入与管理工具

<p>一行命令将 Crosery CPA 网关的上游模型与 API Key 自动注入本机所有主流 AI 编程代理环境，提供模型热更新、动态模型切换、用量与号池监控、gpt-image-2.5 生图等功能。</p>

<p>
  <a href="README.md"><b>中文</b></a>
  &nbsp;|&nbsp;
  <a href="#快速开始"><b>快速开始</b></a>
  &nbsp;·&nbsp;
  <a href="#解决的痛点"><b>解决的痛点</b></a>
  &nbsp;·&nbsp;
  <a href="#支持工具矩阵"><b>支持工具矩阵</b></a>
  &nbsp;·&nbsp;
  <a href="#常用命令与工作流"><b>常用命令与工作流</b></a>
  &nbsp;·&nbsp;
  <a href="#与-crosery-ct-联动"><b>与 crosery-ct 联动</b></a>
</p>

<sub>Cross-AI-Agent CLI · Claude Code / Codex / Pi / oh-my-pi / OpenCode / Kimi / Cursor / Zed · Pure Static Binary</sub>

</div>

---

## 一句话

`crapi` 是一个跨平台、零依赖的命令行工具，彻底解决本地部署和使用多个 AI Agent 时繁琐、容易冲突、格式各异的配置难题。无论你使用的是终端 CLI 类工具（Claude Code、Codex、Pi、omp、OpenCode、Kimi、Hermes 等），还是桌面编辑器（Cursor、Zed、WorkBuddy、Cherry Studio 等），只需提供你的 Crosery API Key，即可全量自动接入，并提供模型热同步、用量号池监控与批量生图能力。

---

## 解决的痛点

| 你以前的痛点 | crapi 怎么解 |
|---|---|
| 装了十几个 Agent 工具，每个配置格式都不一样（JSONC、TOML、YAML、.env） | 一行命令自动检测本机已安装工具，根据各工具原生 AST 规范自动注入，无需人工手改 |
| 手动修改配置文件时，手写的注释、键顺序和未相关字段被工具全部冲掉 | 采用保序 JSON 解析器与外科手术式行级 TOML/YAML 编辑器，修改目标配置时 100% 保持原注释与排版 |
| Claude Code 联网搜索功能依赖指定的 Haiku 模型，且容易与既有 Key 冲突 | 自动匹配并绑定 ANTHROPIC_DEFAULT_HAIKU_MODEL，注入 WebSearch 权限，自动清理冲突的环境变量 |
| 网关上线了新模型或调整了渠道，必须逐个工具重新排查和修改模型清单 | 运行 `crapi update` 自动拉取模型增量，智能标出 `+ 新增` 与 `- 下线`，并保留你手动选中的默认模型 |
| 后面电脑上又新装了其他 Agent CLI，不知道怎么快速接入 | 运行 `crapi reload` 自动扫描新安装的 CLI，使用已有凭据一键完成接入与初始化，无需重复输入 Key |
| 想要切换当前使用的默认主力模型，不知道每个工具现在生效的是什么 | 运行 `crapi use` 动态列出各工具当前生效的模型，支持直接切换或交互式浏览，并随时支持返回上一级 |
| 国内无代理环境下载安装 GitHub Release 经常遇到连接超时或 404 | 接入全球 Anycast CDN（jsDelivr）与智能多源自动测速容灾，两秒内完成高速下载并全量校验 SHA256 |
| Windows 终端中文字符常因代码页或非等宽字体出现对齐错乱，PowerShell 脚本乱码 | 内置 Windows API 自动托管 UTF-8 代码页 65001 与 VT 处理；针对 conhost 自动降级单字节边框；安装脚本采用纯 ASCII Unicode 逃逸设计，彻底根除乱码 |

---

## 核心特性

- **全量 Harness 深度集成** — 覆盖 Claude Code、Codex CLI、Pi、oh-my-pi、Cursor、WorkBuddy、Qoder、Hermes、OpenCode、Kilo、Kimi、Zed、Cherry Studio 等 20+ 款主流 Agent。
- **动态模型快速切换** — `crapi use` 提供可视化的状态看板，清晰查看各工具当前生效的模型，支持全局统一切换或单工具定制切换，支持随时返回上一级。
- **智能重新初始化** — `crapi reload` 自动识别你后来新安装的 Agent CLI，自动补齐适配配置并刷新模型目录。
- **模型增量热更新** — `crapi update` 自动拉取上游网关模型变动，清晰比对增减项，绝不冲掉用户已设定的偏好。
- **gpt-image-2.5 生图与批量并发** — 只支持 gpt-image-2.5 系列（对所有 Key 开放，默认 gpt-image-2.5），支持 1-8 张并发批量生成、快速画幅版式（landscape/portrait/square）与 JSON 结构化输出。
- **与 crosery-ct 无缝联动** — 提供原生 crosery-ct 扩展支持，其他自动化脚本或私有 Agent 可直接通过 `crosery-ct call crosery_image_generate` 调用生图。
- **严格零破坏与原子备份** — 每次修改前在 `~/.config/crapi/backups/` 留存时间戳备份，支持 `crapi restore` 随时一键回滚。
- **单静态二进制与全平台原生** — 采用 Go 1.26 构建，零 CGO 依赖，支持 macOS (Apple Silicon / Intel)、Linux (amd64 / arm64) 以及 Windows (amd64 / arm64 / 386)。
- **零 emoji** — 全仓库遵循严格的工业级技术文档规范，输出清晰、专注、无多余修饰。

---

## 快速开始

### 1. macOS & Linux

#### 七牛云 CDN 极速安装（国内推荐，毫秒级直连）
```bash
# 交互式引导安装
curl -fsSL https://cdn.crosery.com/crapi/install.sh | sh

# 带 Key 免交互全自动安装（适合自动化脚本）
curl -fsSL https://cdn.crosery.com/crapi/install.sh | sh -s -- --key sk-your-key-here
```

#### GitHub 加速镜像备用
```bash
curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/crosery/crapi/main/install.sh | sh
```

#### 官方源直连（海外或全局代理环境）
```bash
curl -fsSL https://raw.githubusercontent.com/crosery/crapi/main/install.sh | sh
```

---

### 2. Windows (PowerShell 5.1+ / PowerShell 7+)

以普通用户权限打开 PowerShell 窗口：

#### 七牛云 CDN 极速安装（国内推荐，毫秒级直连）
```powershell
# 交互式引导安装
irm https://cdn.crosery.com/crapi/install.ps1 | iex

# 带 Key 免交互全自动安装
$env:CRAPI_KEY='sk-your-key-here'; irm https://cdn.crosery.com/crapi/install.ps1 | iex
```

#### GitHub 加速镜像备用
```powershell
irm https://ghfast.top/https://raw.githubusercontent.com/crosery/crapi/main/install.ps1 | iex
```

#### 官方源直连（海外或全局代理环境）
```powershell
irm https://raw.githubusercontent.com/crosery/crapi/main/install.ps1 | iex
```

---

### 3. Windows (传统命令提示符 cmd.exe)

```cmd
powershell -ExecutionPolicy Bypass -c "irm https://cdn.crosery.com/crapi/install.ps1 | iex"
```

Windows 说明：安装脚本会自动将 `crapi.exe` 目录添加至用户注册表 `HKCU\Environment\Path` 并广播刷新系统环境变量，新开终端即可直接使用 `crapi` 命令。

---

## 常用命令与工作流

### 1. 主控制台与初次接入 (setup)

直接运行 `crapi` 进入交互式终端控制台：

```bash
crapi
```

命令行批量接入模式：

```bash
# 检测本机已安装的 harness 并列出选项
crapi setup

# 一键为本机已安装的全部工具写入配置
crapi setup --all

# 只针对指定工具写入配置
crapi setup claude codex

# 指定默认模型并开启 Claude Code 联网搜索
crapi setup claude --model claude-opus-5-5 --websearch

# 仅预览变更文件与内容，不实际落盘
crapi setup --dry-run
```

---

### 2. 查看与快速切换默认模型 (use / switch)

随时查看各个 Agent 工具当前生效的默认模型，并进行快捷切换：

```bash
# 交互式模式：先展示各工具当前生效的模型，选定后切换新模型，支持随时返回上一级
crapi use

# 查看指定工具当前模型并进入该工具的交互切换菜单
crapi use claude

# 直接将指定工具切换为目标模型
crapi use claude claude-opus-5-5
crapi use codex gpt-5.6-sol

# 一键把全部已接入的工具统一切换为目标模型
crapi use claude-opus-5-5
```

---

### 3. 智能重新初始化与新装 CLI 适配 (reload)

如果你在配置之后又在系统里新安装了其他的 Agent CLI（如 Kimi、OpenCode、Codex 等），运行 `crapi reload` 即可自动识别并补齐配置：

```bash
# 自动扫描本机新安装的 Agent CLI 并完成一键适配，同时刷新所有已有工具
crapi reload

# 智能重新初始化并将默认模型统一设置为指定模型
crapi reload --model claude-opus-5-5
```

---

### 4. 上游模型增量热同步 (update)

当 Crosery CPA 网关上线新模型或调整渠道时，运行 `crapi update` 即可无缝同步：

```bash
crapi update
```

- 增量比对：直观以 `+ 新增`（绿色）与 `- 下线`（红色）显示模型变动。
- 保留偏好：用户此前手动指定过的默认模型（只要依然有效）会继续保留。

---

### 5. gpt-image-2.5 生图与批量并发 (image)

只支持 gpt-image-2.5 系列（gpt-image-2.5 / gpt-image-2.5-flare / gpt-image-2.5-sunburst），对所有 Key 开放，默认 gpt-image-2.5；其他生图模型一律不支持：

```bash
# 文本生图（默认 gpt-image-2.5）
crapi image "赛博朋克风格未来科技城市，雨夜霓虹倒影"

# 批量并发生成 4 张横版大图
crapi image "太空宇航员在火星日落下的剪影" -n 4 --variant landscape -o ./output

# 以标准 JSON 输出结果文件路径（供自动化脚本调用）
crapi image "概念插画，科幻机甲" --json -o ./output

# 带参考图做图生图 / 编辑
crapi image "将背景更换为繁星满天的夜空" -i ./photo.png -o ./output
```

---

### 6. 用量与号池监控 (usage / pool)

以树形输出（`├─` / `└─`，层级与命名同 Web 控制台）直观掌握账户与网关状态；`--json` 输出不变：

```bash
# 查看额度窗口（今日/本周/总额度）、Token 消耗统计与近期请求流水
crapi usage

# 查看各渠道号池健康状态（运行、冷却、异常、暂停）与额度窗口
crapi pool
```

---

### 7. 一键退出与退回原本个人配置 (reset / unsetup)

随时随地安全退出 Crosery 配置，将指定工具（或全部工具）恢复为你原本的官方个人账号或原始配置：

```bash
# 交互式退回菜单：浏览已接入工具列表，选择要退回原本配置的工具（支持单选或一键全部退回）
crapi reset

# 将 OpenAI Codex CLI 退出 Crosery，恢复为你原本登录的官方个人账号
crapi reset codex

# 将 Claude Code 退出 Crosery，恢复官方直连模式
crapi reset claude

# 一键退回本机所有已接入 Crosery 的 Agent 工具
crapi reset --all
```

---

### 8. 健康自检与环境诊断 (doctor)

```bash
# 全面诊断网络连通性、API Key 有效性与各工具配置状态
crapi doctor
```

---

## 支持工具矩阵

| 分类 | 工具 / Harness | 配置文件位置 | 自动化能力说明 |
| :--- | :--- | :--- | :--- |
| **CLI 代理** | **Claude Code** | `~/.claude/settings.json`<br>`~/.claude.json` | 自动配置基址与 Token；映射 Haiku 辅助检索模型以支持网络搜索；补全配置跳过 onboarding 流程；消除双 Key 冲突。 |
| **CLI 代理** | **OpenAI Codex CLI** | `~/.codex/config.toml` | 行级注入 `[model_providers.crosery]`，配置 `wire_api = "responses"` 与默认模型，保留用户原注释。 |
| **CLI 代理** | **Pi** | `~/.pi/agent/models.json` | 自动配置 Crosery 模型供应商与 `default_model`。 |
| **CLI 代理** | **oh-my-pi (omp)** | `~/.omp/agent/models.yml`<br>`config.yml` | 保持 YAML 注释与顺序，配置模型列表与 `modelRoles.default`。 |
| **CLI 代理** | **Nous Hermes** | `~/.hermes/config.yaml` | 注入 `providers.crosery`（`chat_completions` 协议）及 `model.provider`。 |
| **CLI 代理** | **OpenCode** | `~/.config/opencode/opencode.json` | 适配 `@ai-sdk/openai-compatible` 协议，写入全量上下文限制与 Tool 调用标记。 |
| **CLI 代理** | **Kilo Code** | `~/.config/kilo/config.json` | 写入 Kilo 规范的多模型供应商列表及 `active_provider`。 |
| **CLI 代理** | **Kimi Code** | `~/.kimi-code/config.toml` | 自动适配 Kimi 特有的 `max_output_size = 128000` 限制，规避 400 溢出。 |
| **CLI 代理** | **Qwen Code** | `~/.qwen/settings.json` | 配置通义千问 Agent 上游端点与 Key。 |
| **CLI 代理** | **OpenClaw** | `~/.openclaw/config.json` | 注入模型映射与网关认证信息。 |
| **CLI 代理** | **Crush** | `~/.crush/config.json` | 写入终端 AI 代理端点与模型规格。 |
| **CLI 代理** | **GitHub Copilot CLI** | `~/.copilot-cli/config.json` | 代理自定义模型端点覆盖。 |
| **CLI 代理** | **Factory Droid** | `~/.factory/droid.json` | 配置 Droid 代理引擎。 |
| **CLI 代理** | **Aider** | `~/.aider.conf.yml` | 写入 `openai-api-base` 与 `openai-api-key`。 |
| **CLI 代理** | **Continue** | `~/.continue/config.json` | 增量追加 Crosery 模型列表至 Continue 配置。 |
| **CLI 代理** | **Gemini CLI** | `~/.gemini/.env`<br>`settings.json` | 提取当前 Key 可用的 Gemini 系列模型并设置 `GOOGLE_GEMINI_BASE_URL`。 |
| **CLI 代理** | **CodeBuddy CLI** | `~/.codebuddy/settings.json` | 腾讯云 CodeBuddy 命令行端点与模型配置。 |
| **CLI 代理** | **Qoder CLI** | `~/.qoder/settings.json` | 注入 Crosery 模型供应商并设为活跃。 |
| **桌面 GUI** | **WorkBuddy / AI** | `~/.workbuddy/models.json` | 解析并安全重写 WorkBuddy 桌面端模型列表数组，设为默认选择。 |
| **桌面 GUI** | **Qoder CN (桌面)** | `~/.qoder/settings.json` | 同步配置桌面端设置文件。 |
| **桌面 GUI** | **Zed 编辑器** | `~/.config/zed/settings.json` | 配置 `language_models.openai_compatible` 模型列表，终端自动拷贝 Key 方便粘贴。 |
| **桌面 GUI** | **Cherry Studio** | 深度链接唤起 | 构造 `cherrystudio://` 专有链接一键唤起并导入 Crosery 服务商配置，杜绝多字节乱码。 |
| **桌面 GUI** | **Cursor** | 应用内指引 | 终端自动将 Key 拷入剪贴板，输出 Override Base URL 及推荐的模型名称清单。 |

---

## 与 crosery-ct 联动

`crapi` 原生支持作为底层能力嵌入到 `crosery-ct`（多 Agent 共享能力系统）中：

```bash
# 查看 crosery-ct 已注册的生图工具参数
python3 ~/.agents/tools/crosery-ct/cli.py show crosery_image_generate

# 通过 crosery-ct 调用批量生图
python3 ~/.agents/tools/crosery-ct/cli.py call crosery_image_generate prompt="未来科技城市" count=4 variant=landscape
```

能力实现位于 `~/.agents/crosery/ct/image/capability.py`，无缝复用 `crapi` 的凭据管理与并发下载通路。

---

## 关键技术与工程保障

1. **非侵入式配置解析引擎**：
   - **JSON / JSONC**：自研 `internal/harness/ojson.go` 保序解码器，能容忍注释与尾逗号，修改字段时严格保持用户原本的字段书写顺序。
   - **TOML**：行级外科手术式更新器（`internal/harness/textedit.go`），通过 AST 与行范围定位，只替换目标表，绝不擦除用户的任何注释与空行。
   - **YAML**：基于 `yaml.v3` Node 树，原样保留标量行内注释与节点位置。
2. **Windows 终端自适应适配层**：
   - Windows 平台（`internal/term/term_windows.go`）在进程启动时通过 Win32 API 自动开启 UTF-8 代码页并激活 VT 处理；并在进程退出或捕获中断信号时可靠复原控制台属性。
   - 自动探测是否运行在传统 `conhost.exe` 下，若为非 Windows Terminal 环境，自动将边框渲染降级为单字节 ASCII，根治中文字符双宽造成的表格错位。
   - `install.ps1` 采用全 ASCII 编码并在运行时通过 `[regex]::Unescape` 动态还原中文提示，完美规避 PowerShell 5.1 在默认 GBK 编码下将网络下载脚本误认为 Latin-1 导致的中文乱码。

---

## 源码构建

如需从源码编译：

```bash
git clone https://github.com/Crosery/crapi.git
cd crapi

# 本机编译并运行
go build -o crapi .
./crapi --version

# 运行完整单元测试
go test -v ./...

# 交叉编译全平台发布产物（产物输出至 dist/ 目录）
chmod +x scripts/build.sh
./scripts/build.sh 0.1.4
```

---

## 开源许可

本项目采用 [MIT 许可证](./LICENSE) 开源。欢迎提交 Issue 与 Pull Request！
