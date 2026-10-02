package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/yetone/magpie/internal/gateway"
	"github.com/yetone/magpie/internal/library"
	"github.com/yetone/magpie/internal/netproxy"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/usage"
)

var revision = "unknown"

// loginAgents is the pinned contract's sign-in agents, set at build time
// (-X main.loginAgents=<csv>, from deploy/magpie/upstream/api.json).
var loginAgents = ""

// Inference, RTK, sign-in and account operations: headless, no GUI, no
// background telemetry, no keychain, no host CLI for agents left disabled.
func main() {
	socket := os.Getenv("MAGPIE_KERNEL_SOCKET")
	if socket == "" {
		os.Exit(1)
	}
	guard := newHostGuard(os.Getenv("MAGPIE_KERNEL_HOST_EXEC"))
	guard.install()
	routeAccountProxies()
	ln, err := net.Listen("unix", socket)
	if err != nil {
		os.Exit(1)
	}
	defer os.Remove(socket)
	if os.Chmod(socket, 0600) != nil {
		os.Exit(1)
	}
	k := &kernel{agents: splitList(loginAgents), guard: guard, ops: magpieOps{}}
	server := &http.Server{Handler: k.mux(accountedInference(gateway.New().Handler())), ReadHeaderTimeout: 15 * time.Second, IdleTimeout: time.Minute}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		drain, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(drain)
	}()
	if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
		os.Exit(1)
	}
}

// accountedInference forwards to the gateway and returns the request's usage
// records in a trailer; accounting stays on the private socket, never in the
// public body.
func accountedInference(inference http.Handler) http.Handler {
	var mu sync.Mutex
	active := map[string][]usage.Record{}
	usage.CroserySink = func(r usage.Record) {
		mu.Lock()
		defer mu.Unlock()
		if records, ok := active[r.RequestID]; ok && len(records) < 16 {
			active[r.RequestID] = append(records, r)
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Crosery-Request-Id")
		if id == "" || len(id) > 80 {
			fail(w, 400, "request_id_required", "request id required")
			return
		}
		mu.Lock()
		active[id] = []usage.Record{}
		mu.Unlock()
		w.Header().Add("Trailer", "X-Crosery-Usage")
		inference.ServeHTTP(w, r)
		mu.Lock()
		records := active[id]
		delete(active, id)
		mu.Unlock()
		b, _ := json.Marshal(records)
		w.Header().Set("X-Crosery-Usage", string(b))
	})
}

type kernel struct {
	agents []string
	guard  hostGuard
	ops    magpieAPI
}

var capabilities = []string{"providers", "rtk", "signin", "accounts", "usage", "codex-reset", "settings", "account-proxy"}

// routeAccountProxies makes http.DefaultClient honour the proxy a request's
// context names (provider.Via / ViaLogin: an account's own exit, pushed as
// accountProxies picks), the way Magpie's netproxy.Install does for the
// desktop app. A request naming none keeps DefaultTransport as it is (the
// launcher strips proxy variables: direct). Install's global fallback
// (settings.json, the system proxy) is deliberately not taken.
func routeAccountProxies() {
	if t, ok := http.DefaultTransport.(*http.Transport); ok {
		http.DefaultClient.Transport = netproxy.Dispatch(t)
	}
}

func (k *kernel) mux(inference http.Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/health", k.health)
	mux.HandleFunc("PUT /internal/providers", func(w http.ResponseWriter, r *http.Request) {
		var ps []provider.Provider
		if !decode(w, r, 4<<20, &ps) {
			return
		}
		provider.SetCroseryProviders(ps)
		w.WriteHeader(204)
	})
	mux.HandleFunc("GET /internal/rtk", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, library.ReadRTK())
	})
	mux.HandleFunc("POST /internal/rtk", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Agent string `json:"agent"`
			On    bool   `json:"on"`
		}
		if !decode(w, r, 1<<20, &req) {
			return
		}
		view, err := library.SetRTK(req.Agent, req.On)
		if err != nil {
			fail(w, 500, "kernel_error", err.Error())
			return
		}
		writeJSON(w, 200, view)
	})
	mux.HandleFunc("POST /internal/signin", k.signinStart)
	mux.HandleFunc("GET /internal/signin/{id}", k.signinStatus)
	mux.HandleFunc("POST /internal/signin/callback", k.signinCallback)
	mux.HandleFunc("POST /internal/signin/cancel", k.signinCancel)
	mux.HandleFunc("GET /internal/accounts", k.accounts)
	mux.HandleFunc("GET /internal/accounts/usage", k.accountUsage)
	mux.HandleFunc("POST /internal/accounts/codex-reset", k.codexReset)
	mux.HandleFunc("POST /internal/accounts/{action}", k.accountAction)
	mux.HandleFunc("GET /internal/settings", k.getSettings)
	mux.HandleFunc("POST /internal/settings", k.setSettings)
	// an unknown control route never falls through to inference
	mux.HandleFunc("/internal/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, 404, "not_found", "no such kernel route")
	})
	if inference != nil {
		mux.Handle("/", inference)
	}
	return mux
}

func (k *kernel) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"ok": true, "engine": "magpie", "revision": revision,
		"capabilities": capabilities,
		"loginAgents":  nonNil(k.agents),
		"signinDeny":   nonNil(k.guard.deniedAgents()),
		"keychain":     false,
	})
}
