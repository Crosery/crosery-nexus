#!/bin/bash
# 把「双源价格」补丁应用到共享同步实现 ~/.agents/crosery/sync.mjs（task-78）。
#
# 为什么需要这个脚本：补丁是在受限会话里开发的（那个会话**不能写** ~/.agents/crosery/），
# 所以实现以 patch 形式随仓库交付；有能力写共享目录的人跑一次即可（幂等、有备份、有语法校验）。
#
# 用法：bash scripts/apply-shared-sync-pricing.sh [--dry-run]
set -euo pipefail
TARGET="${HOME}/.agents/crosery/sync.mjs"
PATCH="$(cd "$(dirname "$0")/.." && pwd)/docs/qa/blue/patches/crosery-sync-pricing.patch"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

[ -f "$TARGET" ] || { echo "找不到共享实现：$TARGET" >&2; exit 2; }
[ -f "$PATCH" ] || { echo "找不到补丁：$PATCH" >&2; exit 2; }
if grep -q "openRouterPrice" "$TARGET"; then
  echo "已经应用过（检测到 openRouterPrice）→ 什么都不做"
  exit 0
fi
if [ "$DRY" = "1" ]; then
  echo "干跑：将把 $PATCH 应用到 $TARGET"
  patch -p1 --dry-run -d "$(dirname "$TARGET")" < "$PATCH"
  exit $?
fi
BACKUP="${TARGET}.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$TARGET" "$BACKUP"
echo "备份：$BACKUP"
if ! patch -p1 -d "$(dirname "$TARGET")" < "$PATCH"; then
  echo "打补丁失败，已保留备份（$BACKUP）；原文件未被破坏" >&2
  exit 1
fi
if ! node --check "$TARGET"; then
  echo "语法校验失败，回滚" >&2
  cp -p "$BACKUP" "$TARGET"
  exit 1
fi
echo "已应用并通过 node --check。验证：node \"$TARGET\" --dump-pricing"
