#!/bin/sh
set -eu
umask 077

: "${COMPOSE_FILE:?missing COMPOSE_FILE}"
: "${COMPOSE_ENV_FILE:?missing COMPOSE_ENV_FILE}"
: "${PG_BACKUP_STAGING_ROOT:?missing PG_BACKUP_STAGING_ROOT}"
: "${NAS_BACKUP_ROOT:?missing NAS_BACKUP_ROOT}"

case "$PG_BACKUP_STAGING_ROOT:$NAS_BACKUP_ROOT" in
  /*:/*) ;;
  *) echo "backup paths must be absolute" >&2; exit 1 ;;
esac

if ! mountpoint -q "$NAS_BACKUP_ROOT"; then
  echo "NAS_BACKUP_ROOT is not a mounted filesystem: $NAS_BACKUP_ROOT" >&2
  exit 1
fi

staging_fs=$(findmnt -n -o FSTYPE -T "$PG_BACKUP_STAGING_ROOT")
case "$staging_fs" in
  nfs*|cifs|smb3|fuse.sshfs)
    echo "backup staging must be local storage, found $staging_fs" >&2
    exit 1
    ;;
esac

lock_file="$PG_BACKUP_STAGING_ROOT/.backup.lock"
exec 9>"$lock_file"
flock -n 9 || {
  echo "another backup is already running" >&2
  exit 1
}

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
partial="$PG_BACKUP_STAGING_ROOT/base/$timestamp.partial"
complete="$PG_BACKUP_STAGING_ROOT/base/$timestamp"
nas_complete="$NAS_BACKUP_ROOT/base/$timestamp"
marker_temp=''
cleanup() {
  test -z "$marker_temp" || rm -f "$marker_temp"
}
trap cleanup EXIT HUP INT TERM

test -d "$PG_BACKUP_STAGING_ROOT/base" || {
  echo "local base-backup directory is not provisioned: $PG_BACKUP_STAGING_ROOT/base" >&2
  exit 1
}
test -d "$PG_BACKUP_STAGING_ROOT/wal" || {
  echo "local WAL archive is not provisioned: $PG_BACKUP_STAGING_ROOT/wal" >&2
  exit 1
}
test ! -e "$partial" || {
  echo "partial backup already exists: $partial" >&2
  exit 1
}
mkdir -p "$NAS_BACKUP_ROOT/base"

container_partial="/var/lib/postgresql-backup/base/$timestamp.partial"
/usr/bin/docker compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" exec -T --user postgres postgres \
  sh -eu -c 'PGPASSWORD=$(cat /run/cpe-postgres-secrets/postgres-backup-password); export PGPASSWORD; exec pg_basebackup -h 127.0.0.1 -U "$POSTGRES_BACKUP_USER" -D "$1" -F t -z -X stream -c fast --manifest-checksums=SHA256' \
  backup "$container_partial"

(cd "$partial" && sha256sum ./*.tar.gz backup_manifest >SHA256SUMS)
printf '%s\n' "$timestamp" >"$partial/COMPLETED_AT_UTC"
mv "$partial" "$complete"

rsync -a --delay-updates --partial "$complete/" "$nas_complete/"
(cd "$nas_complete" && sha256sum -c SHA256SUMS)

# Share the verified, atomic WAL publishing path with the five-minute timer.
script_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
"$script_dir/wal-sync.sh"

marker="$NAS_BACKUP_ROOT/LAST_VERIFIED_BASE_BACKUP"
marker_temp=$(mktemp "$NAS_BACKUP_ROOT/.LAST_VERIFIED_BASE_BACKUP.tmp.XXXXXX")
printf '%s\n' "$timestamp" >"$marker_temp"
sync -f "$marker_temp"
mv -f "$marker_temp" "$marker"
marker_temp=''
sync -f "$marker"
sync -f "$NAS_BACKUP_ROOT"
trap - EXIT HUP INT TERM
echo "verified backup copied: $timestamp"
