package harness

import (
	"os"
	"path/filepath"

	"github.com/crosery/crapi/internal/api"
)

// codex：~/.codex/config.toml。按行修改，只动顶层 model / model_provider
// 与 [model_providers.crosery] 表，用户其余配置（MCP、profiles、注释）原样保留。
// Key 写在 experimental_bearer_token，避免依赖环境变量（Windows 上设置环境变量很麻烦）。
type codex struct{}

func (codex) ID() string         { return "codex" }
func (codex) Name() string       { return "Codex CLI" }
func (codex) Category() Category { return CLI }

func (codex) path(e Env) string {
	if d := os.Getenv("CODEX_HOME"); d != "" && e.Home == defaultHome() {
		return filepath.Join(d, "config.toml")
	}
	return e.P(".codex", "config.toml")
}

func (c codex) Detect(e Env) Detection {
	return detectAny(which(e, "codex"), filepath.Dir(c.path(e)))
}

func (c codex) Status(e Env, base string) Status {
	data, _ := os.ReadFile(c.path(e))
	d := ParseTOML(data)
	prov, _ := d.GetTop("model_provider")
	prov = UnquoteTOML(prov)
	url, _ := d.TableValue("model_providers."+prov, "base_url")
	model, _ := d.GetTop("model")
	return Status{Configured: baseMatches(UnquoteTOML(url), base), Model: UnquoteTOML(model)}
}

func (c codex) Apply(e Env, p Plan, w *Writer) (Result, error) {
	path := c.path(e)
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return Result{}, err
	}
	d := ParseTOML(data)
	var res Result

	prev := ""
	if prov, _ := d.GetTop("model_provider"); UnquoteTOML(prov) == ProviderID {
		v, _ := d.GetTop("model")
		prev = UnquoteTOML(v)
	}
	model := p.Choose(prev, api.PrefGPT, api.PrefOpus)
	d.SetTop("model_provider", TOMLString(ProviderID))
	d.SetTop("model", TOMLString(model))
	d.ReplaceTable("model_providers."+ProviderID, []string{
		"name = " + TOMLString(ProviderName),
		"base_url = " + TOMLString(p.OpenAIBase()),
		"wire_api = \"responses\"",
		"experimental_bearer_token = " + TOMLString(p.Key),
	})
	if v, ok := d.GetTop("profile"); ok {
		res.Notes = append(res.Notes, "config.toml 顶层设置了 profile = "+v+"，该 profile 里的 model_provider 会覆盖这里的设置")
	}
	if err := w.Write(path, d.Bytes(), 0o600); err != nil {
		return res, err
	}
	res.Files = w.Written()
	res.Model = model
	return res, nil
}
