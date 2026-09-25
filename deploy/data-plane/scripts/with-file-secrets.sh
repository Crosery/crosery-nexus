#!/bin/sh
set -eu
umask 077

runtime_user=${CPE_DATA_RUNTIME_USER:-node}
runtime_group=${CPE_DATA_RUNTIME_GROUP:-node}
staging_dir=${CPE_DATA_SECRET_STAGING_DIR:-/run/cpe-data-secrets}

validate_file_secret() {
  variable=$1
  file_variable="${variable}_FILE"
  eval "file=\${$file_variable:-}"
  eval "direct=\${$variable:-}"
  test -z "$direct" || test -z "$file" || {
    echo "$variable and $file_variable cannot both be set" >&2
    exit 1
  }
  test -n "$file" || return 1
  test -r "$file" || {
    echo "required secret file is not readable: $file_variable" >&2
    exit 1
  }
  test -s "$file" || {
    echo "required secret file is empty: $file_variable" >&2
    exit 1
  }
  return 0
}

stage_file_secret() {
  variable=$1
  file_variable="${variable}_FILE"
  eval "source=\${$file_variable:-}"
  target="$staging_dir/$variable"
  # Apply the final mode while root still owns the new inode, then transfer
  # ownership. This avoids requiring CAP_FOWNER after the chown.
  install -m 0400 "$source" "$target"
  chown "$runtime_user:$runtime_group" "$target"
  export "$file_variable=$target"
}

validate_file_secret DATABASE_URL || true
validate_file_secret DATA_AUTH_BEARER_TOKENS || true

test -n "${DATABASE_URL:-}" || test -n "${DATABASE_URL_FILE:-}" || {
  echo "DATABASE_URL or DATABASE_URL_FILE is required" >&2
  exit 1
}

if test "$(id -u)" -eq 0; then
  command -v setpriv >/dev/null 2>&1 || {
    echo "setpriv is required to drop data-service privileges" >&2
    exit 1
  }
  # Keep the directory owned by root so the capability-restricted entrypoint can
  # populate it. The runtime group may traverse it but cannot list it; each
  # staged file is owned by the runtime user and remains 0400.
  install -d -o root -g "$runtime_group" -m 0710 "$staging_dir"
  test -z "${DATABASE_URL_FILE:-}" || stage_file_secret DATABASE_URL
  test -z "${DATA_AUTH_BEARER_TOKENS_FILE:-}" || stage_file_secret DATA_AUTH_BEARER_TOKENS
  exec setpriv --reuid="$runtime_user" --regid="$runtime_group" --clear-groups \
    --inh-caps=-all --ambient-caps=-all -- "$@"
fi

# systemd LoadCredential already gives the unprivileged service account a
# private readable copy, so host-runtime deployments do not need staging.
exec "$@"
