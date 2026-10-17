package cli

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/harness"
	"github.com/crosery/crapi/internal/ui"
)

const updateHelp = `crapi update [harness...] [参数]

从网关拉取当前 Key 可用的最新模型与渠道，刷新所有已接入 Crosery CPA 的 harness：
新上线的模型加进各自的模型目录，下线的模型移除；你手动选过的默认模型只要还可用就保留。

参数：
  --model <id>   顺便把默认模型切换为 <id>
  --dry-run      只显示将要修改的文件，不落盘`

func cmdUpdate(a *App, args []string) error {
	fs := newFlags("update", updateHelp)
	model := fs.String("model", "", "")
	dry := fs.Bool("dry-run", false, "")
	targets, err := parse(fs, args, updateHelp)
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
	printModelDiff(a.Cfg.ModelIDs, ids(chat))

	env := harness.DefaultEnv()
	var list []harness.Harness
	if len(targets) > 0 {
		list, err = chooseHarnesses(env, a.Cfg.Base(), targets, false, true)
		if err != nil {
			return err
		}
	} else {
		// 已被 crapi 接管过的 + 当前配置指向 Crosery CPA 的，都刷新。
		for _, h := range harness.All() {
			_, managed := a.Cfg.Managed[h.ID()]
			det := h.Detect(env)
			if managed || (det.Installed && h.Status(env, a.Cfg.Base()).Configured) {
				list = append(list, h)
			}
		}
	}
	if len(list) == 0 {
		ui.Warn("还没有接入任何 harness，先运行 crapi setup。")
		return nil
	}
	plan := harness.Plan{
		BaseURL:    a.Cfg.Base(),
		Key:        c.Key,
		Models:     chat,
		Model:      *model,
		WebSearch:  false, // 已有的 Haiku 档映射会保留；不再改动用户的权限列表
		UpdateOnly: *model == "",
	}
	ui.Section("刷新 harness", fmt.Sprintf("%d 个", len(list)))
	ok, _ := applyAll(a, env, plan, list, *dry)
	if !*dry {
		a.Cfg.LastUpdate = time.Now()
		a.Cfg.ModelIDs = ids(chat)
		if err := a.Cfg.Save(); err != nil {
			return err
		}
	}
	ui.Println()
	ui.Success("同步完成：%d / %d 个 harness 已是最新模型目录（%d 个对话模型）。", ok, len(list), len(chat))
	return nil
}

// printModelDiff 对比上次同步时的模型列表，列出新增与下线。
func printModelDiff(before, after []string) {
	ui.Section("模型变化")
	if len(before) == 0 {
		ui.Note("首次同步，共 %d 个对话模型", len(after))
		return
	}
	old := map[string]bool{}
	for _, id := range before {
		old[id] = true
	}
	now := map[string]bool{}
	var added, removed []string
	for _, id := range after {
		now[id] = true
		if !old[id] {
			added = append(added, id)
		}
	}
	for _, id := range before {
		if !now[id] {
			removed = append(removed, id)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	if len(added) == 0 && len(removed) == 0 {
		ui.Note("与上次同步相比没有变化（%d 个对话模型）", len(after))
		return
	}
	if len(added) > 0 {
		ui.Println("  " + ui.OKS.Render("+ 新增 "+fmt.Sprint(len(added))) + "  " + strings.Join(added, ", "))
	}
	if len(removed) > 0 {
		ui.Println("  " + ui.ErrS.Render("- 下线 "+fmt.Sprint(len(removed))) + "  " + strings.Join(removed, ", "))
	}
}
