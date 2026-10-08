#!/bin/bash
# CPA 构建流水线 v3（构建机，用户级 cpa-pipeline.timer 每 30 分钟）
#   deploy 分支 = 上游 release + 我们的补丁（补丁系列见控制台仓库 deploy/kernels/cpa-patches/）。
#   CPA 要保持最新：每轮把上游最新的正式 release 合进 deploy（patch、minor、major 都一样）；
#   合并冲突就停住报「要人工移植补丁」，线上不动。
#   合并 → docker 里 go build + go test → 冒烟（生产形状的假配置）→ 存进本机候选库 state/candidates/<版本>/。
#   每一轮最后都交给 tools/cpa-coordinator.mjs：先上预发布，预发布装上后验收一次、浸泡满时长再验收一次，都过了才把
#   同一个二进制连同预发布的记录送到正式。构建机从不安装。
#   两台机器的网关命令与验收参数只在 $ROOT/pipeline.env（不入库）：CPA_PIPELINE_PREVIEW、CPA_PIPELINE_PRODUCTION、
#   CPA_ACCEPT_BASE_URL、CPA_ACCEPT_KEY、CPA_ACCEPT_MODELS。缺了就直接失败，没有默认值。
set -uo pipefail
ROOT=${CPA_PIPELINE_ROOT:-$HOME/cpa-pipeline}; SRC=$ROOT/src; STATE=$ROOT/state; LOG=$ROOT/logs/pipeline.log; TOOLS=$ROOT/tools
STORE=$STATE/candidates
# shellcheck disable=SC1091
if [ -r "$ROOT/pipeline.env" ]; then set -a; . "$ROOT/pipeline.env"; set +a; fi
: "${CPA_PIPELINE_PREVIEW:?CPA_PIPELINE_PREVIEW is not set (pipeline.env)}"
: "${CPA_PIPELINE_PRODUCTION:?CPA_PIPELINE_PRODUCTION is not set (pipeline.env)}"
mkdir -p "$STATE" "$STORE" "$ROOT/logs"
log(){ echo "[$(date +%FT%T)] $*" | tee -a "$LOG"; }
exec 9>"$ROOT/.lock"; flock -n 9 || exit 0

# report <status> [reason-text] — always the last thing a round does: the coordinator uploads, accepts, promotes and
# reports the round to both hosts (their consoles show it). Returns the coordinator's status.
UPSTREAM_LATEST=""; LINE=""; BASE=""; HELD_TAG=""; HELD_TEXT=""; CAND_JSON=null
report(){
  local status=$1 text=${2:-}
  node -e '
    const [status, text, latest, line, base, heldTag, heldText, cand] = process.argv.slice(1)
    const tag = v => (/^v\d+\.\d+\.\d+$/.test(v) ? v : null)
    process.stdout.write(JSON.stringify({ version: 1, kernel: "cpa", status, checkedAt: new Date().toISOString(),
      upstreamLatest: tag(latest), line: /^v\d+\.\d+$/.test(line) ? line : null, base: tag(base),
      heldNewer: tag(heldTag) ? { tag: heldTag, text: heldText } : null,
      candidate: JSON.parse(cand), reasons: text ? [{ code: status, text: text.slice(0, 280) }] : [] }))
  ' "$status" "$text" "$UPSTREAM_LATEST" "$LINE" "$BASE" "$HELD_TAG" "$HELD_TEXT" "$CAND_JSON" > "$STATE/report.json"
  cp "$STATE/report.json" "$STATE/last.json"
  if ! node "$TOOLS/cpa-coordinator.mjs" round --root "$ROOT" >>"$LOG" 2>&1; then log "协调者这一轮有失败（见日志）"; return 1; fi
}

cd "$SRC" || { log "src 不存在"; exit 1; }
git rev-parse --verify -q deploy >/dev/null || { log "deploy 分支不存在"; report held "构建机上没有 deploy 分支"; exit 0; }
if ! git checkout -q deploy 2>>"$LOG"; then log "切换 deploy 分支失败"; report held "构建机切不到 deploy 分支；保留未提交改动，不构建"; exit 1; fi
if ! git fetch -q --tags upstream 2>>"$LOG"; then log "拉取上游失败"; report fetch-failed "构建机拉不到上游 tag"; exit 1; fi
stable(){ git tag -l "$1" --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1; }
latest=$(stable 'v*')
[ -n "$latest" ] || { log "找不到上游 tag"; report fetch-failed "上游没有正式 release tag"; exit 1; }
UPSTREAM_LATEST=$latest
BASE=$(git describe --tags --abbrev=0 --match 'v*' deploy 2>/dev/null || echo v0.0.0)
LINE=${BASE%.*}
if ! git merge-base --is-ancestor "$latest" deploy; then
  if ! git merge --no-edit "$latest" >>"$LOG" 2>&1; then
    files=$(git diff --name-only --diff-filter=U | head -5 | paste -sd' ' -)
    git merge --abort 2>/dev/null
    HELD_TAG=$latest; HELD_TEXT="上游 $latest 和我们的补丁冲突，要人工移植补丁后才跟"
    log "合并 $latest 冲突：$files"; report merge-conflict "合并 $latest 时补丁冲突：$files"; exit 1
  fi
  log "已合并上游 $latest 到 deploy"
  BASE=$latest; LINE=${BASE%.*}
fi
sha=$(git rev-parse --short=8 HEAD); version="${latest#v}-patched.$sha"

# built and smoke-tested before (the version names the commit): reuse it; a damaged copy is rebuilt
if [ -s "$STORE/$version/candidate.json" ] && [ -x "$STORE/$version/cli-proxy-api" ]; then
  want=$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sha256 ?? "") } catch { console.log("") }' "$STORE/$version/candidate.json")
  if [ -n "$want" ] && [ "$(sha256sum "$STORE/$version/cli-proxy-api" | cut -d' ' -f1)" = "$want" ]; then
    CAND_JSON=$(cat "$STORE/$version/candidate.json"); report built; exit $?
  fi
fi

log "开始构建 $version"
rm -rf "$SRC/.pipeline-out"; mkdir -p "$SRC/.pipeline-out"
if ! docker run --rm -v "$SRC:/src" -w /src \
     -v "$ROOT/cache/gomod:/go/pkg/mod" -v "$ROOT/cache/gobuild:/root/.cache/go-build" \
     -v "$ROOT/build-in-container.sh:/build.sh:ro" \
     -e GOPROXY=https://goproxy.cn,direct -e CGO_ENABLED=0 -e GOFLAGS=-buildvcs=false \
     -e VERSION="$version" -e COMMIT="$sha" -e BUILD_DATE="$(date -u +%FT%TZ)" \
     golang:1.26-bookworm bash /build.sh > "$STATE/build.out" 2>&1; then
  cat "$STATE/build.out" >> "$LOG"
  fails=$(grep -E '^(--- FAIL|FAIL|panic)' "$STATE/build.out" | head -3 | tr '\n' ' ')
  log "构建或测试失败"; report build-failed "构建或 go test 没过：${fails:-见构建机日志}"; exit 1
fi
cat "$STATE/build.out" >> "$LOG"
BIN=$SRC/.pipeline-out/cli-proxy-api
[ -x "$BIN" ] || { log "产物缺失"; report build-failed "构建产物缺失"; exit 1; }

if ! node "$TOOLS/cpa-smoke.mjs" --binary "$BIN" --version "$version" --config "$TOOLS/smoke-config.yaml" > "$STATE/smoke.json" 2>>"$LOG"; then
  failed=$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(r.checks.filter(c => !c.ok).map(c => c.name + (c.detail ? " " + c.detail : "")).slice(0, 3).join("；"))' "$STATE/smoke.json" 2>/dev/null)
  log "冒烟失败：$failed"; report smoke-failed "冒烟没过：${failed:-见构建机日志}"; exit 1
fi
CAND_JSON=$(node -e '
  const [version, sha256, commit, tag, smoke] = process.argv.slice(1)
  const checks = JSON.parse(require("fs").readFileSync(smoke, "utf8")).checks.map(({ name, ok, detail }) => ({ name, ok, detail }))
  console.log(JSON.stringify({ version, sha256, commit, tag, checks }))
' "$version" "$(sha256sum "$BIN" | cut -d' ' -f1)" "$(git rev-parse HEAD)" "$latest" "$STATE/smoke.json")

incoming="$STORE/.incoming-$version"
rm -rf "$incoming"; mkdir -p "$incoming"
if ! cp "$BIN" "$incoming/cli-proxy-api" || ! printf '%s\n' "$CAND_JSON" > "$incoming/candidate.json"; then
  rm -rf "$incoming"; log "写候选库失败"; report build-failed "构建机写不进候选库"; exit 1
fi
rm -rf "${STORE:?}/$version"; mv "$incoming" "$STORE/$version"
log "已构建并冒烟 $version，交给协调者（先上预发布）"
report built
