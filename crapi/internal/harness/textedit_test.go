package harness

import (
	"strings"
	"testing"
)

func TestTOMLDoc(t *testing.T) {
	raw := []byte(`# Top level comment
model_provider = "openai"

[existing_table]
key1 = "val1"
# comment in table
key2 = "val2"

[crosery]
model = "claude"
`)

	doc := ParseTOML(raw)
	v, ok := doc.GetTop("model_provider")
	if !ok || v != `"openai"` {
		t.Fatalf("expected \"openai\", got %q (ok=%v)", v, ok)
	}

	doc.SetTop("model_provider", `"crosery"`)
	doc.SetTop("new_key", "123")
	v, ok = doc.GetTop("model_provider")
	if !ok || v != `"crosery"` {
		t.Fatalf("expected \"crosery\", got %q", v)
	}

	doc.ReplaceTable("crosery", []string{
		`model = "claude-opus-5-5"`,
		`wire_api = "responses"`,
	})

	if !doc.HasTable("crosery") {
		t.Fatalf("expected table crosery to exist")
	}

	val, ok := doc.TableValue("crosery", "wire_api")
	if !ok || val != `"responses"` {
		t.Fatalf("expected \"responses\", got %q", val)
	}

	doc.RemoveTablesWithPrefix("existing")
	if doc.HasTable("existing_table") {
		t.Fatalf("expected existing_table to be removed")
	}

	out := string(doc.Bytes())
	if !strings.Contains(out, `[crosery]`) || !strings.Contains(out, `model_provider = "crosery"`) {
		t.Fatalf("unexpected toml output:\n%s", out)
	}
}

func TestDotenv(t *testing.T) {
	raw := []byte(`# Existing env
KEY_A=val_a
KEY_B="old_val_b"
`)

	out := SetDotenv(raw, [][2]string{
		{"KEY_B", "new_val_b"},
		{"KEY_C", "val c with space"},
	})

	if GetDotenv(out, "KEY_A") != "val_a" {
		t.Errorf("expected val_a, got %q", GetDotenv(out, "KEY_A"))
	}
	if GetDotenv(out, "KEY_B") != "new_val_b" {
		t.Errorf("expected new_val_b, got %q", GetDotenv(out, "KEY_B"))
	}
	if GetDotenv(out, "KEY_C") != "val c with space" {
		t.Errorf("expected 'val c with space', got %q", GetDotenv(out, "KEY_C"))
	}
}

func TestYAML(t *testing.T) {
	raw := []byte(`# Hermes config
model:
  provider: "custom:crosery"
providers:
  crosery:
    name: "Crosery"
`)

	doc, root, err := LoadYAML(raw)
	if err != nil {
		t.Fatalf("LoadYAML failed: %v", err)
	}

	modelMap := YMap(root, "model")
	if YScalar(modelMap, "provider") != "custom:crosery" {
		t.Errorf("expected custom:crosery, got %q", YScalar(modelMap, "provider"))
	}

	YSet(modelMap, "provider", YStr("custom:updated"))
	out, err := DumpYAML(doc)
	if err != nil {
		t.Fatalf("DumpYAML failed: %v", err)
	}
	if !strings.Contains(string(out), "custom:updated") {
		t.Fatalf("YAML update not reflected:\n%s", string(out))
	}
}
