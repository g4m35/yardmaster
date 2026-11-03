#!/bin/sh
# Installs the standalone Yardmaster binary (no Node or npm needed).
#   curl -fsSL https://raw.githubusercontent.com/g4m35/yardmaster/main/install.sh | sh
# Options: YARDMASTER_VERSION=v0.2.1 (default: latest), YARDMASTER_INSTALL_DIR=~/bin (default: ~/.local/bin)
set -eu

repo="g4m35/yardmaster"
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "Yardmaster's binary supports macOS and Linux. On other systems use: npm install -g yardmaster" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "Unsupported CPU $(uname -m). Use: npm install -g yardmaster" >&2; exit 1 ;;
esac
if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
  echo "Intel Macs: use npm install -g yardmaster for now (no Intel build yet)." >&2
  exit 1
fi

name="yardmaster-$os-$arch"
version="${YARDMASTER_VERSION:-latest}"
if [ "$version" = latest ]; then base="https://github.com/$repo/releases/latest/download"; else base="https://github.com/$repo/releases/download/$version"; fi
dir="${YARDMASTER_INSTALL_DIR:-$HOME/.local/bin}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $name ($version)..."
curl -fsSL "$base/$name" -o "$tmp/ym"
curl -fsSL "$base/$name.sha256" -o "$tmp/ym.sha256"

expected="$(cut -d' ' -f1 "$tmp/ym.sha256")"
if command -v sha256sum > /dev/null 2>&1; then actual="$(sha256sum "$tmp/ym" | cut -d' ' -f1)"; else actual="$(shasum -a 256 "$tmp/ym" | cut -d' ' -f1)"; fi
if [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch; not installing. Expected $expected, got $actual." >&2
  exit 1
fi

mkdir -p "$dir"
mv "$tmp/ym" "$dir/ym"
chmod +x "$dir/ym"
ln -sf ym "$dir/yardmaster"
echo "Installed $("$dir/ym" --version) to $dir/ym"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add it to your PATH:  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.zshrc  (then open a new terminal)" ;;
esac
echo "Try it:  ym demo"
