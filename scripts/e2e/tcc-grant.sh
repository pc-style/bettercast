#!/usr/bin/env bash
# CI ONLY (hosted macOS runner). Grants Accessibility, PostEvent,
# ScreenCapture and AppleEvents(TextEdit) to the processes the e2e suite
# runs, by inserting rows into the TCC databases, then reports what the
# system actually allows. Never run this on a personal Mac.
#
# usage: tcc-grant.sh <out dir> <client path or bundle id>...
# Writes <out>/tcc.txt (evidence) and <out>/tcc.env (TCC_WRITE_SYSTEM=0|1,
# TCC_WRITE_USER=0|1, SIP=...). Always exits 0: the checks that need a
# permission fail on their own with the reason recorded here.
set -uo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" && "${BETTERCAST_E2E_ALLOW_LOCAL:-}" != "1" ]]; then
  echo "tcc-grant.sh: refusing to modify TCC outside GitHub Actions" >&2
  exit 2
fi

out="${1:?usage: tcc-grant.sh <out dir> <client>...}"
shift
mkdir -p "$out"
log="$out/tcc.txt"
: > "$log"
note() { echo "$*" | tee -a "$log"; }

sys_db="/Library/Application Support/com.apple.TCC/TCC.db"
user_db="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
sip="$(csrutil status 2>&1 | tr '\n' ' ')"
note "sip: $sip"
note "macos: $(sw_vers -productVersion) build $(sw_vers -buildVersion) arch $(uname -m)"

# The responsible process for TCC is usually an ancestor of this shell
# (the runner agent), so grant every ancestor executable too.
clients=("$@")
pid=$$
for _ in $(seq 1 12); do
  ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ -z "$ppid" || "$ppid" == "0" || "$ppid" == "1" ]] && break
  exe="$(ps -o comm= -p "$ppid" 2>/dev/null)"
  [[ "$exe" == /* ]] && clients+=("$exe")
  pid="$ppid"
done
clients+=("/bin/bash" "/bin/zsh" "/bin/sh" "/usr/bin/osascript" "/usr/sbin/screencapture")

now="$(date +%s)"
# Name the columns explicitly (macOS 14/15 layout); columns added by a
# newer macOS keep their defaults. If the full row fails, try the minimal
# older layout, then report.
# sqlite3 on a TCC db (sudo for the system db). No arrays: macOS bash 3.2
# treats an empty "${arr[@]}" as unbound under set -u.
db_sql() { # db sql
  if [[ "$1" == "$sys_db" ]]; then sudo sqlite3 "$1" "$2"; else sqlite3 "$1" "$2"; fi
}
insert_row() { # db service client client_type indirect_type indirect_id
  local db="$1" service="$2" client="$3" ctype="$4" itype="$5" iid="$6"
  local c=${client//\'/\'\'}
  db_sql "$db" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded) VALUES ('$service', '$c', $ctype, 2, 4, 1, NULL, NULL, $itype, '$iid', NULL, 0, $now, NULL, NULL, 'UNUSED', $now);" 2>>"$log" && return 0
  db_sql "$db" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier, flags, last_modified) VALUES ('$service', '$c', $ctype, 2, 4, 1, '$iid', 0, $now);" 2>>"$log"
}

sys_ok=1
user_ok=1
for client in "${clients[@]}"; do
  if [[ "$client" == /* ]]; then ctype=1; else ctype=0; fi
  for service in kTCCServiceAccessibility kTCCServicePostEvent kTCCServiceScreenCapture; do
    if insert_row "$sys_db" "$service" "$client" "$ctype" 0 "UNUSED"; then
      note "granted $service -> $client"
    else
      sys_ok=0
      note "FAILED $service -> $client (system TCC.db not writable: SIP/TCC protection)"
    fi
  done
  mkdir -p "$(dirname "$user_db")"
  if insert_row "$user_db" kTCCServiceAppleEvents "$client" "$ctype" 0 "com.apple.TextEdit"; then
    note "granted kTCCServiceAppleEvents(TextEdit) -> $client"
  else
    user_ok=0
    note "FAILED kTCCServiceAppleEvents(TextEdit) -> $client (user TCC.db not writable)"
  fi
done

# tccd caches decisions; restart it so the new rows are read.
sudo killall -9 tccd >/dev/null 2>&1 || true
killall -9 tccd >/dev/null 2>&1 || true
sleep 1

{
  echo "TCC_WRITE_SYSTEM=$sys_ok"
  echo "TCC_WRITE_USER=$user_ok"
  echo "SIP=\"$sip\""
} > "$out/tcc.env"
note "system db writable: $sys_ok, user db writable: $user_ok"
exit 0
