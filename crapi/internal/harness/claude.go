package harness

import (
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/crosery/crapi/internal/api"
)

// claudeCode：~/.claude/settings.json 的 env 段。
// Claude Code 的 WebSearch、标题生成等后台任务走「Haiku 档」模型，
// 网关上必须把这一档映射到一个真实可用的 Claude Haiku，否则网络搜索会失败。
type claudeCode struct{}

func (claudeCode) ID() string         { return "claude-code" }
func (claudeCode) Name() string       { return "Claude Code" }
func (claudeCode) Category() Category { return CLI }

func (claudeCode) dir(e Env) string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" && e.Home == defaultHome() {
		return d
	}
	return e.P(".claude")
}

// stateFile 是 Claude Code 的全局状态文件（记录是否完成首次引导）。
func (c claudeCode) stateFile(e Env) string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" && e.Home == defaultHome() {
		return filepath.Join(d, ".claude.json")
	}
	return e.P(".claude.json")
}

func (c claudeCode) Detect(e Env) Detection {
	return detectAny(which(e, "claude"), e.P(".claude", "local"))
}

func (c claudeCode) Status(e Env, base string) Status {
	s, _, err := readJSONFile(filepath.Join(c.dir(e), "settings.json"))
	if err != nil {
		return Status{Detail: err.Error()}
	}
	env := s.Child("env")
	return Status{
		Configured: baseMatches(env.Str("ANTHROPIC_BASE_URL"), base),
		Model:      s.Str("model"),
	}
}

func (c claudeCode) Apply(e Env, p Plan, w *Writer) (Result, error) {
	path := filepath.Join(c.dir(e), "settings.json")
	s, had, err := readJSONFile(path)
	if err != nil {
		return Result{}, err
	}
	var res Result
	if had {
		res.Notes = append(res.Notes, "settings.json 里的注释会在重写后丢失（原文件已备份）")
	}
	env := s.Child("env")
	env.Set("ANTHROPIC_BASE_URL", strings.TrimRight(p.BaseURL, "/"))
	env.Set("ANTHROPIC_AUTH_TOKEN", p.Key)
	// 同时存在 API_KEY 时 Claude Code 会优先弹「是否使用该 Key」并可能走错凭据。
	env.Delete("ANTHROPIC_API_KEY")

	opus := keepOr(p, env.Str("ANTHROPIC_DEFAULT_OPUS_MODEL"), api.PrefOpus, "opus")
	sonnet := keepOr(p, env.Str("ANTHROPIC_DEFAULT_SONNET_MODEL"), api.PrefSonnet, "sonnet")
	haiku := keepOr(p, env.Str("ANTHROPIC_DEFAULT_HAIKU_MODEL"), api.PrefHaiku, "haiku")
	if haiku == "" {
		// Haiku 档对所有 Key 开放，/v1/models 没列出（列表会抖动）也照常映射。
		haiku = api.OpenHaiku
	}
	setIf(env, "ANTHROPIC_DEFAULT_OPUS_MODEL", opus)
	setIf(env, "ANTHROPIC_DEFAULT_SONNET_MODEL", sonnet)
	if p.WebSearch || env.Has("ANTHROPIC_DEFAULT_HAIKU_MODEL") {
		env.Set("ANTHROPIC_DEFAULT_HAIKU_MODEL", haiku)
		env.Set("ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", haiku)
		// 旧版本（< 1.0.x）读取的是这个变量。
		env.Set("ANTHROPIC_SMALL_FAST_MODEL", haiku)
	}

	model := s.Str("model")
	switch {
	case p.Model != "":
		model = p.Model
	case model == "" || !p.UpdateOnly:
		if opus != "" {
			model = "opus"
			if m, ok := api.Find(p.Models, opus); ok && m.ContextLength >= 1_000_000 {
				model = "opus[1m]"
			}
		} else if sonnet != "" {
			model = "sonnet"
		} else if len(p.Models) > 0 {
			model = api.Pick(p.Models, api.PrefAgent, nil)
		}
	}
	if model != "" {
		s.Set("model", model)
	}

	if p.WebSearch {
		perms := s.Child("permissions")
		allow := Strs(anyOr(perms, "allow"))
		if !slices.Contains(allow, "WebSearch") {
			arr, _ := anyOr(perms, "allow").([]any)
			perms.Set("allow", append(arr, "WebSearch"))
		}
		if slices.Contains(Strs(anyOr(perms, "deny")), "WebSearch") {
			res.Notes = append(res.Notes, "permissions.deny 里禁用了 WebSearch，网络搜索仍不可用（未改动）")
		}
	}

	if err := w.Write(path, MarshalJSON(s), 0o600); err != nil {
		return res, err
	}

	// 跳过首次启动的登录引导：已经用 Token 认证，不需要 Claude 账号登录。
	state, _, err := readJSONFile(c.stateFile(e))
	if v, _ := stateGet(state, err); v != true {
		state.Set("hasCompletedOnboarding", true)
		if err := w.Write(c.stateFile(e), MarshalJSON(state), 0o600); err != nil {
			return res, err
		}
	}
	if os.Getenv("ANTHROPIC_API_KEY") != "" || os.Getenv("ANTHROPIC_BASE_URL") != "" {
		res.Notes = append(res.Notes, "检测到当前 shell 设置了 ANTHROPIC_* 环境变量，它们会覆盖 settings.json，请移除")
	}
	res.Files = w.Written()
	res.Model = model
	return res, nil
}

// keepOr：档位映射在更新时保留仍然可用的旧值，否则按偏好列表、再按关键字兜底。
func keepOr(p Plan, previous string, prefs []string, keyword string) string {
	if previous != "" && p.Has(previous) {
		return previous
	}
	for _, pr := range prefs {
		if p.Has(pr) {
			return pr
		}
	}
	for _, m := range p.Models {
		if keyword != "" && strings.Contains(m.ID, keyword) {
			return m.ID
		}
	}
	return ""
}

func stateGet(state *Obj, err error) (any, bool) {
	if err != nil || state == nil {
		return true, false // 读不了就不碰它
	}
	return state.Get("hasCompletedOnboarding")
}

func setIf(o *Obj, k, v string) {
	if v != "" {
		o.Set(k, v)
	}
}

func anyOr(o *Obj, k string) any {
	v, _ := o.Get(k)
	return v
}
