#!/usr/bin/env bash
# Reads `otool -L` output on stdin and fails if any linked dependency lives
# outside the OS or the app bundle. Header lines (the inspected binary's own
# path, ending in ":") are not dependencies and are skipped.
set -euo pipefail

bad=0
while IFS= read -r line; do
  # otool prints dependencies indented with a tab; anything else is a header.
  case "$line" in
    [[:space:]]*) ;;
    *) continue ;;
  esac
  dep="${line#"${line%%[![:space:]]*}"}"
  dep="${dep%% (compatibility version*}"
  [ -z "$dep" ] && continue
  case "$dep" in
    @rpath/* | @executable_path/* | @loader_path/* | /System/Library/* | /usr/lib/*) ;;
    *)
      echo "non-bundled dependency: $dep" >&2
      bad=1
      ;;
  esac
done

exit "$bad"
