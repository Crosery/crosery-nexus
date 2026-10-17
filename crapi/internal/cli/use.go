package cli

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/harness"
	"github.com/crosery/crapi/internal/term"
	"github.com/crosery/crapi/internal/ui"
)

const useHelp = `crapi use [harness] [model-id] [参数]

快速查看与切换已接入 agent harness 的默认模型。
不带参数时进入交互式界面：支持直接打字搜索、上下键挑选、Esc 随时返回上一级。

别名：crapi switch, crapi set-model

示例：
  crapi use                               进入单屏交互式菜单（支持即时打字搜索、Esc 返回上一级）
  crapi use claude                        为 Claude Code 进入交互式模型选择
  crapi use claude claude-opus-5-5        直接把 Claude Code 切换为 claude-opus-5-5
  crapi use claude-opus-5-5               一键把全部已接入的工具统一切换为 claude-opus-5-5
  crapi use codex gpt-5.6-sol             直接把 OpenAI Codex 切换为 gpt-5.6-sol

参数：
  --harness <id>  指定要切换的目标 harness（也可作为第一个位置参数直接传入）
  --dry-run       仅预览变更，不实际修改配置文件`

func cmdUse(a *App, args []string) error {
	fs := newFlags("use", useHelp)
	harnessFlag := fs.String("harness", "", "")
	dry := fs.Bool("dry-run", false, "")
	positional, err := parse(fs, args, useHelp)
	if err != nil {
		return err
	}

	c, err := a.client()
	if err != nil {
		return err
	}

	models, err := a.fetchModels(c)
	if err != nil {
		return err
	}
	chat := api.ChatModels(models)
	if len(chat) == 0 {
		return errors.New("当前 API Key 未检测到任何可用的对话模型")
	}

	env := harness.DefaultEnv()

	// 动态实时获取本机所有已接入或已配置的 harness 及其最新状态
	getConfigured := func() []harness.Harness {
		var list []harness.Harness
		for _, h := range harness.All() {
			_, managed := a.Cfg.Managed[h.ID()]
			det := h.Detect(env)
			if managed || (det.Installed && h.Status(env, a.Cfg.Base()).Configured) {
				list = append(list, h)
			}
		}
		return list
	}

	configured := getConfigured()
	if len(configured) == 0 {
		ui.Warn("未检测到已接入 crosery 的 agent harness，请先运行 crapi setup 或 crapi reload。")
		return nil
	}

	// 解析命令行直接传入的参数：支持 crapi use <harness> <model> 或 crapi use <model>
	var targetHarness harness.Harness
	targetModel := ""

	if *harnessFlag != "" {
		h, ok := harness.Get(*harnessFlag)
		if !ok {
			return fmt.Errorf("不认识的 harness 标识：%s（可用 crapi status 查看）", *harnessFlag)
		}
		targetHarness = h
	}

	if len(positional) >= 2 {
		// crapi use <harness> <model>
		h, ok := harness.Get(positional[0])
		if !ok {
			return fmt.Errorf("不认识的 harness 标识：%s", positional[0])
		}
		targetHarness = h
		targetModel = positional[1]
	} else if len(positional) == 1 {
		if h, ok := harness.Get(positional[0]); ok {
			targetHarness = h
		} else {
			targetModel = positional[0]
		}
	}

	// 如果指定了具体 model，校验有效性
	if targetModel != "" {
		if _, ok := api.Find(chat, targetModel); !ok {
			ui.Warn("模型 %s 不在当前 Key 的可用列表中。", ui.Bold.Render(targetModel))
			var similar []string
			for _, m := range chat {
				if strings.Contains(strings.ToLower(m.ID), strings.ToLower(targetModel)) {
					similar = append(similar, m.ID)
				}
			}
			if len(similar) > 0 {
				ui.Note("相似可用模型：%s", strings.Join(similar, ", "))
			}
			return fmt.Errorf("无效的模型标识：%s", targetModel)
		}
	}

	// 1. 命令行非交互模式（用户直接提供了具体 model）：直接执行并输出单行结果
	if targetModel != "" {
		var selected []harness.Harness
		if targetHarness != nil {
			selected = []harness.Harness{targetHarness}
		} else {
			selected = configured
		}

		plan := harness.Plan{
			BaseURL:    a.Cfg.Base(),
			Key:        c.Key,
			Models:     chat,
			Model:      targetModel,
			WebSearch:  false,
			UpdateOnly: false,
		}
		ok, _ := applyAll(a, env, plan, selected, *dry)
		if !*dry {
			if len(selected) > 1 {
				a.Cfg.DefaultModel = targetModel
			}
			_ = a.Cfg.Save()
		}
		ui.Println()
		ui.Success("默认模型已切换为 %s（已更新 %d / %d 个工具配置）。",
			ui.AccentS.Render(targetModel), ok, len(selected))
		return nil
	}

	// 2. 交互模式：进入单屏 TUI 动态选择器（输入搜索 + 上下选 + Esc 返回）
	if !term.Interactive() {
		return errors.New("缺少目标模型名称，例如：crapi use claude-opus-5-5")
	}

	// 构建 Harness 选项列表
	var harnessItems []ui.PickerItem
	harnessItems = append(harnessItems, ui.PickerItem{
		ID:          "ALL",
		Title:       "【全部已接入工具】",
		Subtitle:    fmt.Sprintf("统一切换全部 %d 个工具的默认模型", len(configured)),
		SearchWords: "all 全部 全部工具",
	})
	for _, h := range configured {
		st := h.Status(env, a.Cfg.Base())
		modelDisplay := "未配置"
		if st.Model != "" {
			modelDisplay = ui.CleanModelName(st.Model)
		}
		harnessItems = append(harnessItems, ui.PickerItem{
			ID:          h.ID(),
			Title:       h.Name(),
			Subtitle:    "当前: " + modelDisplay,
			SearchWords: h.Name() + " " + h.ID(),
		})
	}

	// 构建模型选项列表：主流核心模型置顶，其余字母序
	recommended := []string{
		"claude-opus-5-5",
		"claude-sonnet-5",
		"claude-haiku-4-5-20251001",
		"gpt-6-astra",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gemini-3.1-pro-preview",
		"gemini-3.8-flash",
		"deepseek-v4.1-flash",
		"glm-5",
	}

	recSet := map[string]bool{}
	for _, id := range recommended {
		recSet[id] = true
	}

	buildModelItem := func(m api.Model) ui.PickerItem {
		ctxStr := ""
		if m.ContextLength > 0 {
			ctxStr = fmt.Sprintf(" (%s ctx)", ui.Ctx(m.ContextLength))
		}
		sub := api.ChannelLabel(m.OwnedBy) + ctxStr
		return ui.PickerItem{
			ID:          m.ID,
			Title:       m.ID,
			Subtitle:    sub,
			SearchWords: m.ID + " " + m.Name() + " " + m.OwnedBy,
		}
	}

	var modelItems []ui.PickerItem
	for _, id := range recommended {
		if m, ok := api.Find(chat, id); ok {
			modelItems = append(modelItems, buildModelItem(m))
		}
	}

	var others []api.Model
	for _, m := range chat {
		if !recSet[m.ID] {
			others = append(others, m)
		}
	}
	sort.Slice(others, func(i, j int) bool {
		return others[i].ID < others[j].ID
	})
	for _, m := range others {
		modelItems = append(modelItems, buildModelItem(m))
	}

	applyFunc := func(harnessID, chosenModel string) error {
		var targets []harness.Harness
		if harnessID == "ALL" {
			targets = configured
		} else {
			h, ok := harness.Get(harnessID)
			if !ok {
				return fmt.Errorf("找不到 harness: %s", harnessID)
			}
			targets = []harness.Harness{h}
		}

		plan := harness.Plan{
			BaseURL:    a.Cfg.Base(),
			Key:        c.Key,
			Models:     chat,
			Model:      chosenModel,
			WebSearch:  false,
			UpdateOnly: false,
		}

		ok, _ := applyAll(a, env, plan, targets, *dry)
		if ok == 0 && len(targets) > 0 {
			return errors.New("配置写入失败，请检查文件写入权限")
		}
		if !*dry {
			if harnessID == "ALL" {
				a.Cfg.DefaultModel = chosenModel
			}
			_ = a.Cfg.Save()
		}
		return nil
	}

	initialStage := ui.StageHarness
	targetHID := ""
	if targetHarness != nil {
		initialStage = ui.StageModel
		targetHID = targetHarness.ID()
	}

	cfg := ui.ModelPickerConfig{
		Version:         a.Version,
		BaseURL:         a.Cfg.Base(),
		Harnesses:       harnessItems,
		Models:          modelItems,
		ApplyFunc:       applyFunc,
		InitialStage:    initialStage,
		TargetHarnessID: targetHID,
	}

	updatedCount, err := ui.RunModelPicker(cfg)
	if err != nil {
		return err
	}

	if updatedCount > 0 {
		ui.Println()
		ui.Success("默认模型切换操作已完成，共更新 %d 个工具配置。", updatedCount)
	}
	return nil
}
