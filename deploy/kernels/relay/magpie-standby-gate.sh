#!/bin/bash
# Magpie 备用内核发布者（站长 Mac 上 scripts/magpie-standby.mjs）的 SSH forced-command 网关：只允许下面几种操作。
# 备用内核不接流量；暂存后由 crosery-kernel-update 校验、单独启动检查，再换上（scripts/kernel-applier.mjs）。
set -u
cmd=${SSH_ORIGINAL_COMMAND:-}
INBOX=/var/lib/crosery-kernels/magpie/inbox
kick() { systemctl start --no-block crosery-kernel-update.service >/dev/null 2>&1 || true; }
install -d -m 700 "$INBOX"
case "$cmd" in
  magpie-state) cat /opt/crosery-api-console/data/kernels/magpie.json 2>/dev/null || echo '{}' ;;
  magpie-upload\ *)
    rev=${cmd#magpie-upload }
    [[ "$rev" =~ ^[a-f0-9]{40}$ ]] || { echo 'bad revision'; exit 2; }
    gunzip -c | head -c 268435456 > "$INBOX/$rev.bin.tmp" && mv -f "$INBOX/$rev.bin.tmp" "$INBOX/$rev.bin" && echo "uploaded $(stat -c %s "$INBOX/$rev.bin")" ;;
  magpie-report)
    head -c 65537 > "$INBOX/report.json.tmp"
    [ "$(stat -c %s "$INBOX/report.json.tmp")" -le 65536 ] || { rm -f "$INBOX/report.json.tmp"; echo 'report too large'; exit 2; }
    mv -f "$INBOX/report.json.tmp" "$INBOX/report.json" && kick && echo reported ;;
  *) echo "denied: $cmd"; exit 2 ;;
esac
