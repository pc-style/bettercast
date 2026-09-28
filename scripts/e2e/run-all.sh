#!/usr/bin/env bash
# Bettercast end-to-end suite against the PACKAGED app. CI ONLY: it
# registers global hotkeys, posts real keystrokes, writes the pasteboard,
# drives TextEdit, reads the accessibility tree and captures the screen.
# Never run it on a Mac someone is using.
#
# usage: scripts/e2e/run-all.sh <path/to/Bettercast.app> <out dir>
#
# Phase A (BETTERCAST_TEST_MODE=1, dry): the automation keyboard contract
#   (scripts/e2e/launcher-keys.sh), OS effects recorded as notices only.
# Phase B (BETTERCAST_TEST_MODE=e2e): real helper, real hotkeys, real
#   pasteboard, real paste into TextEdit, fake AI provider.
#
# Outputs under <out>: checks.ndjson, logs/, snapshots/, reference-canvas/
# (native automate screenshots: deterministic reference renderer, NOT the
# screen), desktop-capture/ (screencapture -x of the real desktop, each with
# a non-blank/changed-vs-baseline verdict), ax/ (AXUIElement tree dumps).
# Exit status: 1 when any required check failed (see lib.sh E2E_OPTIONAL).
set -uo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" && "${BETTERCAST_E2E_ALLOW_LOCAL:-}" != "1" ]]; then
  echo "run-all.sh: refusing to run outside GitHub Actions (it takes over the keyboard, pasteboard and screen)" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "${1:?usage: run-all.sh <Bettercast.app> <out dir>}" && pwd)"
mkdir -p "${2:?usage: run-all.sh <Bettercast.app> <out dir>}"
OUT="$(cd "$2" && pwd)"
export E2E_OUT="$OUT"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
# shellcheck source=scripts/e2e/lib.sh
source "$HERE/lib.sh"

APP_BIN="$APP/Contents/MacOS/bettercast"
HELPER="$APP/Contents/Resources/assets/bin/bettercast-helper"
APP_SUPPORT="$HOME/Library/Application Support/dev.pcstyle.bettercast"
# Inside the app's own data root: Cmd.readFile/writeFile only accept paths
# under it (no filesystem permission is declared), so the override stays there.
DATA_DIR="$APP_SUPPORT/e2e-data"
RUN_DIR="$OUT/run"
STATE="$OUT/state"
TOOL="${E2E_TOOL:-$OUT/bin/e2e-tool}"
mkdir -p "$OUT"/{snapshots,reference-canvas,desktop-capture,ax,bin} "$STATE"

if [[ ! -x "$TOOL" ]]; then
  swiftc -O -o "$TOOL" "$HERE/tools/e2e-tool.swift" || { record e2e_tool fail "swiftc failed"; exit 1; }
fi

# ------------------------------------------------------------------ UI names
# The accessible names the suite asserts (from app/src/viewmodel.ts,
# hotkeys.ts, app.native, windows/manage.native). Change them together.
V=main-canvas
M=manage-canvas
# a11y state flags as printed in snapshot.txt: state=[selected] / state=[focused,...]
SEL='state=.[a-z, ]*selected'
FOC='state=.[a-z, ]*focused'
FIELD='role=textbox name="Search Bettercast"'
CLIP_FIELD='role=textbox name="Search clipboard history"'
AI_FIELD='role=textbox name="Ask AI"'
MANAGE_TITLE='Bettercast Settings'
SNIP_NAME_FIELD='role=textbox name="Name"'
SNIP_KEYWORD_FIELD='role=textbox name="Keyword"'
SNIP_BODY_FIELD='role=textbox name="Text"'
SAVE_BTN='role=button name="Save"'
DELETE_BTN='role=button name="Delete…"'
CONFIRM_DELETE_BTN='role=button name="Delete"'
NEW_SNIPPET_BTN='role=button name="New Snippet"'
RECORD_LAUNCHER_BTN='role=button name="Record shortcut for Open Bettercast"'
ACTION_QUEUE='Add to Paste Queue'
ACTION_DELETE_CLIP='Delete…'
ACTION_ATTACH='Attach Clipboard Image'
# BETTERCAST_AI_FAKE=1 + provider "fake": helper/AI.swift runFake streams
# "Fake answer.\nPrompt: <n> bytes.\nAttachments: <k> - <name> (<type>, <n> bytes).\nEcho: <prompt>".
AI_FAKE_MARKER='Fake answer'
AI_FAKE_ATTACHED='Attachments: 1'
# Global hotkeys (defaults from hotkeys.ts defaultHotkeys) as e2e-tool chords.
HK_LAUNCHER='opt+space'
HK_CLIPBOARD='opt+cmd+v'
HK_PASTE_NEXT='ctrl+cmd+v'
HK_ASK_AI='opt+cmd+i'
HK_NEW='ctrl+opt+cmd+j'          # what the hotkey_change check records
HK_NEW_WIDGET='ctrl+alt+cmd+j'   # same chord in native automate syntax
HK_NEW_LABEL='Ctrl+Opt+Cmd+J'
# `native automate assert` patterns are regexes: a bare `+` is a quantifier,
# so literal chord labels need `[+]`.
HK_NEW_LABEL_RE='Ctrl[+]Opt[+]Cmd[+]J'

# Synthetic, asymmetric test data (never real user data).
SNIP_NAME='E2E Ωmega snippet'
SNIP_KEYWORD='e2eq'
SNIP_BODY='Hello from the Bettercast e2e suite — ünïcödé ✓ 12345'
SNIP_BODY2='Edited body v2 ☂ (shorter)'
CLIP1='e2e clip one ☂ 1,5 kg'
CLIP2='e2e clip two — a much longer line of text that keeps going to check wrapping and previews 0123456789'
CLIP_SECRET='e2e-concealed-secret-4711'
QUEUE_A='e2e queue A ✓'
QUEUE_B='e2e queue B — ✓✓ second'

# ------------------------------------------------------------------ plumbing
A() { (cd "$RUN_DIR" && native automate "$@"); }
AS() { A assert --timeout-ms "${ASSERT_MS:-10000}" "$@"; }
AS_ABSENT() { A assert --absent --timeout-ms "${ASSERT_MS:-10000}" "$@"; }
SNAPSHOT() { cat "$RUN_DIR/.zig-cache/native-sdk-automation/snapshot.txt" 2>/dev/null; }
# grep the file directly: `cat | grep -q` exits 141 (SIGPIPE) under pipefail
# when grep stops reading early, which read as "no match".
snap_has() { grep -aqE -- "$1" "$RUN_DIR/.zig-cache/native-sdk-automation/snapshot.txt" 2>/dev/null; }
snap() { SNAPSHOT > "$OUT/snapshots/$1.txt" || true; }
# `|| true`: x="$(app_pid)" must not trip errexit before the app wrote its pid.
app_pid() { cat "$STATE/app.pid" 2>/dev/null || true; }
T() { "$TOOL" "$@"; }

widget_id() { # view pattern -> numeric widget id from the snapshot
  SNAPSHOT | grep -m 1 -aoE -- "/$1#[0-9]+ $2" | sed -E 's/^[^#]*#([0-9]+).*/\1/' || true
}

set_text() { # view pattern text (runtime text-input path; used as fallback)
  local id
  id="$(widget_id "$1" "$2")"
  [[ -n "$id" ]] || fail "no widget matching $2 in $1"
  A widget-action "$1" "$id" set_text "$3"
}

focus_to() { # view pattern [max tabs]: Tab until the matching widget has focus
  local view="$1" pat="$2" max="${3:-40}" i
  for ((i = 0; i <= max; i++)); do
    sleep 0.15
    if snap_has "$pat.*focused=true" || snap_has "$pat.*$FOC"; then return 0; fi
    A widget-key "$view" tab >/dev/null
  done
  fail "Tab never reached: $pat"
}

field_text_is() { # pattern text
  AS "$1.*text=\"$2\""
}

# Type with REAL key events (CGEvent) into the focused field; if the field
# does not show the text, fall back to the runtime text path and say so.
type_into() { # view pattern text
  T type "$3" >/dev/null
  if ASSERT_MS=4000 field_text_is "$2" "$3" >/dev/null 2>&1; then
    ev "typed real keys into ${2#*name=}"
  else
    set_text "$1" "$2" "$3"
    field_text_is "$2" "$3"
    ev "real typing did not reach ${2#*name=}; used set_text"
    echo "real-typing-fallback $2" >> "$STATE/typing-fallbacks"
  fi
}

select_action() { # title: with the actions menu open, arrow to the item and run it
  local i
  for ((i = 0; i < 12; i++)); do
    if snap_has "role=menuitem name=\"$1\".*$SEL"; then
      A widget-key "$V" enter
      return 0
    fi
    A widget-key "$V" arrowdown >/dev/null
    sleep 0.1
  done
  fail "action not found: $1"
}

# On-screen windows of the app (CGWindowList, no permission needed for
# bounds). Panel = 720x460 points; Manage = any other window >= 600 wide.
win_sizes() { T windows "$(app_pid)" | sed -nE 's/.* w=([0-9]+) h=([0-9]+) .*/\1 \2/p'; }
panel_onscreen() { win_sizes | awk '$1 >= 710 && $1 <= 730 && $2 >= 450 && $2 <= 470 { f = 1 } END { exit !f }'; }
panel_offscreen() { ! panel_onscreen; }
manage_onscreen() { win_sizes | awk '$1 >= 600 && !($1 >= 710 && $1 <= 730 && $2 >= 450 && $2 <= 470) { f = 1 } END { exit !f }'; }
bring_front() { open -b "$1" && wait_for 10 bash -c "'$TOOL' front | grep -q 'bundle=$1'"; }

refshot() { # view name
  if A screenshot "$1" >/dev/null 2>&1; then
    cp "$RUN_DIR/.zig-cache/native-sdk-automation/screenshot-$1.png" "$OUT/reference-canvas/$2.png"
    T nonblank "$OUT/reference-canvas/$2.png" > "$OUT/reference-canvas/$2.json" || true
  else
    echo "{\"ok\":false,\"reason\":\"automate screenshot failed\"}" > "$OUT/reference-canvas/$2.json"
  fi
}

deskshot() { # name [baseline name]: real desktop capture + verdict json
  local f="$OUT/desktop-capture/$1.png"
  screencapture -x -t png "$f" 2>>"$OUT/logs/screencapture.log" || { echo "{\"ok\":false,\"reason\":\"screencapture failed\"}" > "${f%.png}.json"; return 1; }
  if [[ -n "${2:-}" ]]; then
    T nonblank "$f" --baseline "$OUT/desktop-capture/$2.png" --min-changed 0.02 > "${f%.png}.json"
  else
    T nonblank "$f" > "${f%.png}.json"
  fi
}

ax_dump() { # name
  local pid
  pid="$(app_pid)"
  if T ax-dump "$pid" > "$OUT/ax/$1.txt" 2> "$OUT/ax/$1.err"; then return 0; fi
  return 1
}

te_file() { echo "$STATE/$1.txt"; }
te_open() { # name: open an empty plain-text document in TextEdit and make it frontmost
  local f
  f="$(te_file "$1")"
  : > "$f"
  open -a TextEdit "$f"
  wait_for 20 te_front || bring_front com.apple.TextEdit || fail "TextEdit did not come to the front: $(T front)"
  sleep 1
}
te_front() { T front | grep -q 'bundle=com.apple.TextEdit'; }
te_text() { # name -> document text (AppleScript, AX fallback)
  local f s
  f="$(te_file "$1")"
  if s="$(with_timeout 20 osascript -e "tell application \"TextEdit\" to get text of (first document whose path is \"$f\")" 2>>"$OUT/logs/osascript.log")"; then
    printf '%s' "$s"
    echo "te_text via AppleScript" >> "$STATE/te-methods"
    return 0
  fi
  bring_front com.apple.TextEdit >/dev/null 2>&1 || true
  if s="$(T ax-text com.apple.TextEdit 2>>"$OUT/logs/osascript.log")"; then
    printf '%s' "$s"
    echo "te_text via AX (AppleScript failed)" >> "$STATE/te-methods"
    return 0
  fi
  return 1
}
te_close_all() { with_timeout 15 osascript -e 'tell application "TextEdit" to close every document saving no' >/dev/null 2>&1 || true; }

hide_panel() { A menu-command panel.hide >/dev/null; wait_for 5 panel_offscreen || true; }

launch_app() { # mode label
  quit_app
  rm -rf "$APP_SUPPORT" "$RUN_DIR"
  mkdir -p "$RUN_DIR"
  local envs=(BETTERCAST_TEST_MODE="$1" BETTERCAST_AI_FAKE=1)
  [[ "$1" == "e2e" ]] && envs+=(BETTERCAST_DATA_DIR="$DATA_DIR")
  (cd "$RUN_DIR" && exec env "${envs[@]}" "$APP_BIN" > "$OUT/logs/app-$2.log" 2>&1) &
  echo $! > "$STATE/app.pid"
  echo "launched $APP_BIN pid=$(app_pid) mode=$1 cwd=$RUN_DIR"
  with_timeout 60 native_wait
}
native_wait() { A wait; }

quit_app() {
  local pid
  pid="$(app_pid)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    with_timeout 5 A menu-command app.quit >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  pkill -f "$HELPER watch" 2>/dev/null || true
  rm -f "$STATE/app.pid"
}
trap quit_app EXIT

# ================================================================== checks

c_bundle() {
  [[ -x "$APP_BIN" ]] || fail "missing $APP_BIN"
  [[ -f "$HELPER" ]] || fail "helper not packaged at $HELPER"
  [[ -x "$HELPER" ]] || ev "helper not executable in bundle (locate() chmods it at runtime)"
  ev "helper: $("$HELPER" --version)"
  "$HELPER" selftest | tee /dev/stderr | grep -q 'selftest ok' || fail "helper selftest"
  ev "helper selftest ok (packaged copy)"
  codesign --verify --deep --strict "$APP" || fail "codesign --verify failed"
  ev "codesign: $(codesign -dv "$APP" 2>&1 | grep -E 'Signature|Identifier=' | tr '\n' ' ')"
  plutil -p "$APP/Contents/Info.plist" | grep 'dev.pcstyle.bettercast' >/dev/null || fail "bundle id mismatch"
  ev "bundle id dev.pcstyle.bettercast"
}

c_permissions() {
  local p
  p="$(T perm)"
  ev "e2e-tool: $p"
  [[ -f "$OUT/tcc.env" ]] && ev "tcc: $(tr '\n' ' ' < "$OUT/tcc.env")"
  local axs rc=0
  axs="$("$HELPER" ax-status 2>&1)" || rc=$?
  ev "helper ax-status (spawned from the runner shell): ${axs//$'\n'/ } (exit $rc)"
  [[ "$p" == *"ax=1"* && "$p" == *"post=1"* ]] || fail "e2e-tool lacks Accessibility/PostEvent: real-key checks cannot pass ($p)"
}

c_keys_automation() {
  launch_app 1 phase-a
  "$HERE/launcher-keys.sh" "$RUN_DIR" "$OUT/snapshots/phase-a"
  ev "launcher-keys.sh PASS (dry mode, widget-key + menu-command)"
}

c_readiness() {
  AS 'ready=true' 'role=textbox'
  AS_ABSENT 'dispatch_errors=[1-9]'
  wait_for 15 pgrep -f "$HELPER watch" || fail "no 'bettercast-helper watch' process (helper not located or watch spawn failed)"
  ev "app pid $(app_pid); watch: $(pgrep -fl "$HELPER watch" | head -n 1)"
  [[ -d "$DATA_DIR/clips" && -d "$DATA_DIR/tmp" ]] || fail "data dir not prepared: $DATA_DIR"
  ev "data dir $DATA_DIR ready"
  A menu-command test.seed
  AS 'name="seeded"' || AS 'Fixture Browser'
  snap b01-ready
}

c_launcher_command() {
  hide_panel
  deskshot b00-baseline-hidden || true
  A menu-command panel.show
  wait_for 10 panel_onscreen || fail "panel not on screen after panel.show: $(T windows "$(app_pid)" | tr '\n' ' ')"
  AS "$FIELD.*$FOC"
  ev "panel on screen: $(T windows "$(app_pid)" | head -n 1)"
  refshot "$V" b02-panel-command
  deskshot b02-panel-command b00-baseline-hidden || true
  snap b02-panel-command
}

c_launcher_hotkey() {
  hide_panel
  te_open hotkey-front
  T key "$HK_LAUNCHER"
  wait_for 10 panel_onscreen || fail "Opt+Space did not show the panel: $(T windows "$(app_pid)" | tr '\n' ' ')"
  AS "$FIELD.*$FOC"
  ev "Opt+Space (real CGEvent) opened the panel; front: $(T front)"
  deskshot b03-panel-hotkey || true
}

c_keys_real() {
  # panel is open from the hotkey; every key below is a real CGEvent
  T type fix
  AS "$FIELD.*text=\"fix\"" 'role=listitem name="Fixture Browser, Application".*'"$SEL"
  T key down
  AS 'role=listitem name="Terminal Fixture, Application".*'"$SEL"
  T key up
  AS 'role=listitem name="Fixture Browser, Application".*'"$SEL" "$FIELD.*$FOC"
  ev "type + arrows via real keys"
  T key cmd+k
  AS 'role=menuitem name="Open".*'"$SEL"
  ev "Cmd+K (real) opened actions"
  snap b04-actions-real
  refshot "$V" b04-actions-real
  T key escape
  AS_ABSENT 'role=menuitem'
  T key escape
  AS "$FIELD.*$FOC"
  AS_ABSENT "$FIELD.*text=\"fix\""
  T key tab
  AS 'name="Results".*focused=true'
  T key shift+tab
  AS "$FIELD.*$FOC"
  ev "Esc closes menu then clears; Tab/Shift+Tab move focus"
  T key escape
  wait_for 5 panel_offscreen || fail "Esc on empty query did not hide the panel"
  ev "Esc on empty root hid the panel"
}

c_calculator() {
  A menu-command panel.show
  AS "$FIELD.*$FOC"
  local expr want
  while IFS='|' read -r expr want; do
    set_text "$V" "$FIELD" "$expr"
    AS "role=listitem name=\"$want, Calculator\"" || fail "$expr did not give $want"
    ev "$expr = $want"
  done <<'EOF'
12x4|48
2^10|1,?024
15% of 80|12
(3+4|7
1,5*2|3
2(3+4)|14
-3^2|-9
EOF
  refshot "$V" b05-calculator
  A widget-key "$V" enter
  sleep 1
  ev "Return copied: $(pbpaste | head -c 40)"
  [[ "$(pbpaste)" == "-9" ]] || fail "Return on calculator row did not copy -9 (got '$(pbpaste | head -c 40)')"
}

c_snippet_create() {
  A menu-command manage.snippets
  wait_for 10 manage_onscreen || fail "Manage window not on screen"
  AS "\"$MANAGE_TITLE\"" "$NEW_SNIPPET_BTN"
  focus_to "$M" "$NEW_SNIPPET_BTN"
  A widget-key "$M" space
  AS "$SNIP_NAME_FIELD"
  focus_to "$M" "$SNIP_NAME_FIELD" 10
  type_into "$M" "$SNIP_NAME_FIELD" "$SNIP_NAME"
  focus_to "$M" "$SNIP_KEYWORD_FIELD" 5
  type_into "$M" "$SNIP_KEYWORD_FIELD" "$SNIP_KEYWORD"
  focus_to "$M" "$SNIP_BODY_FIELD" 5
  type_into "$M" "$SNIP_BODY_FIELD" "$SNIP_BODY"
  ax_dump manage-form-new || true
  refshot "$M" b06-snippet-form
  focus_to "$M" "$SAVE_BTN" 10
  A widget-key "$M" space
  AS "name=\"$SNIP_NAME, keyword $SNIP_KEYWORD\""
  ev "saved via Tab + Space on Save; list shows '$SNIP_NAME, keyword $SNIP_KEYWORD'"
  snap b06-snippet-saved
  ax_dump manage-saved || true
  refshot "$M" b06-snippet-saved
  deskshot b06-manage-window b00-baseline-hidden || true
}

paste_snippet_into() { # doc name, expected text
  te_open "$1"
  T key "$HK_LAUNCHER"
  wait_for 10 panel_onscreen || fail "panel did not open over TextEdit"
  T type "$SNIP_KEYWORD"
  AS "role=listitem name=\"$SNIP_NAME, Snippet\".*$SEL"
  T key return
  wait_for 10 panel_offscreen || fail "panel did not hide after Return"
  local got=""
  for _ in $(seq 1 20); do
    got="$(te_text "$1" || true)"
    [[ "$got" == *"$2"* ]] && break
    sleep 0.5
  done
  [[ "$got" == *"$2"* ]] || fail "TextEdit text '${got:0:120}' lacks '$2'; clipboard now '$(pbpaste | head -c 80)'; $(snap_has 'Accessibility' && echo 'app reports Accessibility off (copied only)')"
  ev "TextEdit document contains the snippet ($(tail -n 1 "$STATE/te-methods" 2>/dev/null))"
}

c_snippet_paste() { paste_snippet_into paste-v1 "$SNIP_BODY"; }

c_snippet_edit() {
  A menu-command manage.snippets
  wait_for 10 manage_onscreen || fail "Manage window not on screen"
  focus_to "$M" "name=\"$SNIP_NAME, keyword $SNIP_KEYWORD\""
  snap b07-row-focused
  refshot "$M" b07-row-focused
  A widget-key "$M" space
  if ! ASSERT_MS=5000 AS "$SNIP_BODY_FIELD.*text=\"$SNIP_BODY\"" >/dev/null 2>&1; then
    # Evidence only: the check fails either way. Which other path opens the row?
    snap b07-after-space
    refshot "$M" b07-after-space
    local how="none" id
    A widget-key "$M" enter
    if ASSERT_MS=3000 AS "$SNIP_BODY_FIELD" >/dev/null 2>&1; then how="widget-key enter"; else
      T key space; sleep 0.5
      if ASSERT_MS=3000 AS "$SNIP_BODY_FIELD" >/dev/null 2>&1; then how="real Space key"; else
        id="$(widget_id "$M" "role=listitem name=\"$SNIP_NAME, keyword $SNIP_KEYWORD\"")"
        [[ -n "$id" ]] && A widget-action "$M" "$id" press
        if ASSERT_MS=3000 AS "$SNIP_BODY_FIELD" >/dev/null 2>&1; then how="widget-action press"; fi
      fi
    fi
    snap b07-after-probes
    fail "Space on the Tab-focused snippet row did not open it (see snapshots/b07-row-focused, reference-canvas/b07-row-focused.png); probe that did open it: $how"
  fi
  focus_to "$M" "$SNIP_BODY_FIELD" 10
  A widget-key "$M" cmd+a
  type_into "$M" "$SNIP_BODY_FIELD" "$SNIP_BODY2"
  focus_to "$M" "$SAVE_BTN" 10
  A widget-key "$M" space
  sleep 0.5
  ax_dump manage-edit || true
  snap b07-snippet-edited
  paste_snippet_into paste-v2 "$SNIP_BODY2"
  ev "edited body pasted into TextEdit"
}

c_snippet_delete() {
  A menu-command manage.snippets
  wait_for 10 manage_onscreen || fail "Manage window not on screen"
  focus_to "$M" "name=\"$SNIP_NAME, keyword $SNIP_KEYWORD\""
  A widget-key "$M" space
  focus_to "$M" "$DELETE_BTN" 20
  A widget-key "$M" space
  sleep 0.5
  snap b08-delete-confirm
  refshot "$M" b08-delete-confirm
  if snap_has "$CONFIRM_DELETE_BTN"; then
    focus_to "$M" "$CONFIRM_DELETE_BTN" 10
    A widget-key "$M" space
  else
    T key return
  fi
  AS_ABSENT "name=\"$SNIP_NAME, keyword $SNIP_KEYWORD\""
  A menu-command panel.show
  set_text "$V" "$FIELD" "$SNIP_KEYWORD"
  AS_ABSENT "name=\"$SNIP_NAME, Snippet\""
  ev "deleted: gone from Manage list and launcher search"
  hide_panel
}

c_clipboard_text() {
  local sha1 sha2
  T pb-text "$CLIP1"
  sleep 0.8
  T pb-text "$CLIP2"
  sha1="$(printf '%s' "$CLIP1" | shasum -a 256 | cut -d' ' -f1)"
  sha2="$(printf '%s' "$CLIP2" | shasum -a 256 | cut -d' ' -f1)"
  wait_for 10 test -f "$DATA_DIR/clips/$sha1.txt" || fail "no clip file for text 1 ($sha1)"
  wait_for 10 test -f "$DATA_DIR/clips/$sha2.txt" || fail "no clip file for text 2"
  [[ "$(cat "$DATA_DIR/clips/$sha1.txt")" == "$CLIP1" ]] || fail "clip 1 bytes differ"
  ev "watch wrote clips/$sha1.txt and clips/$sha2.txt"
  hide_panel
  T key "$HK_CLIPBOARD"
  wait_for 10 panel_onscreen || fail "clipboard hotkey did not open the panel"
  AS "$CLIP_FIELD" "role=listitem name=\"$CLIP1, Clipboard\""
  ev "clipboard hotkey (real) opened history with the new clip"
  set_text "$V" "$CLIP_FIELD" "clip one"
  AS "role=listitem name=\"$CLIP1, Clipboard\""
  AS_ABSENT "role=listitem name=\"$CLIP2"
  ev "search filters history"
  refshot "$V" b09-clipboard-search
  # paste from history into TextEdit
  hide_panel
  te_open clip-paste
  T key "$HK_CLIPBOARD"
  wait_for 10 panel_onscreen || fail "clipboard hotkey did not reopen"
  set_text "$V" "$CLIP_FIELD" "clip one"
  AS "role=listitem name=\"$CLIP1, Clipboard\".*$SEL"
  T key return
  local got=""
  for _ in $(seq 1 20); do got="$(te_text clip-paste || true)"; [[ "$got" == *"$CLIP1"* ]] && break; sleep 0.5; done
  [[ "$got" == *"$CLIP1"* ]] || fail "history paste did not reach TextEdit (got '${got:0:80}')"
  ev "Return pasted the clip into TextEdit"
  # delete from history
  A menu-command panel.show
  A menu-command clipboard.open
  set_text "$V" "$CLIP_FIELD" "clip one"
  AS "role=listitem name=\"$CLIP1, Clipboard\".*$SEL"
  A menu-command actions.toggle
  select_action "$ACTION_DELETE_CLIP"
  AS "$CONFIRM_DELETE_BTN"
  snap b09-clip-delete-confirm
  A widget-key "$V" enter
  AS_ABSENT "role=listitem name=\"$CLIP1, Clipboard\""
  ev "Delete action removed the clip"
  hide_panel
}

list_files() { find "$DATA_DIR/clips" -maxdepth 1 -type f -name "$1" 2>/dev/null | sort; }
count_files() { list_files "$1" | wc -l | tr -d ' '; }
# Original image clips only: `<sha>.thumb.png` thumbnails are counted separately.
list_images() { list_files '*.png' | grep -v '[.]thumb[.]png$' || true; }
count_images() { list_images | wc -l | tr -d ' '; }
png_added() { [[ "$(count_images)" -gt "$(wc -l < "$STATE/png-before.txt")" ]]; }

c_clipboard_concealed() {
  local before after
  before="$(count_files '*')"
  T pb-text "$CLIP_SECRET" --concealed
  sleep 2
  T pb-text "e2e transient ☁" --transient
  sleep 2
  after="$(count_files '*')"
  if grep -rlq -- "$CLIP_SECRET" "$DATA_DIR" 2>/dev/null; then fail "concealed text was written under the data dir"; fi
  [[ "$before" == "$after" ]] || fail "clip count changed $before -> $after for concealed/transient items"
  A menu-command panel.show
  A menu-command clipboard.open
  AS_ABSENT "$CLIP_SECRET" 'e2e transient'
  ev "concealed + transient skipped (clips stay $after, not in history)"
  hide_panel
}

c_clipboard_image() {
  local img="$STATE/e2e-image.png" before after thumbs_before thumbs_after first name thumb bytes_sha
  T make-png "$img" 1280 720
  list_images > "$STATE/png-before.txt"
  before="$(wc -l < "$STATE/png-before.txt" | tr -d ' ')"
  thumbs_before="$(count_files '*.thumb.png')"
  T pb-image "$img"
  wait_for 10 png_added || fail "no PNG clip written"
  first="$(list_images | comm -13 "$STATE/png-before.txt" - | head -n 1)"
  name="$(basename "$first" .png)"
  # The name is the helper's pixel hash (dimensions + sRGB RGBA8 pixels), not
  # a hash of the container bytes; it must still be 64 lowercase hex.
  [[ "$name" =~ ^[0-9a-f]{64}$ ]] || fail "stored name $name is not a 64-hex sha256"
  [[ "$(file -b "$first")" == "PNG image data, 1280 x 720"* ]] || fail "stored clip is not a 1280x720 PNG: $(file "$first")"
  thumb="$DATA_DIR/clips/$name.thumb.png"
  wait_for 5 test -f "$thumb" || fail "no thumbnail $name.thumb.png next to the clip"
  [[ "$(file -b "$thumb")" == "PNG image data, 256 x 144"* ]] || fail "thumbnail is not a 256x144 PNG: $(file "$thumb")"
  bytes_sha="$(shasum -a 256 "$first" | cut -d' ' -f1)"
  ev "image stored once as $name.png ($(file -b "$first")) + thumbnail ($(file -b "$thumb"))"
  T pb-text "e2e spacer between images"
  sleep 1
  T pb-image "$img"
  sleep 2
  T pb-text "e2e second spacer between images"
  sleep 1
  # Same pixels in a different container (TIFF only) must land on the same file.
  T pb-image "$img" --tiff-only
  sleep 2
  after="$(count_images)"
  thumbs_after="$(count_files '*.thumb.png')"
  [[ "$after" -eq $((before + 1)) ]] || fail "dedupe: expected $((before + 1)) image PNG files, found $after: $(list_images | xargs -n1 basename | tr '\n' ' ')"
  [[ "$thumbs_after" -eq $((thumbs_before + 1)) ]] || fail "dedupe: expected $((thumbs_before + 1)) thumbnails, found $thumbs_after"
  [[ "$(shasum -a 256 "$first" | cut -d' ' -f1)" == "$bytes_sha" ]] || fail "stored PNG was rewritten by a later copy"
  ev "same image three times (PNG+TIFF twice, TIFF only once) -> one file, one thumbnail, bytes unchanged (images: $after)"
  local sizes
  sizes="$(T tiff-size "$first")"
  echo "$sizes" > "$OUT/image-bytes.json"
  ev "bytes: $sizes"
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d['png_bytes'] < d['tiff_bytes'] else 1)" "$sizes" || fail "stored PNG is not smaller than TIFF"
  A menu-command panel.show
  A menu-command clipboard.open
  AS 'role=listitem name="Image 1280×720, Clipboard"'
  ev "history shows 'Image 1280×720'"
  refshot "$V" b10-clipboard-image
  hide_panel
}

c_sequential_paste() {
  T pb-text "$QUEUE_A"; sleep 0.8
  T pb-text "$QUEUE_B"; sleep 0.8
  A menu-command panel.show
  A menu-command clipboard.open
  local item
  for item in "$QUEUE_A" "$QUEUE_B"; do
    set_text "$V" "$CLIP_FIELD" "${item:0:11}"
    AS "role=listitem name=\"$item, Clipboard\".*$SEL"
    A menu-command actions.toggle
    select_action "$ACTION_QUEUE"
    sleep 0.3
  done
  ev "queued A then B"
  hide_panel
  te_open queue
  ev "before paste-next: $(T flags)"
  T key "$HK_PASTE_NEXT"
  ev "after 1st paste-next key: $(T flags)"
  sleep 1.5
  ev "after 1st paste-next: text '$(te_text queue 2>/dev/null | head -c 80 || true)'; notice '$(SNAPSHOT | grep -m 1 -aoE 'name="(Pasted|Copied|Paste failed|Helper)[^"]*"' || true)'; front $(T front)"
  te_front || bring_front com.apple.TextEdit
  T key "$HK_PASTE_NEXT"
  local got=""
  for _ in $(seq 1 20); do got="$(te_text queue || true)"; [[ "$got" == *"$QUEUE_B"* ]] && break; sleep 0.5; done
  echo "$got" > "$STATE/queue-result.txt"
  if [[ "$got" != *"$QUEUE_A"* ]]; then
    # Evidence only: does the helper's own paste reach this TextEdit document now?
    local probe="$STATE/paste-probe.txt" tepid
    printf 'probe-7Q' > "$probe"
    tepid="$(T front | sed -nE 's/.*pid=([0-9]+).*/\1/p')"
    ev "direct helper paste: $("$HELPER" paste --pid "$tepid" --file "$probe" --kind text 2>&1 | tr '\n' ' '; echo " exit=${PIPESTATUS[0]}") then text '$(sleep 1; te_text queue 2>/dev/null | head -c 80 || true)'; $(T flags)"
  fi
  python3 - "$got" "$QUEUE_A" "$QUEUE_B" <<'PY' || fail "TextEdit text '${got:0:160}' does not contain A before B; front $(T front); TextEdit docs: $(with_timeout 10 osascript -e 'tell application "TextEdit" to get name of every document' 2>&1 || true)"
import sys
t, a, b = sys.argv[1:4]
ia, ib = t.find(a), t.find(b)
sys.exit(0 if 0 <= ia < ib else 1)
PY
  ev "paste-next x2 pasted A then B into TextEdit"
}

c_ai_fake() {
  T pb-image "$STATE/e2e-image.png"
  sleep 1
  hide_panel
  T key "$HK_ASK_AI"
  wait_for 10 panel_onscreen || fail "ask-AI hotkey did not open the panel"
  AS "$AI_FIELD"
  A menu-command actions.toggle
  select_action "$ACTION_ATTACH"
  sleep 0.5
  set_text "$V" "$AI_FIELD" "e2e: describe the attached image in one line"
  A widget-key "$V" enter
  ASSERT_MS=20000 AS "$AI_FAKE_MARKER" "$AI_FAKE_ATTACHED" 'Echo: e2e: describe' || fail "fake AI answer with one attachment not shown"
  ev "fake provider streamed an answer with the clipboard image attached"
  snap b11-ai
  refshot "$V" b11-ai
  deskshot b11-ai b00-baseline-hidden || true
  hide_panel
}

goto_section() { # title: open Manage and move the sidebar tree to a section by keyboard
  local i
  A menu-command manage.settings
  wait_for 10 manage_onscreen || fail "Manage window not on screen"
  focus_to "$M" 'role=treeitem' 20
  for ((i = 0; i < 8; i++)); do
    snap_has "role=treeitem name=\"$1\".*$SEL" && return 0
    A widget-key "$M" arrowdown
    sleep 0.2
  done
  fail "sidebar never selected $1"
}

c_hotkey_change() {
  goto_section Shortcuts
  AS "$RECORD_LAUNCHER_BTN"
  # conflict warning for a system chord
  focus_to "$M" "$RECORD_LAUNCHER_BTN" 30
  A widget-key "$M" space
  AS 'Press the new shortcut'
  A widget-key "$M" cmd+space
  AS 'Spotlight' || fail "no conflict warning for Cmd+Space"
  ev "Cmd+Space capture warns about Spotlight"
  snap b12-hotkey-conflict
  # record the new chord
  focus_to "$M" "$RECORD_LAUNCHER_BTN" 30
  A widget-key "$M" space
  AS 'Press the new shortcut'
  A widget-key "$M" "$HK_NEW_WIDGET"
  AS "$HK_NEW_LABEL_RE"
  ev "launcher recorded as $HK_NEW_LABEL"
  refshot "$M" b12-hotkey-changed
  sleep 1.5   # watch respawn with new --hotkeys
  hide_panel
  bring_front com.apple.finder
  T key "$HK_LAUNCHER"
  sleep 1.5
  panel_offscreen || fail "old hotkey Opt+Space still opens the panel"
  T key "$HK_NEW"
  wait_for 10 panel_onscreen || fail "new hotkey $HK_NEW_LABEL did not open the panel"
  ev "old chord ignored, new chord opens the panel"
  # set it back to Opt+Space through the same UI
  goto_section Shortcuts
  focus_to "$M" "$RECORD_LAUNCHER_BTN" 30
  A widget-key "$M" space
  A widget-key "$M" alt+space
  AS 'Opt[+]Space'
  sleep 1.5
  hide_panel
  bring_front com.apple.finder
  T key "$HK_LAUNCHER"
  wait_for 10 panel_onscreen || fail "Opt+Space did not work after setting it again"
  ev "Opt+Space set through Manage and works"
  hide_panel
}

c_ax_tree() {
  A menu-command panel.show
  set_text "$V" "$FIELD" "fix"
  sleep 0.5
  # The AX mirror updates after the canvas does: poll until the panel
  # window's own subtree (not the tray menu or Manage) has every name.
  local miss=() pat i
  for ((i = 0; i < 10; i++)); do
    ax_dump panel || fail "ax-dump failed: $(cat "$OUT/ax/panel.err")"
    awk '/role=AXWindow /{w = /title="Bettercast"/} w' "$OUT/ax/panel.txt" > "$OUT/ax/panel-window.txt"
    miss=()
    for pat in 'Search Bettercast' 'Fixture Browser' 'description="Actions"' 'description="Manage…"'; do
      grep -qF -- "$pat" "$OUT/ax/panel-window.txt" || miss+=("panel:$pat")
    done
    ((${#miss[@]} == 0)) && break
    sleep 0.5
  done
  hide_panel
  local mf="$OUT/ax/manage-saved.txt"
  [[ -s "$mf" ]] || { A menu-command manage.snippets; sleep 1; ax_dump manage-saved || true; }
  for pat in "$MANAGE_TITLE" 'New Snippet' 'Save' 'Name' 'Keyword' 'Text'; do
    grep -qF -- "$pat" "$OUT"/ax/manage-*.txt 2>/dev/null || miss+=("manage:$pat")
  done
  ((${#miss[@]} == 0)) || fail "names missing from the AX tree: ${miss[*]}"
  ev "AX tree names present (panel: search field, rows, Actions, Manage; manage: window, New Snippet, Save, form fields)"
}

c_reference_canvas() {
  local n=0 bad=() j
  for j in "$OUT"/reference-canvas/*.json; do
    [[ -e "$j" ]] || continue
    n=$((n + 1))
    grep -q '"ok":true' "$j" || bad+=("$(basename "$j")")
  done
  ((n > 0)) || fail "no reference-canvas screenshots"
  ((${#bad[@]} == 0)) || fail "blank reference-canvas: ${bad[*]}"
  ev "$n reference-canvas screenshots, all non-blank"
}

c_desktop_capture() {
  local j ok=() bad=()
  for j in "$OUT"/desktop-capture/*.json; do
    [[ -e "$j" ]] || continue
    [[ "$(basename "$j")" == b00-* ]] && continue
    if grep -q '"ok":true' "$j"; then ok+=("$(basename "$j" .json)"); else bad+=("$(basename "$j" .json): $(sed -E 's/.*"reason":"([^"]*)".*/\1/' "$j")"); fi
  done
  ((${#ok[@]} > 0)) || fail "no desktop capture shows app pixels (${bad[*]:-none taken}). Screen Recording permission missing gives wallpaper-only images."
  ev "desktop captures with app pixels: ${ok[*]}"
  ((${#bad[@]} == 0)) || ev "rejected: ${bad[*]}"
  if ! grep -qs '"ok":true' "$OUT/desktop-capture/b02-panel-command.json"; then
    fail "the panel capture (b02) was rejected: ${bad[*]}"
  fi
}

c_no_errors() {
  kill -0 "$(app_pid)" || fail "app is no longer running"
  AS_ABSENT 'error event=' 'dispatch_errors=[1-9]'
  snap b99-final
  [[ -s "$STATE/typing-fallbacks" ]] && ev "typing fallbacks used: $(tr '\n' ';' < "$STATE/typing-fallbacks")"
  ev "no dispatch errors; app alive"
}

# A failed Phase B check keeps what the next round needs to find the cause,
# under logs/fail-<id>/: the app snapshot, frontmost app, the app's windows,
# the pasteboard text and a desktop capture. Never changes the verdict.
check_b() { # id fn
  run_check "$1" "$2"
  [[ "$(tail -n 1 "$OUT/checks.ndjson")" == *'"status": "fail"'* ]] || return 0
  local d="$OUT/logs/fail-$1"
  mkdir -p "$d"
  SNAPSHOT > "$d/snapshot.txt" || true
  { echo "front: $(T front 2>&1)"; echo "windows:"; T windows "$(app_pid)" 2>&1
    echo "pasteboard: $(pbpaste 2>&1 | head -c 200)"; } > "$d/state.txt" || true
  screencapture -x -t png "$d/desktop.png" 2>> "$d/state.txt" || true
}

# ================================================================== run
run_check bundle c_bundle
run_check permissions c_permissions

# Phase A: dry mode, automation-injected keys (the spike's proven flow).
run_check keys_automation c_keys_automation
quit_app

# Phase B: real OS integration.
launch_app e2e phase-b > "$OUT/logs/launch-phase-b.log" 2>&1 || true
check_b readiness c_readiness
check_b launcher_command c_launcher_command
check_b launcher_hotkey c_launcher_hotkey
check_b keys_real c_keys_real
check_b calculator c_calculator
check_b snippet_create c_snippet_create
check_b snippet_paste_textedit c_snippet_paste
check_b snippet_edit c_snippet_edit
check_b snippet_delete c_snippet_delete
check_b clipboard_text c_clipboard_text
check_b clipboard_concealed c_clipboard_concealed
check_b clipboard_image_dedupe c_clipboard_image
check_b sequential_paste c_sequential_paste
check_b ai_fake c_ai_fake
check_b hotkey_change c_hotkey_change
check_b ax_tree c_ax_tree
check_b reference_canvas c_reference_canvas
check_b desktop_capture c_desktop_capture
check_b no_errors c_no_errors
te_close_all
quit_app

summarize
