package cli

import (
	"fmt"
	"strings"

	"github.com/crosery/crapi/internal/harness"
	"github.com/crosery/crapi/internal/term"
	"github.com/crosery/crapi/internal/ui"
)

const resetHelp = `crapi reset [harness...] [参数]

一键退出 Crosery 配置，将指定的 Agent 工具（或全部已接入工具）退回官方个人账号/原本配置。
优先还原最近一次备份；若无备份则执行安全清理，移除 crosery 注入的全部配置。

别名：crapi unsetup, crapi rollback, crapi restore

示例：
  crapi reset                 进入交互式选择菜单，挑选要退回的工具（支持单选或全部退回）
  crapi reset codex           退回 OpenAI Codex CLI，恢复你原本的个人账号
  crapi reset claude          退回 Claude Code，恢复官方直连模式
  crapi reset --all           一键退回本机所有已接入 Crosery 的 Agent 工具

参数：
  --all      一键退回全部已接入的工具，不逐个询问
  --yes, -y  跳过二次确认直接执行`

func cmdReset(a *App, args []string) error {
	fs := newFlags("reset", resetHelp)
	allFlag := fs.Bool("all", false, "")
	yesFlag := fs.Bool("yes", false, "")
	fs.BoolVar(yesFlag, "y", false, "")
	targets, err := parse(fs, args, resetHelp)
	if err != nil {
		return err
	}

	env := harness.DefaultEnv()

	// 找出所有已接入或被管理的 harness
	var configured []harness.Harness
	for _, h := range harness.All() {
		_, managed := a.Cfg.Managed[h.ID()]
		det := h.Detect(env)
		if managed || (det.Installed && h.Status(env, a.Cfg.Base()).Configured) {
			configured = append(configured, h)
		}
	}

	if len(configured) == 0 {
		ui.Note("当前本机没有已接入 Crosery 的 Agent 工具。")
		return nil
	}

	var toReset []harness.Harness

	if len(targets) > 0 {
		for _, t := range targets {
			h, ok := harness.Get(t)
			if !ok {
				return fmt.Errorf("不认识的 harness 标识：%s（可用 crapi status 查看）", t)
			}
			toReset = append(toReset, h)
		}
	} else if *allFlag {
		toReset = configured
	} else if term.Interactive() {
		// 交互式菜单：让用户清晰挑选退回哪一个
		var opts []ui.Option
		opts = append(opts, ui.Option{
			Label: ui.Pad("【全部工具】", 20) + ui.Dim.Render(fmt.Sprintf("一键退回全部 %d 个工具的原有配置", len(configured))),
			Value: "ALL",
		})

		for _, h := range configured {
			st := h.Status(env, a.Cfg.Base())
			modelHint := ""
			if st.Model != "" {
				modelHint = " [当前: " + ui.CleanModelName(st.Model) + "]"
			}
			hasBackup := len(harness.ListBackups(h.ID())) > 0
			backupTag := ui.Dim.Render("（主动重置官方状态）")
			if hasBackup {
				backupTag = ui.OKS.Render("（有原配置备份）")
			}
			label := ui.Pad(h.Name(), 18) + ui.Dim.Render(modelHint) + " " + backupTag
			opts = append(opts, ui.Option{Label: label, Value: h.ID()})
		}

		ui.Println()
		pick, err := ui.AskSelect("请选择要退回原本个人配置的 Agent 工具：", "", opts)
		if err != nil {
			return err
		}

		if pick == "ALL" {
			toReset = configured
		} else {
			h, _ := harness.Get(pick)
			toReset = []harness.Harness{h}
		}
	} else {
		return errorsNew("请指定要退回的工具标识（例如：crapi reset codex），或使用 --all 退回全部。")
	}

	if len(toReset) == 0 {
		return nil
	}

	// 安全二次确认
	if !*yesFlag && term.Interactive() {
		var names []string
		for _, h := range toReset {
			names = append(names, h.Name())
		}
		ui.Println()
		prompt := fmt.Sprintf("确认将 [%s] 退出 Crosery 并恢复原本的个人账号/官方配置吗？", strings.Join(names, ", "))
		ok, err := ui.Confirm(prompt, "相关工具将不再通过 Crosery 网关代理，直接恢复各工具原本的状态", true)
		if err != nil || !ok {
			ui.Println(ui.Dim.Render("已取消操作。"))
			return nil
		}
	}

	ui.Println()
	ui.Section("执行退回与配置恢复", fmt.Sprintf("共 %d 个工具", len(toReset)))

	successCount := 0
	for _, h := range toReset {
		changed, err := harness.ResetHarness(env, h, a.Cfg.Base())
		if err != nil {
			ui.Fail("%s  %v", ui.Bold.Render(h.Name()), err)
			continue
		}
		successCount++
		ui.Success("%s  已成功退回原本配置", ui.Bold.Render(h.Name()))
		for _, f := range changed {
			ui.Note("已恢复原状: %s", f)
		}
		// 从 managed 列表移除
		delete(a.Cfg.Managed, h.ID())
	}

	_ = a.Cfg.Save()
	_ = harness.SyncAllSkills(env)

	ui.Println()
	ui.Success("退回操作完成！已恢复 %d / %d 个工具的原本配置。", successCount, len(toReset))
	return nil
}

func errorsNew(s string) error {
	return fmt.Errorf("%s", s)
}
