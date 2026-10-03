#!/bin/bash
# CPA 构建流水线 v2（跑在 ibuki-wsl-crosery，用户级 cpa-pipeline.timer 每 30 分钟）
#   deploy 分支 = 上游 release + 我们的补丁。只在当前 minor 线内自动合并上游的新 patch 版；
#   更新的 minor/major 不合并，报「要人工合并补丁」（补丁要按新版本移植，见控制台仓库 deploy/kernels/README.md）。
#   合并 → docker 里 go build + go test → 冒烟（生产形状的假配置：管理接口、Key 级白名单、配置写回不丢字段）
#   → 上传 + 暂存到中转站。构建机不安装：中转站的 crosery-kernel-update 在安静时段、每个版本一次，
#   经 cpa-install-binary.sh（兼容门禁、备份、失败回滚）安装。每一轮的结论都报给中转站（cpa-report），控制台「网关」可见。
set -uo pipefail
# CPA_PIPELINE_ROOT / CPA_PIPELINE_VPS only for a rehearsal next to the live pipeline (own dir, own key, another host)
ROOT=${CPA_PIPELINE_ROOT:-$HOME/cpa-pipeline}; SRC=$ROOT/src; STATE=$ROOT/state; LOG=$ROOT/logs/pipeline.log; TOOLS=$ROOT/tools
VPS=${CPA_PIPELINE_VPS:-"ssh -o BatchMode=yes -o ConnectTimeout=15 -p 39822 root@10.250.250.81"}
mkdir -p "$STATE" "$ROOT/logs"
log(){ echo "[$(date +%FT%T)] $*" | tee -a "$LOG"; }
exec 9>"$ROOT/.lock"; flock -n 9 || exit 0

# report <status> [reason-text] — always the last thing a round does; the relay records it for the console
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
  $VPS cpa-report < "$STATE/report.json" >>"$LOG" 2>&1 || log "报告没送到中转站"
}

cd "$SRC" || { log "src 不存在"; exit 1; }
git rev-parse --verify -q deploy >/dev/null || { log "deploy 分支不存在"; report held "构建机上没有 deploy 分支"; exit 0; }
git checkout -q deploy
if ! git fetch -q --tags upstream 2>>"$LOG"; then log "拉取上游失败"; report fetch-failed "构建机拉不到上游 tag"; exit 1; fi
stable(){ git tag -l "$1" --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1; }
UPSTREAM_LATEST=$(stable 'v*')
BASE=$(git describe --tags --abbrev=0 --match 'v*' deploy 2>/dev/null || echo v0.0.0)
LINE=${BASE%.*}
latest=$(stable "$LINE.*")
[ -n "$latest" ] || { log "找不到 $LINE 线的 tag"; report held "上游没有 $LINE 线的 tag"; exit 1; }
if [ -n "$UPSTREAM_LATEST" ] && [ "$UPSTREAM_LATEST" != "$latest" ]; then
  HELD_TAG=$UPSTREAM_LATEST; HELD_TEXT="上游 $UPSTREAM_LATEST 不在当前 $LINE 线，补丁要人工移植后才跟"
fi
if ! git merge-base --is-ancestor "$latest" deploy; then
  if ! git merge --no-edit "$latest" >>"$LOG" 2>&1; then
    files=$(git diff --name-only --diff-filter=U | head -5 | tr '\n' ' ')
    git merge --abort 2>/dev/null
    log "合并 $latest 冲突：$files"; report merge-conflict "合并 $latest 时补丁冲突：$files"; exit 1
  fi
  log "已合并上游 $latest 到 deploy"
  BASE=$latest
fi
sha=$(git rev-parse --short=8 HEAD); version="${latest#v}-patched.$sha"

deployed=$($VPS cpa-version 2>/dev/null | grep -oE "Version: [^,]+" | cut -d" " -f2 || true)
if [ "$deployed" = "$version" ]; then report up-to-date; exit 0; fi
# already built and staged on the relay: just say so (keeps 「检查于」 fresh on the console); a lost or rejected drop is rebuilt
staged=$($VPS cpa-state 2>/dev/null | node -e 'let s = ""; process.stdin.on("data", d => s += d).on("end", () => { try { console.log(JSON.parse(s).staged?.version ?? "") } catch { console.log("") } })')
if [ "$staged" = "$version" ] && [ "$(cat "$STATE/staged-version" 2>/dev/null)" = "$version" ] && [ -s "$STATE/candidate.json" ]; then
  CAND_JSON=$(cat "$STATE/candidate.json"); report built; exit 0
fi

log "开始构建 $version（线上 ${deployed:-unknown}）"
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

if ! gzip -c "$BIN" | $VPS cpa-upload >>"$LOG" 2>&1 || ! $VPS "cpa-stage $version" >>"$LOG" 2>&1; then
  log "上传失败"; report upload-failed "上传到中转站失败"; exit 1
fi
echo "$CAND_JSON" > "$STATE/candidate.json"; echo "$version" > "$STATE/staged-version"
log "已暂存 $version 到中转站，等安静时段安装"
report built
