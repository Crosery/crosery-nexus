package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/ui"
)

const modelsHelp = `crapi models [关键字] [参数]

列出当前 API Key 可以调用的全部模型，按厂商分组（与控制台「模型」页一致）。
网关不按渠道区分模型：同一个模型由哪个渠道承接，网关按权重自动选择。

参数：
  --kind <类型>     chat / image / audio
  --free            只看免费模型
  --json            输出 JSON（便于脚本处理）`

func cmdModels(a *App, args []string) error {
	fs := newFlags("models", modelsHelp)
	channel := fs.String("channel", "", "")
	kind := fs.String("kind", "", "")
	free := fs.Bool("free", false, "")
	asJSON := fs.Bool("json", false, "")
	pos, err := parse(fs, args, modelsHelp)
	if err != nil {
		return err
	}
	if *channel != "" {
		return errChannelRemoved
	}
	c, err := a.client()
	if err != nil {
		return err
	}
	var models []api.Model
	if *asJSON {
		models, err = c.ListModels(a.ctx)
	} else {
		models, err = a.fetchModels(c)
	}
	if err != nil {
		return err
	}
	kw := strings.ToLower(strings.Join(pos, " "))
	var list []api.Model
	for _, m := range models {
		if *kind != "" && string(m.Kind()) != strings.ToLower(*kind) {
			continue
		}
		if *free && !m.Free() {
			continue
		}
		if kw != "" && !strings.Contains(strings.ToLower(m.ID+" "+m.Name()), kw) {
			continue
		}
		list = append(list, m)
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(list)
	}

	vendors := groupByVendor(list)
	ui.Section("可用模型", fmt.Sprintf("%d 个模型 · %d 个厂商", len(list), len(vendors)))
	ui.Println(ui.Tree(modelTree(vendors)))
	ui.Println()
	ui.Note("列：模型 ID · 名称 · 上下文 · 最大输出 · 能力 · 价格（每百万 token 输入 / 输出，美元）。")
	ui.Note("能力：视=识图 推=推理 工=工具调用 搜=联网 图=生图 音=音频。模型列表已按你的 Key 权限过滤。")
	return nil
}

func caps(m api.Model) string {
	var parts []string
	switch m.Kind() {
	case api.KindImage:
		return ui.AccentS.Render("图")
	case api.KindAudio:
		return ui.AccentS.Render("音")
	}
	if m.Vision() {
		parts = append(parts, "视")
	}
	if m.SupportsReasoning {
		parts = append(parts, "推")
	}
	if m.SupportsToolCall == nil || *m.SupportsToolCall {
		parts = append(parts, "工")
	}
	if m.SupportsWebSearch {
		parts = append(parts, "搜")
	}
	return strings.Join(parts, " ")
}

func price(m api.Model) string {
	if m.Free() {
		return ui.OKS.Render("免费")
	}
	if m.Cost == nil || (m.Cost.Input == 0 && m.Cost.Output == 0) {
		return ui.Dim.Render("-")
	}
	return fmt.Sprintf("$%s / $%s", trimNum(m.Cost.Input), trimNum(m.Cost.Output))
}

func trimNum(v float64) string {
	s := fmt.Sprintf("%.3f", v)
	s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	return s
}

func indent(s, prefix string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = prefix + l
	}
	return strings.Join(lines, "\n")
}
