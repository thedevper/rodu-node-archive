#!/bin/sh
# Installs the shoal binary on macOS without Homebrew:
#
#   curl -fsSL https://raw.githubusercontent.com/TheDevper/shoal/main/packaging/install.sh | sh
#
# SHOAL_VERSION=0.1.0       a specific release instead of the latest
# SHOAL_BIN_DIR=~/bin       where to put shoal (default ~/.local/bin)
# SHOAL_DOWNLOAD_BASE=URL   where the release files are (for testing a local build)
set -eu

REPO="TheDevper/shoal"
BIN_DIR="${SHOAL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  echo "shoal install: $*" >&2
  exit 1
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target="darwin-arm64" ;;
  Darwin-x86_64) target="darwin-x64" ;;
  *) fail "no build for $(uname -s) $(uname -m) yet (macOS and Windows are supported)" ;;
esac

version="${SHOAL_VERSION:-}"
if [ -z "$version" ]; then
  # /releases/latest redirects to /releases/tag/vX.Y.Z; no API token or JSON parsing needed.
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") ||
    fail "could not reach GitHub"
  version="${latest##*/v}"
fi
version="${version#v}"
case "$version" in
  *[!0-9.]* | "" | .* | *. | *..*) fail "unexpected version '$version' (no release published yet?)" ;;
esac
base="${SHOAL_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/v$version}"
archive="shoal-v$version-$target.tar.gz"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading shoal $version ($target)"
curl -fsSL -o "$tmp/$archive" "$base/$archive" || fail "could not download $base/$archive"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download SHA256SUMS"
expected=$(awk -v a="$archive" '$2 == a { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $archive"
actual=$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)
[ "$expected" = "$actual" ] || fail "checksum mismatch for $archive"

tar -xzf "$tmp/$archive" -C "$tmp" shoal
mkdir -p "$BIN_DIR"
# Replace by rename so a running shoal keeps its old file.
mv -f "$tmp/shoal" "$BIN_DIR/shoal"
chmod 755 "$BIN_DIR/shoal"
echo "Installed $("$BIN_DIR/shoal" --version) to $BIN_DIR/shoal"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "$BIN_DIR is not on your PATH yet. Add it, then open a new terminal:"
    case "${SHELL:-}" in
      */fish) echo "  fish_add_path $BIN_DIR" ;;
      */bash) echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bash_profile" ;;
      *) echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc" ;;
    esac
    ;;
esac
echo
echo "Start: mkdir ~/shoal && cd ~/shoal && shoal init --name <you> --key <KEY>, then shoal web"
