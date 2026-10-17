package cli

import (
	"slices"
	"strings"
	"testing"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/ui"
)

// 现网网关的模型列表不再区分渠道（owned_by 一律 crosery），旧网关还会带渠道名。
// 模型分组与选择器只看模型 id，两种网关下的输出必须一样。
func TestModelViewsIgnoreOwnedBy(t *testing.T) {
	models := fixtureModels(t)
	render := func() (string, []string) {
		var items []string
		for _, m := range models {
			it := modelPickerItem(m)
			items = append(items, it.Title+"|"+it.Subtitle+"|"+it.SearchWords)
		}
		return plain(ui.Tree(modelTree(groupByVendor(models)))), items
	}
	flatTree, flatItems := render()

	legacy := []string{"anthropic", "openai", "antigravity", "example-relay"}
	for i := range models {
		models[i].OwnedBy = legacy[i%len(legacy)]
	}
	legacyTree, legacyItems := render()

	if flatTree != legacyTree {
		t.Errorf("模型树随 owned_by 变了：\n%s\n\n%s", flatTree, legacyTree)
	}
	if !slices.Equal(flatItems, legacyItems) {
		t.Errorf("选择器条目随 owned_by 变了：\n%q\n%q", flatItems, legacyItems)
	}
}

func TestModelPickerItem(t *testing.T) {
	models := fixtureModels(t)
	byID := map[string]api.Model{}
	for _, m := range models {
		byID[m.ID] = m
	}
	byID["house-model-2"] = api.Model{ID: "house-model-2", ContextLength: 32000}

	cases := []struct {
		id, subtitle string
		words        []string
	}{
		{"claude-opus-5-5", "Anthropic (1M ctx)", []string{"claude-opus-5-5", "Claude Opus 5.5", "anthropic", "Anthropic"}},
		{"deepseek-v4.1-flash:free", "DeepSeek (128K ctx)", []string{"deepseek", "DeepSeek"}},
		{"house-model-1", "", nil},
		{"house-model-2", "(32K ctx)", nil},
	}
	for _, tc := range cases {
		it := modelPickerItem(byID[tc.id])
		if it.ID != tc.id || it.Title != tc.id {
			t.Errorf("%s：ID/Title = %q/%q", tc.id, it.ID, it.Title)
		}
		if it.Subtitle != tc.subtitle {
			t.Errorf("%s：副标题 = %q，期望 %q", tc.id, it.Subtitle, tc.subtitle)
		}
		for _, w := range tc.words {
			if !strings.Contains(it.SearchWords, w) {
				t.Errorf("%s：搜索词 %q 缺少 %q", tc.id, it.SearchWords, w)
			}
		}
		if len(tc.words) == 0 && (strings.Contains(it.SearchWords, "其他") || strings.Contains(it.SearchWords, "other")) {
			t.Errorf("%s：认不出厂商时不该带「其他」：%q", tc.id, it.SearchWords)
		}
	}
}

// 渠道视图随扁平模型列表移除：旧参数与旧命令要明确报错并指去路，不能悄悄忽略后给出未过滤的结果。
func TestRemovedChannelEntryPoints(t *testing.T) {
	a, buf := fixtureApp(t, map[string]string{"/v1/models": modelsFixture})
	for _, args := range [][]string{{"--channel", "openai"}, {"--channel=openai"}, {"gpt", "--channel", "openai"}} {
		err := cmdModels(a, args)
		if err == nil || !strings.Contains(err.Error(), "--channel 已移除") || !strings.Contains(err.Error(), "crapi pool") {
			t.Errorf("models %v：err = %v", args, err)
		}
		if buf.Len() != 0 {
			t.Errorf("models %v：报错前不该有输出：%q", args, buf.String())
		}
	}

	for _, name := range []string{"channels", "channel"} {
		msg, ok := removedCommand(name)
		if !ok || !strings.Contains(msg, "crapi models") || !strings.Contains(msg, "crapi pool") {
			t.Errorf("removedCommand(%q) = %q, %v", name, msg, ok)
		}
	}
	if _, ok := removedCommand("models"); ok {
		t.Error("现役命令不该被当成已移除")
	}
	for _, c := range commands() {
		if c.name == "channels" || contains(c.aliases, "channels") || contains(c.aliases, "channel") {
			t.Errorf("命令表里还有渠道命令：%s", c.name)
		}
	}
}
