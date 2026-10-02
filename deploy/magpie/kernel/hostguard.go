package main

import (
	"path/filepath"
	"sort"
	"strings"

	"github.com/yetone/magpie/internal/proc"
)

// hostExecAgents sign in by running the vendor's CLI on this machine, and
// install it with `curl … | bash` when it is missing. They stay off unless
// MAGPIE_KERNEL_HOST_EXEC names them; their CLIs are then never started.
var hostExecAgents = map[string][]string{
	"cursor": {"cursor-agent", "agent"},
	"devin":  {"devin"},
	"grok":   {"grok"},
}

// neverRun are programs the kernel never starts, whatever is enabled: the
// macOS login keychain and Linux keyring tools, and Claude Code, whose own
// sign-in on macOS is the login keychain item. The kernel's accounts live in
// files under its own HOME.
var neverRun = []string{"security", "secret-tool", "claude"}

type hostGuard struct {
	denied   map[string]bool // agents whose sign-in is refused
	commands map[string]bool // program base names proc refuses to start
}

func newHostGuard(allow string) hostGuard {
	enabled := map[string]bool{}
	for _, agent := range splitList(allow) {
		enabled[agent] = true
	}
	g := hostGuard{denied: map[string]bool{}, commands: map[string]bool{}}
	for _, name := range neverRun {
		g.commands[name] = true
	}
	for agent, programs := range hostExecAgents {
		if enabled[agent] {
			continue
		}
		g.denied[agent] = true
		for _, name := range programs {
			g.commands[name] = true
		}
	}
	return g
}

// install makes proc refuse the guarded programs before they start. It runs
// once in main, before the kernel serves anything.
func (g hostGuard) install() {
	commands := g.commands
	proc.CroseryDeny = func(name string) bool {
		base := strings.ToLower(filepath.Base(name))
		return commands[strings.TrimSuffix(base, ".exe")]
	}
}

func (g hostGuard) deniedAgents() []string {
	out := make([]string, 0, len(g.denied))
	for agent := range g.denied {
		out = append(out, agent)
	}
	sort.Strings(out)
	return out
}
