package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/proc"
	"github.com/yetone/magpie/internal/provider"
)

var pinnedAgents = []string{"antigravity", "claude", "codex", "commandcode-plan", "copilot", "cursor", "devin", "dimagent",
	"factory", "gemini", "grok", "kiro", "mimo-app", "qoder", "workbuddy", "workbuddy-ai", "zcode", "zed"}

type fakeMagpie struct {
	calls     []string
	logins    map[string][]provider.Login
	signIns   map[string]provider.SignInState
	err       error
	usage     map[string]provider.SubscriptionQuota
	reset     provider.ResetOutcome
	resetWait bool
}

func (f *fakeMagpie) note(s string) { f.calls = append(f.calls, s) }
func (f *fakeMagpie) StartSignIn(agent, site string) (provider.SignInState, error) {
	f.note("start " + agent + " " + site)
	if f.err != nil {
		return provider.SignInState{}, f.err
	}
	return provider.SignInState{ID: "abc123", Agent: agent, State: "waiting", URL: "https://vendor.example/auth"}, nil
}
func (f *fakeMagpie) SignInStatus(id string) (provider.SignInState, bool) {
	st, ok := f.signIns[id]
	return st, ok
}
func (f *fakeMagpie) CancelSignIn(id string) { f.note("cancel " + id) }
func (f *fakeMagpie) SubmitSignInCallback(id, raw string) error {
	f.note("callback " + id)
	return f.err
}
func (f *fakeMagpie) Logins(agent string) []provider.Login { return f.logins[agent] }
func (f *fakeMagpie) Excluded() []provider.Exclusion       { return nil }
func (f *fakeMagpie) SetLoginOn(agent, user string, on bool) error {
	if on {
		f.note("on " + agent + " " + user)
	} else {
		f.note("off " + agent + " " + user)
	}
	return f.err
}
func (f *fakeMagpie) SwitchLogin(agent, user string) error {
	f.note("switch " + agent + " " + user)
	return f.err
}
func (f *fakeMagpie) ForgetLogin(agent, user string) error {
	f.note("forget " + agent + " " + user)
	return f.err
}
func (f *fakeMagpie) LoginUsage(ctx context.Context, agent string) map[string]provider.SubscriptionQuota {
	f.note("usage " + agent)
	return f.usage
}
func (f *fakeMagpie) UseCodexReset(ctx context.Context, user string) (provider.ResetOutcome, error) {
	f.note("reset " + user)
	if f.resetWait {
		<-ctx.Done()
		return provider.ResetOutcome{}, ctx.Err()
	}
	return f.reset, f.err
}

func newTestKernel(ops magpieAPI, allow string) (*kernel, http.Handler) {
	k := &kernel{agents: pinnedAgents, guard: newHostGuard(allow), ops: ops}
	return k, k.mux(nil)
}

func call(t *testing.T, h http.Handler, method, target, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("%s %s: body is not JSON: %q", method, target, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Fatalf("%s %s: content type %q", method, target, ct)
		}
	}
	return rec, out
}

func wantError(t *testing.T, rec *httptest.ResponseRecorder, body map[string]any, status int, code string) {
	t.Helper()
	if rec.Code != status || body["code"] != code || body["error"] == "" || body["error"] == nil {
		t.Fatalf("want %d %s, got %d %v", status, code, rec.Code, body)
	}
}

func TestHealthReportsCapabilitiesAgentsAndDenyList(t *testing.T) {
	_, h := newTestKernel(&fakeMagpie{}, "")
	rec, body := call(t, h, "GET", "/internal/health", "")
	if rec.Code != 200 || body["ok"] != true || body["engine"] != "magpie" || body["keychain"] != false {
		t.Fatalf("health: %d %v", rec.Code, body)
	}
	caps := toStrings(body["capabilities"])
	for _, c := range []string{"providers", "rtk", "signin", "accounts", "usage", "codex-reset"} {
		if !slices.Contains(caps, c) {
			t.Fatalf("capability %s missing: %v", c, caps)
		}
	}
	if got := toStrings(body["loginAgents"]); !slices.Equal(got, pinnedAgents) {
		t.Fatalf("loginAgents %v", got)
	}
	if got := toStrings(body["signinDeny"]); !slices.Equal(got, []string{"cursor", "devin", "grok"}) {
		t.Fatalf("signinDeny %v", got)
	}
	_, h = newTestKernel(&fakeMagpie{}, "devin, GROK")
	_, body = call(t, h, "GET", "/internal/health", "")
	if got := toStrings(body["signinDeny"]); !slices.Equal(got, []string{"cursor"}) {
		t.Fatalf("explicitly enabled agents stay denied: %v", got)
	}
}

func TestSigninDenyListRefusesBeforeMagpie(t *testing.T) {
	f := &fakeMagpie{}
	_, h := newTestKernel(f, "")
	for _, agent := range []string{"cursor", "grok", "devin"} {
		rec, body := call(t, h, "POST", "/internal/signin", `{"agent":"`+agent+`"}`)
		wantError(t, rec, body, 400, "agent_disabled")
	}
	if len(f.calls) != 0 {
		t.Fatalf("magpie was asked: %v", f.calls)
	}
	_, h = newTestKernel(f, "devin")
	rec, body := call(t, h, "POST", "/internal/signin", `{"agent":"devin"}`)
	if rec.Code != 200 || body["state"] != "waiting" || !slices.Equal(f.calls, []string{"start devin "}) {
		t.Fatalf("enabled devin: %d %v %v", rec.Code, body, f.calls)
	}
}

func TestSigninValidatesAndPassesMagpieErrors(t *testing.T) {
	f := &fakeMagpie{}
	_, h := newTestKernel(f, "")
	for _, c := range []struct{ body, code string }{
		{`{"agent":"kimi"}`, "agent_unknown"},
		{`{"agent":"zcode:bigmodel"}`, "agent_unknown"},
		{`{"agent":"Claude"}`, "agent_unknown"},
		{`{"agent":"zcode","site":"../x"}`, "invalid_request"},
		{`{"agent":`, "invalid_request"},
		{`{"agent":"claude","pad":"` + strings.Repeat("x", 70<<10) + `"}`, "too_large"},
	} {
		rec, body := call(t, h, "POST", "/internal/signin", c.body)
		wantError(t, rec, body, 400, c.code)
	}
	rec, body := call(t, h, "POST", "/internal/signin", `{"agent":"zcode","site":"bigmodel"}`)
	if rec.Code != 200 || body["id"] != "abc123" || f.calls[0] != "start zcode bigmodel" {
		t.Fatalf("zcode: %d %v %v", rec.Code, body, f.calls)
	}
	f.err = errors.New("port 1455, where ChatGPT sends the sign-in back, is busy; close any other Codex sign-in and try again")
	rec, body = call(t, h, "POST", "/internal/signin", `{"agent":"codex"}`)
	wantError(t, rec, body, 400, "rejected")
	if !strings.Contains(body["error"].(string), "1455") {
		t.Fatalf("magpie's text is kept: %v", body)
	}
}

func TestSigninStatusCallbackCancel(t *testing.T) {
	f := &fakeMagpie{signIns: map[string]provider.SignInState{"abc123": {ID: "abc123", Agent: "dimagent", State: "waiting", PasteCallback: true}}}
	_, h := newTestKernel(f, "")
	rec, body := call(t, h, "GET", "/internal/signin/abc123", "")
	if rec.Code != 200 || body["state"] != "waiting" || body["pasteCallback"] != true {
		t.Fatalf("status: %d %v", rec.Code, body)
	}
	rec, body = call(t, h, "GET", "/internal/signin/nope", "")
	wantError(t, rec, body, 404, "not_found")
	rec, body = call(t, h, "GET", "/internal/signin/bad%20id", "")
	wantError(t, rec, body, 404, "not_found")
	rec, body = call(t, h, "POST", "/internal/signin/callback", `{"id":"nope","url":"http://127.0.0.1:54321/auth/callback?code=x"}`)
	wantError(t, rec, body, 404, "not_found")
	rec, body = call(t, h, "POST", "/internal/signin/callback", `{"id":"abc123","url":""}`)
	wantError(t, rec, body, 400, "invalid_request")
	rec, body = call(t, h, "POST", "/internal/signin/callback", `{"id":"abc123","url":"`+strings.Repeat("x", 17<<10)+`"}`)
	wantError(t, rec, body, 400, "invalid_request")
	rec, _ = call(t, h, "POST", "/internal/signin/callback", `{"id":"abc123","url":"http://127.0.0.1:54321/auth/callback?code=x"}`)
	if rec.Code != 204 {
		t.Fatalf("callback: %d", rec.Code)
	}
	f.err = errors.New("that URL carries no code")
	rec, body = call(t, h, "POST", "/internal/signin/callback", `{"id":"abc123","url":"http://127.0.0.1:54321/auth/callback"}`)
	wantError(t, rec, body, 400, "rejected")
	for _, id := range []string{"abc123", "unknown"} {
		if rec, _ = call(t, h, "POST", "/internal/signin/cancel", `{"id":"`+id+`"}`); rec.Code != 204 {
			t.Fatalf("cancel %s: %d", id, rec.Code)
		}
	}
	if !slices.Contains(f.calls, "cancel abc123") {
		t.Fatalf("cancel not passed on: %v", f.calls)
	}
}

func TestUnknownControlRouteIsJSONAndNeverInference(t *testing.T) {
	k := &kernel{agents: pinnedAgents, guard: newHostGuard(""), ops: &fakeMagpie{}}
	reached := 0
	h := k.mux(accountedInference(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached++ })))
	for _, c := range []struct{ method, path string }{
		{"GET", "/internal/nope"}, {"GET", "/internal/accounts/on"}, {"POST", "/internal/accounts/import"},
		{"POST", "/internal/signin/import"}, {"DELETE", "/internal/health"},
	} {
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(`{}`))
		req.Header.Set("X-Crosery-Request-Id", "r1")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var body map[string]any
		if json.Unmarshal(rec.Body.Bytes(), &body) != nil || rec.Code != 404 || body["code"] != "not_found" {
			t.Fatalf("%s %s: %d %q", c.method, c.path, rec.Code, rec.Body.String())
		}
	}
	rec, body := call(t, h, "POST", "/v1/chat/completions", `{}`)
	wantError(t, rec, body, 400, "request_id_required")
	if reached != 0 {
		t.Fatalf("control routes reached inference %d times", reached)
	}
}

func TestAccountsListEveryAgentWithoutSecrets(t *testing.T) {
	seen := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	f := &fakeMagpie{logins: map[string][]provider.Login{
		"codex": {
			{Agent: "codex", User: "b@example.test", Plan: "plus", On: true, Seen: seen},
			{Agent: "codex", User: "a@example.test", Plan: "pro", Active: true, On: true, Seen: seen},
			{Agent: "codex", User: "c@example.test", Lapsed: "Signed out"},
			{Agent: "codex", User: "A@example.test"}, // same account, other case
			{Agent: "codex", User: ""},
		},
	}}
	_, h := newTestKernel(f, "")
	rec, _ := call(t, h, "GET", "/internal/accounts", "")
	var out struct {
		Agents   []agentAccounts `json:"agents"`
		Excluded []any           `json:"excluded"`
	}
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &out) != nil || out.Excluded == nil {
		t.Fatalf("accounts: %d %s", rec.Code, rec.Body.String())
	}
	if len(out.Agents) != len(pinnedAgents) {
		t.Fatalf("every pinned agent is listed: %d", len(out.Agents))
	}
	for _, a := range out.Agents {
		if a.Accounts == nil || a.SigninDenied != slices.Contains([]string{"cursor", "devin", "grok"}, a.Agent) {
			t.Fatalf("agent %+v", a)
		}
	}
	codex := out.Agents[slices.IndexFunc(out.Agents, func(a agentAccounts) bool { return a.Agent == "codex" })].Accounts
	if len(codex) != 3 || codex[0].User != "a@example.test" || !codex[0].Active || codex[0].ID != accountID("codex", "A@EXAMPLE.TEST") {
		t.Fatalf("active first, deduplicated: %+v", codex)
	}
	if !codex[2].NeedsRelogin || codex[2].Lapsed != "Signed out" || codex[1].NeedsRelogin || codex[2].Seen != nil {
		t.Fatalf("relogin state: %+v", codex)
	}
	if strings.Contains(strings.ToLower(rec.Body.String()), "token") || strings.Contains(rec.Body.String(), `"auth"`) {
		t.Fatalf("listing leaks a credential field: %s", rec.Body.String())
	}
}

func TestAccountActionsMapToMagpie(t *testing.T) {
	f := &fakeMagpie{logins: map[string][]provider.Login{"codex": {
		{Agent: "codex", User: "a@example.test", Active: true, On: true},
		{Agent: "codex", User: "b@example.test"},
	}}}
	_, h := newTestKernel(f, "")
	for _, action := range []string{"on", "off", "switch", "forget"} {
		rec, body := call(t, h, "POST", "/internal/accounts/"+action, `{"agent":"codex","user":"b@example.test"}`)
		if rec.Code != 200 || body["agent"] != "codex" || len(body["accounts"].([]any)) != 2 {
			t.Fatalf("%s: %d %v", action, rec.Code, body)
		}
	}
	want := []string{"on codex b@example.test", "off codex b@example.test", "switch codex b@example.test", "forget codex b@example.test"}
	if !slices.Equal(f.calls, want) {
		t.Fatalf("calls %v", f.calls)
	}
	f.err = errors.New("codex is signed in to a@example.test now; switch to another account first")
	rec, body := call(t, h, "POST", "/internal/accounts/forget", `{"agent":"codex","user":"a@example.test"}`)
	wantError(t, rec, body, 400, "account_active")
	f.err = errors.New(`no saved codex account "z@example.test"`)
	rec, body = call(t, h, "POST", "/internal/accounts/off", `{"agent":"codex","user":"z@example.test"}`)
	wantError(t, rec, body, 404, "not_found")
	f.err = errors.New("vendor said no")
	rec, body = call(t, h, "POST", "/internal/accounts/switch", `{"agent":"codex","user":"b@example.test"}`)
	wantError(t, rec, body, 400, "rejected")
	for _, c := range []struct{ path, body, code string }{
		{"/internal/accounts/on", `{"agent":"codex","user":""}`, "invalid_request"},
		{"/internal/accounts/on", `{"agent":"codex","user":"a\u0000b"}`, "invalid_request"},
		{"/internal/accounts/on", `{"agent":"codex","user":" a@example.test"}`, "invalid_request"},
		{"/internal/accounts/on", `{"agent":"kimi","user":"a@example.test"}`, "agent_unknown"},
	} {
		rec, body := call(t, h, "POST", c.path, c.body)
		wantError(t, rec, body, 400, c.code)
	}
	rec, body = call(t, h, "POST", "/internal/accounts/rename", `{"agent":"codex","user":"a@example.test"}`)
	wantError(t, rec, body, 404, "not_found")
}

func TestUsageAndCodexReset(t *testing.T) {
	f := &fakeMagpie{usage: map[string]provider.SubscriptionQuota{"a@example.test": {Provider: "codex", User: "a@example.test",
		Windows: []provider.QuotaWindow{{Name: "5 hours", Used: 42}}}}}
	_, h := newTestKernel(f, "")
	rec, body := call(t, h, "GET", "/internal/accounts/usage?agent=codex", "")
	usage := body["usage"].(map[string]any)["a@example.test"].(map[string]any)
	if rec.Code != 200 || body["agent"] != "codex" || usage["windows"].([]any)[0].(map[string]any)["used"] != 42.0 {
		t.Fatalf("usage: %d %v", rec.Code, body)
	}
	f.usage = nil
	if _, body = call(t, h, "GET", "/internal/accounts/usage?agent=devin", ""); len(body["usage"].(map[string]any)) != 0 {
		t.Fatalf("empty usage is {}: %v", body)
	}
	rec, body = call(t, h, "GET", "/internal/accounts/usage?agent=", "")
	wantError(t, rec, body, 400, "agent_unknown")
	f.reset = provider.ResetOutcome{Code: "reset", Windows: 1}
	rec, body = call(t, h, "POST", "/internal/accounts/codex-reset", `{"user":"a@example.test"}`)
	if rec.Code != 200 || body["code"] != "reset" || body["windows"] != 1.0 || body["text"] != "1 window started again" {
		t.Fatalf("reset: %d %v", rec.Code, body)
	}
	rec, body = call(t, h, "POST", "/internal/accounts/codex-reset", `{"user":""}`)
	wantError(t, rec, body, 400, "invalid_request")
	f.err = errors.New("no Codex account a@example.test")
	rec, body = call(t, h, "POST", "/internal/accounts/codex-reset", `{"user":"a@example.test"}`)
	wantError(t, rec, body, 400, "rejected")
}

// The real Magpie provider under a temp HOME: the listing and a Claude
// sign-in run, and nothing guarded (the keychain tool, Claude Code, host
// CLIs or an installer) is ever started, though a stub of each is on PATH.
func TestRealMagpieUnderTempHomeNeverStartsGuardedPrograms(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, "stub-bin")
	marker := filepath.Join(home, "spawned.log")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"security", "secret-tool", "claude", "cursor-agent", "agent", "grok", "devin", "bash", "curl", "probe"} {
		script := "#!/bin/sh\necho " + name + " >> '" + marker + "'\n"
		if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin)
	for _, name := range []string{"XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"} {
		t.Setenv(name, filepath.Join(home, strings.ToLower(strings.TrimPrefix(name, "XDG_"))))
	}
	for _, name := range []string{"CLAUDE_CONFIG_DIR", "CODEX_HOME", "NO_PROXY", "no_proxy"} {
		t.Setenv(name, "")
	}
	for _, name := range []string{"HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"} {
		t.Setenv(name, "http://127.0.0.1:9")
	}
	// a Claude Code sign-in in the kernel HOME: Magpie lists it, and would ask
	// `claude auth status` (and the keychain, were it on) about it
	mustWrite(t, filepath.Join(home, ".claude", ".credentials.json"), `{"claudeAiOauth":{"accessToken":"fixture-access-value","refreshToken":"fixture-refresh-value","expiresAt":4102444800000,"subscriptionType":"max"}}`)
	mustWrite(t, filepath.Join(home, ".claude.json"), `{"oauthAccount":{"emailAddress":"owner@example.test"}}`)
	mustWrite(t, filepath.Join(home, ".cursor", "auth.json"), `{"accessToken":"fixture-cursor-value"}`)
	provider.ForgetAccounts()

	prev := proc.CroseryDeny
	t.Cleanup(func() { proc.CroseryDeny = prev })
	newHostGuard("").install()
	k := &kernel{agents: pinnedAgents, guard: newHostGuard(""), ops: magpieOps{}}
	h := k.mux(nil)

	rec, _ := call(t, h, "GET", "/internal/accounts", "")
	if rec.Code != 200 {
		t.Fatalf("accounts: %d %s", rec.Code, rec.Body.String())
	}
	for _, secret := range []string{"fixture-access-value", "fixture-refresh-value", "fixture-cursor-value"} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatal("the listing leaks a token")
		}
	}
	if !strings.Contains(rec.Body.String(), "owner@example.test") {
		t.Fatalf("the kernel HOME's Claude sign-in is listed: %s", rec.Body.String())
	}
	rec, body := call(t, h, "POST", "/internal/signin", `{"agent":"cursor"}`)
	wantError(t, rec, body, 400, "agent_disabled")

	rec, body = call(t, h, "POST", "/internal/signin", `{"agent":"claude"}`)
	if rec.Code != 200 || body["state"] != "waiting" {
		t.Fatalf("claude sign-in: %d %v", rec.Code, body)
	}
	id := body["id"].(string)
	signInURL, err := url.Parse(body["url"].(string))
	if err != nil || signInURL.Host != "claude.com" || !strings.HasPrefix(signInURL.Query().Get("redirect_uri"), "http://localhost:") {
		t.Fatalf("claude sign-in URL: %v", body["url"])
	}
	if rec, _ = call(t, h, "POST", "/internal/signin/cancel", `{"id":"`+id+`"}`); rec.Code != 204 {
		t.Fatalf("cancel: %d", rec.Code)
	}
	if _, body = call(t, h, "GET", "/internal/signin/"+id, ""); body["state"] != "canceled" {
		t.Fatalf("after cancel: %v", body)
	}
	rec, body = call(t, h, "POST", "/internal/signin/callback", `{"id":"`+id+`","url":"http://localhost:1/callback?code=x"}`)
	wantError(t, rec, body, 400, "rejected")

	for _, name := range []string{"security", "claude", "cursor-agent"} {
		if err := proc.Command(name, "find-generic-password").Run(); err == nil {
			t.Fatalf("%s ran", name)
		}
	}
	if err := proc.Command("probe").Run(); err != nil {
		t.Fatalf("an unguarded program still runs: %v", err)
	}
	got, _ := os.ReadFile(marker)
	if string(got) != "probe\n" {
		t.Fatalf("guarded programs were started: %q", got)
	}
}

func mustWrite(t *testing.T, name, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}
