#!/usr/bin/env bash
# CI-only (hosted macOS runner): drive the RUNNING launcher panel through
# the automation server and assert the keyboard + accessibility contract.
# Mirrors app/harness/keys_test.zig against the real packaged runtime
# (CoreText layout, AppKit window, real automation snapshot).
#
# Preconditions (the workflow does these; never run this on a dev Mac
# someone is using):
#   cd app && nice native build -Dautomation=true
#   (cd app && BETTERCAST_TEST_MODE=1 ./zig-out/bin/bettercast &)   # default app data dir (fresh runner)
#   scripts/e2e/launcher-keys.sh app "$RUNNER_TEMP/e2e-out"
# BETTERCAST_TEST_MODE=1 = dry mode: no watch process, no hotkeys, no
# clipboard polling, OS effects recorded as "dry-run: ..." notices.
#
# Scope: `widget-key` injects keys at the runtime's gpu-surface input seam
# (the same seam AppKit keyDown feeds), and `menu-command` injects the
# command event the app.json shortcut (cmd-K = "actions.toggle") emits.
# The AppKit keyDown -> interpretKeyEvents -> moveUp:/moveDown: hop and the
# shortcut monitor itself need real CGEvents (a separate CI step).
set -euo pipefail
app_dir="${1:?usage: launcher-keys.sh <app dir the app was launched from> [out dir]}"
out="${2:-$app_dir/e2e-out}"
mkdir -p "$out"
cd "$app_dir"
V=main-canvas
A() { native automate "$@"; }
snap() { cp .zig-cache/native-sdk-automation/snapshot.txt "$out/$1.txt"; }
type_text() { local s="$1" i; for ((i = 0; i < ${#s}; i++)); do A widget-key "$V" "${s:i:1}" "${s:i:1}"; done; }
field='role=textbox name="Search Bettercast"'

A wait
A menu-command test.seed
A menu-command panel.show
A assert 'name="seeded"'
# 1. First focus is the search field, with an accessible name.
A assert "$field.*state=.focused"
snap 01-shown

# 2. Type to filter.
type_text fix
A assert "$field.*text=\"fix\"" 'role=listitem name="Fixture Browser, Application".*state=.selected' 'role=listitem name="Terminal Fixture, Application"'
A assert --absent 'role=listitem name="Q, Application"'
snap 02-typed
A screenshot "$V"
cp .zig-cache/native-sdk-automation/screenshot-"$V".png "$out/02-typed.png"

# 3. Arrows move the selection; focus stays in the field.
A widget-key "$V" arrowdown
A assert 'role=listitem name="Terminal Fixture, Application".*state=.selected' "$field.*state=.focused"
A widget-key "$V" arrowdown
A widget-key "$V" arrowup
A assert 'role=listitem name="Terminal Fixture, Application".*state=.selected' "$field.*state=.focused"
A widget-key "$V" arrowup
A assert 'role=listitem name="Fixture Browser, Application".*state=.selected'
# 4. Typing after arrows appends.
type_text t
A assert "$field.*text=\"fixt\".*state=.focused"
snap 03-arrows

# 5. Actions menu (the command cmd-K sends), arrows inside it, Esc closes and keeps the query.
A menu-command actions.toggle
A assert 'role=menuitem name="Open".*state=.selected' 'role=menuitem name="Copy Path"'
snap 04-actions
A widget-key "$V" arrowdown
A assert 'role=menuitem name="Copy Path".*state=.selected'
A widget-key "$V" escape
A assert --absent 'role=menuitem'
A assert "$field.*text=\"fixt\".*state=.focused"

# 6. Esc clears the query.
A widget-key "$V" escape
A assert "$field.*parent=#[0-9]* placeholder=.*state=.focused"  # empty: no text= attribute

# 7. Tab order with visible focus: Results region, rows, the primary-action
#    button, Actions, Manage..., back to the field.
type_text fix
tab_to() { A widget-key "$V" tab; A assert "$1.*focused=true"; }
tab_to 'name="Results"'
tab_to 'role=listitem name="Fixture Browser, Application"'
A screenshot "$V"
cp .zig-cache/native-sdk-automation/screenshot-"$V".png "$out/07-row-focus-ring.png"
tab_to 'role=listitem name="Terminal Fixture, Application"'
tab_to 'role=listitem name="Système Préférences Fixture'
tab_to 'role=listitem name="Safari Fixture, Application"'
tab_to 'role=listitem name="Email sign-off, Snippet"'  # body "A. Fixture" matches
tab_to 'role=listitem name="Ask AI'
tab_to 'role=button name="Open Application"'
tab_to 'role=button name="Actions"'
tab_to 'role=button name="Manage'
A widget-key "$V" tab
A assert "$field.*state=.focused"
snap 07-tab-wrapped

# 8. Return on a Tab-focused row runs that row (dry run: recorded, panel hides).
A widget-key "$V" tab
A widget-key "$V" tab
A assert 'role=listitem name="Fixture Browser, Application".*focused=true'
A widget-key "$V" enter
# The panel hid itself; reopen it to read the footer notice.
A menu-command panel.show
A assert 'name="dry-run: open /Applications/Fixture Browser.app"'
snap 08-row-return

# 9. Return from the field runs the selected row.
A menu-command panel.show
A assert "$field.*state=.focused"
type_text q
A widget-key "$V" enter
A menu-command panel.show
A assert 'name="dry-run: open /Applications/Q.app"'

# 10. Esc on an empty query hides the panel (window ordered out).
A assert "$field.*parent=#[0-9]* placeholder=.*state=.focused"  # empty: no text= attribute
A widget-key "$V" escape
A snapshot > "$out/99-final.txt" || true
A assert --absent 'error event=' 'dispatch_errors=[1-9]'
echo "launcher-keys: PASS"
