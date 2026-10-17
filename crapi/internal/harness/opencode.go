package harness

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/crosery/crapi/internal/api"
)

// opencodeModels 构造 OpenCode 系（opencode / kilo）的 models 字段。
func opencodeModels(p Plan) *Obj {
	models := NewObj()
	for _, m := range agentModels(p) {
		o := O("name", m.Name(),
			"limit", O("context", ctxOr(m, 128000), "output", maxOutOr(m, 16384)),
			"attachment", m.Vision(),
			"reasoning", m.SupportsReasoning,
			"tool_call", true,
			"modalities", O("input", inputs(m), "output", []string{"text"}),
		)
		if m.Cost != nil {
			o.Set("cost", O("input", m.Cost.Input, "output", m.Cost.Output,
				"cache_read", m.Cost.CacheRead, "cache_write", m.Cost.CacheWrite))
		}
		models.Set(m.ID, o)
	}
	return models
}

// opencode：~/.config/opencode/opencode.json(c)，provider.crosery 使用 @ai-sdk/openai-compatible。
// Windows 上 OpenCode 同样读取 %USERPROFILE%\.config\opencode。
type opencode struct{}

func (opencode) ID() string         { return "opencode" }
func (opencode) Name() string       { return "OpenCode" }
func (opencode) Category() Category { return CLI }

func (opencode) path(e Env) string {
	dir := e.P(".config", "opencode")
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" && e.Home == defaultHome() && e.GOOS != "windows" {
		dir = filepath.Join(d, "opencode")
	}
	for _, n := range []string{"opencode.json", "opencode.jsonc", "config.json"} {
		if fileExists(filepath.Join(dir, n)) {
			return filepath.Join(dir, n)
		}
	}
	return filepath.Join(dir, "opencode.json")
}

func (x opencode) Detect(e Env) Detection {
	return detectAny(which(e, "opencode"), filepath.Dir(x.path(e)))
}

func (x opencode) Status(e Env, base string) Status {
	return opencodeStatus(x.path(e), base)
}

func opencodeStatus(path, base string) Status {
	s, _, err := readJSONFile(path)
	if err != nil || s == nil {
		return Status{}
	}
	prov := s.Child("provider").Child(ProviderID)
	return Status{
		Configured: baseMatches(prov.Child("options").Str("baseURL"), base),
		Model:      s.Str("model"),
	}
}

func opencodeApply(path string, p Plan, w *Writer, withSchema string) (Result, error) {
	s, had, err := readJSONFile(path)
	if err != nil {
		return Result{}, err
	}
	if withSchema != "" && !s.Has("$schema") {
		s2 := O("$schema", withSchema)
		for _, k := range s.Keys() {
			v, _ := s.Get(k)
			s2.Set(k, v)
		}
		s = s2
	}
	s.Child("provider").Set(ProviderID, O(
		"npm", "@ai-sdk/openai-compatible",
		"name", ProviderName,
		"options", O("baseURL", p.OpenAIBase(), "apiKey", p.Key),
		"models", opencodeModels(p),
	))
	prev := ""
	if cur := s.Str("model"); strings.HasPrefix(cur, ProviderID+"/") {
		prev = strings.TrimPrefix(cur, ProviderID+"/")
	}
	model := p.Choose(prev, api.PrefAgent)
	if !p.UpdateOnly || prev != model {
		s.Set("model", ProviderID+"/"+model)
		small := api.Pick(p.Models, api.PrefFast, nil)
		if small != "" && (s.Str("small_model") == "" || strings.HasPrefix(s.Str("small_model"), ProviderID+"/")) {
			s.Set("small_model", ProviderID+"/"+small)
		}
	}
	var notes []string
	if had {
		notes = append(notes, filepath.Base(path)+" 里的注释会在重写后丢失（原文件已备份）")
	}
	if err := w.Write(path, MarshalJSON(s), 0o600); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model, Notes: notes}, nil
}

func (x opencode) Apply(e Env, p Plan, w *Writer) (Result, error) {
	return opencodeApply(x.path(e), p, w, "https://opencode.ai/config.json")
}

// geminiCLI：~/.gemini/.env 放 Key 与网关地址（Gemini CLI 启动时自动加载），
// settings.json 选择 API Key 认证并设置默认模型。网关原生支持 Gemini 接口。
type geminiCLI struct{}

func (geminiCLI) ID() string         { return "gemini-cli" }
func (geminiCLI) Name() string       { return "Gemini CLI" }
func (geminiCLI) Category() Category { return CLI }

func (geminiCLI) dir(e Env) string { return e.P(".gemini") }

func (x geminiCLI) Detect(e Env) Detection { return detectAny(which(e, "gemini"), x.dir(e)) }

func (x geminiCLI) Status(e Env, base string) Status {
	data, _ := os.ReadFile(filepath.Join(x.dir(e), ".env"))
	s, _, _ := readJSONFile(filepath.Join(x.dir(e), "settings.json"))
	st := Status{Configured: baseMatches(GetDotenv(data, "GOOGLE_GEMINI_BASE_URL"), base)}
	if s != nil {
		st.Model = s.Child("model").Str("name")
	}
	return st
}

func (x geminiCLI) Apply(e Env, p Plan, w *Writer) (Result, error) {
	var gem []api.Model
	for _, m := range p.Models {
		if m.Vendor() == "google" && strings.HasPrefix(m.ID, "gemini") {
			gem = append(gem, m)
		}
	}
	if len(gem) == 0 {
		return Result{Notes: []string{"当前 Key 没有 Gemini 模型，跳过"}}, nil
	}
	envPath := filepath.Join(x.dir(e), ".env")
	data, _ := os.ReadFile(envPath)
	out := SetDotenv(data, [][2]string{
		{"GEMINI_API_KEY", p.Key},
		{"GOOGLE_GEMINI_BASE_URL", strings.TrimRight(p.BaseURL, "/")},
	})
	if err := w.Write(envPath, out, 0o600); err != nil {
		return Result{}, err
	}
	sPath := filepath.Join(x.dir(e), "settings.json")
	s, _, err := readJSONFile(sPath)
	if err != nil {
		return Result{}, err
	}
	prev := s.Child("model").Str("name")
	pl := Plan{Models: gem, Model: p.Model}
	if p.Model != "" && !strings.HasPrefix(p.Model, "gemini") {
		pl.Model = ""
	}
	model := pl.Choose(prev, api.PrefGemini)
	s.Child("security").Child("auth").Set("selectedType", "gemini-api-key")
	if !p.UpdateOnly || prev != model {
		s.Child("model").Set("name", model)
	}
	if err := w.Write(sPath, MarshalJSON(s), 0o644); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model, Notes: []string{
		"Gemini CLI 只能使用 Gemini 系列模型",
		"Gemini CLI 默认开启「文件夹信任」：在未信任的目录里不会读取 ~/.gemini/.env，首次在项目目录运行 gemini 时选择信任即可",
	}}, nil
}
