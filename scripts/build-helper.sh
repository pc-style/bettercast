#!/usr/bin/env bash
# Build bettercast-helper (helper/*.swift) into app/assets/bin/bettercast-helper.
# Universal (arm64 + x86_64) when both slices compile, else the host arch.
# Works with Command Line Tools only (no Xcode project, no SwiftPM).
# Usage: scripts/build-helper.sh [--arch arm64|x86_64|universal]   (default universal)
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo/helper"
out_dir="$repo/app/assets/bin"
out="$out_dir/bettercast-helper"
want="${2:-universal}"
[[ "${1:-}" == "--arch" ]] || want=universal
min_macos="${BETTERCAST_MIN_MACOS:-13.0}"

mkdir -p "$out_dir"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bettercast-helper.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

sources=()
while IFS= read -r f; do sources+=("$f"); done < <(find "$src" -maxdepth 1 -name '*.swift' | sort)

build_slice() {
  local arch="$1"
  swiftc -O -swift-version 5 -target "$arch-apple-macos$min_macos" \
    -module-name bettercast_helper -o "$tmp/helper-$arch" "${sources[@]}"
}

host="$(uname -m)"
case "$want" in
  arm64|x86_64) build_slice "$want"; cp "$tmp/helper-$want" "$out" ;;
  universal)
    build_slice "$host"
    other=x86_64; [[ "$host" == x86_64 ]] && other=arm64
    if build_slice "$other" 2>"$tmp/other.log"; then
      lipo -create "$tmp/helper-arm64" "$tmp/helper-x86_64" -output "$out"
    else
      echo "build-helper: $other slice failed; shipping $host only" >&2
      sed 's/^/  /' "$tmp/other.log" >&2
      cp "$tmp/helper-$host" "$out"
    fi
    ;;
  *) echo "build-helper: unknown arch $want" >&2; exit 2 ;;
esac

# Ad-hoc sign so the binary runs from inside the (ad-hoc signed) bundle.
codesign --force --sign - "$out" >/dev/null 2>&1 || true
chmod 755 "$out"
lipo -archs "$out" | sed "s|^|build-helper: $out: |"
