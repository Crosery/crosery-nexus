#!/bin/bash
set -euo pipefail
umask 077

root=$HOME/cpe-console-shadow
release=$HOME/cpe-console-releases/20260831T195446Z-low-latency-v2
envfile=$root/data-plane.env
compose=$release/deploy/data-plane/compose.yaml
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
partial=/var/lib/postgresql-backup/base/$timestamp.partial
complete=/var/lib/postgresql-backup/base/$timestamp

exec 9>"$root/.base-webdav.lock"
flock -n 9 || exit 0

docker compose -p crosery-cpe-shadow --env-file "$envfile" -f "$compose" \
  exec -T --user postgres postgres sh -eu -c '
    PGPASSWORD=$(cat /run/cpe-postgres-secrets/postgres-backup-password)
    export PGPASSWORD
    test ! -e "$1"
    mkdir -p "$1"
    pg_basebackup -h 127.0.0.1 -U "$POSTGRES_BACKUP_USER" -D "$1" \
      -F t -z -X stream -c fast --manifest-checksums=SHA256
    (cd "$1" && sha256sum ./*.tar.gz backup_manifest > SHA256SUMS)
    printf "%s\n" "$2" > "$1/COMPLETED_AT_UTC"
    mv "$1" "$3"
  ' backup "$partial" "$timestamp" "$complete"

docker run --rm --network host --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add DAC_READ_SEARCH \
  --entrypoint node \
  -e "BACKUP_SOURCE=/backup/$timestamp" \
  -e NAS2_URL=http://127.0.0.1:5005/NAS2/ \
  -v "$root/secrets/nas2-webdav.json:/secrets/nas2-webdav.json:ro" \
  -v "$root/backup-staging/base/$timestamp:/backup/$timestamp:ro" \
  -v "$release/deploy/data-plane/scripts/webdav-base-upload.mjs:/uploader.mjs:ro" \
  crosery-cpe-data:20260831T195446Z-low-latency-v2 /uploader.mjs

"$root/cpe-wal-webdav.sh"
