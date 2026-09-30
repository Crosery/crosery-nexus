package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/yetone/magpie/internal/gateway"
	"github.com/yetone/magpie/internal/library"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/usage"
)

var revision = "unknown"

// Inference, RTK and provider signin operations: headless without GUI or background telemetry.
func main() {
	socket := os.Getenv("MAGPIE_KERNEL_SOCKET")
	if socket == "" {
		os.Exit(1)
	}
	ln, err := net.Listen("unix", socket)
	if err != nil {
		os.Exit(1)
	}
	defer os.Remove(socket)
	if os.Chmod(socket, 0600) != nil {
		os.Exit(1)
	}
	var mu sync.Mutex
	active := map[string][]usage.Record{}
	usage.CroserySink = func(r usage.Record) {
		mu.Lock()
		defer mu.Unlock()
		if records, ok := active[r.RequestID]; ok && len(records) < 16 {
			active[r.RequestID] = append(records, r)
		}
	}
	inference := gateway.New().Handler()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "engine": "magpie", "revision": revision})
	})
	mux.HandleFunc("PUT /internal/providers", func(w http.ResponseWriter, r *http.Request) {
		var ps []provider.Provider
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&ps) != nil {
			http.Error(w, "invalid providers", 400)
			return
		}
		provider.SetCroseryProviders(ps)
		w.WriteHeader(204)
	})
	mux.HandleFunc("GET /internal/rtk", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(library.ReadRTK())
	})
	mux.HandleFunc("POST /internal/rtk", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Agent string `json:"agent"`
			On    bool   `json:"on"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req) != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		view, err := library.SetRTK(req.Agent, req.On)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(view)
	})
	mux.HandleFunc("POST /internal/signin", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Agent string `json:"agent"`
			Site  string `json:"site"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req) != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		var st provider.SignInState
		var signErr error
		if req.Site != "" {
			st, signErr = provider.StartSignInAt(req.Agent, req.Site)
		} else {
			st, signErr = provider.StartSignIn(req.Agent)
		}
		if signErr != nil {
			http.Error(w, signErr.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(st)
	})
	mux.HandleFunc("GET /internal/signin/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/internal/signin/")
		st, ok := provider.SignInStatus(id)
		if !ok {
			http.Error(w, "not found", 404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(st)
	})
	mux.HandleFunc("POST /internal/signin/callback", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID  string `json:"id"`
			URL string `json:"url"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req) != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		if err := provider.SubmitSignInCallback(req.ID, req.URL); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /internal/signin/cancel", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID string `json:"id"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req) != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		provider.CancelSignIn(req.ID)
		w.WriteHeader(204)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Crosery-Request-Id")
		if id == "" || len(id) > 80 {
			http.Error(w, "request id required", 400)
			return
		}
		mu.Lock()
		active[id] = []usage.Record{}
		mu.Unlock()
		// Accounting stays on the private socket, never in the public body.
		w.Header().Add("Trailer", "X-Crosery-Usage")
		inference.ServeHTTP(w, r)
		mu.Lock()
		records := active[id]
		delete(active, id)
		mu.Unlock()
		b, _ := json.Marshal(records)
		w.Header().Set("X-Crosery-Usage", string(b))
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: time.Minute}
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
