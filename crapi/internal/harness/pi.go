package harness

import (
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"

	"github.com/crosery/crapi/internal/api"
)

// pi（pi-coding-agent）：~/.pi/agent/models.json 的 providers.crosery + settings.json 默认模型。
type pi struct{}

func (pi) ID() string         { return "pi" }
func (pi) Name() string       { return "Pi" }
func (pi) Category() Category { return CLI }

func (pi) dir(e Env) string {
	if d := os.Getenv("PI_CODING_AGENT_DIR"); d != "" && e.Home == defaultHome() {
		return d
	}
	return e.P(".pi", "agent")
}

func (x pi) Detect(e Env) Detection { return detectAny(which(e, "pi"), x.dir(e)) }

func (x pi) Status(e Env, base string) Status {
	m, _, _ := readJSONFile(filepath.Join(x.dir(e), "models.json"))
	s, _, _ := readJSONFile(filepath.Join(x.dir(e), "settings.json"))
	if m == nil || s == nil {
		return Status{}
	}
	prov := m.Child("providers").Child(ProviderID)
	st := Status{Configured: baseMatches(prov.Str("baseUrl"), base)}
	if s.Str("defaultProvider") == ProviderID {
		st.Model = s.Str("defaultModel")
	}
	return st
}

// piModel 构造 pi / omp 共用的模型条目（JSON 形态）。
func piModel(m api.Model) *Obj {
	o := O("id", m.ID, "name", m.Name(), "reasoning", m.SupportsReasoning,
		"input", inputs(m), "contextWindow", ctxOr(m, 128000), "maxTokens", maxOutOr(m, 16384))
	if m.Cost != nil {
		o.Set("cost", O("input", m.Cost.Input, "output", m.Cost.Output,
			"cacheRead", m.Cost.CacheRead, "cacheWrite", m.Cost.CacheWrite))
	}
	return o
}

func (x pi) Apply(e Env, p Plan, w *Writer) (Result, error) {
	modelsPath := filepath.Join(x.dir(e), "models.json")
	settingsPath := filepath.Join(x.dir(e), "settings.json")
	mf, _, err := readJSONFile(modelsPath)
	if err != nil {
		return Result{}, err
	}
	sf, _, err := readJSONFile(settingsPath)
	if err != nil {
		return Result{}, err
	}
	var models []any
	for _, m := range agentModels(p) {
		models = append(models, piModel(m))
	}
	prov := mf.Child("providers").Child(ProviderID)
	prov.Set("name", ProviderName)
	prov.Set("baseUrl", p.OpenAIBase())
	prov.Set("api", "openai-completions")
	prov.Set("apiKey", p.Key)
	prov.Set("models", models)

	prev := ""
	if sf.Str("defaultProvider") == ProviderID {
		prev = sf.Str("defaultModel")
	}
	model := p.Choose(prev, api.PrefAgent)
	if !p.UpdateOnly || prev == "" || prev != model {
		sf.Set("defaultProvider", ProviderID)
		sf.Set("defaultModel", model)
	}
	if err := w.Write(modelsPath, MarshalJSON(mf), 0o600); err != nil {
		return Result{}, err
	}
	if err := w.Write(settingsPath, MarshalJSON(sf), 0o644); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model}, nil
}

// omp（oh-my-pi）：~/.omp/agent/models.yml（canonical）。只有 models.json、还没有 yml 时，
// omp 下次启动会把 json 迁移成 yml——此时改 json，避免新建 yml 导致用户的 json 被忽略。
type omp struct{}

func (omp) ID() string         { return "omp" }
func (omp) Name() string       { return "oh-my-pi (omp)" }
func (omp) Category() Category { return CLI }

func (omp) dir(e Env) string { return e.P(".omp", "agent") }

func (x omp) Detect(e Env) Detection { return detectAny(which(e, "omp"), x.dir(e)) }

func (x omp) useJSON(e Env) bool {
	return !fileExists(filepath.Join(x.dir(e), "models.yml")) && fileExists(filepath.Join(x.dir(e), "models.json"))
}

func (x omp) Status(e Env, base string) Status {
	var url string
	if x.useJSON(e) {
		m, _, _ := readJSONFile(filepath.Join(x.dir(e), "models.json"))
		if m != nil {
			url = m.Child("providers").Child(ProviderID).Str("baseUrl")
		}
	} else if data, err := os.ReadFile(filepath.Join(x.dir(e), "models.yml")); err == nil {
		if _, root, err := LoadYAML(data); err == nil {
			url = YScalar(YGet(YGet(root, "providers"), ProviderID), "baseUrl")
		}
	}
	st := Status{Configured: baseMatches(url, base)}
	if data, err := os.ReadFile(filepath.Join(x.dir(e), "config.yml")); err == nil {
		if _, root, err := LoadYAML(data); err == nil {
			st.Model = YScalar(YGet(root, "modelRoles"), "default")
		}
	}
	return st
}

func ompModelYAML(m api.Model) *yaml.Node {
	n := YMapOf("id", YStr(m.ID), "name", YStr(m.Name()), "reasoning", YBool(m.SupportsReasoning))
	if ef := efforts(m); len(ef) > 0 {
		YSet(n, "thinking", YMapOf("mode", YStr("effort"), "efforts", YFlowList(ef)))
	}
	YSet(n, "input", YFlowList(inputs(m)))
	YSet(n, "contextWindow", YInt(ctxOr(m, 128000)))
	YSet(n, "maxTokens", YInt(maxOutOr(m, 16384)))
	return n
}

func (x omp) Apply(e Env, p Plan, w *Writer) (Result, error) {
	var res Result
	if x.useJSON(e) {
		path := filepath.Join(x.dir(e), "models.json")
		mf, _, err := readJSONFile(path)
		if err != nil {
			return res, err
		}
		var models []any
		for _, m := range agentModels(p) {
			o := piModel(m)
			o.Delete("cost")
			models = append(models, o)
		}
		prov := mf.Child("providers").Child(ProviderID)
		prov.Set("name", ProviderName)
		prov.Set("api", "openai-completions")
		prov.Set("baseUrl", p.OpenAIBase())
		prov.Set("apiKey", p.Key)
		prov.Set("models", models)
		if err := w.Write(path, MarshalJSON(mf), 0o600); err != nil {
			return res, err
		}
	} else {
		path := filepath.Join(x.dir(e), "models.yml")
		data, _ := os.ReadFile(path)
		doc, root, err := LoadYAML(data)
		if err != nil {
			return res, err
		}
		seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		for _, m := range agentModels(p) {
			seq.Content = append(seq.Content, ompModelYAML(m))
		}
		prov := YMap(YMap(root, "providers"), ProviderID)
		YSet(prov, "name", YStr(ProviderName))
		YSet(prov, "api", YStr("openai-completions"))
		YSet(prov, "auth", YStr("apiKey"))
		YSet(prov, "baseUrl", YStr(p.OpenAIBase()))
		YSet(prov, "apiKey", YStr(p.Key))
		YSet(prov, "models", seq)
		out, err := DumpYAML(doc)
		if err != nil {
			return res, err
		}
		if err := w.Write(path, out, 0o600); err != nil {
			return res, err
		}
	}

	// 默认模型：config.yml 的 modelRoles.default = crosery/<id>
	cfgPath := filepath.Join(x.dir(e), "config.yml")
	data, _ := os.ReadFile(cfgPath)
	doc, root, err := LoadYAML(data)
	if err != nil {
		return res, err
	}
	roles := YMap(root, "modelRoles")
	prev := ""
	if cur := YScalar(roles, "default"); len(cur) > len(ProviderID)+1 && cur[:len(ProviderID)+1] == ProviderID+"/" {
		prev = cur[len(ProviderID)+1:]
		if i := indexByte(prev, ':'); i >= 0 {
			prev = prev[:i]
		}
	}
	model := p.Choose(prev, api.PrefAgent)
	if !p.UpdateOnly || prev != model {
		YSet(roles, "default", YStr(ProviderID+"/"+model))
		out, err := DumpYAML(doc)
		if err != nil {
			return res, err
		}
		if err := w.Write(cfgPath, out, 0o644); err != nil {
			return res, err
		}
	}
	res.Files = w.Written()
	res.Model = model
	return res, nil
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}
