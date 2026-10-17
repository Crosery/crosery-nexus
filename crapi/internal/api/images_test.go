package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
)

func TestIsSupportedImageModel(t *testing.T) {
	for id, want := range map[string]bool{
		"gpt-image-2.5":          true,
		"gpt-image-2.5-flare":    true,
		"gpt-image-2.5-sunburst": true,
		"gpt-image-2":            false,
		"gpt-image-1.5":          false,
		"gpt-image-2.55":         false,
		"gemini-3.1-flash-image": false,
		"":                       false,
	} {
		if got := IsSupportedImageModel(id); got != want {
			t.Errorf("IsSupportedImageModel(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestSupportedImageModelsIgnoresListing(t *testing.T) {
	// 列表里没有 2.5 系列时仍返回固定型号；其他生图模型不会混进来；新的同系列型号会被补上。
	got := SupportedImageModels([]Model{{ID: "gpt-image-2"}, {ID: "gemini-3.1-flash-image"}, {ID: "gpt-image-2.5-nova"}})
	want := append(append([]string{}, ImageModelIDs...), "gpt-image-2.5-nova")
	if !slices.Equal(got, want) {
		t.Fatalf("SupportedImageModels = %v, want %v", got, want)
	}
}

func TestGenerateImagesRejectsOtherModelsWithoutRequest(t *testing.T) {
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true }))
	defer srv.Close()
	c := New(srv.URL, srv.URL, "sk-test", "test")
	for _, m := range []string{"gpt-image-2", "gemini-3.1-flash-image", "dall-e-3"} {
		if _, err := c.GenerateImages(context.Background(), ImageRequest{Model: m, Prompt: "x"}); err == nil {
			t.Errorf("GenerateImages(%q) should be rejected", m)
		}
	}
	if hit {
		t.Fatal("rejected models must not reach the gateway")
	}
}
