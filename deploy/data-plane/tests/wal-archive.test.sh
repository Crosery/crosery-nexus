#!/bin/sh
set -eu

project_root=$(CDPATH='' cd -- "$(dirname "$0")/../../.." && pwd)
archive_script="$project_root/deploy/data-plane/scripts/archive-wal.sh"
wal_sync_script="$project_root/deploy/data-plane/scripts/wal-sync.sh"
compose_file="$project_root/deploy/data-plane/compose.yaml"
backup_script="$project_root/deploy/data-plane/scripts/backup.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

real_sha256sum=$(command -v sha256sum)
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

cat >"$fake_bin/mountpoint" <<'EOF'
#!/bin/sh
test "${TEST_MOUNTPOINT_OK:-1}" = 1
EOF
cat >"$fake_bin/findmnt" <<'EOF'
#!/bin/sh
printf '%s\n' "${TEST_STAGING_FS:-ext4}"
EOF
cat >"$fake_bin/flock" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$fake_bin/sync" <<'EOF'
#!/bin/sh
last_argument=''
for argument in "$@"; do last_argument=$argument; done
test "${TEST_SYNC_FAIL:-0}" != 1 || exit 1
if test -n "${TEST_SYNC_FAIL_EXACT:-}" && test "$last_argument" = "$TEST_SYNC_FAIL_EXACT"; then
  exit 1
fi
if test -n "${TEST_SYNC_FAIL_FRAGMENT:-}"; then
  case "$last_argument" in
    *"$TEST_SYNC_FAIL_FRAGMENT"*) exit 1 ;;
  esac
fi
exit 0
EOF
cat >"$fake_bin/sha256sum" <<'EOF'
#!/bin/sh
if test -n "${TEST_SHA_MISMATCH_FRAGMENT:-}"; then
  case "$1" in
    *"$TEST_SHA_MISMATCH_FRAGMENT"*)
      printf '%064d  %s\n' 0 "$1"
      exit 0
      ;;
  esac
fi
exec "$REAL_SHA256SUM" "$@"
EOF
chmod +x "$fake_bin"/*

PATH="$fake_bin:$PATH"
export PATH REAL_SHA256SUM="$real_sha256sum"

segment_one=000000010000000000000001
segment_two=000000010000000000000002
history=00000002.history
backup_history=000000010000000000000001.00000020.backup

archive_source="$test_root/$segment_one"
archive_target="$test_root/local-wal"
mkdir -p "$archive_target"
printf 'complete wal one\n' >"$archive_source"
"$archive_script" "$archive_source" "$segment_one" "$archive_target"
cmp "$archive_source" "$archive_target/$segment_one"
test -z "$(find "$archive_target" -maxdepth 1 -name '.*.archive.*' -print)"

printf 'different\n' >"$archive_target/$segment_two"
printf 'source two\n' >"$test_root/$segment_two"
if "$archive_script" "$test_root/$segment_two" "$segment_two" "$archive_target"; then
  echo "archive helper accepted a conflicting final file" >&2
  exit 1
fi
test "$(cat "$archive_target/$segment_two")" = different

if "$archive_script" "$archive_source" '../not-wal' "$archive_target"; then
  echo "archive helper accepted an invalid PostgreSQL file name" >&2
  exit 1
fi

failure_name=000000010000000000000003
printf 'source three\n' >"$test_root/$failure_name"
if TEST_SYNC_FAIL=1 "$archive_script" "$test_root/$failure_name" "$failure_name" "$archive_target"; then
  echo "archive helper succeeded after fsync failure" >&2
  exit 1
fi
test ! -e "$archive_target/$failure_name"
test -z "$(find "$archive_target" -maxdepth 1 -name '.*.archive.*' -print)"

retry_name=000000010000000000000004
printf 'source four\n' >"$test_root/$retry_name"
if TEST_SYNC_FAIL_EXACT="$archive_target" "$archive_script" "$test_root/$retry_name" "$retry_name" "$archive_target"; then
  echo "archive helper succeeded after directory fsync failure" >&2
  exit 1
fi
cmp "$test_root/$retry_name" "$archive_target/$retry_name"
"$archive_script" "$test_root/$retry_name" "$retry_name" "$archive_target"

staging="$test_root/staging"
nas="$test_root/nas"
mkdir -p "$staging/wal" "$nas"
printf 'wal one\n' >"$staging/wal/$segment_one"
printf 'wal two\n' >"$staging/wal/$segment_two"
printf 'timeline\n' >"$staging/wal/$history"
printf 'backup history\n' >"$staging/wal/$backup_history"
printf 'in progress\n' >"$staging/wal/.$segment_two.archive.hidden"
PG_BACKUP_STAGING_ROOT="$staging" NAS_BACKUP_ROOT="$nas" "$wal_sync_script"
cmp "$staging/wal/$segment_one" "$nas/wal/$segment_one"
cmp "$staging/wal/$history" "$nas/wal/$history"
cmp "$staging/wal/$backup_history" "$nas/wal/$backup_history"
test ! -e "$nas/wal/.$segment_two.archive.hidden"
grep -Eq "^[0-9]{8}T[0-9]{6}Z[[:space:]]+$segment_two$" "$nas/LAST_VERIFIED_WAL_COPY"
test -z "$(find "$nas" \( -name '*.walcopy.*' -o -name '.LAST_VERIFIED_WAL_COPY.tmp.*' \) -print)"

bad_staging="$test_root/bad-staging"
bad_nas="$test_root/bad-nas"
mkdir -p "$bad_staging/wal" "$bad_nas"
printf 'not wal\n' >"$bad_staging/wal/README"
if PG_BACKUP_STAGING_ROOT="$bad_staging" NAS_BACKUP_ROOT="$bad_nas" "$wal_sync_script"; then
  echo "WAL sync accepted an unexpected staging file" >&2
  exit 1
fi
test ! -e "$bad_nas/LAST_VERIFIED_WAL_COPY"

checksum_staging="$test_root/checksum-staging"
checksum_nas="$test_root/checksum-nas"
mkdir -p "$checksum_staging/wal" "$checksum_nas"
printf 'checksum wal\n' >"$checksum_staging/wal/$segment_one"
if TEST_SHA_MISMATCH_FRAGMENT='.walcopy.' PG_BACKUP_STAGING_ROOT="$checksum_staging" NAS_BACKUP_ROOT="$checksum_nas" "$wal_sync_script"; then
  echo "WAL sync accepted a checksum mismatch" >&2
  exit 1
fi
test ! -e "$checksum_nas/wal/$segment_one"
test -z "$(find "$checksum_nas" -name '*.walcopy.*' -print)"

marker_staging="$test_root/marker-staging"
marker_nas="$test_root/marker-nas"
mkdir -p "$marker_staging/wal" "$marker_nas"
printf 'marker wal\n' >"$marker_staging/wal/$segment_one"
printf 'previous marker\n' >"$marker_nas/LAST_VERIFIED_WAL_COPY"
if TEST_SYNC_FAIL_FRAGMENT='.LAST_VERIFIED_WAL_COPY.tmp.' PG_BACKUP_STAGING_ROOT="$marker_staging" NAS_BACKUP_ROOT="$marker_nas" "$wal_sync_script"; then
  echo "WAL sync succeeded after marker fsync failure" >&2
  exit 1
fi
test "$(cat "$marker_nas/LAST_VERIFIED_WAL_COPY")" = 'previous marker'
test -z "$(find "$marker_nas" -name '.LAST_VERIFIED_WAL_COPY.tmp.*' -print)"

unmounted_nas="$test_root/unmounted-nas"
mkdir -p "$unmounted_nas"
if TEST_MOUNTPOINT_OK=0 PG_BACKUP_STAGING_ROOT="$staging" NAS_BACKUP_ROOT="$unmounted_nas" "$wal_sync_script"; then
  echo "WAL sync accepted an unmounted NAS root" >&2
  exit 1
fi

grep -Fq 'archive_command=/usr/local/bin/crosery-archive-wal "%p" "%f" /var/lib/postgresql-backup/wal' "$compose_file"
grep -Fq 'target: /usr/local/bin/crosery-archive-wal' "$compose_file"
# These are literal source fragments; the variables must not expand in this test.
# shellcheck disable=SC2016
wal_sync_invocation='"$script_dir/wal-sync.sh"'
# shellcheck disable=SC2016
legacy_wal_copy='rsync -a --delay-updates --partial "$PG_BACKUP_STAGING_ROOT/wal/'
grep -Fq "$wal_sync_invocation" "$backup_script"
if grep -Fq "$legacy_wal_copy" "$backup_script"; then
  echo "backup script still has a second non-atomic WAL copy path" >&2
  exit 1
fi

echo "WAL archive atomicity tests passed"
