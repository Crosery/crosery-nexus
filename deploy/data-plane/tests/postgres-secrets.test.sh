#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
wrapper=$root/scripts/postgres-entrypoint.sh
compose=$root/compose.yaml
initdb=$root/initdb/10-runtime-roles.sh
backup=$root/scripts/backup.sh

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$tmp/bin" "$tmp/staged"
cat >"$tmp/bin/install" <<'SH'
#!/bin/sh
set -eu
while test "$#" -gt 2; do shift; done
cp "$1" "$2"
chmod 0400 "$2"
SH
chmod 0700 "$tmp/bin/install"

CPE_POSTGRES_ENTRYPOINT_SOURCE_ONLY=1
export CPE_POSTGRES_ENTRYPOINT_SOURCE_ONLY
# shellcheck source=/dev/null
. "$wrapper"
# shellcheck disable=SC2034 # Read by stage_secret from the sourced wrapper.
readonly_secret_dir=$tmp/staged
PATH=$tmp/bin:$PATH
export PATH

printf 'app-password\r\n' >"$tmp/app-password"
printf 'backup-password\r\n\r\n' >"$tmp/backup-password"
stage_secret "$tmp/app-password" postgres-app-password
stage_secret "$tmp/backup-password" postgres-backup-password
test "$(cat "$tmp/staged/postgres-app-password")" = app-password
test "$(cat "$tmp/staged/postgres-backup-password")" = backup-password
test "$(wc -c <"$tmp/staged/postgres-app-password" | tr -d ' ')" = 12
test "$(wc -c <"$tmp/staged/postgres-backup-password" | tr -d ' ')" = 15
sh -eu -c 'PGPASSWORD=$(cat "$1"); test "$PGPASSWORD" = backup-password' \
  backup-consumer "$tmp/staged/postgres-backup-password"

printf '\r\n' >"$tmp/empty-after-trim"
if (stage_secret "$tmp/empty-after-trim" rejected-password) 2>/dev/null; then
  echo 'line-ending-only PostgreSQL secrets must be rejected' >&2
  exit 1
fi

grep -F 'install -o postgres -g postgres -m 0400' "$wrapper" >/dev/null
grep -F 'exec /usr/local/bin/docker-entrypoint.sh "$@"' "$wrapper" >/dev/null
grep -F '/run/cpe-postgres-secrets:size=1m,mode=0700,uid=999,gid=999' "$compose" >/dev/null
grep -F 'entrypoint: [/usr/local/bin/cpe-postgres-entrypoint]' "$compose" >/dev/null
grep -F 'storage-init:' "$compose" >/dev/null
grep -F 'network_mode: none' "$compose" >/dev/null
grep -F 'condition: service_completed_successfully' "$compose" >/dev/null
grep -F '      - /var/lib/postgresql/18' "$compose" >/dev/null
grep -F '    networks: [database, edge]' "$compose" >/dev/null
grep -F '  edge: {}' "$compose" >/dev/null
if grep -F 'POSTGRES_HOST_PORT' "$compose" >/dev/null; then
  echo 'PostgreSQL must not publish a host port' >&2
  exit 1
fi
grep -F "rtrim(pg_read_file(:'app_password_file'), E'\r\n')" "$initdb" >/dev/null
grep -F "rtrim(pg_read_file(:'backup_password_file'), E'\r\n')" "$initdb" >/dev/null
# shellcheck disable=SC2016 # Verify the literal command substitution in backup.sh.
grep -F 'PGPASSWORD=$(cat /run/cpe-postgres-secrets/postgres-backup-password)' "$backup" >/dev/null

printf 'PostgreSQL secret staging contract passed\n'
