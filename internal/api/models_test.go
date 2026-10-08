package api

import "testing"

func TestChannelLabel(t *testing.T) {
	cases := map[string]string{
		"anthropic": "Claude", "claude": "Claude", "openai": "Codex", "codex": "Codex",
		"antigravity": "Antigravity", "grok": "Grok", "xai": "Grok", "kimi-ai": "Kimi 国际站", "muse": "Meta AI",
		"mox-aigw": "Mox 中转", "openrouter": "openrouter", "example-relay": "example-relay", "": "未知渠道",
	}
	for id, want := range cases {
		if got := ChannelLabel(id); got != want {
			t.Errorf("ChannelLabel(%q) = %q，期望 %q", id, got, want)
		}
	}
}

func TestChannelRank(t *testing.T) {
	order := []string{"openai", "claude", "antigravity", "kimi", "kimi-ai", "grok", "devin", "meta"}
	for i, id := range order {
		if got := ChannelRank(id); got != i {
			t.Errorf("ChannelRank(%q) = %d，期望 %d", id, got, i)
		}
	}
	if got := ChannelRank("example-relay"); got != len(order) {
		t.Errorf("ChannelRank(example-relay) = %d，期望 %d", got, len(order))
	}
}
