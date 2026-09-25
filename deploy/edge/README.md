# Edge release layout

The public edge remains an independently reversible release. Do not overwrite
the mutable production checkout in place.

```text
/opt/crosery-api-console-releases/<release-id>/  immutable application release
/opt/crosery-api-console-current                 atomic symlink to that release
/opt/crosery-node-v24...                         pinned Node 24 runtime
/opt/crosery-node-current                        atomic symlink to that runtime
/opt/crosery-api-console/data                    existing mutable SQLite owner
/opt/crosery-api-console/.env                    existing root-owned environment
```

Every release contains `MANIFEST.sha256`, `RELEASE.json`, production `dist/`
and the exact `package-lock.json`. The release is verified with the pinned Node
runtime before either symlink changes. The existing `.env` is merged in place;
it is never copied from `.env.example` or stored in the release.

## Safe order

1. Run the full verification suite and production-size offline benchmark.
2. Create and verify a SQLite online backup on a separate host/storage boundary.
3. Save the current unit, nginx site, current symlink targets, counts and latency baseline.
4. Stop the old edge, checkpoint/truncate its WAL, then atomically point the two
   `*-current` symlinks at the reviewed release and runtime.
5. Install the unit in `systemd/`, run `systemd-analyze verify`, reload systemd
   and start the edge. Keep data-plane reads locked to `sqlite`.
6. Require loopback health, exact usage totals, warm p95, nginx validation and
   zero restarts before increasing exposure.

Application rollback restores the old symlink targets and unit, not the SQLite
backup. The schema changes are additive and the old application ignores them.
Database restore is reserved for failed integrity or aggregate validation and
will discard events after the backup watermark.

## Release baseline

Build the next release by copying the current release directory
(`/opt/crosery-api-console-releases/<current>/`). Never rebuild from the mutable
checkout: both `/opt/crosery-api-console` and the workstation clone are stale and
do not contain what is deployed, so rebuilding from them silently drops every
patch that was applied after they last matched. `RELEASE.json` records the change
set of the release it sits in; keep it and `MANIFEST.sha256` in step with the tree.

## Runtime data that must survive

Two files under `/opt/crosery-api-console/data` carry state that no release
contains, and neither may be treated as disposable:

- `console.db` — usage events and the per-request cost settled at ingest time.
- `gateway-pricing.json` — prices the edge learned from the gateway for models the
  static table does not cover (`gemini-3.8-flash`, `gpt-6-astra`, `deepseek-flash`,
  ...). It is merged, never replaced, on every refresh and read back before the
  edge starts serving, so a gateway outage cannot blank those prices out again.

`crosery-console-backfill-cost.timer` re-prices any row whose `cost_usd` a
transient pricing gap left NULL, every 30 minutes. Keep it enabled: it never
overwrites an existing cost and is the only thing standing between a brief
pricing gap and a permanently unpriced row.
