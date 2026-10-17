package harness

import (
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/crosery/crapi/internal/api"
)

// hermes（Nous Hermes Agent）：~/.hermes/config.yaml。
// 用 v12+ 的 providers.<name> 字典登记渠道，model.provider 写成 custom:crosery。
type hermes struct{}

func (hermes) ID() string         { return "hermes" }
func (hermes) Name() string       { return "Hermes Agent" }
func (hermes) Category() Category { return CLI }

func (hermes) path(e Env) string {
	if d := os.Getenv("HERMES_HOME"); d != "" && e.Home == defaultHome() {
		return filepath.Join(d, "config.yaml")
	}
	return e.P(".hermes", "config.yaml")
}

func (x hermes) Detect(e Env) Detection {
	return detectAny(which(e, "hermes"), filepath.Dir(x.path(e)))
}

func (x hermes) Status(e Env, base string) Status {
	data, err := os.ReadFile(x.path(e))
	if err != nil {
		return Status{}
	}
	_, root, err := LoadYAML(data)
	if err != nil {
		return Status{Detail: err.Error()}
	}
	prov := YGet(YGet(root, "providers"), ProviderID)
	url := YScalar(prov, "api")
	if url == "" {
		url = YScalar(prov, "base_url")
	}
	m := YGet(root, "model")
	st := Status{Configured: baseMatches(url, base) && strings.EqualFold(YScalar(m, "provider"), "custom:"+ProviderID)}
	st.Model = YScalar(m, "default")
	return st
}

func (x hermes) Apply(e Env, p Plan, w *Writer) (Result, error) {
	path := x.path(e)
	data, _ := os.ReadFile(path)
	doc, root, err := LoadYAML(data)
	if err != nil {
		return Result{}, err
	}
	modelNode := YMap(root, "model")
	prev := ""
	if strings.EqualFold(YScalar(modelNode, "provider"), "custom:"+ProviderID) {
		prev = YScalar(modelNode, "default")
	}
	model := p.Choose(prev, api.PrefAgent)

	models := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	for _, m := range agentModels(p) {
		YSet(models, m.ID, YMapOf("name", YStr(m.Name()), "context_length", YInt(ctxOr(m, 128000))))
	}
	prov := YMap(YMap(root, "providers"), ProviderID)
	YSet(prov, "name", YStr(ProviderName))
	YSet(prov, "api", YStr(p.OpenAIBase()))
	YSet(prov, "api_key", YStr(p.Key))
	YSet(prov, "transport", YStr("chat_completions"))
	YSet(prov, "default_model", YStr(model))
	YSet(prov, "models", models)
	YDelete(prov, "base_url")
	YDelete(prov, "api_mode")

	if !p.UpdateOnly || prev != model {
		YSet(modelNode, "default", YStr(model))
		YSet(modelNode, "provider", YStr("custom:"+ProviderID))
		// model 段里旧的 base_url / api_key 会盖过命名渠道，去掉（原文件已备份）。
		YDelete(modelNode, "base_url")
		YDelete(modelNode, "api_key")
		if m, ok := api.Find(p.Models, model); ok {
			YSet(modelNode, "supports_vision", YBool(m.Vision()))
		}
	}
	out, err := DumpYAML(doc)
	if err != nil {
		return Result{}, err
	}
	if err := w.Write(path, out, 0o600); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model}, nil
}
