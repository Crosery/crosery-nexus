package harness

import (
	"os"
	"path/filepath"
)

// SkillContent 是内置的 crapi 技能定义内容。
const SkillContent = `---
name: crapi
description: "通过 crapi 管理本机所有 Agent Harness（Claude Code, WorkBuddy, Codex, Pi, OpenCode, Kimi 等）的 Crosery CPA 网关配置、动态切换主流默认模型、重新初始化适配新安装的 CLI，以及通过 Crosery CPA 用 gpt-image-2.5 系列批量生图与图像编辑。"
---

# crapi

Crosery CPA 网关与多 Agent Harness 统一管理 CLI。可独立运行，也可通过终端驱动。

## 核心工作流

### 1. 批量生图与图像编辑（只支持 gpt-image-2.5 系列）
` + "```bash" + `
# 文本生图（返回标准 JSON 数组，包含图片绝对路径，方便后续工具读取）
crapi image "赛博朋克风格未来科技城市，雨夜霓虹倒影" --json --outdir ./images -n 4 --variant landscape

# 带参考图编辑 / 图生图
crapi image "保持人物面貌与发型不变，将背景换成海边日落" -i ./portrait.png --json
` + "```" + `
- --variant：landscape (1536x1024), portrait (1024x1536), square (1024x1024)
- -n, --count：1-8 张并发批量生成
- 只支持 gpt-image-2.5 / gpt-image-2.5-flare / gpt-image-2.5-sunburst（对所有 Key 开放），默认 gpt-image-2.5；其他生图模型会被拒绝

### 2. 动态切换主流默认模型
` + "```bash" + `
# 交互式切换：先看所有已接入工具当前使用的模型，再快速选择新模型
crapi use

# 直接把指定工具切换为目标模型
crapi use claude claude-opus-5-5
crapi use codex gpt-5.6-sol

# 一键把全部已接入的工具统一切换为目标模型
crapi use claude-opus-5-5
` + "```" + `

### 3. 智能重新初始化与新装 CLI 适配
用户在电脑上安装了新的 Agent CLI（如 Kimi、OpenCode、Codex 等）时运行：
` + "```bash" + `
# 自动检测新安装的 Agent CLI 并完成一键接入，同时刷新所有已有工具
crapi reload
` + "```" + `

### 4. 上游模型与渠道热同步
` + "```bash" + `
# 从网关同步最新上线的模型与渠道，增量刷新本地配置
crapi update
` + "```" + `

### 5. 账号用量与号池监控
` + "```bash" + `
crapi usage         # 查看今日/本周/总额度、Token 消耗与近况流水
crapi pool          # 查看上游渠道号池健康度与冷却状态
` + "```" + `

### 6. 一键退出与退回原本个人配置
` + "```bash" + `
crapi reset         # 交互式挑选工具退回原本的官方个人账号/配置
crapi reset codex   # 将 Codex CLI 退出 Crosery 并恢复个人账号
crapi reset claude  # 将 Claude Code 退出 Crosery 恢复官方直连
` + "```" + `
`

// KnownSkillDirs 返回各 Agent Harness 常见的 skills 存放目录。
func KnownSkillDirs(e Env) []string {
	dirs := []string{
		e.P(".agents", "skills"),
		e.P(".claude", "skills"),
		e.P(".workbuddy", "skills"),
		e.P(".workbuddy-ai", "skills"),
		e.P(".codex", "skills"),
		e.P(".omp", "agent", "skills"),
		e.P(".pi", "agent", "skills"),
		e.P(".hermes", "skills"),
		e.P(".codebuddy", "skills"),
		e.P(".kimi-code", "skills"),
		e.P(".config", "opencode", "skills"),
		e.P(".config", "kilo", "skills"),
		e.P(".qwen", "skills"),
		e.P(".openclaw", "skills"),
		e.P(".crush", "skills"),
	}

	// 针对可能通过 XDG_CONFIG_HOME 或自定义目录配置的环境
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" && e.Home == defaultHome() && e.GOOS != "windows" {
		dirs = append(dirs, filepath.Join(d, "opencode", "skills"), filepath.Join(d, "kilo", "skills"))
	}
	return dirs
}

// SyncAllSkills 将 crapi 的技能文件全量自动同步到本机所有已安装的 Agent 目录中。
func SyncAllSkills(e Env) (syncedDirs []string) {
	// 1. 确保全局源目录 ~/.agents/skills/crapi/SKILL.md 存在且内容最新
	globalDir := e.P(".agents", "skills", "crapi")
	_ = os.MkdirAll(globalDir, 0o755)
	globalSkillFile := filepath.Join(globalDir, "SKILL.md")
	_ = os.WriteFile(globalSkillFile, []byte(SkillContent), 0o644)

	// 2. 扫描所有已存在的 Agent skills 根目录
	for _, parent := range KnownSkillDirs(e) {
		// 如果父级目录存在，或者其宿主目录存在（例如 ~/.workbuddy 存在），则补齐 skills 目录并注入
		hostDir := filepath.Dir(parent)
		if hostDir == e.P(".omp") || hostDir == e.P(".pi") {
			hostDir = filepath.Dir(hostDir) // ~/.omp 或 ~/.pi
		}
		// 如果 skills 目录本身已存在，或者宿主工具根目录已存在，则确保 skills 目录存在并同步 crapi skill
		if !dirExists(parent) && !dirExists(hostDir) {
			continue
		}

		_ = os.MkdirAll(parent, 0o755)
		targetSkillDir := filepath.Join(parent, "crapi")

		// 检查是否已经是有效软链
		if fi, err := os.Lstat(targetSkillDir); err == nil {
			if fi.Mode()&os.ModeSymlink != 0 {
				if link, err := os.Readlink(targetSkillDir); err == nil {
					targetResolved := link
					if !filepath.IsAbs(targetResolved) {
						targetResolved = filepath.Clean(filepath.Join(parent, link))
					}
					if targetResolved == globalDir {
						syncedDirs = append(syncedDirs, targetSkillDir)
						continue
					}
				}
				_ = os.Remove(targetSkillDir)
			}
		}

		// 优先尝试建立软链接到 ~/.agents/skills/crapi
		rel, err := filepath.Rel(parent, globalDir)
		symlinked := false
		if err == nil && e.GOOS != "windows" {
			if err := os.Symlink(rel, targetSkillDir); err == nil {
				symlinked = true
			}
		}

		// Windows 或软链接创建失败时，直接写入实体目录与 SKILL.md
		if !symlinked {
			_ = os.MkdirAll(targetSkillDir, 0o755)
			targetFile := filepath.Join(targetSkillDir, "SKILL.md")
			_ = os.WriteFile(targetFile, []byte(SkillContent), 0o644)
		}
		syncedDirs = append(syncedDirs, targetSkillDir)
	}
	return syncedDirs
}
