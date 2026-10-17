package harness

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/atotto/clipboard"

	"github.com/crosery/crapi/internal/api"
)

// copyKey 把 Key 放进剪贴板，方便在图形界面里粘贴；失败时静默（无头 Linux 没有剪贴板）。
func copyKey(key string) bool { return clipboard.WriteAll(key) == nil }

// openURL 用系统默认程序打开链接（deep link）。
func openURL(e Env, url string) error {
	var cmd *exec.Cmd
	switch e.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

func topModels(p Plan, n int) []string {
	var out []string
	for _, pref := range [][]string{api.PrefOpus[:1], api.PrefGPT[:1], api.PrefSonnet[:1], api.PrefGemini[:1], api.PrefGPT[1:3]} {
		for _, id := range pref {
			if p.Has(id) && len(out) < n {
				out = append(out, id)
			}
		}
	}
	return out
}

// ---------- Cursor：Key 存在系统钥匙串加密的 SecretStorage 里，只能在应用内填写 ----------

type cursor struct{}

func (cursor) ID() string         { return "cursor" }
func (cursor) Name() string       { return "Cursor" }
func (cursor) Category() Category { return IDE }

func (cursor) Detect(e Env) Detection {
	app := appInstalled(e, []string{"Cursor"}, []string{"cursor", "Cursor"}, []string{"cursor"})
	return detectAny(app, filepath.Join(e.AppSupport(), "Cursor"))
}

func (cursor) Status(Env, string) Status { return Status{Detail: "需在 Cursor 设置中查看"} }

func (cursor) Apply(e Env, p Plan, w *Writer) (Result, error) {
	copied := ""
	if !w.DryRun && copyKey(p.Key) {
		copied = "（Key 已复制到剪贴板）"
	}
	models := strings.Join(topModels(p, 5), "、")
	return Result{Manual: true, Model: api.Pick(p.Models, api.PrefAgent, nil), Notes: []string{
		"Cursor 把第三方 Key 存在系统钥匙串的加密区里，外部程序无法安全写入，需要在应用内完成：",
		"① Cursor → Settings → Models → 打开 OpenAI API Key，粘贴你的 Key" + copied,
		"② 打开 Override OpenAI Base URL，填 " + p.OpenAIBase(),
		"③ 点 + Add Model 添加模型名，例如：" + models,
		"注意：cursor-agent 命令行不支持自定义地址；Tab 补全仍使用 Cursor 自己的模型",
	}}, nil
}

// ---------- Zed：settings.json 的 language_models.openai_compatible；Key 只能放钥匙串 / 环境变量 ----------

type zed struct{}

func (zed) ID() string         { return "zed" }
func (zed) Name() string       { return "Zed" }
func (zed) Category() Category { return IDE }

func (zed) path(e Env) string {
	switch e.GOOS {
	case "windows":
		return filepath.Join(e.AppData(), "Zed", "settings.json")
	case "linux":
		if d := os.Getenv("XDG_CONFIG_HOME"); d != "" && e.Home == defaultHome() {
			return filepath.Join(d, "zed", "settings.json")
		}
	}
	return e.P(".config", "zed", "settings.json")
}

func (x zed) Detect(e Env) Detection {
	app := appInstalled(e, []string{"Zed"}, []string{"Zed"}, []string{"zed", "zeditor"})
	return detectAny(app, filepath.Dir(x.path(e)))
}

func (x zed) Status(e Env, base string) Status {
	s, _, _ := readJSONFile(x.path(e))
	if s == nil {
		return Status{}
	}
	prov := s.Child("language_models").Child("openai_compatible").Child(ProviderID)
	return Status{
		Configured: baseMatches(prov.Str("api_url"), base),
		Model:      s.Child("agent").Child("default_model").Str("model"),
	}
}

func (x zed) Apply(e Env, p Plan, w *Writer) (Result, error) {
	path := x.path(e)
	s, had, err := readJSONFile(path)
	if err != nil {
		return Result{}, err
	}
	var models []any
	for _, m := range agentModels(p) {
		models = append(models, O("name", m.ID, "display_name", m.Name(),
			"max_tokens", ctxOr(m, 128000), "max_output_tokens", maxOutOr(m, 16384),
			"capabilities", O("tools", true, "images", m.Vision(), "parallel_tool_calls", true,
				"prompt_cache_key", false, "chat_completions", true)))
	}
	s.Child("language_models").Child("openai_compatible").Set(ProviderID, O(
		"api_url", p.OpenAIBase(), "available_models", models))
	dm := s.Child("agent").Child("default_model")
	prev := ""
	if dm.Str("provider") == ProviderID {
		prev = dm.Str("model")
	}
	model := p.Choose(prev, api.PrefAgent)
	if !p.UpdateOnly || prev != model {
		dm.Set("provider", ProviderID)
		dm.Set("model", model)
	}
	if err := w.Write(path, MarshalJSON(s), 0o644); err != nil {
		return Result{}, err
	}
	copied := ""
	if !w.DryRun && copyKey(p.Key) {
		copied = "（Key 已复制到剪贴板）"
	}
	notes := []string{"Zed 不允许把 Key 写进 settings.json：打开 Agent 面板 → 设置 → " + ProviderID + "，粘贴 Key" + copied}
	if had {
		notes = append(notes, "settings.json 里的注释会在重写后丢失（原文件已备份，可用 crapi restore zed 还原）")
	}
	return Result{Files: w.Written(), Model: model, Notes: notes}, nil
}

// ---------- Cherry Studio：通过 cherrystudio:// deep link 一键导入渠道 ----------

type cherry struct{}

func (cherry) ID() string         { return "cherry-studio" }
func (cherry) Name() string       { return "Cherry Studio" }
func (cherry) Category() Category { return Desktop }

func (cherry) Detect(e Env) Detection {
	app := appInstalled(e, []string{"Cherry Studio"}, []string{"Cherry Studio", "CherryStudio"}, []string{"cherry-studio", "cherrystudio"})
	return detectAny(app, filepath.Join(e.AppSupport(), "CherryStudio"))
}

func (cherry) Status(Env, string) Status {
	return Status{Detail: "在 Cherry Studio 的模型服务列表中查看"}
}

func (cherry) Apply(e Env, p Plan, w *Writer) (Result, error) {
	// 处理函数会删掉括号、把单引号换成双引号，所以名称里不能带这些字符。
	payload, _ := json.Marshal(map[string]string{
		"id": ProviderID, "name": "Crosery", "type": "openai",
		"apiKey": p.Key, "baseUrl": strings.TrimRight(p.BaseURL, "/"),
	})
	link := "cherrystudio://providers/api-keys?v=1&data=" + base64.RawURLEncoding.EncodeToString(payload)
	res := Result{Manual: true, Model: api.Pick(p.Models, api.PrefAgent, nil)}
	if w.DryRun {
		res.Notes = []string{"将打开 Cherry Studio 导入链接"}
		return res, nil
	}
	if err := openURL(e, link); err != nil {
		return res, err
	}
	res.Notes = []string{
		"已唤起 Cherry Studio，请在弹窗里点「确认」导入「Crosery」",
		"导入后在该服务商页面点「管理」，从网关拉取模型列表并勾选需要的模型",
	}
	return res, nil
}
