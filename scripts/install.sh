#!/usr/bin/env bash
# Install Bettercast from the CI artifact: unzip Bettercast.app.zip, clear the
# download quarantine flag, and copy the app to ~/Applications.
# Refuses to replace an app with a different bundle id (the older Sol-era
# Bettercast is com.pcstyle.bettercast and stays where it is).
# Usage: bash install.sh [path/to/Bettercast.app.zip]
#   BETTERCAST_INSTALL_DIR overrides the destination folder.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
zip="${1:-$here/Bettercast.app.zip}"
dest_dir="${BETTERCAST_INSTALL_DIR:-$HOME/Applications}"
dest="$dest_dir/Bettercast.app"
want_id="dev.pcstyle.bettercast"

bundle_id() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true; }
bundle_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || true; }

[[ -f "$zip" ]] || { echo "install: $zip not found" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/bettercast-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
xattr -d com.apple.quarantine "$zip" 2>/dev/null || true
ditto -x -k "$zip" "$tmp"
app="$tmp/Bettercast.app"
[[ -d "$app" ]] || { echo "install: Bettercast.app not in $zip" >&2; exit 1; }
id="$(bundle_id "$app")"
[[ "$id" == "$want_id" ]] || { echo "install: unexpected bundle id '$id' in $zip" >&2; exit 1; }

if [[ -e "$dest" ]]; then
  old_id="$(bundle_id "$dest")"
  if [[ "$old_id" != "$want_id" ]]; then
    echo "install: $dest belongs to '$old_id', not $want_id; leaving it alone." >&2
    echo "install: set BETTERCAST_INSTALL_DIR to install somewhere else." >&2
    exit 1
  fi
  if pgrep -f "$dest/Contents/MacOS/" >/dev/null; then
    echo "install: Bettercast is running from $dest; quit it first." >&2
    exit 1
  fi
  rm -rf "$dest"
fi

mkdir -p "$dest_dir"
ditto "$app" "$dest"
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
echo "installed Bettercast $(bundle_version "$dest") ($want_id) to $dest"
echo "open it with: open \"$dest\""
