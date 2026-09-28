#!/usr/bin/env bash
# bettercast-helper OS-path tests. HOSTED CI ONLY (GitHub macOS runner):
# it writes the pasteboard, registers global hotkeys, posts key events and
# opens TextEdit. It refuses to run anywhere else.
#
# Usage: helper/ci-test.sh [helper path] [out dir]
# Prints PASS/FAIL/SKIP lines; exits 1 if anything FAILed. Logs in <out>.
set -uo pipefail
if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "helper/ci-test.sh: refusing to run outside GitHub Actions (it touches the pasteboard and hotkeys)" >&2
  exit 2
fi
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
H="${1:-$repo/app/assets/bin/bettercast-helper}"
out="${2:-$repo/app/e2e-out/helper}"
mkdir -p "$out"
export BETTERCAST_CI=1
data="$(mktemp -d)"
fx="$(mktemp -d)"
failures=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; failures=$((failures + 1)); }
skip() { echo "SKIP $*"; }
b64d() { if [[ "$1" == "-" ]]; then printf ''; else printf '%s' "$1" | base64 -d; fi; }

# --- one-shots -------------------------------------------------------------
"$H" --version | grep -q '^bettercast-helper ' && pass version || fail version
"$H" selftest > "$out/selftest.txt"; [[ $? == 0 ]] && grep -qx 'selftest ok' "$out/selftest.txt" && pass selftest || { fail selftest; cat "$out/selftest.txt"; }
"$H" apps > "$out/apps.txt"
names="$(grep '^app ' "$out/apps.txt" | while read -r _ n _; do b64d "$n"; echo; done)"
tail -1 "$out/apps.txt" | grep -qx done && grep -qx 'Terminal' <<<"$names" && pass "apps ($(grep -c '^app ' "$out/apps.txt") bundles, Terminal found)" || fail apps
awk 'length($0) >= 4096 { bad = 1 } END { exit bad }' "$out/apps.txt" && pass "apps line bound" || fail "apps line bound"
"$H" providers > "$out/providers.txt" && tail -1 "$out/providers.txt" | grep -qx done && pass providers || fail providers

printf 'synthetic attachment · ż\n' > "$fx/att one.txt"
{ printf 'provider fake\nbin -\nmodel -\nattach %s\nprompt\n' "$(printf '%s' "$fx/att one.txt" | base64)"; printf 'Question ☃ with a second line\nand more'; } > "$fx/req.txt"
BETTERCAST_AI_FAKE=1 "$H" ai --request "$fx/req.txt" > "$out/ai.txt"
answer="$(grep '^chunk ' "$out/ai.txt" | while read -r _ c; do b64d "$c"; done)"
[[ "$(tail -1 "$out/ai.txt")" == done ]] && grep -q 'Attachments: 1' <<<"$answer" && grep -q 'Question ☃' <<<"$answer" && pass "ai fake streams $(grep -c '^chunk ' "$out/ai.txt") chunks" || fail "ai fake"

# --- watch -----------------------------------------------------------------
log="$out/watch.log"
: > "$log"
# Wrapper parent so the parent-death exit can be tested by killing it.
bash -c '"$0" watch --hotkeys launcher:49:2048,clipboard:9:6400 --data-dir "$1" --images 1 >> "$2" 2>&1 & echo $! > "$1/helper.pid"; wait' "$H" "$data" "$log" &
wrapper=$!

# wait_line <regex> <seconds>: first log line matching regex after mark.
mark=0
wait_line() {
  local re="$1" secs="${2:-5}" i line
  for ((i = 0; i < secs * 10; i++)); do
    line="$(tail -n +"$((mark + 1))" "$log" | grep -m1 -E "$re" || true)"
    if [[ -n "$line" ]]; then echo "$line"; return 0; fi
    sleep 0.1
  done
  return 1
}
set_mark() { mark="$(wc -l < "$log" | tr -d ' ')"; }

if wait_line '^ready ' 15 > /dev/null; then pass "watch ready: $(grep -m1 '^ready' "$log")"; else fail "watch ready"; cat "$log"; fi
sleep 0.3
grep -q '^hotkey-error' "$log" && fail "hotkey registration: $(grep '^hotkey-error' "$log")" || pass "hotkeys registered (Opt+Space, Ctrl+Opt+V)"

text1=$'Synthetic clip ✓ zażółć 日本 — first\nsecond line'
printf '%s' "$text1" > "$fx/t1.txt"
set_mark; "$H" debug-pasteboard --file "$fx/t1.txt" --kind text > /dev/null
if l="$(wait_line '^clip text ' 5)"; then
  read -r _ _ at sha bytes preview src <<<"$l"
  want="$(printf '%s' "$text1" | shasum -a 256 | cut -d' ' -f1)"
  [[ "$sha" == "$want" && "$(cat "$data/clips/$sha.txt")" == "$text1" && "$bytes" == "$(printf '%s' "$text1" | wc -c | tr -d ' ')" ]] && pass "text clip stored as <sha>.txt" || fail "text clip content ($l)"
  [[ "$(b64d "$preview")" == "$text1" ]] && pass "text preview" || fail "text preview"
else fail "text clip"; fi

set_mark; "$H" debug-pasteboard --file "$fx/t1.txt" --kind text > /dev/null
l="$(wait_line '^clip text ' 5)" && [[ "$(awk '{print $4}' <<<"$l")" == "$sha" && "$(ls "$data/clips" | grep -c '\.txt$')" == 1 ]] && pass "same text dedupes to one file" || fail "text dedupe"

head -c 120000 /dev/zero | tr '\0' 'x' > "$fx/long.txt"; printf 'ż tail' >> "$fx/long.txt"
set_mark; "$H" debug-pasteboard --file "$fx/long.txt" --kind text > /dev/null
l="$(wait_line '^clip text ' 5)" && (( ${#l} < 4096 )) && (( $(b64d "$(awk '{print $6}' <<<"$l")" | wc -c) <= 240 )) && pass "long text: line < 4 KiB, preview <= 240 bytes" || fail "long text"

printf '  \n\t ' > "$fx/blank.txt"
set_mark; "$H" debug-pasteboard --file "$fx/blank.txt" --kind text > /dev/null
wait_line '^clip-skip empty' 5 > /dev/null && pass "blank text skipped" || fail "blank text"
for pair in "org.nspasteboard.ConcealedType concealed" "org.nspasteboard.TransientType transient" "org.nspasteboard.AutoGeneratedType autogenerated"; do
  read -r uti reason <<<"$pair"
  set_mark; "$H" debug-pasteboard --file "$fx/t1.txt" --kind text --extra-type "$uti" > /dev/null
  wait_line "^clip-skip $reason\$" 5 > /dev/null && pass "$reason skipped" || fail "$reason not skipped"
done

set_mark; tiff_line="$("$H" debug-pasteboard --file "$repo/app/assets/icon.png" --kind image | grep '^tiff-bytes')"
tiff_bytes="${tiff_line#tiff-bytes }"
if l="$(wait_line '^clip image ' 10)"; then
  read -r _ _ at isha ibytes w h src <<<"$l"
  [[ -f "$data/clips/$isha.png" && -f "$data/clips/$isha.thumb.png" ]] && [[ "$(shasum -a 256 "$data/clips/$isha.png" | cut -d' ' -f1)" == "$isha" ]] && pass "image stored as <sha>.png + thumb (${w}x${h})" || fail "image files ($l)"
  (( ibytes * 4 < tiff_bytes )) && pass "image PNG $ibytes bytes vs TIFF $tiff_bytes bytes" || fail "image not compressed ($ibytes vs $tiff_bytes)"
else fail "image clip"; fi
set_mark; "$H" debug-pasteboard --file "$repo/app/assets/icon.png" --kind image > /dev/null
l="$(wait_line '^clip image ' 10)" && [[ "$(awk '{print $4}' <<<"$l")" == "${isha:-x}" && "$(ls "$data/clips" | grep -c '^[0-9a-f]*\.png$')" == 1 ]] && pass "same image dedupes" || fail "image dedupe"

set_mark; "$H" copy --file "$fx/t1.txt" --kind text > "$out/copy.txt"
grep -qx 'result copied' "$out/copy.txt" && wait_line '^clip-skip self$' 5 > /dev/null && pass "own copy skipped as self" || fail "self marker"
[[ "$(pbpaste)" == "$text1" ]] && pass "copy put text on the pasteboard" || fail "copy content"

# Conflict: a second registration of the same chord must report hotkey-error.
"$H" watch --hotkeys launcher:49:2048 --data-dir "$data" --images 0 > "$out/watch2.log" 2>&1 &
w2=$!
for _ in $(seq 50); do grep -q '^ready' "$out/watch2.log" && break; sleep 0.1; done
sleep 0.3; kill "$w2" 2>/dev/null; wait "$w2" 2>/dev/null
grep -q '^hotkey-error launcher ' "$out/watch2.log" && pass "conflict reported: $(grep '^hotkey-error' "$out/watch2.log")" || fail "conflict not reported ($(cat "$out/watch2.log"))"

ax="$("$H" ax-status | awk '{print $2}')"
echo "info: helper Accessibility trust on this runner: ax=$ax"

set_mark; "$H" debug-key --code 49 --mods 2048 > "$out/key.txt"; kc=$?
if [[ $kc == 0 ]]; then
  wait_line '^hotkey launcher$' 5 > /dev/null && pass "Opt+Space fires hotkey launcher" || fail "hotkey did not fire"
else skip "hotkey fire (no Accessibility to post events, exit $kc)"; fi

set_mark; open -a TextEdit
if l="$(wait_line "^front [0-9]+ $(printf 'com.apple.TextEdit' | base64) " 15)"; then
  tpid="$(awk '{print $2}' <<<"$l")"; pass "front event for TextEdit (pid $tpid)"
  osascript -e 'tell application "TextEdit" to make new document' > /dev/null 2>&1 || true
  sleep 1
  "$H" paste --pid "$tpid" --file "$fx/t1.txt" --kind text > "$out/paste.txt"; pc=$?
  if [[ $pc == 0 ]]; then
    sleep 1
    got="$(osascript -e 'tell application "TextEdit" to get text of front document' 2>/dev/null || true)"
    [[ "$got" == *"Synthetic clip"* ]] && pass "paste into TextEdit" || fail "paste text not in TextEdit (got: ${got:0:80})"
  elif [[ $pc == 3 ]]; then
    grep -qx 'result copied' "$out/paste.txt" && [[ "$(pbpaste)" == "$text1" ]] && pass "paste without AX leaves content copied (exit 3)" || fail "copied-only path"
  else fail "paste exit $pc: $(cat "$out/paste.txt")"; fi
  osascript -e 'tell application "TextEdit" to quit saving no' > /dev/null 2>&1 || true
else fail "front event for TextEdit"; fi

# Parent death: kill the wrapper; the helper must exit on its own.
hp="$(cat "$data/helper.pid" 2>/dev/null)"
kill -9 "$wrapper" 2>/dev/null
for _ in $(seq 30); do kill -0 "$hp" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$hp" 2>/dev/null; then fail "watch survived its parent"; kill "$hp"; else pass "watch exits when its parent dies"; fi

awk 'length($0) >= 4096 { bad = 1 } END { exit bad }' "$log" && pass "watch line bound" || fail "watch line bound"
cp -R "$data/clips" "$out/clips" 2>/dev/null || true
echo "helper ci-test: $failures failure(s)"
exit $(( failures > 0 ))
