#!/usr/bin/env bash
# Fixture tests for check-macho-deps.sh. Runs on Linux or macOS.
set -uo pipefail
check="$(dirname "$0")/check-macho-deps.sh"
failures=0

expect() {
  local want="$1" name="$2" input="$3"
  printf '%s\n' "$input" | bash "$check" 2>/dev/null
  local got=$?
  if { [ "$want" = pass ] && [ "$got" -ne 0 ]; } || { [ "$want" = fail ] && [ "$got" -eq 0 ]; }; then
    echo "FAIL: $name (expected $want, exit $got)"
    failures=$((failures + 1))
  else
    echo "ok: $name"
  fi
}

T=$'\t'

expect pass "header path under /Users is not a dependency" \
"/Users/runner/work/bettercast/bettercast/build/out/Bettercast.app/Contents/MacOS/bettercast:
${T}/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1900.180.0)
${T}/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit (compatibility version 45.0.0, current version 2575.60.5)
${T}@rpath/hermes.framework/Versions/0/hermes (compatibility version 0.12.0, current version 0.12.0)
${T}/usr/lib/swift/libswiftCore.dylib (compatibility version 1.0.0, current version 0.0.0)"

expect pass "repeated header for a framework binary" \
"/Users/runner/x/Sparkle.framework/Versions/B/Sparkle:
${T}@rpath/Sparkle.framework/Versions/B/Sparkle (compatibility version 1.6.0, current version 2.9.5)
${T}@loader_path/../Frameworks/libfoo.dylib (compatibility version 1.0.0, current version 1.0.0)"

expect fail "DerivedData dependency" \
"/Users/runner/out/Bettercast.app/Contents/MacOS/bettercast:
${T}/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
${T}/Users/runner/work/bettercast/bettercast/build/DerivedData/Build/Products/Release/libReact.dylib (compatibility version 1.0.0, current version 1.0.0)"

expect fail "Homebrew dependency" \
"/tmp/app/bettercast:
${T}/opt/homebrew/lib/libsqlite3.dylib (compatibility version 9.0.0, current version 9.6.0)"

expect fail "path with spaces outside bundle" \
"/tmp/app/bettercast:
${T}/Applications/Some App.app/Contents/Frameworks/X.framework/X (compatibility version 1.0.0, current version 1.0.0)"

[ "$failures" -eq 0 ] && echo "all check-macho-deps fixtures passed"
exit "$failures"
