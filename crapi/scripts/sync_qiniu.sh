#!/usr/bin/env bash
# 自动同步 crapi 发布产物到七牛云存储桶 crosery 并刷新 CDN 缓存。
# 用法：scripts/sync_qiniu.sh [version]
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-0.1.5}"
echo "1. 编译全平台产物（版本：$VERSION）..."
./scripts/build.sh "$VERSION"

echo "2. 确保七牛云账号切换到 crosery..."
qshell user cu crosery

echo "3. 上传 dist 产物到七牛云 crosery:crapi/..."
for f in dist/*; do
  name="$(basename "$f")"
  echo "  --> 上传 $name ..."
  qshell rput crosery "crapi/$name" "$f" --overwrite >/dev/null
done

echo "4. 刷新七牛云 CDN 缓存 (https://cdn.crosery.com/crapi/)..."
echo "https://cdn.crosery.com/crapi/" | qshell cdnrefresh -r

echo "5. 同步更新 GitHub Release (v$VERSION)..."
if command -v gh >/dev/null 2>&1; then
  git tag -f "v$VERSION"
  git push origin "v$VERSION" --force 2>/dev/null || true
  gh release delete "v$VERSION" -y 2>/dev/null || true
  gh release create "v$VERSION" dist/* --title "Release v$VERSION" --notes "Release v$VERSION with Qiniu CDN and multi-mirror sync" 2>/dev/null || true
fi

echo "6. 刷新 jsDelivr 历史旧缓存（防止第三方镜像污染）..."
for u in \
  "https://purge.jsdelivr.net/gh/crosery/crapi/install.ps1" \
  "https://purge.jsdelivr.net/gh/crosery/crapi/install.sh" \
  "https://purge.jsdelivr.net/gh/crosery/crapi@main/install.ps1" \
  "https://purge.jsdelivr.net/gh/crosery/crapi@main/install.sh" \
  "https://purge.jsdelivr.net/gh/crosery/crapi@latest/install.ps1" \
  "https://purge.jsdelivr.net/gh/crosery/crapi@latest/install.sh"; do
  curl -s "$u" >/dev/null 2>&1 || true
done

echo "同步完成！可通过以下直连高速链接验证："
echo "  https://cdn.crosery.com/crapi/VERSION"
echo "  https://cdn.crosery.com/crapi/install.sh"
echo "  https://cdn.crosery.com/crapi/install.ps1"
