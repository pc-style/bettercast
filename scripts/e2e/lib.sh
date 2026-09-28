#!/usr/bin/env bash
# Shared helpers for the Bettercast e2e suite (sourced, not executed).
# Result records: one JSON object per line in $E2E_OUT/checks.ndjson:
#   {"id","required","status":"pass|fail|skip","seconds","evidence","log"}
# Required-ness: every check is required unless its id is listed in
# E2E_OPTIONAL (comma-separated), which the manifest reports verbatim.

E2E_OUT="${E2E_OUT:-$PWD/e2e-out}"
E2E_OPTIONAL="${E2E_OPTIONAL:-}"
mkdir -p "$E2E_OUT/logs"

e2e_is_required() { # id -> 0 when required
  [[ ",$E2E_OPTIONAL," != *",$1,"* ]]
}

# record <id> <pass|fail|skip> <evidence> [log path]
record() {
  local id="$1" status="$2" evidence="$3" logp="${4:-}" seconds="${5:-0}" req=true
  e2e_is_required "$id" || req=false
  python3 - "$E2E_OUT/checks.ndjson" "$id" "$req" "$status" "$seconds" "$evidence" "$logp" <<'PY'
import json, sys
path, cid, req, status, seconds, evidence, logp = sys.argv[1:8]
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps({"id": cid, "required": req == "true", "status": status,
                        "seconds": float(seconds or 0), "evidence": evidence[-4000:],
                        "log": logp}, ensure_ascii=False) + "\n")
PY
  printf '%-28s %s  %s\n' "$id" "$(echo "$status" | tr '[:lower:]' '[:upper:]')" "${evidence:0:300}"
}

# run_check <id> <command...>: runs the command (a function or program) in a
# subshell with errexit, logs to logs/<id>.log, records pass/fail. Lines the
# command prints as "evidence: ..." become the recorded evidence; on
# failure the log tail is appended.
run_check() {
  local id="$1"; shift
  local logf="$E2E_OUT/logs/$id.log" start end rc evidence
  start=$(date +%s)
  echo "::group::check $id"
  (set -euo pipefail; "$@") 2>&1 | tee "$logf"
  rc=${PIPESTATUS[0]}
  echo "::endgroup::"
  end=$(date +%s)
  evidence="$(grep -a '^evidence: ' "$logf" 2>/dev/null | sed 's/^evidence: //' | tr '\n' ';' || true)"
  if [[ $rc -eq 0 ]]; then
    record "$id" pass "${evidence:-ok}" "logs/$id.log" "$((end - start))"
  else
    record "$id" fail "exit $rc; ${evidence}; tail: $(tail -n 6 "$logf" | tr '\n' ' ')" "logs/$id.log" "$((end - start))"
  fi
  return 0
}

ev() { echo "evidence: $*"; }
fail() { echo "FAIL: $*" >&2; ev "FAIL: $*"; exit 1; }

# Poll `cmd` until it succeeds or `secs` elapse (0.25 s steps).
wait_for() { # secs cmd...
  local secs="$1"; shift
  local n=$((secs * 4)) i
  for ((i = 0; i < n; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  "$@"
}

# Run cmd with a hard timeout (macOS has no coreutils `timeout`).
with_timeout() { # secs cmd...
  local secs="$1"; shift
  "$@" &
  local pid=$! t=0
  while kill -0 "$pid" 2>/dev/null; do
    if ((t >= secs * 10)); then kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 124; fi
    sleep 0.1; t=$((t + 1))
  done
  wait "$pid"
}

summarize() { # prints totals; returns 1 when a required check failed or an expected check never ran
  python3 - "$E2E_OUT/checks.ndjson" "${E2E_EXPECT:-}" "$E2E_OPTIONAL" <<'PY'
import json, os, sys
path, expect, optional = sys.argv[1], sys.argv[2].split(), sys.argv[3].split(",")
rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()] if os.path.exists(path) else []
# the last record for an id wins (a re-run replaces an earlier result)
last = {}
for r in rows: last[r["id"]] = r
# E2E_EXPECT lists checks that must have run: a skipped step (an earlier
# failure) is a missing result, never a silent pass.
for cid in expect:
    if cid not in last:
        last[cid] = {"id": cid, "required": cid not in optional, "status": "missing", "evidence": "never ran (an earlier step failed or was skipped)"}
bad = [r for r in last.values() if r["required"] and r["status"] != "pass"]
opt = [r for r in last.values() if not r["required"] and r["status"] != "pass"]
print(f"checks: {len(last)}  passed: {sum(r['status']=='pass' for r in last.values())}  required failures: {len(bad)}  optional failures: {len(opt)}")
for r in bad: print(f"  REQUIRED FAIL {r['id']}: {r['evidence'][:400]}")
for r in opt: print(f"  optional fail {r['id']}: {r['evidence'][:400]}")
sys.exit(1 if bad else 0)
PY
}
