#!/bin/bash
# v3-cutover §3 (rehearsed on sj-4837-new 2026-10-03). Runbook §3 + §4 (v3 form): MANIFEST check, then a throwaway instance on 18787 with its own DATA_DIR/HOME and a dead CPA.
# Started with setsid so the whole tree is one process group; cleanup kills only that group (never pgrep -f).
set -u
NEW=${NEW:-/opt/crosery-api-console-releases/20261003-console-v3}
PORT=${PORT:-18787}
FAIL=0
note(){ printf '%s\n' "$*"; }
hard(){ printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL+1)); }
cd "$NEW" || { echo "FAIL  $NEW 不存在"; exit 9; }
sha256sum -c MANIFEST.sha256 --quiet && note "PASS  MANIFEST OK ($(wc -l < MANIFEST.sha256) 条)" || hard "MANIFEST 校验失败"
[ "$(grep -c 'id="app"' dist/index.html)" = 1 ] && note 'PASS  dist/index.html 是 Vue 入口' || hard 'dist/index.html 不是 Vue 入口'
ss -ltn | grep -q ":$PORT " && { hard "端口 $PORT 已被占用"; exit "$FAIL"; }
STAGE_DATA=$(mktemp -d /tmp/crosery-staging-data-XXXX)
STAGE_HOME=$(mktemp -d /tmp/crosery-staging-home-XXXX)
setsid env -i PATH=/opt/crosery-node-current/bin:/usr/bin:/bin HOME="$STAGE_HOME" \
    DATA_DIR="$STAGE_DATA" HOST=127.0.0.1 PORT="$PORT" \
    CPA_BASE_URL=http://127.0.0.1:9 CPA_MANAGEMENT_KEY=staging-not-real \
    SESSION_SECRET=staging-not-real-0123456789abcdef0123 \
    CONSOLE_USERNAME=staging CONSOLE_PASSWORD=staging-not-real \
    /opt/crosery-node-current/bin/npm run start > /tmp/crosery-staging.log 2>&1 < /dev/null &
PID=$!
sleep 0.5
PGID=$(ps -o pgid= -p "$PID" | tr -d ' ')
note "staging pid=$PID pgid=$PGID"
UP=0
for i in $(seq 1 40); do
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/session" && { UP=1; break; }
  kill -0 "$PID" 2>/dev/null || { hard "进程已退出"; break; }
  sleep 0.5
done
[ "$UP" = 1 ] || hard "20s 内未开始监听 $PORT"
c(){ curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://127.0.0.1:$PORT$1" || echo 000; }
[ "$(c /api/session)" = 200 ] && note "PASS  H1 session=200" || hard "H1 session"
[ "$(curl -s --max-time 5 http://127.0.0.1:$PORT/ | grep -c 'id="app"')" = 1 ] && note "PASS  H2 vue-index=1" || hard "H2 vue-index"
[ "$(c /keys)" = 200 ] && note "PASS  H3 /keys=200" || hard "H3 /keys"
entry=$(grep -oE '/assets/[^"]+\.js' dist/index.html | head -1)
[ "$(c "$entry")" = 200 ] && note "PASS  H4 asset=200" || hard "H4 asset"
[ "$(c /api/monitor)" = 401 ] && note "PASS  H5 未登录 /api/monitor=401" || hard "H5 monitor 未拒绝"
[ "$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' -X POST http://127.0.0.1:$PORT/api/credentials/upload)" = 401 ] && note "PASS  H6 未登录 upload=401（路由存在且受保护）" || hard "H6 upload"
# cleanup: the recorded process group only
kill -TERM -- "-$PGID" 2>/dev/null; sleep 2; kill -KILL -- "-$PGID" 2>/dev/null
rm -rf "$STAGE_DATA" "$STAGE_HOME"
ss -ltn | grep -q ":$PORT " && hard "端口 $PORT 仍在监听" || note "PASS  临时实例已关闭（pgid $PGID）"
echo "硬失败计数: $FAIL"
exit "$FAIL"
