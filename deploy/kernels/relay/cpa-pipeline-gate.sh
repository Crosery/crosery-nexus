#!/bin/bash
# 构建机（协调者 scripts/cpa-coordinator.mjs）的 SSH forced-command 网关。预发布与正式同一份，按角色放行：
#   authorized_keys：command="/usr/local/sbin/cpa-pipeline-gate.sh preview",restrict <构建机公钥>
#                    command="/usr/local/sbin/cpa-pipeline-gate.sh production",restrict <构建机公钥>
# 只允许下面几种操作，禁止任意 shell。构建机从不安装：它上传、暂存、报告、送验收与晋级记录；
# 安装由 crosery-kernel-update（scripts/kernel-applier.mjs）经 /usr/local/sbin/cpa-install-binary.sh 完成。
#   通用：cpa-version · cpa-state · cpa-upload（stdin gzip）· cpa-stage <版本> · cpa-report（stdin JSON）· rtk-state
#   预发布：cpa-accept（stdin 验收记录）· cpa-promotion（读晋级记录）
#   正式：cpa-promote（stdin 晋级记录）· rtk-promote（stdin RTK 晋级记录）
set -u
role=${1:-}
case "$role" in preview|production) ;; *) echo 'gate role must be preview or production'; exit 2 ;; esac
cmd=${SSH_ORIGINAL_COMMAND:-}
LIB=${KERNEL_LIB_DIR:-/var/lib/crosery-kernels}
DATA=${KERNEL_DATA_DIR:-/opt/crosery-api-console/data}
RTK_STATE=${RTK_STATE_DIR:-$DATA/rtk}
BINARY=${CPA_BINARY:-/usr/local/bin/cli-proxy-api}
INBOX=$LIB/cpa/inbox
UPLOAD=$LIB/cpa/upload.bin
MAX_BINARY=268435456
kick() { systemctl start --no-block crosery-kernel-update.service >/dev/null 2>&1 || true; }
# take <file> <max-bytes>: stdin → file, capped, replaced atomically
take() {
  head -c $(( $2 + 1 )) > "$1.tmp" || { rm -f "$1.tmp"; echo 'write failed'; exit 2; }
  [ "$(wc -c < "$1.tmp")" -le "$2" ] || { rm -f "$1.tmp"; echo 'too large'; exit 2; }
  mv -f "$1.tmp" "$1"
}
install -d -m 700 "$INBOX"
case "$role:$cmd" in
  *:cpa-version) exec "$BINARY" --version ;;
  *:cpa-state) cat "$DATA/kernels/cpa.json" 2>/dev/null || echo '{}' ;;
  *:cpa-upload)
    gunzip -c | head -c $(( MAX_BINARY + 1 )) > "$UPLOAD.tmp" || { rm -f "$UPLOAD.tmp"; echo 'upload failed'; exit 2; }
    [ "$(wc -c < "$UPLOAD.tmp")" -le "$MAX_BINARY" ] || { rm -f "$UPLOAD.tmp"; echo 'upload too large'; exit 2; }
    mv -f "$UPLOAD.tmp" "$UPLOAD" && echo "uploaded $(wc -c < "$UPLOAD")" ;;
  *:cpa-stage\ *)
    ver=${cmd#cpa-stage }
    [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo 'bad version'; exit 2; }
    [ -s "$UPLOAD" ] || { echo 'nothing uploaded'; exit 2; }
    mv -f "$UPLOAD" "$INBOX/$ver.bin" && echo "staged $ver" ;;
  *:cpa-report) take "$INBOX/report.json" 65536 && kick && echo reported ;;
  *:rtk-state) cat "$RTK_STATE/autoupdate-rtk.json" 2>/dev/null || echo '{}' ;;
  preview:cpa-accept) take "$INBOX/acceptance.json" 65536 && kick && echo accepted ;;
  preview:cpa-promotion) cat "$DATA/kernels/cpa-promotion.json" 2>/dev/null || echo '{}' ;;
  # the report that follows kicks the applier; binary, record and report are taken together
  production:cpa-promote) take "$INBOX/promotion.json" 65536 && echo recorded ;;
  production:rtk-promote) install -d -m 700 "$RTK_STATE" && take "$RTK_STATE/promotion.json" 65536 && echo recorded ;;
  *) echo "denied: $cmd"; exit 2 ;;
esac
