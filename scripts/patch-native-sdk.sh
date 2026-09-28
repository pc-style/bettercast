#!/usr/bin/env bash
# Apply Bettercast's fixes to the installed @native-sdk/cli before building.
# usage: scripts/patch-native-sdk.sh [sdk dir]   (default: global npm install)
#
# native-sdk-0.10.1-ax-focus-echo: the macOS host echoed the runtime's own
# focus back as an assistive "focus" action on every accessibility publish,
# demoting a Tab-earned ring to quiet focus; a Tab-focused list row then
# ignored Space/Return and buttons lost their visible focus ring.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sdk="${1:-$(npm root -g)/@native-sdk/cli}"
version="$(node -p "require('$sdk/package.json').version")"
[[ "$version" == "0.10.1" ]] || { echo "patch-native-sdk: patches target 0.10.1, found $version; re-check them" >&2; exit 1; }
for p in "$here"/patches/native-sdk-0.10.1-*.patch; do
  if patch -p1 -R -f -s --dry-run -d "$sdk" < "$p" >/dev/null 2>&1; then
    echo "already applied: $(basename "$p")"
  else
    patch -p1 -f -d "$sdk" < "$p"
    echo "applied: $(basename "$p")"
  fi
done
