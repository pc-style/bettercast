#!/usr/bin/env bash
# Package Bettercast.app from the last `native build` (app/zig-out/bin) and
# make the bundled helper executable.
#
# `native package` copies app/assets/ into Contents/Resources/assets/ but
# drops the executable bit, and a bundle launched from a read-only place
# (DMG, App Translocation) cannot chmod it at runtime. So: package, chmod
# the helper, re-seal the ad-hoc signature, verify, and (with --dmg) build
# the drag-to-Applications DMG from the fixed bundle.
#
# usage: scripts/package-app.sh <out dir> [--dmg]
#   <out dir>/Bettercast.app, and with --dmg <out dir>/Bettercast-<version>.dmg
# Never opens the app. The DMG step uses hdiutil only (no Finder scripting).
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:?usage: package-app.sh <out dir> [--dmg]}"
want_dmg="${2:-}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
app="$out/Bettercast.app"
helper_rel="Contents/Resources/assets/bin/bettercast-helper"

[[ -x "$repo/app/assets/bin/bettercast-helper" ]] || { echo "package-app: build the helper first (scripts/build-helper.sh)" >&2; exit 1; }
rm -rf "$app"
(cd "$repo/app" && native package --target macos --output "$app" --signing adhoc)

[[ -f "$app/$helper_rel" ]] || { echo "package-app: helper missing from the bundle" >&2; exit 1; }
chmod 755 "$app/$helper_rel"
codesign --force --sign - "$app/$helper_rel"
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"
[[ -x "$app/$helper_rel" ]] || { echo "package-app: helper not executable after chmod" >&2; exit 1; }
echo "package-app: $app ($(lipo -archs "$app/$helper_rel") helper, mode $(stat -f '%Sp' "$app/$helper_rel"))"

if [[ "$want_dmg" == "--dmg" ]]; then
  version="$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")"
  dmg="$out/Bettercast-$version.dmg"
  stage="$(mktemp -d "${TMPDIR:-/tmp}/bettercast-dmg.XXXXXX")"
  trap 'rm -rf "$stage"' EXIT
  ditto "$app" "$stage/Bettercast.app"
  ln -s /Applications "$stage/Applications"
  rm -f "$dmg"
  hdiutil create -quiet -volname Bettercast -srcfolder "$stage" -ov -format UDZO -imagekey zlib-level=9 "$dmg"
  echo "package-app: $dmg ($(du -h "$dmg" | cut -f1))"
fi
