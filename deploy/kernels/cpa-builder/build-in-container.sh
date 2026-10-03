#!/bin/bash
# 在 golang:1.26 容器里执行：构建 linux/amd64 静态二进制并跑全量测试（CGO_ENABLED=0 由 run.sh 传入）。
set -euo pipefail
cd /src
git config --global --add safe.directory /src
go build -trimpath -ldflags "-s -w -X main.Version=${VERSION} -X main.Commit=${COMMIT} -X main.BuildDate=${BUILD_DATE}" -o /src/.pipeline-out/cli-proxy-api ./cmd/server
ver=$(/src/.pipeline-out/cli-proxy-api --version 2>&1 || true); printf "%s\n" "$ver" | head -1
if ! go test ./... >/tmp/gotest.out 2>&1; then
  grep -E '^(--- FAIL|FAIL|panic)' /tmp/gotest.out | head -40
  exit 1
fi
echo "tests passed"
