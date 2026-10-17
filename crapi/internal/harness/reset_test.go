package harness

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func resetCodex(t *testing.T, config string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("CRAPI_HOME", filepath.Join(home, "crapi")) // 不读写真实备份目录
	cfg := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ResetHarness(Env{Home: home, GOOS: runtime.GOOS}, codex{}, "https://ai.crosery.com"); err != nil {
		t.Fatal(err)
	}
	out, _ := os.ReadFile(cfg)
	return string(out)
}

func TestResetCodexKeepsUsersOwnProvider(t *testing.T) {
	got := resetCodex(t, `model_provider = "custom"
model = "gpt-5"

[model_providers.custom]
base_url = "https://relay.example.com/v1"
`)
	if !strings.Contains(got, `model_provider = "custom"`) || !strings.Contains(got, "[model_providers.custom]") {
		t.Fatalf("reset must not touch a provider crapi did not write:\n%s", got)
	}
}

func TestResetCodexRemovesCroseryProvider(t *testing.T) {
	got := resetCodex(t, `model_provider = "crosery"
model = "gpt-6-astra"

[model_providers.crosery]
base_url = "https://ai.crosery.com/v1"
`)
	if !strings.Contains(got, `model_provider = "openai"`) || strings.Contains(got, "[model_providers.crosery]") {
		t.Fatalf("reset should drop the crosery provider and fall back to openai:\n%s", got)
	}
}
