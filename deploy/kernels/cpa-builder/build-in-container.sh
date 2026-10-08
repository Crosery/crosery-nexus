#!/bin/bash
# 在 run.sh 钉死的 golang 容器里执行：构建 linux/amd64 静态二进制并跑全量测试。CGO_ENABLED=0、GOFLAGS=-buildvcs=false、
# GOOS/GOARCH 和 BUILD_DATE（HEAD 的提交时间）由 run.sh 传入；参数不要改，改了同一个 HEAD 就不再是同一个二进制。
set -euo pipefail
cd /src
git config --global --add safe.directory /src
go env GOVERSION > /src/.pipeline-out/go-version
go build -trimpath -ldflags "-s -w -X main.Version=${VERSION} -X main.Commit=${COMMIT} -X main.BuildDate=${BUILD_DATE}" -o /src/.pipeline-out/cli-proxy-api ./cmd/server
ver=$(/src/.pipeline-out/cli-proxy-api --version 2>&1 || true); printf "%s\n" "$ver" | head -1
if ! go test ./... >/tmp/gotest.out 2>&1; then
  grep -E '^(--- FAIL|FAIL|panic)' /tmp/gotest.out | head -40
  exit 1
fi
echo "tests passed"
