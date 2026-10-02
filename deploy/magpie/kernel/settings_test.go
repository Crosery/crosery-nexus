package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/settings"
)

func settingsHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("MAGPIE_NO_STATS", "1")
	return filepath.Join(dir, "magpie", "settings.json")
}

func TestSettingsReadOnlyTheGatewayKeysAndNeverSecrets(t *testing.T) {
	file := settingsHome(t)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	hand := `{"lan":true,"lanKey":"sk-magpie-` + strings.Repeat("ab", 20) + `","proxy":"http://user:pw@127.0.0.1:7890","redact":true,"redactWords":["acme"]}`
	if err := os.WriteFile(file, []byte(hand), 0o600); err != nil {
		t.Fatal(err)
	}
	_, h := newTestKernel(&fakeMagpie{}, "")
	rec, body := call(t, h, "GET", "/internal/settings", "")
	if rec.Code != 200 || body["redact"] != true || body["redactPersonal"] != false {
		t.Fatalf("GET: %d %v", rec.Code, body)
	}
	raw := rec.Body.String()
	for _, secret := range []string{"sk-magpie-", "lanKey", "user:pw", "proxy"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("settings view leaks %q: %s", secret, raw)
		}
	}
	tel := body["telemetry"].(map[string]any)
	if tel["off"] != true || tel["forced"] != true || tel["sender"] != false {
		t.Fatalf("telemetry %v", tel)
	}
	if !slices.Equal(toStrings(body["keys"]), settingsKeys) || body["applies"] != "next-request" {
		t.Fatalf("keys/applies %v", body)
	}
}

func TestSettingsWriteMergesValidatesAndKeepsTheRest(t *testing.T) {
	file := settingsHome(t)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(`{"lan":true,"lanKey":"sk-magpie-keep","theme":"dark","noStats":false}`), 0o644); err != nil {
		t.Fatal(err)
	}
	_, h := newTestKernel(&fakeMagpie{}, "")
	rec, body := call(t, h, "POST", "/internal/settings",
		`{"redact":true,"redactPersonal":true,"redactWords":[" acme ","acme","内部代号"],"redactRules":[{"kind":"oc key","prefix":"oc_sk_"},{"kind":"gw","regex":"gw-[a-z0-9]{12,}"}]}`)
	if rec.Code != 200 || body["redact"] != true || body["redactPersonal"] != true {
		t.Fatalf("POST: %d %v", rec.Code, body)
	}
	if got := toStrings(body["redactWords"]); !slices.Equal(got, []string{"acme", "内部代号"}) {
		t.Fatalf("words %v", got)
	}
	s := settings.Load()
	if !s.LAN || s.LANKey != "sk-magpie-keep" || s.Theme != "dark" || !s.NoStats {
		t.Fatalf("other keys changed or stats not forced off: %+v", s)
	}
	if len(s.RedactRules) != 2 || s.RedactRules[0].Kind != "OC_KEY" || s.RedactRules[1].Regex == "" {
		t.Fatalf("rules %+v", s.RedactRules)
	}
	if info, err := os.Stat(file); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("settings file is written atomically (0600 temp + rename): %v %v", info.Mode(), err)
	}
	entries, _ := os.ReadDir(filepath.Dir(file))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".settings-") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
	// a partial write changes only what it names
	rec, body = call(t, h, "POST", "/internal/settings", `{"redactPersonal":false}`)
	if rec.Code != 200 || body["redact"] != true || body["redactPersonal"] != false || len(body["redactRules"].([]any)) != 2 {
		t.Fatalf("partial: %d %v", rec.Code, body)
	}
}

func TestSettingsRefusesUnknownKeysBadRulesAndModels(t *testing.T) {
	file := settingsHome(t)
	_, h := newTestKernel(&fakeMagpie{}, "")
	if rec, body := call(t, h, "POST", "/internal/settings", `{"redact":true}`); rec.Code != 200 {
		t.Fatalf("seed: %d %v", rec.Code, body)
	}
	before, _ := os.ReadFile(file)
	long := strings.Repeat("x", 301)
	nested := `(((a{1,1000}){1,1000}){1,1000})`
	for _, c := range []struct{ body, code string }{
		{`{"lanKey":"x"}`, "unknown_setting"},
		{`{"noStats":false}`, "unknown_setting"},
		{`{"proxy":"direct"}`, "unknown_setting"},
		{`{"redact":"yes"}`, "invalid_setting"},
		{`{"redactRules":[{"kind":"x","regex":"("}]}`, "invalid_setting"},
		{`{"redactRules":[{"kind":"x","regex":".*"}]}`, "invalid_setting"},
		{`{"redactRules":[{"kind":"x","regex":"` + long + `"}]}`, "invalid_setting"},
		{`{"redactRules":[{"kind":"x","regex":"` + nested + `"}]}`, "invalid_setting"},
		{`{"redactRules":[{"kind":"x","prefix":"ab"}]}`, "invalid_setting"},
		{`{"redactRules":[{"kind":"x","prefix":"abc","regex":"abc"}]}`, "invalid_setting"},
		{`{"redactRules":[{"kind":"x","prefix":"abcd","extra":1}]}`, "invalid_setting"},
		{`{"redactWords":["a"]}`, "invalid_setting"},
		{`{"redactWords":["` + strings.Repeat("w", 65) + `"]}`, "invalid_setting"},
		{`{"redactWords":"acme"}`, "invalid_setting"},
		{`{"vision":"nobody/model"}`, "invalid_setting"},
		{`{"imageGen":"noslash"}`, "invalid_setting"},
		{`{}`, "invalid_setting"},
	} {
		rec, body := call(t, h, "POST", "/internal/settings", c.body)
		wantError(t, rec, body, 400, c.code)
	}
	words := make([]string, 101)
	for i := range words {
		words[i] = "word" + strings.Repeat("x", i%50) + string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	b, _ := json.Marshal(map[string]any{"redactWords": words})
	rec, body := call(t, h, "POST", "/internal/settings", string(b))
	wantError(t, rec, body, 400, "invalid_setting")
	after, _ := os.ReadFile(file)
	if string(before) != string(after) {
		t.Fatalf("a refused write changed the file:\n%s\n%s", before, after)
	}
	for _, v := range []string{"off", ""} {
		rec, body := call(t, h, "POST", "/internal/settings", `{"vision":"`+v+`","imageGen":"`+v+`"}`)
		if rec.Code != 200 || body["vision"] != v || body["imageGen"] != v || body["visionEffective"] != "" && v == "off" {
			t.Fatalf("model %q: %d %v", v, rec.Code, body)
		}
	}
}

func TestSettingsModelsFollowTheConsoleProvidersAndFallBackToAutomatic(t *testing.T) {
	settingsHome(t)
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	var ps []provider.Provider
	if err := json.Unmarshal([]byte(`[{"id":"c-img","name":"绘图渠道","key":"k","chat":"https://example.invalid/v1","models":["gpt-image-1","chat-model-x"]}]`), &ps); err != nil {
		t.Fatal(err)
	}
	provider.SetCroseryProviders(ps)
	t.Cleanup(func() { provider.SetCroseryProviders(nil) })
	_, h := newTestKernel(&fakeMagpie{}, "")
	rec, body := call(t, h, "GET", "/internal/settings", "")
	if rec.Code != 200 {
		t.Fatalf("GET: %d %v", rec.Code, body)
	}
	ids := func(v any) (out []string) {
		for _, m := range v.([]any) {
			out = append(out, m.(map[string]any)["id"].(string))
		}
		return out
	}
	if got := ids(body["imageGenModels"]); !slices.Contains(got, "c-img/gpt-image-1") || slices.Contains(got, "c-img/chat-model-x") {
		t.Fatalf("imageGenModels %v", got)
	}
	if got := ids(body["models"]); !slices.Equal(got, []string{"c-img/gpt-image-1", "c-img/chat-model-x"}) {
		t.Fatalf("models %v", got)
	}
	if strings.Contains(rec.Body.String(), `"k"`) || strings.Contains(rec.Body.String(), "example.invalid") {
		t.Fatalf("provider key or base URL leaked: %s", rec.Body.String())
	}
	rec, body = call(t, h, "POST", "/internal/settings", `{"imageGen":"c-img/gpt-image-1"}`)
	if rec.Code != 200 || body["imageGen"] != "c-img/gpt-image-1" || body["imageGenEffective"] != "c-img/gpt-image-1" {
		t.Fatalf("set imageGen: %d %v", rec.Code, body)
	}
	provider.SetCroseryProviders(nil)
	_, body = call(t, h, "GET", "/internal/settings", "")
	if body["imageGen"] != "c-img/gpt-image-1" || body["imageGenEffective"] != body["imageGenAuto"] {
		t.Fatalf("a model that no longer resolves falls back to automatic: %v", body)
	}
}
