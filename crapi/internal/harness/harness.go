// Package harness 为每个 agent harness 提供「探测 / 查看状态 / 写入配置」三件事。
// 新增 harness：在本目录加一个文件实现 Harness，并在 registry 里登记。
package harness

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/crosery/crapi/internal/api"
)

// ProviderID 是写进各 harness 配置里的渠道标识。
const ProviderID = "crosery"

// ProviderName 是展示名。
const ProviderName = "Crosery"

// Category 标记 harness 的形态。
type Category string

const (
	CLI     Category = "CLI"
	IDE     Category = "IDE"
	Desktop Category = "桌面"
)

// Detection 是探测结果。
type Detection struct {
	Installed bool
	Where     string
}

// Status 描述 harness 当前是否已指向 Crosery。
type Status struct {
	Configured bool
	Model      string
	Detail     string
}

// Plan 是一次写配置的输入。
type Plan struct {
	BaseURL    string      // 网关根地址，不带 /v1
	Key        string      // API Key
	Models     []api.Model // 当前 Key 可用的对话模型
	Model      string      // 用户指定的默认模型；空表示自动选择（update 时保留原选择）
	WebSearch  bool        // Claude Code：配置网络搜索依赖的 Haiku 模型
	UpdateOnly bool        // update：只刷新模型目录，尽量保留用户原先的默认模型
}

// OpenAIBase 返回 OpenAI 兼容基址（带 /v1）。
func (p Plan) OpenAIBase() string { return strings.TrimRight(p.BaseURL, "/") + "/v1" }

// Has 报告某模型是否在当前 Key 的可用列表里。
func (p Plan) Has(id string) bool {
	_, ok := api.Find(p.Models, id)
	return ok
}

// Choose 选出默认模型：显式指定 > (update 时) 仍可用的旧值 > 偏好列表。
func (p Plan) Choose(previous string, prefs ...[]string) string {
	if p.Model != "" {
		return p.Model
	}
	if previous != "" && p.Has(previous) {
		return previous
	}
	var all []string
	for _, pr := range prefs {
		all = append(all, pr...)
	}
	return api.Pick(p.Models, all, nil)
}

// Result 是写配置的结果。
type Result struct {
	Files  []string
	Model  string
	Notes  []string
	Manual bool // 只能手动配置（给出指引），没有写文件
}

// Harness 是一个 agent 工具的适配器。
type Harness interface {
	ID() string
	Name() string
	Category() Category
	Detect(e Env) Detection
	Status(e Env, base string) Status
	Apply(e Env, p Plan, w *Writer) (Result, error)
}

// All 按展示顺序返回全部适配器。
func All() []Harness {
	return []Harness{
		claudeCode{},
		codex{},
		pi{},
		omp{},
		opencode{},
		kilo{},
		hermes{},
		geminiCLI{},
		qwenCode{},
		kimi{},
		copilot{},
		droid{},
		openclaw{},
		crush{},
		aider{},
		codebuddy{},
		workbuddy{variant: "WorkBuddy", dir: ".workbuddy"},
		workbuddy{variant: "WorkBuddy AI", dir: ".workbuddy-ai"},
		qoder{variant: "Qoder CLI", dir: ".qoder"},
		qoder{variant: "Qoder CN", dir: ".qoder-cn"},
		cursor{},
		zed{},
		continueDev{},
		cherry{},
	}
}

// Get 按 id 或别名查找适配器。
func Get(id string) (Harness, bool) {
	id = strings.ToLower(strings.TrimSpace(id))
	if a, ok := aliases[id]; ok {
		id = a
	}
	for _, h := range All() {
		if h.ID() == id {
			return h, true
		}
	}
	return nil, false
}

var aliases = map[string]string{
	"claude": "claude-code", "claudecode": "claude-code", "cc": "claude-code",
	"codex-cli": "codex", "oh-my-pi": "omp", "pi-agent": "pi",
	"gemini": "gemini-cli", "qwen": "qwen-code", "factory": "droid",
	"kilocode": "kilo", "kilo-code": "kilo", "code-buddy": "codebuddy",
	"qodercli": "qoder", "qoder-cli": "qoder", "cherrystudio": "cherry-studio", "cherry": "cherry-studio",
	"hermes-agent": "hermes", "work-buddy": "workbuddy", "kimi-code": "kimi", "kimi-cli": "kimi",
	"copilot-cli": "copilot", "github-copilot": "copilot", "continue-dev": "continue", "aider-chat": "aider",
}

// ---------- 探测工具 ----------

// which 在 PATH 与常见安装目录里查找可执行文件。
func which(e Env, names ...string) string {
	for _, n := range names {
		if p, err := exec.LookPath(n); err == nil {
			return p
		}
	}
	extra := []string{
		e.P(".local", "bin"), e.P(".bun", "bin"), e.P(".npm-global", "bin"), e.P("bin"),
		e.P(".cargo", "bin"), e.P("go", "bin"), "/opt/homebrew/bin", "/usr/local/bin",
	}
	if e.GOOS == "windows" {
		extra = append(extra,
			filepath.Join(e.AppData(), "npm"),
			filepath.Join(e.LocalAppData(), "Programs"),
			filepath.Join(e.LocalAppData(), "Microsoft", "WinGet", "Links"),
			e.P("scoop", "shims"),
		)
	}
	for _, n := range names {
		for _, dir := range extra {
			for _, cand := range exeNames(e, n) {
				if fileExists(filepath.Join(dir, cand)) {
					return filepath.Join(dir, cand)
				}
			}
		}
	}
	return ""
}

func exeNames(e Env, n string) []string {
	if e.GOOS == "windows" {
		return []string{n + ".exe", n + ".cmd", n + ".bat", n + ".ps1"}
	}
	return []string{n}
}

// appInstalled 查找桌面应用：macOS 的 .app，Windows 的 LocalAppData\Programs 目录。
func appInstalled(e Env, macApps []string, winDirs []string, linuxBins []string) string {
	switch e.GOOS {
	case "darwin":
		for _, a := range macApps {
			for _, root := range []string{"/Applications", e.P("Applications")} {
				p := filepath.Join(root, a+".app")
				if dirExists(p) {
					return p
				}
			}
		}
	case "windows":
		for _, d := range winDirs {
			for _, root := range []string{filepath.Join(e.LocalAppData(), "Programs"), os.Getenv("ProgramFiles"), e.LocalAppData()} {
				if root == "" {
					continue
				}
				p := filepath.Join(root, d)
				if dirExists(p) {
					return p
				}
			}
		}
	default:
		if p := which(e, linuxBins...); p != "" {
			return p
		}
	}
	return ""
}

// detectAny 组合：可执行文件、应用或配置目录任一存在即视为已安装。
func detectAny(bin string, dirs ...string) Detection {
	if bin != "" {
		return Detection{Installed: true, Where: bin}
	}
	for _, d := range dirs {
		if d != "" && dirExists(d) {
			return Detection{Installed: true, Where: d}
		}
	}
	return Detection{}
}

// baseMatches 判断配置里的地址是否指向我们的网关。
func baseMatches(url, base string) bool {
	u := strings.TrimRight(strings.ToLower(strings.TrimSpace(url)), "/")
	b := strings.TrimRight(strings.ToLower(base), "/")
	return u != "" && (u == b || strings.HasPrefix(u, b+"/"))
}

// ---------- 模型目录映射 ----------

func ctxOr(m api.Model, def int) int {
	if m.ContextLength > 0 {
		return m.ContextLength
	}
	return def
}

func maxOutOr(m api.Model, def int) int {
	if m.MaxCompletionTokens > 0 {
		return m.MaxCompletionTokens
	}
	return def
}

func inputs(m api.Model) []string {
	if m.Vision() {
		return []string{"text", "image"}
	}
	return []string{"text"}
}

func toolCapable(m api.Model) bool { return m.SupportsToolCall == nil || *m.SupportsToolCall }

// efforts 返回规范顺序的推理档位。
func efforts(m api.Model) []string {
	order := []string{"minimal", "low", "medium", "high", "xhigh", "max"}
	var out []string
	for _, o := range order {
		if slices.Contains(m.Efforts(), o) {
			out = append(out, o)
		}
	}
	return out
}

// agentModels 返回适合写进 harness 的模型：只要对话模型，工具调用能力未知的也保留。
func agentModels(p Plan) []api.Model {
	var out []api.Model
	for _, m := range p.Models {
		if toolCapable(m) {
			out = append(out, m)
		}
	}
	return out
}
