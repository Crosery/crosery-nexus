package cli

import (
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/harness"
	"github.com/crosery/crapi/internal/store"
	"github.com/crosery/crapi/internal/term"
	"github.com/crosery/crapi/internal/ui"
)

const setupHelp = `crapi setup [harness...] [参数]

输入 API Key 后，自动探测本机已安装的 agent harness 并写入 Crosery CPA 配置。
不写 harness 名称时，交互式勾选（默认勾选已安装的）。

参数：
  --key sk-xxx     直接给出 API Key（也可用环境变量 CRAPI_KEY）
  --model <id>     指定默认模型（缺省自动挑选当前最强的可用模型）
  --all            配置全部支持的 harness（包括未检测到安装的）
  --yes, -y        不询问，直接配置检测到的 harness
  --no-websearch   不为 Claude Code 配置网络搜索（Haiku 档）
  --dry-run        只显示将要修改的文件，不落盘

harness 名称：` + "claude codex pi omp opencode kilo hermes gemini qwen kimi copilot droid openclaw crush aider codebuddy workbuddy workbuddy-ai qoder qoder-cn cursor zed continue cherry"

func cmdSetup(a *App, args []string) error {
	fs := newFlags("setup", setupHelp)
	key := fs.String("key", "", "")
	model := fs.String("model", "", "")
	all := fs.Bool("all", false, "")
	yes := fs.Bool("yes", false, "")
	fs.BoolVar(yes, "y", false, "")
	noSearch := fs.Bool("no-websearch", false, "")
	dry := fs.Bool("dry-run", false, "")
	targets, err := parse(fs, args, setupHelp)
	if err != nil {
		return err
	}

	ui.Banner(a.Version, a.Cfg.Base())
	c, models, err := a.ensureKey(*key, !*yes)
	if err != nil {
		return err
	}
	chat := api.ChatModels(models)
	printKeySummary(a, models)

	env := harness.DefaultEnv()
	selected, err := chooseHarnesses(env, a.Cfg.Base(), targets, *all, *yes)
	if err != nil {
		return err
	}
	if len(selected) == 0 {
		ui.Warn("没有选中任何 harness。以后可以运行 crapi setup 再配置。")
		return nil
	}
	if *model != "" {
		if _, ok := api.Find(models, *model); !ok {
			return fmt.Errorf("当前 Key 看不到模型 %s，可用 crapi models 查看", *model)
		}
	}
	plan := harness.Plan{
		BaseURL:   a.Cfg.Base(),
		Key:       c.Key,
		Models:    chat,
		Model:     *model,
		WebSearch: !*noSearch,
	}
	ui.Section("写入配置", fmt.Sprintf("%d 个 harness", len(selected)))
	ok, manual := applyAll(a, env, plan, selected, *dry)
	if !*dry {
		a.Cfg.LastUpdate = time.Now()
		a.Cfg.ModelIDs = ids(chat)
		if err := a.Cfg.Save(); err != nil {
			return err
		}
	}
	ui.Println()
	failed := len(selected) - ok - manual
	msg := fmt.Sprintf("完成：%d 个 harness 已自动接入 crosery", ok)
	if manual > 0 {
		msg += fmt.Sprintf("，%d 个需按上方提示在应用内完成最后一步", manual)
	}
	if failed > 0 {
		ui.Warn("%s，%d 个失败（见上方提示）。", msg, failed)
	} else {
		ui.Success("%s。", msg)
	}
	nextSteps()
	return nil
}

func nextSteps() {
	ui.Println()
	ui.Println(ui.Dim.Render("接下来可以："))
	for _, l := range [][2]string{
		{"crapi usage", "查看用量与额度"},
		{"crapi pool", "查看号池状态"},
		{"crapi models", "查看可用模型与渠道"},
		{"crapi update", "网关上新模型后一键同步到所有 harness"},
		{`crapi image "描述"`, "生图"},
	} {
		ui.Printf("  %s  %s\n", ui.AccentS.Render(ui.Pad(l[0], 20)), ui.Dim.Render(l[1]))
	}
}

// ensureKey 解析 Key（参数 > 环境变量 > 已保存 > 交互输入），并用 /v1/models 校验。
func (a *App) ensureKey(flagKey string, allowPrompt bool) (*api.Client, []api.Model, error) {
	key := strings.TrimSpace(flagKey)
	if key == "" {
		key = a.Cfg.Key()
	}
	prompted := false
	for attempt := 0; attempt < 3; attempt++ {
		if key == "" {
			if !allowPrompt || !term.Interactive() {
				return nil, nil, errors.New("缺少 API Key：请用 --key sk-xxx 或环境变量 CRAPI_KEY 提供")
			}
			v, err := ui.AskSecret("请输入 crosery API Key", "Key 只保存在本机（"+store.Path()+"）", func(s string) error {
				if len(strings.TrimSpace(s)) < 8 {
					return errors.New("Key 太短了，请检查是否复制完整")
				}
				return nil
			})
			if err != nil {
				return nil, nil, err
			}
			key = strings.TrimSpace(v)
			prompted = true
		}
		c := a.clientWith(key)
		models, err := a.fetchModels(c)
		if err == nil {
			if key != a.Cfg.APIKey {
				a.Cfg.APIKey = key
				if err := a.Cfg.Save(); err != nil {
					return nil, nil, err
				}
				ui.Success("API Key 已验证并保存 %s", ui.Dim.Render(store.MaskKey(key)))
			} else {
				ui.Success("API Key 有效 %s", ui.Dim.Render(store.MaskKey(key)))
			}
			return c, models, nil
		}
		if api.IsAuthError(err) && allowPrompt && term.Interactive() {
			ui.Fail("这个 Key 无效或已停用，请重新输入")
			key = ""
			continue
		}
		if !prompted && api.IsAuthError(err) {
			return nil, nil, fmt.Errorf("API Key 无效或已停用：%s", store.MaskKey(key))
		}
		return nil, nil, err
	}
	return nil, nil, errors.New("多次输入的 Key 都无效，请确认后重试")
}

func printKeySummary(a *App, models []api.Model) {
	chat := api.ChatModels(models)
	imgs := api.SupportedImageModels(models)
	channels := map[string]int{}
	for _, m := range models {
		channels[m.OwnedBy]++
	}
	ui.KV("网关", a.Cfg.Base())
	ui.KV("模型", fmt.Sprintf("%s 个对话模型 · %s 生图 %s 个 · %s 个渠道",
		ui.Bold.Render(fmt.Sprint(len(chat))), api.ImageFamily, ui.Bold.Render(fmt.Sprint(len(imgs))), ui.Bold.Render(fmt.Sprint(len(channels)))))
}

// chooseHarnesses 决定要配置哪些 harness。
func chooseHarnesses(env harness.Env, base string, targets []string, all, yes bool) ([]harness.Harness, error) {
	if len(targets) > 0 {
		var out []harness.Harness
		for _, t := range targets {
			h, ok := harness.Get(t)
			if !ok {
				return nil, fmt.Errorf("不认识的 harness：%s（可用 crapi status 查看支持列表）", t)
			}
			out = append(out, h)
		}
		return out, nil
	}
	type row struct {
		h   harness.Harness
		det harness.Detection
		st  harness.Status
	}
	var rows []row
	for _, h := range harness.All() {
		det := h.Detect(env)
		var st harness.Status
		if det.Installed {
			st = h.Status(env, base)
		}
		rows = append(rows, row{h, det, st})
	}
	if all {
		var out []harness.Harness
		for _, r := range rows {
			out = append(out, r.h)
		}
		return out, nil
	}
	installed := 0
	for _, r := range rows {
		if r.det.Installed {
			installed++
		}
	}
	if yes || !term.Interactive() {
		var out []harness.Harness
		for _, r := range rows {
			if r.det.Installed {
				out = append(out, r.h)
			}
		}
		ui.KV("检测到", fmt.Sprintf("%d 个已安装的 harness", installed))
		return out, nil
	}
	g := ui.G()
	var opts []ui.Option
	for _, r := range rows {
		tag := ui.Dim.Render("未检测到")
		if r.det.Installed {
			tag = ui.OKS.Render("已安装")
		}
		if r.st.Configured {
			tag += " " + ui.AccentS.Render(g.Dot+" 已接入")
		}
		label := ui.Pad(r.h.Name(), 18) + " " + ui.Dim.Render(ui.Pad(string(r.h.Category()), 5)) + " " + tag
		opts = append(opts, ui.Option{Label: label, Value: r.h.ID(), Selected: false})
	}
	ui.Println()
	picked, err := ui.AskMulti("请勾选需要接入 Crosery 的 Agent 工具",
		fmt.Sprintf("检测到 %d 个已安装的工具。请按空格键勾选要接入的工具，回车确认（默认全部未勾选，避免影响现有配置）。", installed), opts)
	if err != nil {
		return nil, err
	}
	var out []harness.Harness
	for _, id := range picked {
		if h, ok := harness.Get(id); ok {
			out = append(out, h)
		}
	}
	return out, nil
}

// applyAll 依次写配置并打印结果，返回自动完成的个数与需要手动完成的个数。
func applyAll(a *App, env harness.Env, plan harness.Plan, list []harness.Harness, dry bool) (ok, manual int) {
	stamp := time.Now().Format("20060102-150405")
	for _, h := range list {
		w := harness.NewWriter(dry, stamp)
		w.Harness = h.ID()
		res, err := h.Apply(env, plan, w)
		if err != nil {
			ui.Fail("%s  %v", ui.Bold.Render(h.Name()), err)
			continue
		}
		if res.Manual {
			manual++
		} else {
			ok++
		}
		model := ""
		if res.Model != "" {
			model = ui.Dim.Render(" "+ui.G().Arrow+" 默认模型 ") + ui.AccentS.Render(res.Model)
		}
		if res.Manual {
			ui.Warn("%s%s  %s", ui.Bold.Render(h.Name()), model, ui.Dim.Render("需要手动完成一步"))
		} else {
			ui.Success("%s%s", ui.Bold.Render(h.Name()), model)
		}
		files := res.Files
		sort.Strings(files)
		for _, f := range slices.Compact(files) {
			verb := "已写入"
			if dry {
				verb = "将写入"
			}
			ui.Note("%s %s", verb, f)
		}
		if len(res.Files) == 0 && !res.Manual {
			ui.Note("配置已是最新，无需改动")
		}
		for _, n := range res.Notes {
			ui.Println("  " + ui.WarnS.Render(ui.G().Bullet) + " " + n)
		}
		if !dry && !res.Manual {
			m := a.Cfg.Managed[h.ID()]
			if m.ConfiguredAt.IsZero() {
				m.ConfiguredAt = time.Now()
			}
			m.UpdatedAt = time.Now()
			m.Model = res.Model
			m.Files = res.Files
			a.Cfg.Managed[h.ID()] = m
		}
	}
	return ok, manual
}

func ids(models []api.Model) []string {
	out := make([]string, 0, len(models))
	for _, m := range models {
		out = append(out, m.ID)
	}
	sort.Strings(out)
	return out
}
