# Following Magpie's Kernel and Source API

## Acceptance and Current Scope

Keep Crosery Console and its authoritative keys, policy and ledger. Reuse the
upstream inference implementation; do not copy the upstream UI or expose every
upstream management route as a proxy.

Observable acceptance for this change:

- A clean source checkout reproduces the committed route/type artifacts.
- Admission uses generated provider types and checks its approved inference
  routes and Gemini methods against the generated route registry.
- Kernel builds reject stale artifacts, a wrong source revision and changed
  overlay seams. The health endpoint reports the revision embedded by the build.
- A scheduled check detects route, field, login-type and implementation changes,
  generating a separate candidate without replacing code, credentials or data.
- Console reports the running revision, candidate changes and unconnected
  capabilities honestly. An upstream removal never deletes a local account.

This implements source-contract following and candidate generation, not arbitrary
business-code rewriting or automatic installation of an unverified kernel.
The headless host exposes Magpie's own sign-in, account list/actions, per-agent
usage and Codex reset on its private socket (see CONSOLE-KERNEL.md); the
subscription catalog is generated from the same pin by `scripts/magpie-catalog.mjs`
and its build check fails on reviewed sign-in policy drift. Accounts signed in
there do not serve inference yet.

## Source API Analysis

The pinned baseline is `3fe2ff99587e17dfe0ea707ffd0eccc088824433`. The generated
[API inventory](upstream/API.md) lists 107 registered routes and 399 named Go
types. Build-conditional routes remain in the inventory, but are excluded from
the default TypeScript registry.

There are two separate listeners in upstream:

| Surface | Upstream source | Crosery treatment |
| --- | --- | --- |
| Inference | `internal/gateway/gateway.go`, `Server.Handler()` | Import the real kernel; put Crosery admission and accounting in front |
| Management | `internal/gui/*.go`, HTTP route registrations | Parse the contract; adapt selected operations explicitly |

Inference includes Chat, Responses, Messages, token counting, image generation
and editing, Gemini's model/method dispatcher, and a wildcard Codex backend
dispatcher. A wildcard registration is not an exhaustive list of its dynamic
operations. Crosery currently approves only the existing four-protocol JSON
generation/counting paths and filtered model lists. Images, arbitrary Codex
operations and all management paths remain blocked at admission.

OAuth source routes:

| Route | Input / Result |
| --- | --- |
| `POST /api/signin` | `Agent`, `Site`; `provider.SignInState` |
| `GET /api/signin/{id}` | Poll the same sign-in state |
| `POST /api/signin/{id}/cancel` | Cancel; HTTP 204 |
| `POST /api/signin/{id}/callback` | `URL`; HTTP 204 |
| `POST /api/signin/import` | `Agent`, `Files`; validates imported accounts with the vendor |

`internal/provider/signin.go` owns vendor authorization, PKCE/callback or device
flows and account persistence. Its state contains `id`, `agent`, `url`, `state`
and optional code, callback, installation, user, plan and error fields. These
are vendor sign-ins driven by Magpie, not a Magpie-hosted identity service.
Starting a flow may install an agent CLI; successful account operations can
also alter agent state. Imports may refresh tokens and invalidate another
gateway's copy. None of those actions runs during source inspection.

RTK here means the command-output compression tool and agent hooks, not Redux
Toolkit and not an inference protocol:

| Route | Input / Result |
| --- | --- |
| `GET /api/library/rtk` | `library.RTKView` |
| `POST /api/library/rtk` | `Agent`, `On`; change the agent hook |
| `POST /api/library/rtk/install` | Install the RTK binary |
| `POST /api/library/rtk/upgrade` | Upgrade the RTK binary |

These operations write local agent configuration or install executable files.
The detector tracks their source contract and public RTK release only. It does
not install RTK, modify hooks, execute upstream code or sign in any account.

## Generated Contract Ownership

The trusted generator is `scripts/magpie-api/main.go` plus
`scripts/magpie-upstream.mjs`, owned by this repository. It uses Go's AST parser
and standard library only. It scans gateway, GUI, provider, library, catalog and
usage source; it does not import, compile or execute the candidate's packages.
There are no new npm production dependencies.

Committed, reviewed baseline:

- `deploy/magpie/upstream/api.json`: source routes, JSON-tagged shapes, query
  parameters, action dispatch, login IDs and semantic source hashes.
- `deploy/magpie/upstream/API.md`: navigable route inventory with source locations.
- `packages/contracts/magpie-upstream.generated.ts`: route IDs, request/response
  maps, named types, login IDs and the single trusted source revision.

Do not edit these files manually. Source shapes are not an OpenAPI or complete
wire-level compatibility proof. Dynamic JSON, embedding, custom marshaling and
unresolved responses remain `unknown`. Slice/map nullability is preserved.
Conditional declarations, aliases, dynamic dispatch, optional input semantics,
errors, headers, streaming and authorization still require wire tests.

Actual consumers are `server/magpieEngine.ts`, `server/magpieUpstream.ts`, the
kernel build, and the Console version panel. TypeScript checks provider mapping
against the generated upstream type. Regenerating a baseline after a required
route removal causes a compile/check failure, rather than silently forwarding
new routes with no policy review.

## Detect and Review

Use Node 24, Git and Go. These commands are local-only:

```sh
npm run magpie:api:generate -- --source /path/to/reviewed/clean/magpie
npm run magpie:api:verify -- --source /path/to/reviewed/clean/magpie
npm run magpie:upstream:check
npm run magpie:upstream:install
```

The installer preserves credential-free HTTP/SOCKS proxy settings from the
terminal so Git can also reach upstream from LaunchAgent. It never copies the
terminal's complete environment or authenticated proxy URLs. To refresh an
existing service from this same checkout after a proxy/Node/path change, run
`npm run magpie:upstream:install -- --replace`; unrelated services are refused.

`generate` explicitly updates the trusted baseline; do not use it as a timer.
`verify` reproduces all three artifacts and rejects byte-level drift.
`check --source /path/to/clean/candidate` inspects a local candidate without
fetching public release metadata, useful for offline tests.

Online checks read the public main commit from `yetone/magpie`, the latest
release from `yetone/magpie-releases`, and the RTK release from `rtk-ai/rtk`.
The private runtime is `~/.agents/crosery/magpie-upstream`, overridable with
`MAGPIE_UPSTREAM_RUNTIME`. It contains one managed source checkout, immutable
candidate sets under `candidates/` and one `status.json` pointing to the latest
complete set; no per-harness duplicate implementation. Unchanged candidates are
deduplicated by all three output files, including generator format changes, and
publication stages all artifacts before the status is updated.
The macOS LaunchAgent `com.crosery.magpie-upstream-check` runs at load and every
1800 seconds. It references this checkout and the Node installation.

Checks use an exclusive `check.lock`, bounded network/process/source sizes and
timeouts, a clean Git checkout, disabled Git hooks and redacted failure messages.
Failures identify the inspection stage without logging raw response data.
Failures preserve the running deployment and previous candidate. A killed
checker can leave a lock: inspect its recorded PID and confirm it is no longer
running before removing that single stale lock. Never remove an active lock.
Detection refresh in the Console only rereads status; it does not install code.

Candidate adoption remains a deliberate local change:

1. Review `status.json` and its `artifact` candidate directory, including removed login types and
   implementation-only changes.
2. Generate a reviewed baseline from that exact clean commit.
3. Adapt consumers and asserted overlay seams; run artifact verification,
   TypeScript checks and a kernel build in an isolated runtime.
4. Run the real-kernel admission/stream/accounting tests and selected OAuth/RTK
   wire tests when those capabilities have been integrated.
5. Authorize deployment separately; keep the previous artifact and engine flag
   available for rollback. Do not install the official desktop binary over the
   headless host, which would bypass Crosery policy/accounting overlays.

## Automatic Update Policy

`scripts/magpie-autoupdate.mjs` adds a guarded path after detection. It is
driven by `~/.agents/crosery/magpie-upstream/autoupdate.json` (Console Settings
or `cradmin magpie auto on|off`; a missing file means on, window 03:00–06:00
local). The LaunchAgent runs `magpie-upstream.mjs scheduled`: `check`, then the
auto steps in the job's own process. The Console never replaces the kernel,
because the restart would kill it. An agent installed before this change still
runs `check` only, and the Console says so; activate with
`npm run magpie:upstream:install -- --replace` (the job needs `go` on PATH and
the proxy environment for `proxy.golang.org`).

Each new candidate is rehearsed once per input fingerprint:

1. Check out the clean candidate.
2. Classify it against the baseline with `scripts/magpie-autoupdate-policy.mjs`.
   A removed or changed route the Console uses, a changed schema those routes
   reach, removed login agents, catalog drift, settings drift, a new contract
   version or new diagnostics hold the candidate for review. Additive routes and
   schemas are allowed.
3. Build the overlay with `build-magpie-kernel.mjs --candidate --test`. This
   runs the contract verify, catalog check, every overlay seam, `go vet` and
   `go test`.
4. Run `scripts/magpie-kernel-smoke.mjs` on the staged binary with a temporary
   HOME.

A held candidate stays held until the baseline or candidate changes. Infra
failures (network, `go mod download`) back off for at least 30 minutes and do
not count as an attempt.

An eligible build is applied only inside the window, and never while a sign-in
lease (`signin-active.json`, written by the Console with a live pid) is open.
Each revision gets one attempt. The apply holds `check.lock`, then decides
again from disk (window, sign-in lease, switch, candidate, rehearsal), so a
decision made before a long rehearsal or a lock wait is never acted on stale. A
busy lock waits for the next round without spending the attempt. A staged build
that is missing or changed stops the apply before anything is touched; the
attempt is not spent and the candidate is rehearsed again after a back-off. A
rehearsal removes the superseded staged build. The apply sequence:

1. Verify the staged sha256.
2. Record the attempt, then copy the binary and kernel HOME to
   `autoupdate-backups/` (three are kept).
3. Rename the new binary into place.
4. `launchctl kickstart -k gui/$UID/com.crosery.console-magpie`.
5. Require kernel health with the new revision, the gateway `/health` and the
   Console session within 60 seconds.

If the restart command fails or any check fails, the backup binary and HOME are
restored (the backup HOME is copied aside first and renamed into place just
before the restart), the failed HOME is kept as `home.failed-*`, the kernel is
kicked again, and the revision is not retried. A rollback that cannot finish is
recorded as `rollback-failed`.

Manual rollback: `node scripts/magpie-autoupdate.mjs rollback --confirm`. It
only restores the kernel this job installed, and only while that kernel is the
one running (or the kernel is down). The HOME it restores is the one from the
moment of the install; the current HOME is kept as `home.failed-*`.

`scripts/rtk-autoupdate.mjs` upgrades RTK the same way. It reads releases
through the shared ETag cache and back-off, then downloads the platform asset
from GitHub. The asset must match a published sha256 (`checksums.txt` or the
release asset digest). Signature-only releases and releases without a checksum
are refused. The upgrade backs up the binary, swaps it atomically, checks
`rtk --version`, and restores the backup on failure. Right before the swap it
checks that the target is still the file it detected (same link target and
inode); otherwise nothing is replaced and the attempt is not spent. A release
that declares a BREAKING change between the local and latest versions is held
until `cradmin rtk upgrade --accept-breaking`. Homebrew installs use
`brew upgrade rtk`; a formula that is not updated yet is retried after a
back-off, not every round.

State and evidence live next to the candidates:

- `autoupdate-magpie.json`
- `autoupdate-rtk.json`
- `autoupdate/<rev12>/build.log`

## Recovery and Remaining Gates

Stop the read-only timer without touching the Console or kernel:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.crosery.magpie-upstream-check.plist"
```

The standard Console stop/start recovery remains documented in
[CONSOLE-KERNEL.md](CONSOLE-KERNEL.md). Detector artifacts never contain
credentials, account data, prompts or usage records.

Remaining work: expose narrowly authenticated headless management operations
using upstream provider/library functions, translate Crosery OAuth/account
flows and RTK controls, isolate their storage/agent-write effects, and gate
token refresh, migration and hook installation. Automatic kernel promotion is
limited to the guarded policy above.
No production cutover, historical-data migration or live OAuth/RTK action is
authorized or claimed by this source-contract change.

## Verification on September 30, 2026

- Go AST extractor: five tests passed, including conditional routes, nullable
  collections, Gemini dispatch, conservative unknowns and symlink rejection.
- Artifact generation and byte-for-byte verification passed against the clean
  pinned source.
- Isolated kernel build, upstream gateway/provider/usage tests and host `go vet`
  passed. Real-kernel tests verified the embedded revision and four protocols,
  streaming, policy denial, concurrency and accounting.
- Forty-seven focused Magpie and OAuth/version tests passed with no skips.
- Full suite: 486 tests, 465 passed, 21 failed, no skips. A separate clean
  `d85128c` baseline reproduced the same 21 failure names; none was introduced.
  Existing failures include pricing/cache accounting, credential validation,
  key policy and route/bootstrap behavior. This is not a globally green build.
- `npm run build` and bundle budgets passed. `npm run lint` passed with two
  existing `nativeResponses.ts` control-regex warnings. The Impeccable detector
  reported four existing CSS warnings outside this change.
- The aggregate `npm run typecheck` passed its root compiler phase, then failed
  because this checkout lacks `apps/data/tsconfig.json`. The separate data
  workspace and its deployment checks were not validated.
- Local service restart, administrator login, `/api/version` and `/health`
  passed. The installed detector completed through LaunchAgent with exit code
  0 after its missing credential-free proxy configuration was fixed.
- Browser checks at 1488x998 and 390x844 verified opening, change expansion,
  refresh, keyboard Enter/Escape, focus restoration and contained narrow-screen
  positioning. The TaskSpace was released. Screen-reader conformance and other
  browser engines were not tested.

The detected snapshot at 16:38:55 China Standard Time was main commit
`bcb9db935640deb24d7e90b0b0414810d49f0571`, with public release `v0.1.477`.
Compared with the pinned baseline, it added the two agent-model routes, changed
three management routes and 23 named types, changed 56 implementation files,
and removed `dimagent` from the login dispatcher. No registered route was
removed. Main and release are independent snapshots, not asserted to be the
same source revision.

The running kernel remains `3fe2ff99587e17dfe0ea707ffd0eccc088824433`. Its previous
local binary is retained as `bin/magpie-kernel.before-api-contract-20260930`
under the Console runtime for artifact rollback. Stop the Console service
before restoring that binary, then start it and verify health. This change
made no database, upstream account, token or agent-hook migration.
