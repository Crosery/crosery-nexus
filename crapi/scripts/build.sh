#!/usr/bin/env bash
# 交叉编译全部平台，产物放 dist/：crapi-<os>-<arch>[.exe]、VERSION、SHA256SUMS 与安装脚本。
#   scripts/build.sh 0.1.0
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-$(git describe --tags --always 2>/dev/null || echo dev)}"
VERSION="${VERSION#v}"
rm -rf dist && mkdir -p dist
targets="darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64 windows/386"
for t in $targets; do
  os="${t%/*}"; arch="${t#*/}"
  out="dist/crapi-$os-$arch"; [ "$os" = windows ] && out="$out.exe"
  echo "build $out"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION" -o "$out" .
done
echo "$VERSION" > dist/VERSION
cp install.sh install.ps1 install.cmd dist/
( cd dist && { command -v sha256sum >/dev/null && sha256sum crapi-* || shasum -a 256 crapi-*; } > SHA256SUMS )
ls -lh dist
