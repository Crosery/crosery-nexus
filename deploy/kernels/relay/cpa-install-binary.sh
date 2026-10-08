#!/bin/bash
# CPA 安装事务，唯一的安装入口（预发布与正式同一份，装到 /usr/local/sbin/cpa-install-binary.sh）：
#   门禁基线 → 备份二进制与配置快照 → 换二进制 → 重启 → 就绪 / 真实请求 / 兼容门禁 → 任一不过就换回旧二进制。
#
#   cpa-install-binary.sh <binary> <version> [-- <verify-hook> [args...]]
#
# kernel-applier.mjs 自动安装时带 hook（每类 OAuth 账号发一个真实请求）；一键回滚和人工安装不带。hook 会被追加
# `--phase baseline|verify|restored --budget <秒>`：baseline 在替换前跑，没过就不替换（已有故障不能造成误回滚）；
# verify 在换上之后跑；restored 在换回旧版本之后跑，只记录。
# 换上新二进制之后的全部检查必须在 CPA_VERIFY_BUDGET 秒（默认 25）内通过，否则立即换回旧二进制：出问题 30 秒内换回。
# 配置或被监视的凭据文件在换装期间变了（可能是新版本迁移了配置）就不自动换回：旧版本不能对着没审过的配置启动。
#
# 主机相关的值只来自 /etc/cli-proxy-api/install.env（root 600，不入库）或环境变量：
#   CPA_EXTRA_GATES   额外的兼容门禁（空格分隔，不带参数的可执行文件），例如 AGY 门禁
#   CPA_WATCH_FILES   除 config.yaml 外换装期间不许变的文件（空格分隔），例如被 AGY 门禁使用的凭据
#   CPA_CONSOLE_GATE  管理 API/Console 门禁（默认 /usr/local/sbin/cpa-management-console-compat-check；设为空则不跑）
#   CPA_READY_URL     就绪探测（默认 http://127.0.0.1:8317/v1/models；任何非 5xx 应答都算在跑）
#   CPA_VERIFY_BUDGET / CPA_BASELINE_BUDGET / CPA_RESTORE_VERIFY_BUDGET（秒）
set -uo pipefail
INSTALL_ENV=${CPA_INSTALL_ENV:-/etc/cli-proxy-api/install.env}
# shellcheck disable=SC1090
[ -r "$INSTALL_ENV" ] && . "$INSTALL_ENV"

NEWBIN=${1:?binary path}
EXPECT=${2:-}
shift $(( $# < 2 ? $# : 2 ))
HOOK=()
if [ "${1:-}" = "--" ]; then shift; HOOK=("$@"); fi
HOOK_N=${#HOOK[@]}

BIN=${CPA_BINARY:-/usr/local/bin/cli-proxy-api}
SVC=${CPA_SERVICE:-cli-proxy-api}
BACKUP_DIR=${CPA_BACKUP_DIR:-/var/backups/cpa}
LOCK=${CPA_INSTALL_LOCK:-/run/cpa-auto-update.lock}
CONFIG_FILE=${CPA_CONFIG:-/etc/cli-proxy-api/config.yaml}
HOLD=${CPA_HOLD_FILE:-/etc/cli-proxy-api/auto-update.hold}
CONSOLE_GATE=${CPA_CONSOLE_GATE-/usr/local/sbin/cpa-management-console-compat-check}
EXTRA_GATES=${CPA_EXTRA_GATES:-}
WATCH_FILES=${CPA_WATCH_FILES:-}
READY_URL=${CPA_READY_URL:-http://127.0.0.1:8317/v1/models}
int(){ case "$1" in ''|*[!0-9]*) echo "$2" ;; *) if [ "$1" -lt "$3" ] || [ "$1" -gt "$4" ]; then echo "$2"; else echo "$1"; fi ;; esac; }
KEEP=$(int "${CPA_KEEP_BACKUPS:-}" 5 1 50)
BUDGET=$(int "${CPA_VERIFY_BUDGET:-}" 25 5 120)
BASELINE_BUDGET=$(int "${CPA_BASELINE_BUDGET:-}" 60 5 600)
RESTORE_BUDGET=$(int "${CPA_RESTORE_VERIFY_BUDGET:-}" 60 5 600)

log(){ command -v logger >/dev/null 2>&1 && logger -t cpa-pipeline "$*"; echo "$*"; }
exec 9>"$LOCK" || exit 1
flock -w 120 9 || { log "拿不到锁，放弃"; exit 1; }
mkdir -p "$BACKUP_DIR"

if [ -e "$HOLD" ]; then log "本地补丁hold生效（含空锁文件），拒绝流水线安装"; exit 1; fi

chmod +x "$NEWBIN"
newver=$("$NEWBIN" --version 2>&1 || true)
if [ -z "$EXPECT" ]; then EXPECT=$(printf "%s\n" "$newver" | head -1 | grep -oE "Version: [^,]+" | cut -d" " -f2); fi
if [ -z "$EXPECT" ]; then log "未能解析版本且未指定 expected version，放弃"; exit 1; fi
if ! printf "%s\n" "$newver" | head -1 | grep -qF -- "$EXPECT"; then log "新二进制自检未报告 $EXPECT，放弃（线上未改动）"; exit 1; fi
curver=$("$BIN" --version 2>&1 || true)
cur=$(printf "%s\n" "$curver" | head -1 | grep -oE "Version: [^,]+" | cut -d" " -f2)
[ -z "$cur" ] && cur="unknown"
if [ "$cur" = "$EXPECT" ]; then log "线上已是 $EXPECT，跳过"; exit 0; fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/cpa-install.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
umask 077

# bounded <seconds> <cmd…>: run it, kill it when the seconds run out (exit 124). No GNU timeout needed.
bounded(){
  local limit=$1; shift
  [ "$limit" -gt 0 ] || return 124
  "$@" & local pid=$! end=$((SECONDS + limit))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$end" ]; then
      kill -TERM "$pid" 2>/dev/null; sleep 1; kill -KILL "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.2
  done
  wait "$pid"
}
left(){ echo $(( $1 - SECONDS )); }
# the gateway answers at all (401 without a key is an answer); 5xx or no connection is not
wait_ready(){
  local end=$1 code
  while [ "$SECONDS" -lt "$end" ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$READY_URL" 2>/dev/null || true)
    case "$code" in ''|000|5*) ;; *) return 0 ;; esac
    sleep 0.5
  done
  return 1
}
run_gates_once(){ # <end> [baseline]
  local end=$1 gate
  if [ -n "$CONSOLE_GATE" ]; then
    if [ "${2:-}" = baseline ]; then
      bounded "$(left "$end")" "$CONSOLE_GATE" --output "$tmp/baseline.json" >"$tmp/console.out" 2>&1 || return 1
    else
      bounded "$(left "$end")" "$CONSOLE_GATE" --baseline "$state_dir/baseline.json" --output "$state_dir/after.json" >"$tmp/console.out" 2>&1 || return 1
    fi
  fi
  for gate in $EXTRA_GATES; do bounded "$(left "$end")" "$gate" >"$tmp/gate.out" 2>&1 || return 1; done
  return 0
}
gates_pass(){ # <end>: retried while time is left (model registration warms up after a restart)
  local end=$1
  while :; do
    run_gates_once "$end" && return 0
    [ "$(left "$end")" -gt 3 ] || return 1
    log "等待兼容门禁（还剩 $(left "$end") 秒）..."
    sleep 2
  done
}
run_hook(){ # <phase> <end>
  [ "$HOOK_N" -gt 0 ] || return 0
  local budget
  budget=$(left "$2")
  [ "$budget" -gt 0 ] || return 124
  bounded "$budget" "${HOOK[@]}" --phase "$1" --budget "$budget" >"$tmp/hook-$1.out" 2>&1
}
hook_says(){ tail -n 1 "$tmp/hook-$1.out" 2>/dev/null | cut -c1-200; }

[ -z "$CONSOLE_GATE" ] || [ -x "$CONSOLE_GATE" ] || { log "兼容检查器缺失，线上未改动"; exit 1; }
for gate in $EXTRA_GATES; do [ -x "$gate" ] || { log "兼容检查器缺失（$gate），线上未改动"; exit 1; }; done

# Existing failures must block before replacing anything, never cause a spurious rollback.
end=$((SECONDS + BASELINE_BUDGET))
if ! run_gates_once "$end" baseline; then log "管理API/Console或兼容门禁基线失败，线上未改动；先修复现有故障再升级"; exit 1; fi
if ! run_hook baseline "$end"; then log "真实请求基线没过，线上未改动；先修复现有故障再升级（$(hook_says baseline)）"; exit 1; fi

backup="$BACKUP_DIR/cli-proxy-api.$cur.$(date +%Y%m%dT%H%M%S).$$"
state_dir="$backup.state"
mkdir -m 700 "$state_dir" || { log "快照目录创建失败，线上未改动"; exit 1; }
cp -a "$BIN" "$backup" || { log "二进制备份失败，线上未改动"; exit 1; }
cp -a "$CONFIG_FILE" "$state_dir/config.yaml.before" || { log "配置快照失败，线上未改动"; exit 1; }
n=0
for file in $WATCH_FILES; do
  n=$((n + 1))
  cp -a "$file" "$state_dir/watch-$n.before" || { log "凭据快照失败（$file），线上未改动"; exit 1; }
done
chmod 600 "$state_dir"/*.before
[ -f "$tmp/baseline.json" ] && cp "$tmp/baseline.json" "$state_dir/baseline.json"

state_unchanged(){
  local file i=0
  cmp -s "$CONFIG_FILE" "$state_dir/config.yaml.before" || return 1
  for file in $WATCH_FILES; do i=$((i + 1)); cmp -s "$file" "$state_dir/watch-$i.before" || return 1; done
  return 0
}
rollback(){
  log "$1；准备回滚到 $cur（备份 $backup）"
  # No configuration compare-and-swap exists across CPA, Console and human writers: a changed file may be a migration,
  # an OAuth refresh or a concurrent edit. Never overwrite it, never restart an older binary against an unreviewed one.
  if ! state_unchanged; then
    log "严重：配置/凭据已变更，无法区分迁移与并发编辑；停止自动回滚（含二进制），保留当前服务及快照 $state_dir，需人工审查恢复"; return 1
  fi
  if ! systemctl stop "$SVC"; then log "严重：停止服务失败，未回滚"; return 1; fi
  if ! state_unchanged; then
    systemctl start "$SVC"
    log "严重：停止期间发现配置冲突，未覆盖任何文件；人工审查 $state_dir"; return 1
  fi
  if ! install -m 755 "$backup" "$BIN"; then log "严重：二进制恢复失败；服务已停止，备份 $backup"; return 1; fi
  if ! systemctl start "$SVC"; then log "严重：旧版本启动失败，需人工介入"; return 1; fi
  log "旧二进制已换回（restore-at=$(date +%s)）"
  local rend=$((SECONDS + RESTORE_BUDGET))
  if wait_ready "$rend" && gates_pass "$rend"; then
    run_hook restored "$rend" || log "注意：旧版本的真实请求也没过（$(hook_says restored)），可能是上游或账号问题"
    log "已回滚到 $cur，旧版本应答且兼容门禁通过；配置未覆盖"
  else
    log "严重：回滚后旧版本没有应答或兼容门禁仍失败，需人工介入；快照 $state_dir"; return 1
  fi
}

# Do not start a deployment whose snapshots have already become stale.
if ! state_unchanged; then log "快照后配置发生变更，线上未改动，取消安装"; exit 1; fi
if [ -e "$HOLD" ]; then log "本地补丁hold仍生效（含空锁文件），取消安装"; exit 1; fi
log "开始安装 $cur -> $EXPECT（备份 $backup）"
if ! systemctl stop "$SVC"; then log "停止服务失败，二进制未改动"; exit 1; fi
if ! state_unchanged; then
  systemctl start "$SVC"
  log "停止期间配置发生变更，二进制未改动，取消安装"; exit 1
fi
if ! install -m 755 "$NEWBIN" "$BIN"; then rollback "新二进制安装失败"; exit 1; fi
log "换上 $EXPECT（swap-at=$(date +%s)）"
end=$((SECONDS + BUDGET))
if ! systemctl start "$SVC"; then rollback "新版本启动失败"; exit 1; fi
if ! wait_ready "$end"; then rollback "新版本 ${BUDGET} 秒内没有应答"; exit 1; fi
if ! run_hook verify "$end"; then rollback "真实请求验证没过（$(hook_says verify)）"; exit 1; fi
if ! gates_pass "$end"; then rollback "管理API/Console或兼容门禁回归"; exit 1; fi
if ! cmp -s "$CONFIG_FILE" "$state_dir/config.yaml.before"; then
  log "警告：升级期间主配置发生变化；当前验收通过，保留新配置及快照，不自动覆盖；需人工审查 $state_dir"
fi
log "安装成功 $cur -> $EXPECT（就绪、真实请求与兼容门禁通过；备份 $backup）"
# keep binary and its restricted snapshot together; never touch another backup family (names are ours: no spaces)
kept=0
# shellcheck disable=SC2012
ls -1td -- "$BACKUP_DIR"/cli-proxy-api.* 2>/dev/null | while read -r path; do
  [ -f "$path" ] && [ ! -L "$path" ] || continue
  kept=$((kept + 1))
  [ "$kept" -gt "$KEEP" ] || continue
  [ -d "$path.state" ] && [ ! -L "$path.state" ] && rm -rf "$path.state"
  rm -f "$path"
done
exit 0
