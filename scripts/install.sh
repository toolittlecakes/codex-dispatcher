#!/bin/sh
set -eu

repo="toolittlecakes/codex-dispatcher"
install_dir="${CODEX_DISPATCHER_INSTALL_DIR:-$HOME/.local/bin}"
binary_name="codex-dispatcher"

os="$(uname -s)"
arch="$(uname -m)"

case "$os-$arch" in
  Darwin-arm64)
    asset="codex-dispatcher-darwin-arm64"
    ;;
  *)
    echo "Unsupported platform: $os-$arch" >&2
    echo "This installer currently ships a macOS arm64 binary only." >&2
    exit 1
    ;;
esac

mkdir -p "$install_dir"

url="https://github.com/$repo/releases/latest/download/$asset"
tmp="$(mktemp "${TMPDIR:-/tmp}/codex-dispatcher.XXXXXX")"
trap 'rm -f "$tmp"' EXIT INT TERM

echo "Downloading $url"
curl -fsSL "$url" -o "$tmp"
chmod +x "$tmp"
mv "$tmp" "$install_dir/$binary_name"

echo "Installed $binary_name to $install_dir/$binary_name"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    echo "Add $install_dir to PATH to run $binary_name from any shell."
    ;;
esac

echo "Run: $binary_name doctor"
