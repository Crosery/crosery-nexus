package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/yetone/magpie/internal/provider"
)

// accountView is one saved subscription account, without its secrets:
// Magpie's Login (logins.go) plus a stable id and needsRelogin.
type accountView struct {
	ID           string     `json:"id"` // sha256(agent NUL lower(user)), 16 hex
	Agent        string     `json:"agent"`
	User         string     `json:"user"` // the vendor's account name, usually an email
	Plan         string     `json:"plan,omitempty"`
	Active       bool       `json:"active"` // the agent is signed in to it: used first
	On           bool       `json:"on"`     // in use: the active one, or next in line
	Own          bool       `json:"own,omitempty"`
	NeedsRelogin bool       `json:"needsRelogin"`
	Lapsed       string     `json:"lapsed,omitempty"` // why the vendor refused to renew it
	Seen         *time.Time `json:"seen,omitempty"`
}

type agentAccounts struct {
	Agent        string        `json:"agent"`
	SigninDenied bool          `json:"signinDenied,omitempty"`
	Accounts     []accountView `json:"accounts"`
}

const (
	listTimeout  = 10 * time.Second
	usageTimeout = 12 * time.Second
	resetTimeout = 20 * time.Second
)

func accountID(agent, user string) string {
	sum := sha256.Sum256([]byte(agent + "\x00" + strings.ToLower(user)))
	return hex.EncodeToString(sum[:8])
}

func project(agent string, logins []provider.Login) []accountView {
	out := []accountView{}
	seen := map[string]bool{}
	for _, l := range logins {
		if strings.TrimSpace(l.User) == "" {
			continue
		}
		id := accountID(agent, l.User)
		if seen[id] {
			continue
		}
		seen[id] = true
		v := accountView{ID: id, Agent: agent, User: l.User, Plan: l.Plan, Active: l.Active, On: l.On || l.Active,
			Own: l.Own, Lapsed: l.Lapsed, NeedsRelogin: l.Lapsed != ""}
		if !l.Seen.IsZero() {
			at := l.Seen.UTC()
			v.Seen = &at
		}
		out = append(out, v)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Active && !out[j].Active })
	return out
}

func (k *kernel) agentAccounts(agent string) agentAccounts {
	return agentAccounts{Agent: agent, SigninDenied: k.guard.denied[agent], Accounts: project(agent, k.ops.Logins(agent))}
}

// within runs a Magpie call that takes no context, answering 504 when it
// outlives d (the call itself still finishes in the background).
func within[T any](w http.ResponseWriter, d time.Duration, call func() T) (T, bool) {
	type result struct {
		v   T
		err error
	}
	done := make(chan result, 1)
	go func() {
		defer func() {
			if p := recover(); p != nil {
				done <- result{err: fmt.Errorf("magpie failed: %v", p)}
			}
		}()
		done <- result{v: call()}
	}()
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case res := <-done:
		if res.err != nil {
			fail(w, 500, "kernel_error", "magpie failed while reading the accounts")
			return res.v, false
		}
		return res.v, true
	case <-timer.C:
		fail(w, 504, "timeout", "magpie took too long")
		var zero T
		return zero, false
	}
}

// accounts lists every pinned sign-in agent with its saved accounts, and
// the sign-ins Magpie found but leaves out (removed, or saved but signed out).
func (k *kernel) accounts(w http.ResponseWriter, r *http.Request) {
	type listing struct {
		Agents   []agentAccounts      `json:"agents"`
		Excluded []provider.Exclusion `json:"excluded"`
	}
	out, ok := within(w, listTimeout, func() listing {
		l := listing{Agents: []agentAccounts{}}
		for _, agent := range k.agents {
			l.Agents = append(l.Agents, k.agentAccounts(agent))
		}
		l.Excluded = nonNil(k.ops.Excluded())
		return l
	})
	if ok {
		writeJSON(w, 200, out)
	}
}

func validUser(user string) bool {
	if user == "" || len(user) > 320 || !utf8.ValidString(user) || strings.TrimSpace(user) != user {
		return false
	}
	return !strings.ContainsFunc(user, unicode.IsControl)
}

// accountAction is POST /internal/accounts/{on,off,switch,forget}
// {agent, user}: Magpie's login/on, login/off, login/switch, login/forget.
func (k *kernel) accountAction(w http.ResponseWriter, r *http.Request) {
	action := r.PathValue("action")
	switch action {
	case "on", "off", "switch", "forget":
	default:
		fail(w, 404, "not_found", "no such kernel route")
		return
	}
	var req struct {
		Agent string `json:"agent"`
		User  string `json:"user"`
	}
	if !decode(w, r, 64<<10, &req) || !k.agentOf(w, req.Agent) {
		return
	}
	if !validUser(req.User) {
		fail(w, 400, "invalid_request", "invalid user")
		return
	}
	var err error
	switch action {
	case "on", "off":
		err = k.ops.SetLoginOn(req.Agent, req.User, action == "on")
	case "switch":
		err = k.ops.SwitchLogin(req.Agent, req.User)
	case "forget":
		err = k.ops.ForgetLogin(req.Agent, req.User)
	}
	if err != nil {
		status, code := 400, "rejected"
		found, active := false, false
		for _, a := range project(req.Agent, k.ops.Logins(req.Agent)) {
			if a.ID == accountID(req.Agent, req.User) {
				found, active = true, a.Active
			}
		}
		switch {
		case !found:
			status, code = 404, "not_found"
		case active:
			code = "account_active"
		}
		fail(w, status, code, err.Error())
		return
	}
	writeJSON(w, 200, k.agentAccounts(req.Agent))
}

// accountUsage is GET /internal/accounts/usage?agent=: Magpie's
// LoginUsage, each account's allowance by user (Magpie caches each one 60 s).
func (k *kernel) accountUsage(w http.ResponseWriter, r *http.Request) {
	agent := r.URL.Query().Get("agent")
	if !k.agentOf(w, agent) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), usageTimeout)
	defer cancel()
	usage := k.ops.LoginUsage(ctx, agent)
	if usage == nil {
		usage = map[string]provider.SubscriptionQuota{}
	}
	writeJSON(w, 200, map[string]any{"agent": agent, "usage": usage})
}

// codexReset spends one of a Codex account's rate-limit resets; it can't be
// undone, so the console asks first.
func (k *kernel) codexReset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		User string `json:"user"`
	}
	if !decode(w, r, 64<<10, &req) {
		return
	}
	if !validUser(req.User) {
		fail(w, 400, "invalid_request", "invalid user")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), resetTimeout)
	defer cancel()
	out, err := k.ops.UseCodexReset(ctx, req.User)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			fail(w, 504, "timeout", "magpie took too long")
			return
		}
		fail(w, 400, "rejected", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"user": req.User, "code": out.Code, "windows": out.Windows, "text": out.Text()})
}
