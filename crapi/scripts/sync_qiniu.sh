#!/usr/bin/env bash
# 自动同步 crapi 发布产物到七牛云存储桶 crosery 并刷新 CDN 缓存，再把产物发到公开仓库的 GitHub Release。
# 用法：crapi/scripts/sync_qiniu.sh <version>      例：crapi/scripts/sync_qiniu.sh 0.3.0
# 源码在 crosery-api-console 的 crapi/ 下；Crosery/crapi 只做分发（Release 产物、jsDelivr 安装脚本），
# 所以这里不给控制台仓库打 tag、不推送，GitHub 操作一律用 --repo 指向公开仓库。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?用法：scripts/sync_qiniu.sh <version>，例如 0.3.0}"
VERSION="${VERSION#v}"
PUBLIC_REPO="Crosery/crapi"

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

echo "5. 同步更新 GitHub Release (v$VERSION → $PUBLIC_REPO)..."
if command -v gh >/dev/null 2>&1; then
  gh release delete "v$VERSION" --repo "$PUBLIC_REPO" --cleanup-tag -y 2>/dev/null || true
  gh release create "v$VERSION" dist/* --repo "$PUBLIC_REPO" --title "Release v$VERSION" \
    --notes "Release v$VERSION with Qiniu CDN and multi-mirror sync" \
    || echo "  ! GitHub Release 创建失败，七牛云 CDN 已更新；请手动补发 Release"
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
