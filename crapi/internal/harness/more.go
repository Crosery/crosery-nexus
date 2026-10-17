package harness

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/crosery/crapi/internal/api"
)

// ---------- Qwen Code：~/.qwen/settings.json 的 modelProviders.openai ----------

type qwenCode struct{}

func (qwenCode) ID() string         { return "qwen-code" }
func (qwenCode) Name() string       { return "Qwen Code" }
func (qwenCode) Category() Category { return CLI }

func (qwenCode) path(e Env) string {
	if d := os.Getenv("QWEN_HOME"); d != "" && e.Home == defaultHome() {
		return filepath.Join(d, "settings.json")
	}
	return e.P(".qwen", "settings.json")
}

func (x qwenCode) Detect(e Env) Detection {
	return detectAny(which(e, "qwen"), filepath.Dir(x.path(e)))
}

const qwenKeyEnv = "CROSERY_API_KEY"

func (x qwenCode) Status(e Env, base string) Status {
	s, _, _ := readJSONFile(x.path(e))
	if s == nil {
		return Status{}
	}
	list, _ := anyOr(s.Child("modelProviders"), "openai").([]any)
	for _, v := range list {
		if o, ok := v.(*Obj); ok && baseMatches(o.Str("baseUrl"), base) {
			return Status{Configured: true, Model: s.Child("model").Str("name")}
		}
	}
	return Status{Model: s.Child("model").Str("name")}
}

func (x qwenCode) Apply(e Env, p Plan, w *Writer) (Result, error) {
	path := x.path(e)
	s, had, err := readJSONFile(path)
	if err != nil {
		return Result{}, err
	}
	// Key 放在 settings.json 顶层 env 块（优先级最低，shell 同名变量会覆盖）。
	s.Child("env").Set(qwenKeyEnv, p.Key)
	var list []any
	existing, _ := anyOr(s.Child("modelProviders"), "openai").([]any)
	for _, v := range existing {
		if o, ok := v.(*Obj); ok && baseMatches(o.Str("baseUrl"), p.BaseURL) {
			continue
		}
		list = append(list, v)
	}
	for _, m := range agentModels(p) {
		list = append(list, O(
			"id", m.ID, "name", m.Name(), "envKey", qwenKeyEnv,
			"baseUrl", p.OpenAIBase(), "wireApi", "chat-completions",
			"capabilities", O("vision", m.Vision()),
			"generationConfig", O("contextWindowSize", ctxOr(m, 128000),
				"samplingParams", O("max_tokens", maxOutOr(m, 16384))),
		))
	}
	s.Child("modelProviders").Set("openai", list)
	prev := s.Child("model").Str("name")
	model := p.Choose(prev, api.PrefAgent)
	if !p.UpdateOnly || prev != model {
		s.Child("security").Child("auth").Set("selectedType", "openai")
		s.Child("model").Set("name", model)
	}
	var notes []string
	if had {
		notes = append(notes, "settings.json 里的注释会在重写后丢失（原文件已备份）")
	}
	if err := w.Write(path, MarshalJSON(s), 0o600); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model, Notes: notes}, nil
}

// ---------- OpenClaw：~/.openclaw/openclaw.json（JSON5）----------

type openclaw struct{}

func (openclaw) ID() string         { return "openclaw" }
func (openclaw) Name() string       { return "OpenClaw" }
func (openclaw) Category() Category { return CLI }

func (openclaw) path(e Env) string {
	if p := os.Getenv("OPENCLAW_CONFIG_PATH"); p != "" && e.Home == defaultHome() {
		return p
	}
	return e.P(".openclaw", "openclaw.json")
}

func (x openclaw) Detect(e Env) Detection {
	return detectAny(which(e, "openclaw"), filepath.Dir(x.path(e)))
}

func (x openclaw) Status(e Env, base string) Status {
	s, _, _ := readJSONFile(x.path(e))
	if s == nil {
		return Status{}
	}
	prov := s.Child("models").Child("providers").Child(ProviderID)
	model, _ := anyOr(s.Child("agents").Child("defaults"), "model").(string)
	if o, ok := anyOr(s.Child("agents").Child("defaults"), "model").(*Obj); ok {
		model = o.Str("primary")
	}
	return Status{Configured: baseMatches(prov.Str("baseUrl"), base), Model: model}
}

func (x openclaw) Apply(e Env, p Plan, w *Writer) (Result, error) {
	path := x.path(e)
	s, had, err := readJSONFile(path)
	if err != nil {
		return Result{}, err
	}
	var models []any
	for _, m := range agentModels(p) {
		models = append(models, O("id", m.ID, "name", m.Name(), "reasoning", m.SupportsReasoning,
			"input", inputs(m), "contextWindow", ctxOr(m, 128000), "maxTokens", maxOutOr(m, 16384)))
	}
	mm := s.Child("models")
	if !mm.Has("mode") {
		mm.Set("mode", "merge")
	}
	mm.Child("providers").Set(ProviderID, O(
		"baseUrl", p.OpenAIBase(), "apiKey", p.Key, "api", "openai-completions", "models", models))
	defaults := s.Child("agents").Child("defaults")
	prev := ""
	switch v := anyOr(defaults, "model").(type) {
	case string:
		prev = v
	case *Obj:
		prev = v.Str("primary")
	}
	prevID := strings.TrimPrefix(prev, ProviderID+"/")
	if !strings.HasPrefix(prev, ProviderID+"/") {
		prevID = ""
	}
	model := p.Choose(prevID, api.PrefAgent)
	if !p.UpdateOnly || prevID != model {
		if o, ok := anyOr(defaults, "model").(*Obj); ok {
			o.Set("primary", ProviderID+"/"+model)
		} else {
			defaults.Set("model", O("primary", ProviderID+"/"+model))
		}
	}
	notes := []string{"若 ~/.openclaw/agents/<id>/agent/models.json 里也有 crosery 渠道，它会覆盖这里的 Key"}
	if had {
		notes = append(notes, "openclaw.json 里的注释会在重写后丢失（原文件已备份）")
	}
	if err := w.Write(path, MarshalJSON(s), 0o600); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model, Notes: notes}, nil
}

// ---------- Crush：~/.config/crush/crush.json（Windows 同样在 %USERPROFILE%\.config）----------

type crush struct{}

func (crush) ID() string         { return "crush" }
func (crush) Name() string       { return "Crush" }
func (crush) Category() Category { return CLI }

func (crush) path(e Env) string {
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" && e.Home == defaultHome() {
		return filepath.Join(d, "crush", "crush.json")
	}
	return e.P(".config", "crush", "crush.json")
}

func (x crush) Detect(e Env) Detection {
	return detectAny(which(e, "crush"), filepath.Dir(x.path(e)))
}

func (x crush) Status(e Env, base string) Status {
	s, _, _ := readJSONFile(x.path(e))
	if s == nil {
		return Status{}
	}
	return Status{
		Configured: baseMatches(s.Child("providers").Child(ProviderID).Str("base_url"), base),
		Model:      s.Child("models").Child("large").Str("model"),
	}
}

func (x crush) Apply(e Env, p Plan, w *Writer) (Result, error) {
	path := x.path(e)
	s, _, err := readJSONFile(path)
	if err != nil {
		return Result{}, err
	}
	if !s.Has("$schema") {
		s2 := O("$schema", "https://charm.land/crush.json")
		for _, k := range s.Keys() {
			v, _ := s.Get(k)
			s2.Set(k, v)
		}
		s = s2
	}
	var models []any
	for _, m := range agentModels(p) {
		var cin, cout, cr, cw float64
		if m.Cost != nil {
			cin, cout, cr, cw = m.Cost.Input, m.Cost.Output, m.Cost.CacheRead, m.Cost.CacheWrite
		}
		models = append(models, O("id", m.ID, "name", m.Name(),
			"context_window", ctxOr(m, 128000), "default_max_tokens", maxOutOr(m, 16384),
			"can_reason", m.SupportsReasoning, "supports_attachments", m.Vision(),
			"cost_per_1m_in", cin, "cost_per_1m_out", cout,
			"cost_per_1m_in_cached", cr, "cost_per_1m_out_cached", cw))
	}
	s.Child("providers").Set(ProviderID, O(
		"name", ProviderName, "type", "openai-compat", "base_url", p.OpenAIBase(), "api_key", p.Key, "models", models))
	large := s.Child("models").Child("large")
	prev := ""
	if large.Str("provider") == ProviderID {
		prev = large.Str("model")
	}
	model := p.Choose(prev, api.PrefAgent)
	if !p.UpdateOnly || prev != model {
		large.Set("provider", ProviderID)
		large.Set("model", model)
		if small := api.Pick(p.Models, api.PrefFast, nil); small != "" {
			sm := s.Child("models").Child("small")
			sm.Set("provider", ProviderID)
			sm.Set("model", small)
		}
	}
	if err := w.Write(path, MarshalJSON(s), 0o600); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model,
		Notes: []string{"Crush 会优先使用你在应用里手动切换过的模型"}}, nil
}

// ---------- Kilo CLI：OpenCode 分支，~/.config/kilo/kilo.json(c) ----------

type kilo struct{}

func (kilo) ID() string         { return "kilo" }
func (kilo) Name() string       { return "Kilo Code CLI" }
func (kilo) Category() Category { return CLI }

func (kilo) path(e Env) string {
	dir := e.P(".config", "kilo")
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" && e.Home == defaultHome() && e.GOOS != "windows" {
		dir = filepath.Join(d, "kilo")
	}
	for _, n := range []string{"kilo.jsonc", "kilo.json", "opencode.json"} {
		if fileExists(filepath.Join(dir, n)) {
			return filepath.Join(dir, n)
		}
	}
	return filepath.Join(dir, "kilo.json")
}

func (x kilo) Detect(e Env) Detection {
	return detectAny(which(e, "kilo", "kilocode"), filepath.Dir(x.path(e)))
}

func (x kilo) Status(e Env, base string) Status { return opencodeStatus(x.path(e), base) }

func (x kilo) Apply(e Env, p Plan, w *Writer) (Result, error) {
	return opencodeApply(x.path(e), p, w, "https://app.kilo.ai/config.json")
}

// ---------- Kimi Code CLI：~/.kimi-code/config.toml ----------

type kimi struct{}

func (kimi) ID() string         { return "kimi" }
func (kimi) Name() string       { return "Kimi Code CLI" }
func (kimi) Category() Category { return CLI }

func (kimi) path(e Env) string {
	if d := os.Getenv("KIMI_CODE_HOME"); d != "" && e.Home == defaultHome() {
		return filepath.Join(d, "config.toml")
	}
	return e.P(".kimi-code", "config.toml")
}

func (x kimi) Detect(e Env) Detection {
	return detectAny(which(e, "kimi"), filepath.Dir(x.path(e)))
}

// kimiModelKey 是 [models.<key>] 的表名：crosery/<id>，带点号或斜杠时加引号。
func kimiModelKey(id string) string { return TOMLString(ProviderID + "/" + id) }

func (x kimi) Status(e Env, base string) Status {
	data, _ := os.ReadFile(x.path(e))
	d := ParseTOML(data)
	url, _ := d.TableValue("providers."+ProviderID, "base_url")
	def, _ := d.GetTop("default_model")
	return Status{Configured: baseMatches(UnquoteTOML(url), base), Model: UnquoteTOML(def)}
}

func (x kimi) Apply(e Env, p Plan, w *Writer) (Result, error) {
	path := x.path(e)
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return Result{}, err
	}
	d := ParseTOML(data)
	d.ReplaceTable("providers."+ProviderID, []string{
		`type = "openai"`,
		"base_url = " + TOMLString(p.OpenAIBase()),
		"api_key = " + TOMLString(p.Key),
	})
	// 先删掉旧的 crosery 模型表，再按当前目录重建。
	d.RemoveTablesWithPrefix(`models."` + ProviderID + "/")
	for _, m := range agentModels(p) {
		d.ReplaceTable("models."+kimiModelKey(m.ID), []string{
			"provider = " + TOMLString(ProviderID),
			"model = " + TOMLString(m.ID),
			"max_context_size = " + itoa(ctxOr(m, 128000)),
			// 不写时 kimi 会按上下文推一个过大的 max_tokens，网关按模型真实上限拒绝（400）。
			"max_output_size = " + itoa(maxOutOr(m, 16384)),
		})
	}
	prevRaw, _ := d.GetTop("default_model")
	prev := strings.TrimPrefix(UnquoteTOML(prevRaw), ProviderID+"/")
	if !strings.HasPrefix(UnquoteTOML(prevRaw), ProviderID+"/") {
		prev = ""
	}
	model := p.Choose(prev, api.PrefAgent)
	if !p.UpdateOnly || prev != model {
		d.SetTop("default_model", TOMLString(ProviderID+"/"+model))
	}
	if err := w.Write(path, d.Bytes(), 0o600); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model, Notes: []string{"可用 kimi doctor config 校验配置"}}, nil
}

// ---------- GitHub Copilot CLI：~/.copilot/providers.json + settings.json ----------

type copilot struct{}

func (copilot) ID() string         { return "copilot" }
func (copilot) Name() string       { return "GitHub Copilot CLI" }
func (copilot) Category() Category { return CLI }

func (copilot) dir(e Env) string {
	if d := os.Getenv("COPILOT_HOME"); d != "" && e.Home == defaultHome() {
		return d
	}
	return e.P(".copilot")
}

func (x copilot) Detect(e Env) Detection {
	if b := which(e, "copilot"); b != "" {
		return Detection{Installed: true, Where: b}
	}
	return Detection{}
}

func (x copilot) Status(e Env, base string) Status {
	pf, _, _ := readJSONFile(filepath.Join(x.dir(e), "providers.json"))
	sf, _, _ := readJSONFile(filepath.Join(x.dir(e), "settings.json"))
	st := Status{}
	if pf != nil {
		list, _ := anyOr(pf, "providers").([]any)
		for _, v := range list {
			if o, ok := v.(*Obj); ok && o.Str("name") == ProviderID && baseMatches(o.Str("baseUrl"), base) {
				st.Configured = true
			}
		}
	}
	if sf != nil {
		st.Model = sf.Str("model")
	}
	return st
}

func (x copilot) Apply(e Env, p Plan, w *Writer) (Result, error) {
	pPath := filepath.Join(x.dir(e), "providers.json")
	sPath := filepath.Join(x.dir(e), "settings.json")
	pf, _, err := readJSONFile(pPath)
	if err != nil {
		return Result{}, err
	}
	var provs, models []any
	existing, _ := anyOr(pf, "providers").([]any)
	for _, v := range existing {
		if o, ok := v.(*Obj); ok && o.Str("name") == ProviderID {
			continue
		}
		provs = append(provs, v)
	}
	provs = append(provs, O("name", ProviderID, "type", "openai", "baseUrl", p.OpenAIBase(),
		"apiKey", p.Key, "wireApi", "completions"))
	oldModels, _ := anyOr(pf, "models").([]any)
	for _, v := range oldModels {
		if o, ok := v.(*Obj); ok && o.Str("provider") == ProviderID {
			continue
		}
		models = append(models, v)
	}
	for _, m := range agentModels(p) {
		models = append(models, O("provider", ProviderID, "id", m.ID))
	}
	pf.Set("providers", provs)
	pf.Set("models", models)
	sf, _, err := readJSONFile(sPath)
	if err != nil {
		return Result{}, err
	}
	prev := ""
	if cur := sf.Str("model"); strings.HasPrefix(cur, ProviderID+"/") {
		prev = strings.TrimPrefix(cur, ProviderID+"/")
	}
	model := p.Choose(prev, api.PrefAgent)
	if !p.UpdateOnly || prev != model {
		sf.Set("model", ProviderID+"/"+model)
	}
	if err := w.Write(pPath, MarshalJSON(pf), 0o600); err != nil {
		return Result{}, err
	}
	if err := w.Write(sPath, MarshalJSON(sf), 0o644); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model}, nil
}

// ---------- Factory Droid：~/.factory/settings.json 的 customModels ----------

type droid struct{}

func (droid) ID() string         { return "droid" }
func (droid) Name() string       { return "Factory Droid" }
func (droid) Category() Category { return CLI }

func (droid) path(e Env) string { return e.P(".factory", "settings.json") }

func (x droid) Detect(e Env) Detection {
	return detectAny(which(e, "droid"), filepath.Dir(x.path(e)))
}

func (x droid) Status(e Env, base string) Status {
	s, _, _ := readJSONFile(x.path(e))
	if s == nil {
		return Status{}
	}
	list, _ := anyOr(s, "customModels").([]any)
	for _, v := range list {
		if o, ok := v.(*Obj); ok && baseMatches(o.Str("baseUrl"), base) {
			return Status{Configured: true, Model: s.Child("sessionDefaultSettings").Str("model")}
		}
	}
	return Status{}
}

var droidSpace = regexp.MustCompile(`\s+`)

func (x droid) Apply(e Env, p Plan, w *Writer) (Result, error) {
	path := x.path(e)
	s, had, err := readJSONFile(path)
	if err != nil {
		return Result{}, err
	}
	var list []any
	existing, _ := anyOr(s, "customModels").([]any)
	for _, v := range existing {
		if o, ok := v.(*Obj); ok && baseMatches(o.Str("baseUrl"), p.BaseURL) {
			continue
		}
		list = append(list, v)
	}
	// Droid 为自定义模型生成的 id 形如 custom:<displayName 空格换成 ->-<序号>，序号是它在数组里的位置。
	idOf := map[string]string{}
	for _, m := range agentModels(p) {
		display := "Crosery " + m.ID
		idOf[m.ID] = "custom:" + droidSpace.ReplaceAllString(display, "-") + "-" + itoa(len(list))
		provider, baseURL := "generic-chat-completion-api", p.OpenAIBase()
		if m.Vendor() == "anthropic" {
			provider, baseURL = "anthropic", strings.TrimRight(p.BaseURL, "/")
		}
		list = append(list, O("model", m.ID, "displayName", display, "baseUrl", baseURL,
			"apiKey", p.Key, "provider", provider, "maxOutputTokens", maxOutOr(m, 16384)))
	}
	s.Set("customModels", list)
	model := p.Choose("", api.PrefAgent)
	sd := s.Child("sessionDefaultSettings")
	if !p.UpdateOnly || !strings.HasPrefix(sd.Str("model"), "custom:Crosery") {
		sd.Set("model", idOf[model])
	}
	notes := []string{"Droid 仍需要登录 Factory 账号（或设置 FACTORY_API_KEY）才能启动；登录后在 /model 里选择 Crosery 开头的模型"}
	if had {
		notes = append(notes, "settings.json 里的注释会在重写后丢失（原文件已备份）")
	}
	if err := w.Write(path, MarshalJSON(s), 0o600); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model, Notes: notes}, nil
}

// ---------- Aider：~/.aider.conf.yml + ~/.aider.model.metadata.json ----------

type aider struct{}

func (aider) ID() string         { return "aider" }
func (aider) Name() string       { return "Aider" }
func (aider) Category() Category { return CLI }

func (x aider) Detect(e Env) Detection {
	if b := which(e, "aider"); b != "" {
		return Detection{Installed: true, Where: b}
	}
	return Detection{}
}

func (x aider) Status(e Env, base string) Status {
	data, err := os.ReadFile(e.P(".aider.conf.yml"))
	if err != nil {
		return Status{}
	}
	_, root, err := LoadYAML(data)
	if err != nil {
		return Status{}
	}
	return Status{Configured: baseMatches(YScalar(root, "openai-api-base"), base),
		Model: strings.TrimPrefix(YScalar(root, "model"), "openai/")}
}

func (x aider) Apply(e Env, p Plan, w *Writer) (Result, error) {
	cfgPath := e.P(".aider.conf.yml")
	data, _ := os.ReadFile(cfgPath)
	doc, root, err := LoadYAML(data)
	if err != nil {
		return Result{}, err
	}
	prev := ""
	if baseMatches(YScalar(root, "openai-api-base"), p.BaseURL) {
		prev = strings.TrimPrefix(YScalar(root, "model"), "openai/")
	}
	model := p.Choose(prev, api.PrefAgent)
	YSet(root, "openai-api-base", YStr(p.OpenAIBase()))
	YSet(root, "openai-api-key", YStr(p.Key))
	if !p.UpdateOnly || prev != model {
		YSet(root, "model", YStr("openai/"+model))
		if weak := api.Pick(p.Models, api.PrefFast, nil); weak != "" {
			YSet(root, "weak-model", YStr("openai/"+weak))
		}
	}
	out, err := DumpYAML(doc)
	if err != nil {
		return Result{}, err
	}
	if err := w.Write(cfgPath, out, 0o600); err != nil {
		return Result{}, err
	}
	metaPath := e.P(".aider.model.metadata.json")
	meta, _, err := readJSONFile(metaPath)
	if err != nil {
		return Result{}, err
	}
	for _, m := range agentModels(p) {
		meta.Set("openai/"+m.ID, O("max_input_tokens", ctxOr(m, 128000), "max_output_tokens", maxOutOr(m, 16384),
			"max_tokens", maxOutOr(m, 16384), "litellm_provider", "openai", "mode", "chat", "supports_vision", m.Vision()))
	}
	if err := w.Write(metaPath, MarshalJSON(meta), 0o644); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model}, nil
}

// ---------- Continue：~/.continue/config.yaml ----------

type continueDev struct{}

func (continueDev) ID() string         { return "continue" }
func (continueDev) Name() string       { return "Continue" }
func (continueDev) Category() Category { return IDE }

func (continueDev) path(e Env) string { return e.P(".continue", "config.yaml") }

func (x continueDev) Detect(e Env) Detection {
	return detectAny(which(e, "cn"), filepath.Dir(x.path(e)))
}

func (x continueDev) Status(e Env, base string) Status {
	data, err := os.ReadFile(x.path(e))
	if err != nil {
		return Status{}
	}
	_, root, err := LoadYAML(data)
	if err != nil {
		return Status{}
	}
	if seq := YGet(root, "models"); seq != nil {
		for _, n := range seq.Content {
			if baseMatches(YScalar(n, "apiBase"), base) {
				return Status{Configured: true, Model: YScalar(n, "model")}
			}
		}
	}
	return Status{}
}

func (x continueDev) Apply(e Env, p Plan, w *Writer) (Result, error) {
	path := x.path(e)
	data, _ := os.ReadFile(path)
	doc, root, err := LoadYAML(data)
	if err != nil {
		return Result{}, err
	}
	for k, v := range map[string]string{"name": "Crosery", "version": "1.0.0", "schema": "v1"} {
		if YScalar(root, k) == "" {
			YSet(root, k, YStr(v))
		}
	}
	model := p.Choose("", api.PrefAgent)
	seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	// 默认模型放第一个：Continue 没有默认模型字段，按顺序取第一个。
	ordered := agentModels(p)
	for i, m := range ordered {
		if m.ID == model && i > 0 {
			ordered = append([]api.Model{m}, append(ordered[:i:i], ordered[i+1:]...)...)
			break
		}
	}
	for _, m := range ordered {
		capsList := []string{"tool_use"}
		if m.Vision() {
			capsList = append(capsList, "image_input")
		}
		seq.Content = append(seq.Content, YMapOf(
			"name", YStr("Crosery · "+m.Name()),
			"provider", YStr("openai"),
			"model", YStr(m.ID),
			"apiBase", YStr(p.OpenAIBase()),
			"apiKey", YStr(p.Key),
			"roles", YFlowList([]string{"chat", "edit", "apply"}),
			"capabilities", YFlowList(capsList),
			"defaultCompletionOptions", YMapOf("contextLength", YInt(ctxOr(m, 128000)), "maxTokens", YInt(maxOutOr(m, 16384))),
		))
	}
	// 保留用户自己的其他模型。
	if old := YGet(root, "models"); old != nil {
		for _, n := range old.Content {
			if !baseMatches(YScalar(n, "apiBase"), p.BaseURL) {
				seq.Content = append(seq.Content, n)
			}
		}
	}
	YSet(root, "models", seq)
	out, err := DumpYAML(doc)
	if err != nil {
		return Result{}, err
	}
	if err := w.Write(path, out, 0o600); err != nil {
		return Result{}, err
	}
	return Result{Files: w.Written(), Model: model}, nil
}

func itoa(n int) string { return strconv.Itoa(n) }
