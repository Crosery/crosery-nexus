#!/bin/sh
set -eu
umask 077

is_archive_name() {
  printf '%s\n' "$1" | LC_ALL=C grep -Eq '^([0-9A-F]{24}|[0-9A-F]{8}\.history|[0-9A-F]{24}\.[0-9A-F]{8}\.backup)$'
}

is_wal_segment() {
  printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[0-9A-F]{24}$'
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
    echo "WAL staging must be local storage, found $staging_fs" >&2
    exit 1
    ;;
esac

source_dir="$PG_BACKUP_STAGING_ROOT/wal"
target_dir="$NAS_BACKUP_ROOT/wal"
test -d "$source_dir" || {
  echo "local WAL archive does not exist: $source_dir" >&2
  exit 1
}

mkdir -p "$target_dir"
lock_file="$PG_BACKUP_STAGING_ROOT/.wal-sync.lock"
exec 9>"$lock_file"
flock -w 60 9 || {
  echo "another WAL copy is already running" >&2
  exit 1
}

archive_count=0
for source_path in "$source_dir"/*; do
  test -e "$source_path" || continue
  archive_count=$((archive_count + 1))
  archive_name=${source_path##*/}
  is_archive_name "$archive_name" || {
    echo "refusing unexpected file in WAL archive staging: $archive_name" >&2
    exit 1
  }
  test -f "$source_path" && test ! -L "$source_path" || {
    echo "refusing non-regular WAL archive staging entry: $archive_name" >&2
    exit 1
  }
done
test "$archive_count" -gt 0 || {
  echo "no completed PostgreSQL WAL archive files are available" >&2
  exit 1
}

temp_path=''
marker_temp=''
cleanup() {
  test -z "$temp_path" || rm -f "$temp_path"
  test -z "$marker_temp" || rm -f "$marker_temp"
}
trap cleanup EXIT HUP INT TERM

latest=''
for source_path in "$source_dir"/*; do
  test -e "$source_path" || continue
  archive_name=${source_path##*/}
  is_archive_name "$archive_name" || {
    echo "refusing unexpected file added to WAL staging during sync: $archive_name" >&2
    exit 1
  }
  test -f "$source_path" && test ! -L "$source_path" || {
    echo "refusing non-regular WAL entry added during sync: $archive_name" >&2
    exit 1
  }
  target_path="$target_dir/$archive_name"

  if test -e "$target_path" || test -L "$target_path"; then
    if ! { test -f "$target_path" && test ! -L "$target_path" && same_file "$source_path" "$target_path"; }; then
      echo "NAS WAL copy does not match local archive: $archive_name" >&2
      exit 1
    fi
    sync -f "$target_path"
  else
    temp_path=$(mktemp "$target_dir/.$archive_name.walcopy.XXXXXX")
    cp "$source_path" "$temp_path"
    sync -f "$temp_path"
    same_file "$source_path" "$temp_path" || {
      echo "NAS WAL copy verification failed before publish: $archive_name" >&2
      exit 1
    }

    if test -e "$target_path" || test -L "$target_path"; then
      if ! { test -f "$target_path" && test ! -L "$target_path" && same_file "$source_path" "$target_path"; }; then
        echo "concurrent NAS WAL copy does not match local archive: $archive_name" >&2
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
  fi

  # Verify the published final again before it can advance the marker.
  same_file "$source_path" "$target_path" || {
    echo "published NAS WAL copy failed verification: $archive_name" >&2
    exit 1
  }
  if is_wal_segment "$archive_name"; then
    latest=$(printf '%s\n%s\n' "$latest" "$archive_name" | LC_ALL=C sort | tail -n 1)
  fi
done

test -n "$latest" || {
  echo "no completed WAL segment was verified" >&2
  exit 1
}

marker="$NAS_BACKUP_ROOT/LAST_VERIFIED_WAL_COPY"
marker_temp=$(mktemp "$NAS_BACKUP_ROOT/.LAST_VERIFIED_WAL_COPY.tmp.XXXXXX")
printf '%s\t%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$latest" >"$marker_temp"
sync -f "$marker_temp"
mv -f "$marker_temp" "$marker"
marker_temp=''
sync -f "$marker"
sync -f "$NAS_BACKUP_ROOT"
trap - EXIT HUP INT TERM
echo "WAL archive copied through $latest"
