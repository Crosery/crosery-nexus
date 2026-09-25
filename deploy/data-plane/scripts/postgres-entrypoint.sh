#!/bin/sh
set -eu
umask 077

readonly_secret_dir=/run/cpe-postgres-secrets

stage_secret() {
  source_file=$1
  target_name=$2
  test -r "$source_file" || {
    echo "required PostgreSQL secret is not readable: $target_name" >&2
    exit 1
  }
  test -s "$source_file" || {
    echo "required PostgreSQL secret is empty: $target_name" >&2
    exit 1
  }

  secret_value=$(cat "$source_file")
  carriage_return=$(printf '\r')
  newline='
'
  while :; do
    case "$secret_value" in
      *"$carriage_return"|*"$newline") secret_value=${secret_value%?} ;;
      *) break ;;
    esac
  done
  test -n "$secret_value" || {
    echo "required PostgreSQL secret is empty after trimming line endings: $target_name" >&2
    exit 1
  }

  normalized_file=$(mktemp "$readonly_secret_dir/.$target_name.XXXXXX")
  printf '%s' "$secret_value" >"$normalized_file"
  secret_value=
  install -o postgres -g postgres -m 0400 "$normalized_file" "$readonly_secret_dir/$target_name"
  rm -f "$normalized_file"
}

main() {
  test "$(id -u)" = 0 || {
    echo 'PostgreSQL secret staging must start as root' >&2
    exit 1
  }
  mkdir -p "$readonly_secret_dir"
  chown postgres:postgres "$readonly_secret_dir"
  chmod 0700 "$readonly_secret_dir"

  stage_secret "$POSTGRES_APP_PASSWORD_FILE" postgres-app-password
  stage_secret "$POSTGRES_BACKUP_PASSWORD_FILE" postgres-backup-password
  POSTGRES_APP_PASSWORD_FILE="$readonly_secret_dir/postgres-app-password"
  POSTGRES_BACKUP_PASSWORD_FILE="$readonly_secret_dir/postgres-backup-password"
  export POSTGRES_APP_PASSWORD_FILE POSTGRES_BACKUP_PASSWORD_FILE

  exec /usr/local/bin/docker-entrypoint.sh "$@"
}

if test "${CPE_POSTGRES_ENTRYPOINT_SOURCE_ONLY:-0}" != 1; then
  main "$@"
fi
