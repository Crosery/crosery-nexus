package harness

import (
	"strings"
	"testing"
)

func TestParseJSONC(t *testing.T) {
	raw := []byte(`{
		// line comment
		"key": "value", /* block comment */
		"nested": {
			"a": 1,
			"b": 2, // trailing comma
		},
	}`)

	obj, hadComments, err := ParseJSON(raw)
	if err != nil {
		t.Fatalf("ParseJSON failed: %v", err)
	}
	if !hadComments {
		t.Errorf("expected hadComments=true")
	}
	if obj.Str("key") != "value" {
		t.Errorf("expected value, got %q", obj.Str("key"))
	}
	nested := obj.Child("nested")
	if !nested.Has("a") || !nested.Has("b") {
		t.Errorf("missing nested keys")
	}

	// Test order preservation
	obj.Set("zebra", "last")
	obj.Set("apple", "first")
	keys := obj.Keys()
	expectedOrder := []string{"key", "nested", "zebra", "apple"}
	for i, k := range expectedOrder {
		if i >= len(keys) || keys[i] != k {
			t.Errorf("key order mismatch at %d: got %v, expected %v", i, keys, expectedOrder)
		}
	}

	marshaled := string(MarshalJSON(obj))
	if !strings.Contains(marshaled, `"key": "value"`) {
		t.Errorf("marshaled JSON missing key: %s", marshaled)
	}
}

func TestParseJSONArray(t *testing.T) {
	raw := []byte(`[
		{"id": 1},
		{"id": 2}, // trailing comma
	]`)
	arr, err := ParseJSONArray(raw)
	if err != nil {
		t.Fatalf("ParseJSONArray failed: %v", err)
	}
	if len(arr) != 2 {
		t.Fatalf("expected 2 elements, got %d", len(arr))
	}
}
