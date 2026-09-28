#!/usr/bin/env bash
# Run one command as a recorded check (used by the CI workflow for build
# steps so they land in the same checks.ndjson/manifest as the e2e tests).
# usage: E2E_OUT=<dir> scripts/e2e/check.sh <id> <command> [args...]
# Exits with the command's status so the workflow step fails too.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/lib.sh
source "$here/lib.sh"
id="${1:?usage: check.sh <id> <command...>}"
shift
logf="$E2E_OUT/logs/$id.log"
start=$(date +%s)
"$@" 2>&1 | tee "$logf"
rc=${PIPESTATUS[0]}
end=$(date +%s)
if [[ $rc -eq 0 ]]; then
  record "$id" pass "$(tail -n 3 "$logf" | tr '\n' ' ')" "logs/$id.log" "$((end - start))"
else
  record "$id" fail "exit $rc: $(tail -n 8 "$logf" | tr '\n' ' ')" "logs/$id.log" "$((end - start))"
fi
exit "$rc"
