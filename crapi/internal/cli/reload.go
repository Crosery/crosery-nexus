package cli

import (
	"fmt"
	"strings"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/harness"
	"github.com/crosery/crapi/internal/ui"
)

const reloadHelp = `crapi reload [参数]

重新扫描本机所有 AI Agent CLI 与桌面客户端，智能适配并接入新安装的 harness，并同步最新模型。

当你后面安装了新的 Agent CLI（如 Claude Code, Codex, Cline 等）时运行此命令，自动为其生成接入配置。

别名：crapi reinit, crapi rescan

示例：
  crapi reload                     自动扫描本机环境，为新装和已有工具补齐配置
  crapi reload --model gpt-5.6-sol 重新扫描并统一切换默认模型为 gpt-5.6-sol

参数：
  --model <id>   指定或切换默认模型（可选）
  --dry-run      仅预览将要修改的文件，不实际写入配置`

func cmdReload(a *App, args []string) error {
	fs := newFlags("reload", reloadHelp)
	modelFlag := fs.String("model", "", "")
	dry := fs.Bool("dry-run", false, "")
	_, err := parse(fs, args, reloadHelp)
	if err != nil {
		return err
	}

	c, err := a.client()
	if err != nil {
		return err
	}
	ui.Banner(a.Version, a.Cfg.Base())

	models, err := a.fetchModels(c)
	if err != nil {
		return err
	}
	chat := api.ChatModels(models)

	env := harness.DefaultEnv()
	allHarnesses := harness.All()

	var targets []harness.Harness
	var newDetected []string

	for _, h := range allHarnesses {
		det := h.Detect(env)
		if !det.Installed {
			continue
		}
		_, managed := a.Cfg.Managed[h.ID()]
		stat := h.Status(env, a.Cfg.Base())
		// 如果是新安装未托管的，或者配置尚未指向本网关的
		if !managed || !stat.Configured {
			newDetected = append(newDetected, h.Name())
		}
		targets = append(targets, h)
	}

	if len(targets) == 0 {
		ui.Warn("未检测到任何已安装的 agent harness。")
		return nil
	}

	targetModel := *modelFlag
	if targetModel == "" {
		targetModel = a.Cfg.DefaultModel
	}
	if targetModel == "" {
		targetModel = api.Pick(chat, api.PrefAgent, nil)
	}

	if len(newDetected) > 0 {
		ui.Success("智能检测到 %d 个新安装/待适配的客户端：%s", len(newDetected), strings.Join(newDetected, ", "))
	} else {
		ui.Note("已检测到 %d 个已安装的 agent harness，正在刷新配置...", len(targets))
	}

	ui.Section("重新初始化与适配", fmt.Sprintf("默认模型：%s · 共计 %d 个工具", ui.AccentS.Render(targetModel), len(targets)))
	plan := harness.Plan{
		BaseURL:    a.Cfg.Base(),
		Key:        c.Key,
		Models:     chat,
		Model:      targetModel,
		WebSearch:  false,
		UpdateOnly: false,
	}

	ok, _ := applyAll(a, env, plan, targets, *dry)
	if !*dry {
		a.Cfg.DefaultModel = targetModel
		if err := a.Cfg.Save(); err != nil {
			return err
		}
	}

	ui.Println()
	ui.Success("重新初始化完成：已为 %d / %d 个 agent harness 注入配置。", ok, len(targets))
	return nil
}
