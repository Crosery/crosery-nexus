#!/bin/bash
# usage: v3-switch.sh <release-dir-name> [cookie-jar]  — atomic symlink swap + restart, then the §6 checks.
# Same command for cut-over and for rollback (pass 20260928-reset-clears-cooldown). Rehearsed on sj-4837-new 2026-10-03.
set -u
T=/opt/crosery-api-console-releases/$1; B=http://127.0.0.1:8787; svc=crosery-api-console.service
test -d "$T" || { echo "no $T"; exit 9; }
before=$(systemctl show $svc -p NRestarts --value)
t0=$(date +%s.%N)
ln -s "$T" /opt/crosery-api-console-current.next && mv -T /opt/crosery-api-console-current.next /opt/crosery-api-console-current
systemctl restart $svc
for i in $(seq 1 240); do curl -s -o /dev/null --max-time 2 $B/api/session && break; sleep 0.25; done
echo "current=$(readlink -f /opt/crosery-api-console-current | xargs basename) listening after $(echo "$(date +%s.%N) - $t0" | bc | cut -c1-4)s"
sleep 8
systemctl show $svc -p ActiveState -p NRestarts | tr '\n' ' '; echo "(NRestarts before=$before)"
echo "session=$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' $B/api/session) app-index=$(curl -s $B/ | grep -c 'id="app"') root-index=$(curl -s $B/ | grep -c 'id="root"') keys=$(curl -s -o /dev/null -w '%{http_code}' $B/keys) unauth-monitor=$(curl -s -o /dev/null -w '%{http_code}' $B/api/monitor)"
[ -n "${2:-}" ] && echo "existing cookie → $(curl -s -b "$2" $B/api/session | head -c 120)"
exit 0
