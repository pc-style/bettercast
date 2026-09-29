#!/usr/bin/env bash
# Launch the packaged app the way a user does: no BETTERCAST_* test
# variables, so boot runs the real chain (locate, app scan, provider
# detection, login status, helper watch). Pass when the process is still
# alive after the wait; print its stderr either way (the SDK reports a
# fatal callback there as "platform callback failed: ...").
# usage: scripts/e2e/real-launch.sh <Bettercast.app> <out dir> [seconds]
set -uo pipefail
app="${1:?usage: real-launch.sh <Bettercast.app> <out dir> [seconds]}"
out="${2:?usage: real-launch.sh <Bettercast.app> <out dir> [seconds]}"
wait_s="${3:-15}"
exe="$app/Contents/MacOS/bettercast"
log="$out/real-launch.stderr.log"
mkdir -p "$out"

env -u BETTERCAST_TEST_MODE -u BETTERCAST_DATA_DIR -u BETTERCAST_HELPER -u BETTERCAST_AI_FAKE \
  "$exe" >"$log" 2>&1 &
pid=$!
for _ in $(seq 1 "$wait_s"); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done

if kill -0 "$pid" 2>/dev/null; then
  echo "alive after ${wait_s}s (pid $pid)"
  kill -TERM "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  pkill -f "$app/Contents/Resources/assets/bin/bettercast-helper" 2>/dev/null || true
  echo "--- stderr"; tail -n 20 "$log"
  exit 0
fi
wait "$pid"
rc=$?
echo "FAIL: exited on its own with status $rc within ${wait_s}s"
echo "--- stderr"; tail -n 40 "$log"
pkill -f "$app/Contents/Resources/assets/bin/bettercast-helper" 2>/dev/null || true
exit 1
