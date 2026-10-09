#!/bin/bash
set -euo pipefail

root=$HOME/cpe-console-shadow
release=$HOME/cpe-console-releases/20260831T195446Z-low-latency-v2
exec 9>"$root/.wal-webdav.lock"
flock -n 9 || exit 0

docker run --rm --network host --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add DAC_READ_SEARCH \
  --entrypoint node \
  -e WAL_SOURCE=/wal \
  -e NAS2_URL=http://127.0.0.1:5005/NAS2/ \
  -v "$root/secrets/nas2-webdav.json:/secrets/nas2-webdav.json:ro" \
  -v "$root/backup-staging/wal:/wal:ro" \
  -v "$release/deploy/data-plane/scripts/webdav-wal-upload.mjs:/uploader.mjs:ro" \
  crosery-cpe-data:20260831T195446Z-low-latency-v2 /uploader.mjs
