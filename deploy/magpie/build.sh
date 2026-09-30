#!/bin/sh
set -eu
revision=3fe2ff99587e17dfe0ea707ffd0eccc088824433
runtime=${MAGPIE_RUNTIME:-"$HOME/.agents/crosery/magpie"}
source=${MAGPIE_SOURCE:-"$runtime/source"}
test -f "$runtime/manifest.json" || { printf '%s\n' 'Run magpie-local.mjs prepare first'; exit 1; }
if ! test -d "$source/.git"; then
  git clone --no-checkout https://github.com/yetone/magpie.git "$source"
  git -C "$source" checkout --detach "$revision"
fi
test "$(git -C "$source" rev-parse HEAD)" = "$revision" || {
  printf '%s\n' 'Source revision mismatch; refusing to build unreviewed code'
  exit 1
}
test -z "$(git -C "$source" status --porcelain)" || {
  printf '%s\n' 'Source is dirty; refusing to build'
  exit 1
}
cd "$source"
CGO_ENABLED=0 go build -tags nogui -trimpath \
  -ldflags="-s -w -X main.version=crosery-3fe2ff9" -o "$runtime/bin/magpie" .
printf '%s\n' 'Built pinned Magpie web/CLI binary'
