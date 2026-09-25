# Data-plane deployment assets

These files describe a proposed PostgreSQL 18 and private data-service deployment. They do not authorize or perform production installation, migration or traffic changes.

## Contents

- `compose.yaml`: a no-network storage initializer, PostgreSQL 18, a one-shot migration service and the private data service.
- `Dockerfile.data`: Node 24 multi-stage build consuming `npm run build:data` output at `build/apps/data/src/index.js`.
- `data-plane.env.example`: non-secret configuration contract.
- `initdb/10-runtime-roles.sh`: creates owner-controlled `cpe_data`, plus least-privilege runtime and backup roles for a new cluster.
- `systemd/crosery-cpe-data.service`: optional host-runtime unit; loads secrets from files, then runs root project command `npm run start:data` as an unprivileged user.
- `systemd/crosery-cpe-backup.*`: daily base-backup unit and timer.
- `systemd/crosery-cpe-wal-sync.*`: five-minute archived-WAL copy unit and timer.
- `scripts/archive-wal.sh`: PostgreSQL `archive_command` helper that verifies and atomically publishes completed WAL into local staging.
- `scripts/postgres-entrypoint.sh`: stages host `0600` app/backup passwords into a container-only tmpfs as `postgres:postgres 0400` before calling the official image entrypoint.
- `scripts/webdav-base-upload.mjs`, `scripts/webdav-wal-upload.mjs` and `scripts/webdav-restore-download.mjs`: authenticated NAS2 WebDAV fallback with staged upload, remote SHA-256 verification and atomic `MOVE` publication.
- `scripts/webdav-*-job.sh` and `cron.example`: production-tested WSL wrappers for five-minute WAL copies and daily base backups.
- `tailscale-grants.example.hujson`: edge-to-data-service grant; deliberately excludes PostgreSQL.
- `BACKUP-RESTORE.md`: storage, backup failure and restore-drill contract.

## Preconditions

1. Review `docs/architecture/ADR-001-low-latency-data-plane.md`, the threat model and migration runbook.
2. Confirm target CPU, RAM, local SSD, NAS mount, direct/relayed Tailscale path and service user on the real data host.
3. Create a dedicated `crosery-cpe` system user with no interactive login. Do not add it to the Docker group.
4. Create a root-owned `0600` environment file and separate owner/runtime database URL and Bearer-token secret files under `/etc/crosery-cpe-console`. The token content must match the edge `DATA_PLANE_TOKEN`; never put it in the environment file. Compose starts only the small entrypoint as root, copies these files into a private tmpfs, then drops every UID/GID and capability before Node starts.
5. Provision empty `PG_LOCAL_ROOT` and `PG_BACKUP_STAGING_ROOT` directories on local encrypted SSD. The no-network `storage-init` service creates the versioned PGDATA and backup staging children as `postgres:postgres 0700` before PostgreSQL starts.
6. Mount the encrypted NAS backup dataset at the exact path used by both the environment file and systemd `ReadWritePaths`. If a different path is selected, add a reviewed systemd drop-in; changing only the environment file is insufficient.
7. Resolve `POSTGRES_IMAGE` to a PostgreSQL 18 image digest in the approved registry. `pull_policy: never` intentionally separates image acquisition from service start.
8. Resolve `NODE_IMAGE` to a reviewed Node 24 digest and build a traceable `DATA_IMAGE`. The runtime image uses the built-in non-root `node` user and contains production dependencies, compiled output and migrations only.

Keep `IDENTITY_RETENTION_DAYS` at least as large as `HOUR_RETENTION_DAYS`; the default `410` preserves request-identity tombstones beyond the default 400-day aggregate window so a late replay cannot be counted twice.

PostgreSQL 18 changed the official image's default data path to `/var/lib/postgresql/18/docker` and its declared volume to `/var/lib/postgresql`. The compose bind mount follows that layout. See the [Docker Official Image documentation](https://hub.docker.com/_/postgres).

## Review checks

Run these against a disposable host configuration before requesting deployment approval:

```bash
docker compose --env-file /path/to/review.env -f deploy/data-plane/compose.yaml config
docker build --build-arg NODE_IMAGE='node:24-bookworm-slim@sha256:<reviewed-digest>' \
  -f deploy/data-plane/Dockerfile.data -t crosery-cpe-data:<release-id> .
sh -n deploy/data-plane/initdb/10-runtime-roles.sh
sh -n deploy/data-plane/scripts/backup.sh
sh -n deploy/data-plane/scripts/archive-wal.sh
sh -n deploy/data-plane/scripts/wal-sync.sh
sh deploy/data-plane/tests/wal-archive.test.sh
systemd-analyze verify deploy/data-plane/systemd/*.service deploy/data-plane/systemd/*.timer
```

Then verify that the host has no 5432 listener, the data-service port is reachable only from the tagged edge node, an unrelated Tailnet node is denied, and the public interface has no route to `/internal/v1/*`.

The container deployment sequence is `storage-init` complete, `postgres` healthy, one successful `migrate`, then `data`. Never start `data` with the owner URL. The migration container receives only the owner database URL; it does not receive the data-service Bearer token. The PostgreSQL wrapper copies only the app and backup passwords into a private tmpfs because Compose file-backed secrets retain host ownership while official init scripts execute as `postgres`; it never exports those values. The data-service wrapper applies the same file-only boundary, then uses `setpriv` to start Node as the unprivileged `node` user with an empty capability set. PostgreSQL and migrations stay on the externally isolated `database` network. The data service also joins `edge` so Docker can publish its port, but that port must bind to the host Tailnet address rather than `0.0.0.0`. Docker Compose is the recommended runtime because it closes the image, secret and network contracts together. The host-runtime systemd unit is a fallback template: it uses `LoadCredential` so the unprivileged service can read private copies of root-owned database and Bearer-token files. Run the same reviewed one-shot migration first. Do not run the host and container data services simultaneously on port 8792.

Phase 1 stores only `cpe_data` usage events, rollups, snapshots and migration/idempotency metadata. Management state, audit records and quota ledgers remain in edge SQLite.

Use PostgreSQL's documented `pg_basebackup` and continuous-archiving procedures for the pinned PostgreSQL 18 minor version. Backup existence is not acceptance; complete an isolated restore drill and record RPO/RTO before cutover.

## NAS2 WebDAV fallback

The filesystem-based systemd timers remain preferred on a normal Linux data
host. The current 2080Ti WSL host exposes NAS2 through authenticated WebDAV, so
it uses the WebDAV scripts instead of treating an ordinary directory as a NAS
mount.

Keep `nas2-webdav.json` root-owned `0600` outside the repository with only
`user` and `password` fields. The Docker job mounts that file read-only;
credentials never appear in the command line, environment, log, checkpoint or
backup tree. `webdav-wal-upload.mjs` advances its marker only after verifying
every published file. Later five-minute runs use that marker to copy only new
WAL segments instead of downloading the full archive again.

Before installing `cron.example`, run both wrappers interactively, verify the
remote markers, download a base backup with `webdav-restore-download.mjs`, run
`pg_verifybackup`, and start the restored PostgreSQL cluster with networking
disabled. User cron is used on WSL because a long-running user systemd manager
can retain an obsolete supplementary-group list; cron initializes current
`docker` group membership for every run. Update the pinned release/image values
in both job wrappers during each reviewed data-service release.
