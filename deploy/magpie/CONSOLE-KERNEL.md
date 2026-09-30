# Crosery Console With the Magpie Inference Kernel

## Scope and Acceptance

This is the corrected integration: retain Crosery Console, replace the inference
implementation with Magpie. It does not use the Magpie UI or send inference
through the old CPA gateway. The older `local.mjs` experiment is separate and is
not this deployment.

Risk class: R3 (admission, accounting, migration). This deployment is local-only,
reversible, and experimental, not a production cutover.

Observable acceptance:

- The existing Crosery UI logs in and manages its own local API keys and channels.
- The inference response identifies `X-Crosery-Engine: magpie`.
- Chat, Responses, Messages and Gemini generation cross the real pinned kernel.
- The selected provider receives its original model ID and upstream credential.
- Model lists and requests enforce the same channel policy, including duplicate
  model names across allowed and disallowed channels.
- Disabled keys, exceeded quotas and concurrency limits reject before forwarding.
- Usage settles through the existing `persistUsageRecords` transaction, quota
  ledger and outbox, with the original public model and channel names.
- No upstream secret is copied into channel snapshots, manifests, logs or source.
- Restoring a local database snapshot passes SQLite integrity and row-count checks.
- Stop/start recovery works without touching the original gateway or desktop app.

## Implementation and Ownership

```text
Browser -> Crosery Console :8791 -> local channel registry + existing SQLite schema
Client  -> Crosery admission :8790 -> private Unix socket -> Magpie kernel
                                                        -> channel upstream

CPA management GET -> credential source -> memory -> private kernel configuration
                      (no CPA inference request and no source management writes)
```

`server/magpieEngine.ts` owns admission, protocol route selection, streaming and
accounting translation. `server/magpieRuntime.ts` joins it to existing Console
keys, quotas and usage storage. `server/magpieControl.ts` adapts the established
management consumers to the local registry; SQLite owns key state and policy.
The old CPA model/channel ACL setters intentionally do not create another policy
store in local mode: admission reads SQLite directly for every call.

The Go host imports `internal/gateway`, `internal/provider` and `internal/usage`
from upstream revision `3fe2ff99587e17dfe0ea707ffd0eccc088824433`.
It does not import the GUI, invoke agent configuration, run login refreshers,
or start warmups, check-ins or telemetry.
Upstream is MIT-licensed; the build retains its license alongside the binary.
The pinned revision is read from the generated source API contract. See
[UPSTREAM.md](UPSTREAM.md) for API analysis, contract generation, scheduled
detection, candidate review and the remaining OAuth/RTK integration gates.

The build uses an asserted Go overlay, not an untracked fork:

- provider configuration is injected and kept in process memory;
- usage records have a request ID and an in-memory sink instead of a JSONL file;
- inference request IDs are attached to ordinary, image and Codex usage records.

The original source remains clean. The overlay fails if its expected seams
change. The separate host is under `deploy/magpie/kernel/main.go`.

The host's socket is `0600` inside a `0700` directory. Both inference and internal
configuration operations are accessible only through that socket, not another
unauthenticated TCP port. Upstream credentials travel in memory through it.
Usage metadata returns on a private HTTP trailer that the admission module does
not forward to the client.

Each channel/model mapping becomes an explicit kernel provider slot. There is no
kernel cross-channel fallback: choosing another channel without a new admission
decision would violate key authorization. Duplicate authorized model mappings
rotate at admission, and multiple keys within a slot use Magpie's key rotation.

## Configuration

| Setting | Meaning |
| --- | --- |
| `GATEWAY_ENGINE=cpa` | Default, retains the original application behavior |
| `GATEWAY_ENGINE=magpie` | Starts Magpie-backed admission on a distinct loopback port |
| `MAGPIE_CONTROL_PLANE=local` | Local registry and Console SQLite key ownership |
| `MAGPIE_CONTROL_PLANE=cpa` | Transitional CPA management ownership; inference still goes directly through Magpie |
| `MAGPIE_KERNEL_SOCKET` | Private kernel socket path |
| `MAGPIE_CHANNELS_FILE` | Version 1 registry, never raw upstream keys |
| `MAGPIE_PORT` | Admission port, default `8790` |
| `MAGPIE_TIMEOUT_MS` | Request deadline, default 10 minutes |
| `MAGPIE_SOURCE_CPA_BASE_URL` | Read-only source management address |
| `MAGPIE_SOURCE_CPA_KEY_FILE` | Existing private management credential reference |
| `CONSOLE_PASSWORD_FILE` | Existing private Console password reference |
| `SESSION_SECRET_FILE` | Optional existing private session secret reference |

`NATIVE_RESPONSES_ENABLED` must be false in Magpie mode, and the Console and
admission ports must be distinct. The launcher gives the kernel an isolated HOME
and an allowlisted environment. Existing file-backed credentials remain path
references; a local Keychain password is injected into the Console environment
in memory only. Its per-run Console session secret is memory-only.

Registry example, using an environment or private file-backed credential:

```json
{
  "version": 1,
  "channels": [{
    "name": "example",
    "base-url": "https://upstream.example/v1",
    "protocol": "responses",
    "api-key-entries": [{"api-key": "env:EXAMPLE_UPSTREAM_KEY"}],
    "models": [{"name": "upstream-model", "alias": "public-model"}]
  }]
}
```

Supply `EXAMPLE_UPSTREAM_KEY` or `EXAMPLE_UPSTREAM_KEY_FILE`, never both.
Imported CPA references are hashed channel selectors and slot numbers; they read
the original credential at runtime and do not copy it. Source reads are cached
for five seconds. They fail closed if the source is unavailable. Imported slot
order must remain stable; review an upstream key-pool reorder before using it.
Local channel/model enable, disable and restore operate on this registry only.

## Build and Run

Requires the repository's Node 24 runtime and Go >= 1.26.3. No new npm production
dependency was added. Set `MAGPIE_SOURCE` to a clean clone at the pinned revision.

```sh
MAGPIE_SOURCE=/path/to/pinned/magpie npm run magpie:build
npm run magpie:prepare
npm run magpie:install
```

The macOS LaunchAgent is `com.crosery.console-magpie`. Its persistent runtime is
`~/.agents/crosery/magpie-console`, and it uses the Node binary that installed it.
`prepare` refuses an existing manifest or data directory.

Open `http://127.0.0.1:8791`. The username is `admin`. By default, preparation
references the existing Crosery API Console password without changing it.
For an independent local password, replace `consolePasswordFile` in the runtime
manifest with a macOS Keychain reference:

```json
{
  "consolePasswordKeychain": {
    "service": "com.crosery.console-magpie.local",
    "account": "admin"
  }
}
```

Create that item with an interactive hidden prompt, never a password argument:

```sh
security add-generic-password -a admin -s com.crosery.console-magpie.local -w
```

Keep exactly one password reference. A missing or unreadable Keychain item fails
startup without falling back to shared credentials. Restart the local service
after changing the reference; existing sessions are invalidated on restart.
A simple local password must remain loopback-only and must not be reused for
production. To revert, restore the original `consolePasswordFile` reference,
remove `consolePasswordKeychain`, and restart. Never overwrite the shared file.

The model-client base is `http://127.0.0.1:8790/v1`; use a key created by this
local Crosery Console, not `magpie` or a shared upstream key.
Messages and Gemini clients use the root `http://127.0.0.1:8790`.

```sh
node --import tsx scripts/magpie-console.mjs status
curl http://127.0.0.1:8790/health
MAGPIE_KERNEL_TEST_BINARY="$HOME/.agents/crosery/magpie-console/bin/magpie-kernel" npm run test:magpie
node scripts/magpie-console-smoke.mjs --live
```

The live smoke explicitly opts into four tiny `openrouter/free` calls. It logs
only status, engine and byte counts, creates one temporary local key and removes
it in `finally`. It never runs in the automatic unit-test suite.

## Migration Status

The local rehearsal preserves channel names, model IDs, aliases and key slots
without replacing the Console database schema. The prepared runtime has a
manifest containing counts, a restored-database checksum and pending items.

On September 30, 2026:

- `commandcode` and `openrouter` were imported as enabled direct channels.
- `cline-pass` and `qoder-cn` were imported disabled because their source URLs
  refer to the production machine's loopback, not this computer.
- Twelve source OAuth accounts were not copied, refreshed or switched.
- Only the repository's local sample SQLite database was restored, with zero
  API keys, usage events, quota events and channel rows. This was not a restore
  of production historical usage or production client keys.

The sample rehearsal refuses a database containing API keys or provider
snapshots rather than creating another secret copy. A populated installation
should retain its authoritative database in place behind the reversible engine
flag, after explicit production authorization and policy/ledger verification.
Do not run the local `prepare` command against production data.

Full CPA removal is not complete: imported credentials still depend on read-only
CPA management. OAuth formats and refresh lifecycles are not equivalent and need
an explicit adapter and separate verification. There is no claim of a painless,
lossless production migration at this stage.

## Protocol and Product Gates

- Chat, Responses and Messages may be translated or normalized by Magpie.
- Gemini is a client protocol translated through Magpie's IR, not a native
  Gemini upstream. Native Gemini and Vertex entries are reported as pending.
- Counts are estimates where upstream counting is unavailable, not billing truth.
- Stateful Responses, encrypted reasoning, built-in tools, remote media URLs,
  image generation/editing, Responses WebSocket/resource operations and arbitrary
  Magpie admin endpoints are not exposed through this admission module.
- Complex tool streams, advanced reasoning, provider-specific features and
  truncation/clean-EOF behavior have not received production compatibility gates.
- The local registry accepts credential references, not raw keys pasted into
  Console channel forms. Local CPA OAuth/account actions and model scanning are
  explicitly unsupported, not silently forwarded to production management.
- Imported API-key channels with unknown endpoints default to Chat; native
  Responses or Messages need an explicit slot. Mixed per-key proxies fail closed.
- Local mode restores the existing price snapshot/static prices; it does not
  independently discover or audit the shared Crosery gateway model catalog.
  Price/capability parity with production remains a separate acceptance gate.

Inference keeps the OpenAI-compatible error envelope to preserve the existing
wire contract instead of replacing it with RFC 9457 bodies. This is an
experimental compatibility endpoint, not a new management API.

## Security and Recovery

Assets: credits, client identity, prompts, upstream secrets, local ledger and
management credentials. Actors: authenticated local administrators, model
clients, local processes/browser pages and configured upstreams.

Controls: authenticated Console sessions; per-request key/policy/quota checks;
per-key/per-channel concurrency; exact loopback Host and Origin checks;
8 MiB request limit; deadlines; streaming backpressure; private socket; no public
kernel/admin UI; no automatic OAuth credential mutation; no prompt/body logging;
no inference through CPA; no source management writes. A ledger failure blocks
further admission in that process.

Residual risks: same-user local processes remain trusted; the Go converter is
not a hardened multi-tenant service; memory/crash dumps can contain credentials;
there is no crash-durable cross-process usage handoff yet. Abrupt process loss
after an upstream call but before SQLite settlement can lose accounting. Do not
publish this local deployment before resolving that gap and completing egress,
resource, protocol, pricing and OAuth migration gates.

```sh
node --import tsx scripts/magpie-console.mjs stop
node --import tsx scripts/magpie-console.mjs start
```

Stopping only unloads this LaunchAgent and retains its data. The original CPA,
production traffic and original desktop Magpie are unchanged. The application
kill switch is `GATEWAY_ENGINE=cpa`; that alone does not move external traffic
or undo local data written during a rehearsal.

Checks run: actual Go-overlay build, gateway/provider/usage Go tests, host vet,
focused Console tests, full existing test suite, production web build, local
browser login and channels, live four-protocol smoke and service recovery.
The full existing suite retained 21 pre-existing failures in pricing/cache,
credentials, key access and route wiring; it was not globally green.
The Pi-only `/deepsec-audit` command was not available in this Codex host; the
security checks here are the focused admission tests, source review and known
credential-copy scan, not a claim of an automated DeepSec audit.
