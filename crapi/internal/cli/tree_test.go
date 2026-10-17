package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/crosery/crapi/internal/api"
	"github.com/crosery/crapi/internal/store"
	"github.com/crosery/crapi/internal/ui"
)

// 夹具只用占位名（example-relay、demo-key），不含真实主机、Key 或账号。
// 模型的 owned_by 与现网网关一致：一律 crosery，不区分渠道；号池夹具里的渠道是账号来源，不是模型归属。
const modelsFixture = `{"data":[
 {"id":"claude-opus-5-5","display_name":"Claude Opus 5.5","owned_by":"crosery","context_length":1000000,"max_completion_tokens":128000,"supportedInputModalities":["text","image"],"supports_reasoning":true,"cost":{"input":5,"output":25}},
 {"id":"claude-haiku-4-5-20251001","display_name":"Claude Haiku 4.5","owned_by":"crosery","context_length":200000,"max_completion_tokens":64000,"supportedInputModalities":["text","image"],"cost":{"input":1,"output":5}},
 {"id":"gpt-6-astra","display_name":"GPT-6 Astra","owned_by":"crosery","context_length":400000,"max_completion_tokens":128000,"supportedInputModalities":["text","image"],"supports_reasoning":true,"cost":{"input":2.5,"output":15}},
 {"id":"gpt-image-2.5","owned_by":"crosery","supportedOutputModalities":["image"],"cost":{"input":5,"output":40}},
 {"id":"gemini-3.1-pro-preview","display_name":"Gemini 3.1 Pro","owned_by":"crosery","context_length":1048576,"max_completion_tokens":65536,"supports_reasoning":true,"cost":{"input":2,"output":12}},
 {"id":"claude-sonnet-4-6","display_name":"Claude Sonnet 4.6","owned_by":"crosery","context_length":200000,"max_completion_tokens":64000,"cost":{"input":3,"output":15}},
 {"id":"deepseek-v4.1-flash:free","owned_by":"crosery","context_length":128000,"supports_tool_call":false},
 {"id":"qcn-glm-5.3","owned_by":"crosery","context_length":200000,"max_completion_tokens":32000,"cost":{"input":0.6,"output":2.2}},
 {"id":"house-model-1","owned_by":"crosery"}
]}`

const poolFixture = `{"generatedAt":"","providers":[
 {"provider":"example-relay","label":"","accounts":{"total":1,"active":1},"windows":[],"models":[]},
 {"provider":"antigravity","label":"","accounts":{"total":3,"active":1,"error":2},"windows":[],"models":["gemini-3.1-pro-preview"]},
 {"provider":"claude","label":"","accounts":{"total":5,"active":3,"cooling":1,"disabled":1},
  "windows":[{"id":"five_hour","label":"5 小时额度","usedPercent":42,"accounts":3},{"id":"seven_day","label":"7 天额度","usedPercent":71,"accounts":3}],
  "models":["claude-opus-5-5","claude-haiku-4-5-20251001"]},
 {"provider":"codex","label":"","accounts":{"total":2,"active":2},"windows":[],"models":["gpt-6-astra"]}
]}`

const usageFixture = `{"days":7,"key":{"name":"demo-key"},"quotaTimeZone":"Asia/Shanghai",
 "quota":{"unlimited":false,
  "daily":{"limitUsd":5,"spentUsd":1.6,"exceeded":false},
  "weekly":{"limitUsd":20,"spentUsd":21,"exceeded":true},
  "total":{"limitUsd":0,"spentUsd":42.3,"exceeded":false}},
 "models":[
  {"model":"gpt-6-astra","requests":40,"newInputTokens":300000,"outputTokens":50000,"cacheTokens":900000,"totalTokens":1250000,"totalCostUsd":3.2,"priced":true},
  {"model":"house-model-1","requests":7,"newInputTokens":1000,"outputTokens":2000,"cacheTokens":0,"totalTokens":3000,"totalCostUsd":null,"priced":false},
  {"model":"claude-opus-5-5","requests":1200,"newInputTokens":1200000,"outputTokens":300000,"cacheTokens":8000000,"totalTokens":9500000,"totalCostUsd":12.3,"priced":true}],
 "totals":{"requests":1247,"newInputTokens":1501000,"outputTokens":352000,"cacheTokens":8900000,"totalTokens":10753000,"totalCostUsd":15.5},
 "unpricedModels":["house-model-1"]}`

var ansiRE = regexp.MustCompile(`\x1b\[[0-9;:]*m`)

const requestsFixture = `{"items":[{"timestamp":"2026-10-09T01:30:00Z","model":"gpt-6-astra","endpoint":"POST /v1/responses","success":1,"statusCode":200,"latencyMs":1820,"inputTokens":1200,"outputTokens":300}]}`

func plain(s string) string { return ansiRE.ReplaceAllString(s, "") }

func fixtureModels(t *testing.T) []api.Model {
	t.Helper()
	c := fixtureClient(t, map[string]string{"/v1/models": modelsFixture})
	models, err := c.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return models
}

func fixtureServer(t *testing.T, routes map[string]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := routes[r.URL.Path]
		if !ok {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, "<!doctype html>")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func fixtureClient(t *testing.T, routes map[string]string) *api.Client {
	srv := fixtureServer(t, routes)
	return api.New(srv.URL, srv.URL, "sk-placeholder", "crapi-test")
}

func decode[T any](t *testing.T, raw string) *T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatal(err)
	}
	return &v
}

func TestVendorOf(t *testing.T) {
	cases := map[string]string{
		"claude-opus-5-5":             "Anthropic",
		"gpt-6-astra":                 "OpenAI",
		"o4-mini":                     "OpenAI",
		"gemini-3.1-pro-preview":      "Google",
		"veo-3.1-generate-preview":    "Google",
		"qcn-glm-5.3":                 "智谱 GLM",
		"cline-deepseek-v4.1-flash":   "DeepSeek",
		"moonshotai/kimi-k2":          "Kimi",
		"x-ai/grok-4":                 "xAI",
		"meta-llama/llama-4-maverick": "Meta Llama",
		"house-model-1":               "其他",
	}
	for id, want := range cases {
		if _, got := vendorOf(id); got != want {
			t.Errorf("vendorOf(%q) = %q，期望 %q", id, got, want)
		}
	}
}

func TestTrees(t *testing.T) {
	models := fixtureModels(t)
	cases := []struct {
		name  string
		nodes []ui.TreeNode
		want  string
	}{
		{
			name:  "models：厂商 → 模型，「其他」垫底",
			nodes: modelTree(groupByVendor(models)),
			want: `
├─ Anthropic  3 个
│  ├─ claude-haiku-4-5-20251001  Claude Haiku 4.5    200K   64K  视 工         $1 / $5
│  ├─ claude-opus-5-5            Claude Opus 5.5       1M  128K  视 推 工     $5 / $25
│  └─ claude-sonnet-4-6          Claude Sonnet 4.6   200K   64K  工           $3 / $15
├─ OpenAI     2 个
│  ├─ gpt-6-astra                GPT-6 Astra         400K  128K  视 推 工   $2.5 / $15
│  └─ gpt-image-2.5                                     -     -  图           $5 / $40
├─ DeepSeek   1 个
│  └─ deepseek-v4.1-flash:free                       128K     -                   免费
├─ Google     1 个
│  └─ gemini-3.1-pro-preview     Gemini 3.1 Pro     1.05M   66K  推 工        $2 / $12
├─ 智谱 GLM   1 个
│  └─ qcn-glm-5.3                                    200K   32K  工        $0.6 / $2.2
└─ 其他       1 个
   └─ house-model-1                                     -     -  工                  -`,
		},
		{
			name:  "pool：全部 → 渠道 → 账号 / 额度窗口 / 模型",
			nodes: poolTree(decode[api.Pool](t, poolFixture)),
			want: `
├─ 全部  ███████████████████████████░░░  运行 7 · 冷却 1 · 异常 2 · 暂停 1 / 共 11
├─ Codex          ● 正常
│  ├─ 账号        ████████████████████████  运行 2 / 共 2
│  └─ 模型  gpt-6-astra
├─ Claude         ● 正常
│  ├─ 账号        ███████████████████░░░░░  运行 3 · 冷却 1 · 暂停 1 / 共 5
│  ├─ 5 小时额度  ██████████░░░░░░░░░░░░░░   42% · 3 个账号平均
│  ├─ 7 天额度    █████████████████░░░░░░░   71% · 3 个账号平均
│  └─ 模型  claude-opus-5-5, claude-haiku-4-5-20251001
├─ Antigravity    ● 紧张
│  ├─ 账号        ████████████████████████  运行 1 · 异常 2 / 共 3
│  └─ 模型  gemini-3.1-pro-preview
└─ example-relay  ● 正常
   └─ 账号        ████████████████████████  运行 1 / 共 1`,
		},
		{
			name:  "usage：额度（日 / 周 / 累计）→ 合计 → 按模型 · 花费",
			nodes: usageTree(decode[api.Usage](t, usageFixture)),
			want: `
├─ 额度
│  ├─ 日    ███████▋░░░░░░░░░░░░░░░░   32%  $1.60 / $5.00
│  ├─ 周    ████████████████████████  105%  $21.00 / $20.00 已超额
│  └─ 累计  ░░░░░░░░░░░░░░░░░░░░░░░░        $42.30 / 不限 · 不自动重置
├─ 合计           请求 1,247 · 总 Token 10.75M · 输入 1.5M · 输出 352K · 缓存读 8.9M 86% · 估算花费 $15.50
└─ 按模型 · 花费  共 3 个模型
   ├─ claude-opus-5-5  1,200 次  输入 1.2M  输出 300K    缓存读 8M  $12.30  ██████████████
   ├─ gpt-6-astra         40 次  输入 300K   输出 50K  缓存读 900K   $3.20  ███▋░░░░░░░░░░
   └─ house-model-1        7 次    输入 1K    输出 2K     缓存读 0  未定价  ░░░░░░░░░░░░░░`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := plain(ui.Tree(tc.nodes))
			want := strings.TrimPrefix(tc.want, "\n")
			if got != want {
				t.Fatalf("got:\n%s\n\nwant:\n%s", got, want)
			}
		})
	}
}

// fixtureApp 起一个只服务夹具路由的网关，返回指向它的 App 与收集界面输出的缓冲。
func fixtureApp(t *testing.T, routes map[string]string) (*App, *bytes.Buffer) {
	t.Helper()
	srv := fixtureServer(t, routes)
	t.Setenv("CRAPI_KEY", "")
	t.Setenv("CRAPI_BASE_URL", srv.URL)
	t.Setenv("CRAPI_CONSOLE_URL", srv.URL)
	a := &App{Version: "test", Cfg: &store.Config{APIKey: "sk-placeholder"}, ctx: context.Background()}
	var buf bytes.Buffer
	saved := ui.Out
	ui.Out = &buf
	t.Cleanup(func() { ui.Out = saved })
	return a, &buf
}

// 命令级：经 HTTP 拉夹具 → 分组 → 树形输出，确认默认输出是树、号池接口缺失时只给提示。
func TestCommandsPrintTrees(t *testing.T) {
	a, buf := fixtureApp(t, map[string]string{"/v1/models": modelsFixture, "/v1/usage": usageFixture, "/v1/usage/requests": requestsFixture})

	cases := []struct {
		name string
		run  func() error
		want []string
	}{
		{"models", func() error { return cmdModels(a, nil) }, []string{"◆ 可用模型  9 个模型 · 6 个厂商", "├─ Anthropic  3 个", "└─ 其他       1 个", "   └─ house-model-1"}},
		{"models 关键字", func() error { return cmdModels(a, []string{"gpt"}) }, []string{"2 个模型 · 1 个厂商", "└─ OpenAI  2 个"}},
		{"pool 无号池接口", func() error { return cmdPool(a, nil) }, []string{"控制台暂未开放号池接口；可用模型见 crapi models。"}},
		{"usage", func() error { return cmdUsage(a, nil) }, []string{"◆ 账号用量 · demo-key  最近 7 天", "├─ 额度", "└─ 按模型 · 花费  共 3 个模型", "未定价（不计入花费与额度）：house-model-1"}},
		{"usage --requests", func() error { return cmdUsage(a, []string{"--requests"}) }, []string{"最近请求  1 条", "│ 时间        │ 模型        │ 状态  │ Token │ 缓存读 │ 首字 │  耗时 │", "│ gpt-6-astra │ ✓ 200 │"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			buf.Reset()
			if err := tc.run(); err != nil {
				t.Fatal(err)
			}
			out := plain(buf.String())
			for _, w := range tc.want {
				if !strings.Contains(out, w) {
					t.Errorf("输出缺少 %q：\n%s", w, out)
				}
			}
			for _, line := range strings.Split(out, "\n") {
				if strings.HasSuffix(line, " ") && strings.TrimSpace(line) != "" {
					t.Errorf("行尾有空格：%q", line)
				}
			}
		})
	}
}
