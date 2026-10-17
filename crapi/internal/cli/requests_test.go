package cli

import (
	"strings"
	"testing"
	"time"

	"github.com/crosery/crapi/internal/api"
)

func TestDuration(t *testing.T) {
	cases := map[float64]string{0: "0ms", 849.4: "849ms", 1820: "1.82s", 83_700: "83.7s", 412_000: "412s"}
	for ms, want := range cases {
		if got := duration(ms); got != want {
			t.Errorf("duration(%v) = %q，期望 %q", ms, got, want)
		}
	}
}

// 列与控制台「最近请求」表一致；没有首字、没有缓存读时是 —。
func TestRequestsTable(t *testing.T) {
	saved := time.Local
	time.Local = time.FixedZone("UTC+8", 8*3600)
	t.Cleanup(func() { time.Local = saved })
	items := []api.RequestItem{
		{Timestamp: "2026-10-09T01:30:00Z", Model: "gpt-6-astra", Endpoint: "POST /v1/responses", Success: 1, StatusCode: 200, LatencyMs: 1820, TTFTMs: 640, InputTokens: 1200, OutputTokens: 300, CachedTokens: 800},
		{Timestamp: "2026-10-09T01:31:00Z", Model: "house-model-1", Endpoint: "POST /v1/chat/completions", Success: 0, StatusCode: 429, LatencyMs: 85, InputTokens: 10, TotalTokens: 10},
	}
	want := `
╭─────────────┬───────────────┬───────┬───────┬────────┬───────┬───────╮
│ 时间        │ 模型          │ 状态  │ Token │ 缓存读 │  首字 │  耗时 │
├─────────────┼───────────────┼───────┼───────┼────────┼───────┼───────┤
│ 10-09 09:30 │ gpt-6-astra   │ ✓ 200 │  1.5K │    800 │ 640ms │ 1.82s │
│ 10-09 09:31 │ house-model-1 │ ✗ 429 │    10 │      — │     — │  85ms │
╰─────────────┴───────────────┴───────┴───────┴────────┴───────┴───────╯`
	if got := plain(requestsTable(items)); got != strings.TrimPrefix(want, "\n") {
		t.Errorf("表格不一致：\n%s\n期望：\n%s", got, want)
	}
}
