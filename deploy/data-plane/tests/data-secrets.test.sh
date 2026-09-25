#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
wrapper=$root/scripts/with-file-secrets.sh
compose=$root/compose.yaml
dockerfile=$root/Dockerfile.data

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT HUP INT TERM

printf 'postgresql://runtime@postgres/console\n' >"$tmp/database-url"
printf '%032d\n' 0 >"$tmp/bearer-token"
cat >"$tmp/probe.sh" <<'SH'
#!/bin/sh
set -eu
test -z "${DATABASE_URL:-}"
test -z "${DATA_AUTH_BEARER_TOKENS:-}"
test "$(cat "$DATABASE_URL_FILE")" = 'postgresql://runtime@postgres/console'
test "$(wc -c <"$DATA_AUTH_BEARER_TOKENS_FILE" | tr -d ' ')" = 33
SH
chmod 0700 "$tmp/probe.sh"

# This exercises the systemd LoadCredential path. The Compose root-staging path
# is verified again by the disposable image smoke test in the deployment runbook.
DATABASE_URL_FILE="$tmp/database-url" \
DATA_AUTH_BEARER_TOKENS_FILE="$tmp/bearer-token" \
  CPE_DATA_RUNTIME_USER="$(id -un)" \
  CPE_DATA_RUNTIME_GROUP="$(id -gn)" \
  CPE_DATA_SECRET_STAGING_DIR="$tmp/staged" \
  "$wrapper" "$tmp/probe.sh"

sh -n "$wrapper"
grep -F 'install -d -o root -g "$runtime_group" -m 0710 "$staging_dir"' "$wrapper" >/dev/null
grep -F 'install -m 0400 "$source" "$target"' "$wrapper" >/dev/null
grep -F 'chown "$runtime_user:$runtime_group" "$target"' "$wrapper" >/dev/null
grep -F 'setpriv --reuid="$runtime_user" --regid="$runtime_group" --clear-groups' "$wrapper" >/dev/null
grep -F 'USER root' "$dockerfile" >/dev/null
test "$(grep -c '/run/cpe-data-secrets:size=1m,mode=0700' "$compose")" = 2
test "$(grep -c 'cap_add: \[CHOWN, SETGID, SETUID\]' "$compose")" = 2

printf 'Data-service secret staging contract passed\n'
