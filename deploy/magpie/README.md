# Magpie + Crosery CPA Local Deployment

## Decision

This is an isolated, local-only integration, not a production CPA replacement.
The current Console, its database, quota enforcement, API keys and OAuth accounts
remain authoritative and unchanged.

```text
Client -> Magpie 127.0.0.1:3465
       -> credential bridge 127.0.0.1:3467
       -> https://ai.crosery.com -> CPA -> upstream

Browser -> 127.0.0.1:3467/open -> authenticated Magpie web UI :3466
```

The bridge is necessary because upstream Magpie stores provider keys in
`providers.json` and does not resolve them from environment variables. Instead,
this deployment stores non-secret key-slot identifiers, resolves the Crosery key
from the shared credential store or an injected environment variable, and adds
upstream authentication only in memory. Existing ordinary provider keys and
custom headers are read from the original private `providers.json`; they are not
copied into the isolated runtime. Restart the service after rotating these keys.

There is one implementation in this repository and one runtime under
`~/.agents/crosery/magpie`. No implementation or model audit table is copied into
individual agent harness directories.

## Observable Acceptance

- Magpie exposes the shared Crosery catalog with audited context/output limits,
  image-input flags and reasoning efforts.
- Chat, Responses and Messages reach the corresponding CPA HTTP paths.
- SSE reaches the client before the upstream finishes.
- No real upstream key appears in the generated provider configuration, CLI
  arguments, service plist or logs.
- The original Magpie instance and agent settings are not switched or overwritten.
- Preparation refuses to overwrite an existing runtime; copied snapshots have
  recorded SHA-256 checksums.
- The new process is loopback-only and can be stopped without affecting CPA.

## Install

Requires the repository's Node 24 runtime, Git and Go >= 1.26.3. Upstream source is
pinned to `3fe2ff99587e17dfe0ea707ffd0eccc088824433`; it is not patched or vendored
into the Console. `go.sum` supplies upstream dependency integrity checks.

```sh
node scripts/magpie-local.mjs prepare
sh deploy/magpie/build.sh
node scripts/magpie-service.mjs install
```

The service installer is macOS-only and refuses an existing plist. Other hosts
can run `node scripts/magpie-local.mjs start` in the foreground. To build from an
already reviewed clone:

```sh
MAGPIE_SOURCE=/path/to/pinned/clean/magpie sh deploy/magpie/build.sh
```

The prepared runtime is separate from `~/.config/magpie`. The Magpie child has its
own `HOME`, XDG directories and an allowlisted environment, so its automatic
catalog writes and any model changes made in this web UI target the scratch
home, not the real agents. This is intentional: do not interpret the UI's
"default" agent selections as the actual agents' current selections.

Open `http://127.0.0.1:3467/open`. The bridge supplies a random, per-run admin
key via a local redirect; Magpie immediately exchanges it for an HttpOnly cookie
and removes it from the URL. The real key is not printed or saved.

API bases:

| Client | Base | Local key | Example model |
| --- | --- | --- | --- |
| OpenAI Chat / Responses | `http://127.0.0.1:3465/v1` | `magpie` | `crosery/gpt-5.6-luna` |
| Anthropic | `http://127.0.0.1:3465` | `magpie` | `crosery/claude-sonnet-4-6` |
| Gemini | `http://127.0.0.1:3465` | `magpie` | `crosery/gpt-5.6-luna` |

`magpie` is a loopback placeholder, not an authentication boundary.
Do not paste real upstream credentials into this isolated Magpie UI. Rotate the
shared credential or the original provider's credential instead, then restart
this service; upstream Magpie's ordinary Add Provider flow still stores keys.

## Migration Scope

| Data | Local treatment | Limit |
| --- | --- | --- |
| Existing ordinary provider IDs, chosen models, routing groups, key slots | Preserve IDs and picks; route to their original endpoints via the bridge | Preset-specific adapters, balances, custom model lists and custom proxies are not equivalent; proxies requiring review are imported off |
| Existing primary/additional API keys and private headers | Reference original private file, load into bridge memory | Original file must remain available; restart to reload; no credential copy |
| Display preferences and model overrides | Allowlisted copy | LAN sharing, warmups, telemetry and automatic check-in stay disabled |
| Profiles, local usage JSONL, cached quotas | Bounded regular-file copy with checksums when present and not flagged as sensitive | Profiles with library/credential fields are skipped; quota caches are not authoritative quotas |
| Magpie / agent OAuth sign-ins | Do not copy or refresh the original credentials | Provider picks are retained but hidden/off; a separate authorized sign-in is needed |
| Library, instructions, MCP, skills and agent stashes | Keep original instance's files | No automatic application to real agents |
| Console / CPA users, keys, policies, quota ledgers, audit and usage database | Keep existing system unchanged | Not schema-compatible with Magpie; no "lossless migration" claim |

The 64 MiB snapshot limit is for this rehearsal, not a bulk-history migration.
Failures leave the new directory for inspection and never delete the original.
There is no production SSH, management write, external publish or traffic
cutover in these commands.

Model discovery remains owned by `~/.agents/crosery/sync.mjs`. The adapter reads
`catalog.json` offline and prepares a fixed snapshot; it never independently
requests the gateway model list. Magpie's Refresh uses the bridge's snapshot,
not a second network sync. Creating a new reviewed runtime is currently required
to adopt a new shared-catalog snapshot. A fresh models.dev catalog may enrich
Magpie display information later; it is not our authoritative model audit.

## Protocol Limits

Chat, Responses and Messages have conditional same-protocol forwarding in
Magpie, not byte-for-byte transparency. Magpie can modify roles, model names,
reasoning controls, headers and SSE frames. CPA may also translate further.

Gemini is a client-side protocol in the ordinary provider model. Its generation
requests are converted through Magpie's intermediate representation, not sent
to CPA's native Gemini endpoint. Safety/grounding metadata, multiple candidates,
some file/media and structured-output semantics are not fully represented.

Messages token counting may fall back to an estimate; Gemini counting is local
estimation. Do not use these counts as the authoritative billing tokenizer.

Images have separate request/response rebuilding and are not ordinary native
passthrough. Image generation/editing, masks and multipart behavior were not
live-tested against paid image models in this deployment.

Parallel interleaved tool-call deltas, sealed reasoning state, truncated streams,
Responses WebSocket/compact/resource operations and advanced built-in tools
need separate compatibility gates. Keep the original CPA endpoint available
for clients that need these features. Detailed findings and fixed source
references are in `docs/research/magpie-cpa-integration.md`.

## Threat Model

Assets are gateway credits, prompts/tool results, old provider keys, OAuth
credentials and local configuration. Actors are the local user, local
applications/browser pages and upstream providers.

All three ports bind only to `127.0.0.1`. The bridge rejects browser Origin,
cross-site fetches, foreign Host headers, unregistered routes, arbitrary query
parameters, invalid key slots and oversized streamed uploads. It strips client
credentials, cookies and hop-by-hop headers; it does not follow upstream
redirects. Outbound calls have a wall-clock timeout and stream with backpressure.
Only configured provider destinations can be reached through it.

These controls do not turn Magpie into a multi-tenant server. Any trusted local
process able to reach its gateway can spend the configured provider allowance.
Magpie has additional upstream security limitations, including image-URL fetch
SSRF and unbounded request reads before the bridge sees the body. Browser-to-
Magpie origin isolation, malicious local processes, full resource limits and
advanced converter failures are not proven secure by this test suite.

Do not expose these ports on LAN/public interfaces, reverse-proxy the entire
web UI, or enable sharing without a separately reviewed authentication,
authorization, egress and resource-limit design. In particular, publishing a
shared Magpie provider key would collapse CPA's per-client identity and quotas.

## Verify And Recover

```sh
node --test scripts/magpie-local.test.mjs
node scripts/magpie-local.mjs verify
node scripts/magpie-service.mjs status
curl http://127.0.0.1:3467/health
```

The following command explicitly performs four tiny live model requests and two
counting requests. It is never included in `npm test`:

```sh
node scripts/magpie-smoke.mjs --live
```

Service logs contain wrapper status only. Upstream stdout/stderr are suppressed
because Magpie prints its admin bearer link and may include private diagnostic
values. Inspect the authenticated local UI for request diagnostics; do not
export prompts/tool results or raw provider headers into shared logs.

```sh
node scripts/magpie-service.mjs stop
node scripts/magpie-service.mjs start
```

`stop` unloads only `com.crosery.magpie-local` and retains all files. This is the
rollback entry point: the original Magpie at `3425` and the original CPA remain
running and do not require restoration. No database rollback is involved.
The service references this repository and the current Node binary, so moving
the checkout or removing that Node installation requires a reviewed service
reinstall.
