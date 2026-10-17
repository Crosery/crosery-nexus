package api

import (
	"context"
	"slices"
	"sort"
	"strings"
	"time"
)

// Model 是网关 /v1/models 的一条记录（只保留 crapi 用得到的字段）。
// 列表本身已按 Key 的权限过滤：Key 看不到的模型不会出现。
type Model struct {
	ID                  string    `json:"id"`
	DisplayName         string    `json:"display_name"`
	OwnedBy             string    `json:"owned_by"`
	Family              string    `json:"family"`
	Description         string    `json:"description"`
	ContextLength       int       `json:"context_length"`
	MaxCompletionTokens int       `json:"max_completion_tokens"`
	InputModalities     []string  `json:"supportedInputModalities"`
	OutputModalities    []string  `json:"supportedOutputModalities"`
	SupportsReasoning   bool      `json:"supports_reasoning"`
	SupportsToolCall    *bool     `json:"supports_tool_call"`
	SupportsWebSearch   bool      `json:"supports_web_search"`
	Thinking            *Thinking `json:"thinking"`
	Cost                *Cost     `json:"cost"`
	ReleaseDate         string    `json:"release_date"`
}

// Thinking 描述推理档位。
type Thinking struct {
	Levels []string `json:"levels"`
	Min    int      `json:"min"`
	Max    int      `json:"max"`
}

// Cost 为每百万 token 的美元单价。
type Cost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cache_read"`
	CacheWrite float64 `json:"cache_write"`
}

// Kind 是模型的用途分类。
type Kind string

const (
	KindChat  Kind = "chat"
	KindImage Kind = "image"
	KindAudio Kind = "audio"
)

// Kind 根据输出模态判断模型用途；没有声明模态的按对话模型处理。
func (m Model) Kind() Kind {
	out := m.OutputModalities
	if slices.Contains(out, "image") || strings.Contains(m.ID, "-image") || strings.HasPrefix(m.ID, "gpt-image") ||
		strings.Contains(m.ID, "imagine-image") {
		return KindImage
	}
	if len(out) > 0 && !slices.Contains(out, "text") && slices.Contains(out, "audio") {
		return KindAudio
	}
	if strings.Contains(m.ID, "lyria") {
		return KindAudio
	}
	return KindChat
}

// Name 返回展示名，缺省用 id。
func (m Model) Name() string {
	if strings.TrimSpace(m.DisplayName) != "" {
		return m.DisplayName
	}
	return m.ID
}

// Vision 报告是否接受图片输入。
func (m Model) Vision() bool { return slices.Contains(m.InputModalities, "image") }

// Efforts 返回推理档位（low/medium/high/xhigh/max 的子集）。
func (m Model) Efforts() []string {
	if m.Thinking == nil {
		return nil
	}
	return m.Thinking.Levels
}

// Free 报告是否是免费通道模型。
func (m Model) Free() bool {
	return strings.HasSuffix(m.ID, ":free") || strings.HasSuffix(m.ID, "-free") || m.ID == "openrouter/free"
}

// Vendor 推断模型本身的厂商（不是渠道），用于选择协议与分组。
func (m Model) Vendor() string {
	id := strings.ToLower(m.ID)
	switch {
	case strings.HasPrefix(id, "claude"):
		return "anthropic"
	case strings.HasPrefix(id, "gpt") || strings.HasPrefix(id, "o3") || strings.HasPrefix(id, "o4") || strings.HasPrefix(id, "codex"):
		return "openai"
	case strings.HasPrefix(id, "gemini") || strings.HasPrefix(id, "gemma") || strings.HasPrefix(id, "google/"):
		return "google"
	case strings.Contains(id, "deepseek"):
		return "deepseek"
	case strings.Contains(id, "glm"):
		return "zhipu"
	case strings.Contains(id, "qwen"):
		return "qwen"
	case strings.Contains(id, "kimi"):
		return "moonshot"
	case strings.Contains(id, "grok"):
		return "xai"
	}
	return "other"
}

// ListModels 拉取当前 Key 可用的全部模型，按 id 排序。
func (c *Client) ListModels(ctx context.Context) ([]Model, error) {
	var resp struct {
		Data []Model `json:"data"`
	}
	if err := c.getJSON(ctx, c.BaseURL+"/v1/models", 30*time.Second, &resp); err != nil {
		return nil, err
	}
	sort.Slice(resp.Data, func(i, j int) bool { return resp.Data[i].ID < resp.Data[j].ID })
	return resp.Data, nil
}

// ChatModels 过滤出可用于 agent 对话的模型。
func ChatModels(all []Model) []Model {
	var out []Model
	for _, m := range all {
		if m.Kind() == KindChat {
			out = append(out, m)
		}
	}
	return out
}

// ImageModels 过滤出生图模型。
func ImageModels(all []Model) []Model {
	var out []Model
	for _, m := range all {
		if m.Kind() == KindImage {
			out = append(out, m)
		}
	}
	return out
}

// Find 按 id 查找模型。
func Find(all []Model, id string) (Model, bool) {
	for _, m := range all {
		if m.ID == id {
			return m, true
		}
	}
	return Model{}, false
}

// Pick 在 all 里按偏好顺序取第一个存在的 id；都不存在时用 fallback 过滤器兜底。
func Pick(all []Model, prefs []string, fallback func(Model) bool) string {
	for _, p := range prefs {
		if _, ok := Find(all, p); ok {
			return p
		}
	}
	if fallback != nil {
		for _, m := range all {
			if fallback(m) {
				return m.ID
			}
		}
	}
	if len(all) > 0 {
		return all[0].ID
	}
	return ""
}

// 默认模型偏好：挑选网关上当前最强、最稳定的型号；Key 看不到时顺延。
var (
	PrefOpus   = []string{"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-fable-5", "claude-opus-4-6-thinking"}
	PrefSonnet = []string{"claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"}
	PrefHaiku  = []string{"claude-haiku-4-5-20251001", "claude-haiku-4-5"}
	PrefGPT    = []string{"gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-6-luna", "gpt-5.6-luna"}
	PrefGemini = []string{"gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.1-pro-low", "gemini-3.5-flash-lite"}
	PrefFast   = []string{"gpt-6-luna", "gpt-5.6-luna", "claude-haiku-4-5-20251001", "gemini-3.8-flash", "deepseek-v4.1-flash", "qcn-glm-5.3-flash"}
	PrefAgent  = append(append(append([]string{}, PrefOpus[:2]...), PrefGPT[:3]...), PrefSonnet...)
)

// 以下模型在网关层对所有 Key 开放，不以 /v1/models 是否列出为准（列表本身会抖动）。
const (
	// OpenHaiku 是 Claude Code 网络搜索等后台任务使用的 Haiku 档。
	OpenHaiku = "claude-haiku-4-5-20251001"
	// ImageFamily 是 crapi 唯一支持的生图系列，其他生图模型一律不用。
	ImageFamily = "gpt-image-2.5"
)

// ImageModelIDs 是 gpt-image-2.5 系列的已知型号，第一个为默认。
var ImageModelIDs = []string{"gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"}

// IsSupportedImageModel 报告 id 是否属于 gpt-image-2.5 系列。
func IsSupportedImageModel(id string) bool {
	return id == ImageFamily || strings.HasPrefix(id, ImageFamily+"-")
}

// SupportedImageModels 返回可用的生图型号：已知型号，加上网关新列出的同系列型号。
func SupportedImageModels(all []Model) []string {
	out := append([]string{}, ImageModelIDs...)
	for _, m := range all {
		if IsSupportedImageModel(m.ID) && !slices.Contains(out, m.ID) {
			out = append(out, m.ID)
		}
	}
	return out
}

// VendorIs 返回一个按厂商过滤的谓词。
func VendorIs(v string) func(Model) bool {
	return func(m Model) bool { return m.Vendor() == v && m.Kind() == KindChat }
}

// ChannelID 把渠道标识换成控制台的渠道 id（控制台 PROVIDERS 的 types 别名）。
// 渠道标识来自号池接口的 provider；/v1/models 的 owned_by 现在一律是 crosery，不再用它认渠道。
func ChannelID(ownedBy string) string {
	id := strings.ToLower(strings.TrimSpace(ownedBy))
	switch id {
	case "anthropic":
		return "claude"
	case "openai":
		return "codex"
	case "grok":
		return "xai"
	case "muse":
		return "meta"
	}
	return id
}

// 控制台的渠道名（src/channelLabels.ts + 订阅账号池 PROVIDERS 的 name）；控制台改名，这里跟着改。
var channelLabels = map[string]string{
	"claude": "Claude", "codex": "Codex", "antigravity": "Antigravity", "xai": "Grok",
	"kimi": "Kimi", "kimi-ai": "Kimi 国际站", "devin": "Devin", "meta": "Meta AI",
	"minimax": "MiniMax", "openai-compatible-minimax": "MiniMax",
	"mox-aigw": "Mox 中转", "openai-compatible-mox-aigw": "Mox 中转",
}

// 订阅账号池在控制台里的顺序。
var channelOrder = []string{"codex", "claude", "antigravity", "kimi", "kimi-ai", "xai", "devin", "meta"}

// ChannelLabel 是渠道标识在控制台里的渠道名；没有专门名字的渠道原样显示 id。
func ChannelLabel(ownedBy string) string {
	id := ChannelID(ownedBy)
	if id == "" {
		return "未知渠道"
	}
	if name, ok := channelLabels[id]; ok {
		return name
	}
	return strings.TrimSpace(ownedBy)
}

// ChannelRank 是渠道的排序位置：订阅账号池按控制台顺序在前，其余并列在后。
func ChannelRank(ownedBy string) int {
	if i := slices.Index(channelOrder, ChannelID(ownedBy)); i >= 0 {
		return i
	}
	return len(channelOrder)
}
