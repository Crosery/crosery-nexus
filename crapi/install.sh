#!/bin/sh
# crapi 一键安装（macOS / Linux，内置国内外自动加速）
#   curl -fsSL https://raw.githubusercontent.com/crosery/crapi/main/install.sh | sh
#   # 国内加速单行命令：
#   curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/crosery/crapi/main/install.sh | sh
#   # 带 Key 全自动：
#   curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/crosery/crapi/main/install.sh | sh -s -- --key sk-xxx
# 可选环境变量：
#   CRAPI_DOWNLOAD_BASE  发布产物下载地址（需包含 VERSION / SHA256SUMS / crapi-<os>-<arch>）
#   CRAPI_INSTALL_DIR    安装目录，默认 ~/.local/bin
#   CRAPI_NO_SETUP=1     只安装，不进入配置流程
set -eu

DIR="${CRAPI_INSTALL_DIR:-$HOME/.local/bin}"

if [ -t 1 ]; then
  Y="$(printf '\033[33m')"; G="$(printf '\033[32m')"; R="$(printf '\033[31m')"; N="$(printf '\033[0m')"
else
  Y=""; G=""; R=""; N=""
fi
say()  { printf '%s◆%s %s\n' "$Y" "$N" "$1"; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$1"; }
die()  { printf '%s✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  MINGW*|MSYS*|CYGWIN*) die "Windows 请在 PowerShell 中运行：irm https://raw.githubusercontent.com/crosery/crapi/main/install.ps1 | iex" ;;
  *) die "暂不支持的系统：$(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "暂不支持的 CPU 架构：$(uname -m)" ;;
esac

fetch() { # fetch <url> <out> [timeout_seconds]
  url="$1"
  out="$2"
  timeout="${3:-20}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout "$timeout" -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T "$timeout" -O "$out" "$url"
  else
    die "需要 curl 或 wget"
  fi
}

# 候选下载节点（七牛云 CDN 极速源 + GitHub 官方源 + 国内加速镜像）
PRIMARY_BASE="https://cdn.crosery.com/crapi"
OFFICIAL_BASE="https://github.com/crosery/crapi/releases/latest/download"
CANDIDATE_BASES=""

if [ -n "${CRAPI_DOWNLOAD_BASE:-}" ]; then
  CANDIDATE_BASES="${CRAPI_DOWNLOAD_BASE%/}"
else
  M1="https://ghfast.top/$OFFICIAL_BASE"
  M2="https://ghproxy.net/$OFFICIAL_BASE"
  CANDIDATE_BASES="$PRIMARY_BASE $M1 $OFFICIAL_BASE $M2"
fi

ASSET="crapi-$OS-$ARCH"
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t crapi)"
trap 'rm -rf "$TMP"' EXIT INT TERM

printf '\n%s  crapi · Crosery CPA 一键接入%s\n\n' "$Y" "$N"

CHOSEN_BASE=""
for base in $CANDIDATE_BASES; do
  if [ "$base" = "$PRIMARY_BASE" ]; then
    say "正在从七牛云 CDN 高速下载 $ASSET..."
  elif [ "$base" = "$OFFICIAL_BASE" ]; then
    say "正在从官方源下载 $ASSET..."
  else
    say "正在通过国内加速节点下载 $ASSET..."
  fi
  if fetch "$base/$ASSET" "$TMP/crapi" 25; then
    CHOSEN_BASE="$base"
    break
  fi
done

if [ -z "$CHOSEN_BASE" ]; then
  die "下载失败：已尝试所有官方及镜像源，请检查网络连接。"
fi

# 下载校验和进行安全校验
if [ -n "$CHOSEN_BASE" ] && fetch "$CHOSEN_BASE/SHA256SUMS" "$TMP/SHA256SUMS" 10 2>/dev/null; then
  WANT="$(awk -v a="$ASSET" '$2==a || $2=="*"a {print $1}' "$TMP/SHA256SUMS")"
  if [ -n "$WANT" ]; then
    if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$TMP/crapi" | awk '{print $1}')"
    else GOT="$(shasum -a 256 "$TMP/crapi" | awk '{print $1}')"; fi
    [ "$WANT" = "$GOT" ] || die "校验和不一致，已中止安装"
    ok "校验通过"
  fi
fi

mkdir -p "$DIR"
chmod +x "$TMP/crapi"
mv -f "$TMP/crapi" "$DIR/crapi"
ok "已安装到 $DIR/crapi"

# 把安装目录加入 PATH（只追加一次）
case ":$PATH:" in
  *":$DIR:"*) ;;
  *)
    LINE="export PATH=\"$DIR:\$PATH\"  # crapi"
    case "${SHELL:-}" in
      */zsh)  RCS="$HOME/.zshrc" ;;
      */bash) RCS="$HOME/.bashrc $HOME/.bash_profile" ;;
      */fish) RCS="" ; mkdir -p "$HOME/.config/fish/conf.d"
              echo "fish_add_path $DIR  # crapi" > "$HOME/.config/fish/conf.d/crapi.fish" ;;
      *)      RCS="$HOME/.profile" ;;
    esac
    for rc in $RCS; do
      [ -f "$rc" ] || [ "$rc" = "$HOME/.zshrc" ] || [ "$rc" = "$HOME/.bashrc" ] || [ "$rc" = "$HOME/.profile" ] || continue
      grep -qs "# crapi" "$rc" || printf '\n%s\n' "$LINE" >> "$rc"
    done
    ok "已把 $DIR 加入 PATH（新开终端生效）"
    ;;
esac

if [ "${CRAPI_NO_SETUP:-}" = "1" ]; then
  printf '\n运行 %scrapi setup%s 开始配置。\n' "$Y" "$N"
  exit 0
fi

printf '\n'
# 通过 curl | sh 运行时标准输入是管道，交互界面需要接到终端上。
if [ -r /dev/tty ] && [ -w /dev/tty ] && ( : </dev/tty ) 2>/dev/null; then
  "$DIR/crapi" setup "$@" </dev/tty
else
  "$DIR/crapi" setup --yes "$@"
fi
