#!/bin/bash
# 构建机（ibuki-wsl-crosery）的 SSH forced-command 网关：只允许下面几种操作，禁止任意 shell。
# v2：构建机不再安装。它上传、暂存、报告；安装由 crosery-kernel-update（安静时段、每个版本一次）
# 经 /usr/local/sbin/cpa-install-binary.sh 完成（scripts/kernel-applier.mjs）。
set -u
cmd=${SSH_ORIGINAL_COMMAND:-}
INBOX=/var/lib/crosery-kernels/cpa/inbox
UPLOAD=/tmp/cpa-pipeline-upload.bin
kick() { systemctl start --no-block crosery-kernel-update.service >/dev/null 2>&1 || true; }
case "$cmd" in
  cpa-version) exec /usr/local/bin/cli-proxy-api --version ;;
  cpa-state) cat /opt/crosery-api-console/data/kernels/cpa.json 2>/dev/null || echo '{}' ;;
  cpa-upload) gunzip -c > "$UPLOAD.tmp" && mv -f "$UPLOAD.tmp" "$UPLOAD" && echo "uploaded $(stat -c %s "$UPLOAD")" ;;
  cpa-stage\ *)
    ver=${cmd#cpa-stage }
    [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo 'bad version'; exit 2; }
    [ -s "$UPLOAD" ] || { echo 'nothing uploaded'; exit 2; }
    install -d -m 700 "$INBOX" && mv -f "$UPLOAD" "$INBOX/$ver.bin" && echo "staged $ver" ;;
  cpa-report)
    install -d -m 700 "$INBOX"
    head -c 65537 > "$INBOX/report.json.tmp"
    [ "$(stat -c %s "$INBOX/report.json.tmp")" -le 65536 ] || { rm -f "$INBOX/report.json.tmp"; echo 'report too large'; exit 2; }
    mv -f "$INBOX/report.json.tmp" "$INBOX/report.json" && kick && echo reported ;;
  *) echo "denied: $cmd"; exit 2 ;;
esac
