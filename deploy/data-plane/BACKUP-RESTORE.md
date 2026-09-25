# PostgreSQL backup and restore

## Storage contract

- `PG_LOCAL_ROOT`: local encrypted SSD only; mounted at `/var/lib/postgresql` for PostgreSQL 18's versioned `PGDATA`.
- `PG_BACKUP_STAGING_ROOT`: separate capacity budget on local SSD; receives archived WAL and base-backup staging.
- `NAS_BACKUP_ROOT`: mounted backup dataset only. It must never be used for `PGDATA`, `pg_wal`, query temp files or the live Unix socket.
- Secret and encryption keys live outside all three trees.

The official PostgreSQL 18 image uses `/var/lib/postgresql/18/docker` as `PGDATA`; the compose file therefore mounts the parent `/var/lib/postgresql`. Pin `POSTGRES_IMAGE` to a reviewed digest before use.

## Backup prerequisites

1. Provision root-owned `0600` password files named by `data-plane.env`.
2. Verify local disk and NAS encryption at rest and least-privilege NAS credentials.
3. Create local SSD roots with ownership expected by the official image. Create `PG_BACKUP_STAGING_ROOT/wal` before starting PostgreSQL.
4. Mount the NAS before starting the backup timer. The script fails if `NAS_BACKUP_ROOT` is not a distinct mount.
5. Install `docker`, the Compose plugin, `rsync`, `findmnt`, `mountpoint`, `flock`, `grep`, `mktemp`, `sync` and `sha256sum` through the approved host provisioning path.

`scripts/archive-wal.sh` is the PostgreSQL `archive_command`: it writes a temporary file in the local archive directory, fsyncs and verifies it, then atomically renames it to the final PostgreSQL archive name. `scripts/wal-sync.sh` accepts only WAL segments, timeline history and backup history names, copies each through a same-directory temporary file, verifies size and SHA-256 before publishing, and atomically updates `LAST_VERIFIED_WAL_COPY`. Hidden archive temporaries are never candidates for NAS copy. `scripts/backup.sh` creates a streaming base backup on local SSD, copies and verifies it on NAS, invokes that same WAL sync path, then atomically updates `LAST_VERIFIED_BASE_BACKUP`. All scripts deliberately avoid pruning data. Apply a separately reviewed retention job only after restore drills establish the required base-backup and WAL chain.

The base-backup timer is daily and the WAL-copy timer runs every five minutes. Together with the five-minute `archive_timeout`, they target a worst-case ten-minute copy delay under normal operation. The 15-minute RPO still depends on both jobs succeeding; a daily base backup alone does not satisfy it. Monitor the newest archived WAL locally and on NAS, not only timer exit status.

## Restore drill

Never restore over active `PGDATA`.

1. Record the selected base-backup ID, target recovery time, image digest and operator.
2. Stop only an isolated drill instance and create a new empty local-SSD directory.
3. Retrieve the backup through the approved NAS identity and, where applicable, retrieve the encryption key separately.
4. Verify `SHA256SUMS` before extraction. Reject path traversal and unexpected ownership while extracting as the dedicated database operator.
5. Extract the base tar into the PostgreSQL 18 versioned data directory. Copy the required archived WAL into an isolated read-only restore source.
6. Configure `restore_command` against that isolated WAL source. For point-in-time recovery set an explicit target and create `recovery.signal` according to PostgreSQL 18 documentation.
7. Start the drill instance on an unused loopback port with no public or Tailnet listener.
8. Verify recovery completion, schema revision, row counts, usage aggregates and representative analytics queries. Record achieved RPO and RTO.
9. Stop and securely remove the drill copy after evidence is retained.

Promoting a restored cluster is a separate R3 production decision. Before promotion, fence the old writer, capture the final common watermark, rotate database credentials and point the data service to the new loopback endpoint through reviewed configuration.

## Failure behavior

- NAS unavailable: live PostgreSQL continues on local SSD; backup copy fails and alerts. WAL archive staging must have enough reserved capacity.
- WAL archive publish or verification failure: `archive_command` exits nonzero, removes its temporary file and PostgreSQL retains the source for retry. Never mark the segment verified manually.
- Local staging near capacity: stop backfill and nonessential writes before disk exhaustion; never redirect WAL to NAS as an emergency shortcut.
- Base-backup checksum mismatch: quarantine that backup ID, keep prior verified chains and page the data owner.
- Missing WAL in a recovery chain: the achievable RPO is the last continuous chain, not the newest base-backup timestamp.
