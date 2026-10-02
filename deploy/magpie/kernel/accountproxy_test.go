package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

// An account's own exit (an accountProxies pick, as the console pushes it)
// carries its requests made through http.DefaultClient; every other request
// stays as it was (direct under the launcher's stripped environment).
func TestDefaultClientTakesTheAccountsOwnExit(t *testing.T) {
	saved := http.DefaultClient.Transport
	t.Cleanup(func() {
		http.DefaultClient.Transport = saved
		provider.SetCroseryProviders(nil)
	})
	var mu sync.Mutex
	var hosts []string
	exit := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hosts = append(hosts, r.Host) // an absolute-form request: the exit is an HTTP proxy
		mu.Unlock()
		io.WriteString(w, "via-exit")
	}))
	defer exit.Close()
	direct := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "direct") }))
	defer direct.Close()

	routeAccountProxies()
	provider.SetCroseryProviders([]provider.Provider{{ID: "codex", AccountProxies: map[string]string{"a@example.test": exit.URL}}})

	get := func(ctx context.Context, target string) string {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			t.Fatal(err)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", target, err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return string(body)
	}

	// vendor.invalid never resolves: an answer proves the request went to the exit, not to the host
	if got := get(provider.ViaLogin(context.Background(), "codex", "A@Example.test"), "http://vendor.invalid/usage"); got != "via-exit" {
		t.Fatalf("account with an exit: %q", got)
	}
	mu.Lock()
	if !slices.Contains(hosts, "vendor.invalid") {
		t.Fatalf("exit saw %v", hosts)
	}
	mu.Unlock()
	// an account of the same service without an exit, and a request naming none: never the exit
	for _, ctx := range []context.Context{provider.ViaLogin(context.Background(), "codex", "b@example.test"), context.Background()} {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://vendor.invalid/other", nil)
		if res, err := http.DefaultClient.Do(req); err == nil {
			res.Body.Close()
		}
	}
	mu.Lock()
	if len(hosts) != 1 {
		t.Fatalf("exit saw requests it should not: %v", hosts)
	}
	mu.Unlock()
	if got := get(context.Background(), direct.URL); got != "direct" {
		t.Fatalf("request naming no proxy: %q", got)
	}
}

func TestHealthReportsAccountProxy(t *testing.T) {
	_, h := newTestKernel(&fakeMagpie{}, "")
	_, body := call(t, h, "GET", "/internal/health", "")
	if !slices.Contains(toStrings(body["capabilities"]), "account-proxy") {
		t.Fatalf("capabilities %v", body["capabilities"])
	}
}
