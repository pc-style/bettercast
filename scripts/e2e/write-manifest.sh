#!/usr/bin/env bash
# Write <out>/manifest.json: the exact commit, runner image, tool versions,
# artifact hashes and every recorded check (pass/fail + evidence), so a
# downloaded DMG can be matched to the run that tested it.
# usage: scripts/e2e/write-manifest.sh <out dir> [artifact files...]
set -uo pipefail
out="${1:?usage: write-manifest.sh <out dir> [artifacts...]}"
shift
mkdir -p "$out"

ver() { "$@" 2>&1 | head -n 1 | tr -d '\r'; }
export M_SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null)}"
export M_REF="${GITHUB_REF:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}"
export M_RUN="${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
export M_IMAGE="${ImageOS:-unknown} ${ImageVersion:-}"
export M_RUNNER="${RUNNER_NAME:-} ${RUNNER_ARCH:-$(uname -m)}"
M_MACOS="$(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"; export M_MACOS
M_XCODE="$(ver xcodebuild -version)"; export M_XCODE
M_SWIFT="$(ver swiftc --version)"; export M_SWIFT
M_ZIG="$(ver zig version)"; export M_ZIG
M_NATIVE="$(ver native version)"; export M_NATIVE
M_NODE="$(ver node --version)"; export M_NODE
M_SIP="$(ver csrutil status)"; export M_SIP

python3 - "$out" "$@" <<'PY'
import hashlib, json, os, sys
out, arts = sys.argv[1], sys.argv[2:]
checks_path = os.path.join(out, "checks.ndjson")
rows = []
if os.path.exists(checks_path):
    rows = [json.loads(l) for l in open(checks_path, encoding="utf-8") if l.strip()]
last = {}
for r in rows:
    last[r["id"]] = r
checks = list(last.values())
failed_required = [c["id"] for c in checks if c["required"] and c["status"] != "pass"]
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()
artifacts = []
for a in arts:
    if os.path.isfile(a):
        artifacts.append({"name": os.path.basename(a), "bytes": os.path.getsize(a), "sha256": sha(a)})
image_bytes = None
ib = os.path.join(out, "image-bytes.json")
if os.path.exists(ib):
    try:
        image_bytes = json.load(open(ib))
    except Exception:
        image_bytes = None
e = os.environ
manifest = {
    "app": {"id": "dev.pcstyle.bettercast", "name": "Bettercast"},
    "git": {"sha": e.get("M_SHA"), "ref": e.get("M_REF")},
    "run": e.get("M_RUN"),
    "runner": {"image": e.get("M_IMAGE").strip(), "runner": e.get("M_RUNNER").strip(),
               "macos": e.get("M_MACOS"), "sip": e.get("M_SIP")},
    "tools": {"xcode": e.get("M_XCODE"), "swift": e.get("M_SWIFT"), "zig": e.get("M_ZIG"),
              "native": e.get("M_NATIVE"), "node": e.get("M_NODE")},
    "build": {"automation": False,
              "note": "the DMG/zip are the release build (no -Dautomation): real_launch ran it from / like Finder does; the e2e suite drove an otherwise identical -Dautomation=true build of the same commit"},
    "artifacts": artifacts,
    "clipboard_image_bytes": image_bytes,
    "optional_checks": [x for x in os.environ.get("E2E_OPTIONAL", "").split(",") if x],
    "summary": {"checks": len(checks),
                "passed": sum(c["status"] == "pass" for c in checks),
                "failed_required": failed_required,
                "ok": len(checks) > 0 and not failed_required},
    "checks": checks,
}
with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
print(json.dumps(manifest["summary"]))
PY
