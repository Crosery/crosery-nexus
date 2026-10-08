package cli

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/ui"
)

// 树形输出的层级与命名对齐控制台（crosery-api-console）：
//   models   厂商 → 模型          同 /me/models 的厂商分组（src/features/me/meModel.ts vendorOf）
//   channels 渠道 → 类型 → 模型   渠道名同 src/channelLabels.ts，顺序同订阅账号池（src/features/accounts/model.ts PROVIDERS）
// 控制台改了这些规则时，这里要跟着改。

var consoleVendors = []struct {
	re        *regexp.Regexp
	id, label string
}{
	{regexp.MustCompile(`^(claude|anthropic)`), "anthropic", "Anthropic"},
	{regexp.MustCompile(`^(gpt|o\d|chatgpt|codex|openai|dall-e|whisper|tts|text-embedding|computer-use)`), "openai", "OpenAI"},
	{regexp.MustCompile(`^(gemini|gemma|lyria|imagen|veo|google|learnlm)`), "google", "Google"},
	{regexp.MustCompile(`^(qwen|qwq|qvq|tongyi)`), "qwen", "Qwen"},
	{regexp.MustCompile(`^(deepseek)`), "deepseek", "DeepSeek"},
	{regexp.MustCompile(`^(glm|chatglm|zhipu|cogview)`), "zhipu", "智谱 GLM"},
	{regexp.MustCompile(`^(kimi|moonshot)`), "moonshot", "Kimi"},
	{regexp.MustCompile(`^(grok|xai)`), "xai", "xAI"},
	{regexp.MustCompile(`^(minimax|abab)`), "minimax", "MiniMax"},
	{regexp.MustCompile(`^(mistral|ministral|codestral|devstral|mixtral|voxtral|magistral|pixtral)`), "mistral", "Mistral"},
	{regexp.MustCompile(`^(llama|meta-llama)`), "meta", "Meta Llama"},
	{regexp.MustCompile(`^(nemotron|nvidia)`), "nvidia", "NVIDIA"},
	{regexp.MustCompile(`^(command|cohere|north|aya)`), "cohere", "Cohere"},
}

// vendorOf 从模型 id 判断厂商：认 `vendor/` 前缀，跳过一次 `qcn-glm-5.3` 这类分销前缀，认不出的归「其他」。
func vendorOf(id string) (key, label string) {
	raw := strings.ToLower(id)
	bare, prefix, tail := raw, "", ""
	if i := strings.LastIndex(raw, "/"); i >= 0 {
		bare = raw[i+1:]
		prefix = raw[:strings.Index(raw, "/")]
	}
	if i := strings.Index(bare, "-"); i >= 0 {
		tail = bare[i+1:]
	}
	for _, candidate := range []string{prefix, bare, tail} {
		if candidate == "" {
			continue
		}
		for _, v := range consoleVendors {
			if v.re.MatchString(candidate) {
				return v.id, v.label
			}
		}
	}
	return "other", "其他"
}

type vendorGroup struct {
	id, label string
	models    []api.Model
}

// groupByVendor：「其他」垫底，其余按模型数从多到少、再按名称；组内保持 id 顺序。
// 控制台还会先按近 7 天用量排，crapi 的模型列表里没有用量，这一层跳过。
func groupByVendor(list []api.Model) []vendorGroup {
	idx := map[string]int{}
	var groups []vendorGroup
	for _, m := range list {
		id, label := vendorOf(m.ID)
		if _, ok := idx[id]; !ok {
			idx[id] = len(groups)
			groups = append(groups, vendorGroup{id: id, label: label})
		}
		groups[idx[id]].models = append(groups[idx[id]].models, m)
	}
	sort.SliceStable(groups, func(i, j int) bool {
		a, b := groups[i], groups[j]
		if (a.id == "other") != (b.id == "other") {
			return b.id == "other"
		}
		if len(a.models) != len(b.models) {
			return len(a.models) > len(b.models)
		}
		return a.label < b.label
	})
	return groups
}

// channelHead 是渠道一行的「名称 + 标识」：标识与名称只差大小写时不重复显示。
func channelHead(label, id string) []string {
	if strings.EqualFold(label, id) {
		return []string{ui.Bold.Render(label), ""}
	}
	return []string{ui.Bold.Render(label), ui.Dim.Render(id)}
}

// kindLabels 用控制台的模型类型名（src/lib/modelKind.ts MODEL_KIND_LABEL）。
var kindLabels = map[api.Kind]string{api.KindChat: "对话", api.KindImage: "图片", api.KindAudio: "语音"}

func modelTree(groups []vendorGroup) []ui.TreeNode {
	var nodes []ui.TreeNode
	for _, grp := range groups {
		node := ui.TreeNode{Cells: []string{ui.Bold.Render(grp.label), ui.Dim.Render(fmt.Sprintf("%d 个", len(grp.models)))}}
		for _, m := range grp.models {
			name := ""
			if m.Name() != m.ID {
				name = ui.Dim.Render(ui.Truncate(m.Name(), 26))
			}
			node.Children = append(node.Children, ui.TreeNode{
				Cells:  []string{m.ID, name, ui.Ctx(m.ContextLength), ui.Ctx(m.MaxCompletionTokens), caps(m), price(m)},
				Aligns: []ui.Align{ui.Left, ui.Left, ui.Right, ui.Right, ui.Left, ui.Right},
			})
		}
		nodes = append(nodes, node)
	}
	return nodes
}

func channelTree(groups []channelGroup) []ui.TreeNode {
	var nodes []ui.TreeNode
	for _, grp := range groups {
		node := ui.TreeNode{Cells: append(channelHead(api.ChannelLabel(grp.channel), grp.channel), ui.Dim.Render(fmt.Sprintf("%d 个模型", len(grp.models))))}
		for _, k := range []api.Kind{api.KindChat, api.KindImage, api.KindAudio} {
			var of []api.Model
			for _, m := range grp.models {
				if m.Kind() == k {
					of = append(of, m)
				}
			}
			if len(of) == 0 {
				continue
			}
			sample := ids(of)
			if len(sample) > 4 {
				sample = append(sample[:4], "…")
			}
			node.Children = append(node.Children, ui.TreeNode{
				Cells:  []string{kindLabels[k], fmt.Sprint(len(of)), ui.Truncate(strings.Join(sample, ", "), 64)},
				Aligns: []ui.Align{ui.Left, ui.Right},
			})
		}
		nodes = append(nodes, node)
	}
	return nodes
}
