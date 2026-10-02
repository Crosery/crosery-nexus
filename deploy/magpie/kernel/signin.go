package main

import (
	"net/http"
	"regexp"
	"slices"
)

var (
	agentRE    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)
	siteRE     = regexp.MustCompile(`^[a-z0-9-]{0,32}$`)
	signInIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
)

// maxCallbackURL is Magpie's own cap on a pasted callback address.
const maxCallbackURL = 16 << 10

// agentOf checks an agent named in a request: one of the pinned sign-in
// agents, lower case, no "agent:site" form. On failure it has answered.
func (k *kernel) agentOf(w http.ResponseWriter, agent string) bool {
	if !agentRE.MatchString(agent) || !slices.Contains(k.agents, agent) {
		fail(w, 400, "agent_unknown", "not a sign-in agent of this kernel")
		return false
	}
	return true
}

func (k *kernel) signinStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agent string `json:"agent"`
		Site  string `json:"site"`
	}
	if !decode(w, r, 64<<10, &req) || !k.agentOf(w, req.Agent) {
		return
	}
	if !siteRE.MatchString(req.Site) {
		fail(w, 400, "invalid_request", "invalid site")
		return
	}
	// refused before Magpie looks for (or installs) the agent's CLI
	if k.guard.denied[req.Agent] {
		fail(w, 400, "agent_disabled", req.Agent+" signs in through a CLI or installer run on this machine, which this kernel has disabled")
		return
	}
	st, err := k.ops.StartSignIn(req.Agent, req.Site)
	if err != nil {
		fail(w, 400, "rejected", err.Error())
		return
	}
	writeJSON(w, 200, st)
}

func (k *kernel) signinStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !signInIDRE.MatchString(id) {
		fail(w, 404, "not_found", "no such sign-in")
		return
	}
	st, ok := k.ops.SignInStatus(id)
	if !ok {
		fail(w, 404, "not_found", "no such sign-in")
		return
	}
	writeJSON(w, 200, st)
}

func (k *kernel) signinCallback(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	if !decode(w, r, maxCallbackURL+(4<<10), &req) {
		return
	}
	if len(req.URL) == 0 || len(req.URL) > maxCallbackURL {
		fail(w, 400, "invalid_request", "invalid callback URL")
		return
	}
	if !signInIDRE.MatchString(req.ID) {
		fail(w, 404, "not_found", "no such sign-in")
		return
	}
	if _, ok := k.ops.SignInStatus(req.ID); !ok {
		fail(w, 404, "not_found", "no such sign-in")
		return
	}
	if err := k.ops.SubmitSignInCallback(req.ID, req.URL); err != nil {
		fail(w, 400, "rejected", err.Error())
		return
	}
	w.WriteHeader(204)
}

// signinCancel answers 204 for an unknown id too, as Magpie does.
func (k *kernel) signinCancel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if !decode(w, r, 64<<10, &req) {
		return
	}
	if signInIDRE.MatchString(req.ID) {
		k.ops.CancelSignIn(req.ID)
	}
	w.WriteHeader(204)
}
