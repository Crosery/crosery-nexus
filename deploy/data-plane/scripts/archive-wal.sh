#!/bin/sh
set -eu
umask 077

is_archive_name() {
  printf '%s\n' "$1" | LC_ALL=C grep -Eq '^([0-9A-F]{24}|[0-9A-F]{8}\.history|[0-9A-F]{24}\.[0-9A-F]{8}\.backup)$'
}

file_size() {
  measured_size=$(wc -c <"$1") || return 1
  measured_size=$(printf '%s' "$measured_size" | tr -d '[:space:]') || return 1
  printf '%s\n' "$measured_size" | LC_ALL=C grep -Eq '^[0-9]+$' || return 1
  printf '%s\n' "$measured_size"
}

file_digest() {
  digest_line=$(sha256sum "$1") || return 1
  measured_digest=${digest_line%% *}
  printf '%s\n' "$measured_digest" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s\n' "$measured_digest"
}

same_file() {
  first_size=$(file_size "$1") || return 1
  second_size=$(file_size "$2") || return 1
  test "$first_size" = "$second_size" || return 1
  first_digest=$(file_digest "$1") || return 1
  second_digest=$(file_digest "$2") || return 1
  test "$first_digest" = "$second_digest"
}

test "$#" -eq 3 || {
  echo "usage: archive-wal.sh SOURCE WAL_NAME TARGET_DIR" >&2
  exit 1
}

source_path=$1
wal_name=$2
target_dir=$3

case "$target_dir" in
  /*) ;;
  *) echo "WAL archive target must be absolute" >&2; exit 1 ;;
esac
is_archive_name "$wal_name" || {
  echo "refusing unexpected PostgreSQL archive file name: $wal_name" >&2
  exit 1
}
test "${source_path##*/}" = "$wal_name" || {
  echo "WAL source basename does not match archive name" >&2
  exit 1
}
test -f "$source_path" && test -r "$source_path" || {
  echo "WAL source is not a readable regular file: $source_path" >&2
  exit 1
}
test -d "$target_dir" || {
  echo "WAL archive target is not provisioned: $target_dir" >&2
  exit 1
}

target_path="$target_dir/$wal_name"
temp_path=''
cleanup() {
  test -z "$temp_path" || rm -f "$temp_path"
}
trap cleanup EXIT HUP INT TERM

if test -e "$target_path" || test -L "$target_path"; then
  if ! { test -f "$target_path" && test ! -L "$target_path" && same_file "$source_path" "$target_path"; }; then
    echo "existing WAL archive does not match source: $wal_name" >&2
    exit 1
  fi
  sync -f "$target_path"
  sync -f "$target_dir"
  exit 0
fi

# The temporary file and final archive live in the same directory, so rename is atomic.
temp_path=$(mktemp "$target_dir/.$wal_name.archive.XXXXXX")
cp "$source_path" "$temp_path"
sync -f "$temp_path"
same_file "$source_path" "$temp_path" || {
  echo "WAL archive verification failed before publish: $wal_name" >&2
  exit 1
}

# PostgreSQL uses one archiver process, but tolerate an identical file published by
# an operator between the initial check and this point without overwriting it.
if test -e "$target_path" || test -L "$target_path"; then
  if ! { test -f "$target_path" && test ! -L "$target_path" && same_file "$source_path" "$target_path"; }; then
    echo "concurrent WAL archive does not match source: $wal_name" >&2
    exit 1
  fi
  rm -f "$temp_path"
  temp_path=''
else
  mv -f "$temp_path" "$target_path"
  temp_path=''
fi

sync -f "$target_path"
sync -f "$target_dir"
trap - EXIT HUP INT TERM
