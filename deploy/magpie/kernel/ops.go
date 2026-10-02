package main

import (
	"context"

	"github.com/yetone/magpie/internal/provider"
)

// magpieAPI is the part of the pinned provider package the control routes
// use; tests replace it.
type magpieAPI interface {
	StartSignIn(agent, site string) (provider.SignInState, error)
	SignInStatus(id string) (provider.SignInState, bool)
	CancelSignIn(id string)
	SubmitSignInCallback(id, url string) error
	Logins(agent string) []provider.Login
	Excluded() []provider.Exclusion
	SetLoginOn(agent, user string, on bool) error
	SwitchLogin(agent, user string) error
	ForgetLogin(agent, user string) error
	LoginUsage(ctx context.Context, agent string) map[string]provider.SubscriptionQuota
	UseCodexReset(ctx context.Context, user string) (provider.ResetOutcome, error)
}

type magpieOps struct{}

func (magpieOps) StartSignIn(agent, site string) (provider.SignInState, error) {
	return provider.StartSignInAt(agent, site)
}
func (magpieOps) SignInStatus(id string) (provider.SignInState, bool) {
	return provider.SignInStatus(id)
}
func (magpieOps) CancelSignIn(id string) { provider.CancelSignIn(id) }
func (magpieOps) SubmitSignInCallback(id, url string) error {
	return provider.SubmitSignInCallback(id, url)
}
func (magpieOps) Logins(agent string) []provider.Login { return provider.Logins(agent) }
func (magpieOps) Excluded() []provider.Exclusion       { return provider.Excluded() }
func (magpieOps) SetLoginOn(agent, user string, on bool) error {
	return provider.SetLoginOn(agent, user, on)
}
func (magpieOps) SwitchLogin(agent, user string) error { return provider.SwitchLogin(agent, user) }
func (magpieOps) ForgetLogin(agent, user string) error { return provider.ForgetLogin(agent, user) }
func (magpieOps) LoginUsage(ctx context.Context, agent string) map[string]provider.SubscriptionQuota {
	return provider.LoginUsage(ctx, agent)
}
func (magpieOps) UseCodexReset(ctx context.Context, user string) (provider.ResetOutcome, error) {
	return provider.UseCodexReset(ctx, user)
}
