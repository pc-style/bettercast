# Bettercast V0 contract

Authoritative for every agent working in `app/`, `helper/`, `scripts/`.
Change it only together with the code it describes.

## Layout

| Path | What |
| --- | --- |
| `app/app.json` | identity (`dev.pcstyle.bettercast`), launcher window `main` (chromeless, always on top, initially hidden, close = hide, 720x460, centered), shortcuts, capabilities (persist, credentials, tray, clipboard) |
| `app/src/core.ts` | ENTRY: `Model`, `Msg` (all V0 features), `initialModel`, `update` (the only place Cmds are built, NS1017), `subscriptions`, `commandMsg`, `keyMsg`, `statusItem`, `windows`, `envMsgs`, `viewUnbound`, markup binding helpers |
| `app/src/update.ts` | every transition: `step(model, msg)` returns `{ model, persist, window, op }`; add an `Op` arm there and its `case` in `core.ts` `update` |
| `app/src/viewmodel.ts` | derived rows for the views (core.ts re-exports; markup can only bind helpers declared in core.ts) |
| `app/src/model.ts`, `shared.ts` | component records; `shared.ts` = records crossing the service boundary |
| `app/src/{search,calc,snippets,clipboard,hotkeys,ai,protocol,bytes,textedit,fixtures}.ts` | feature modules (owners fill the STUBs) |
| `app/src/services/system.ts` | filesystem-only service ops: `locate`, `scanApps`, `detectProviders`, `exportConfig`, `importConfig` |
| `app/src/app.native` | launcher panel: search field + one result list + footer (Actions, Manage...). No side/preview pane |
| `app/src/windows/manage.native` | Manage window (label `manage`, normal titled window): sidebar tree Snippets, Clipboard, Shortcuts, AI, General (About folded into General). See "Views" |
| `app/harness/` | headless null-platform full-loop test of the real core + markup (`scripts/harness-test.sh`) |
| `helper/main.swift` | `bettercast-helper` CLI, built by `scripts/build-helper.sh` into `app/assets/bin/bettercast-helper` (gitignored; `native package` copies `assets/` to `Contents/Resources/assets/`) |
| `scripts/e2e/` | CI-only end-to-end scripts (hosted macOS runner) |

Persistence: `Cmd.persist()` snapshots the WHOLE Model. Any Model shape change must bump `persist.version` in app.json (NS1068). Never put secrets in the Model: the API key lives only in `Cmd.credentials` and flows straight from the `credentials.get` result into the `ai` spawn's stdin.

## Environment and boot

`envMsgs`: `NATIVE_SDK_APP_DATA_DIR` (always), `BETTERCAST_DATA_DIR` (override), `BETTERCAST_HELPER` (override path), `BETTERCAST_TEST_MODE`, `BETTERCAST_AI_FAKE` (`1` in e2e mode only: the `ai` spawn gets `--provider fake`; the helper inherits the same env var, which it also requires).

- unset: normal app.
- `1` = dry: no watch process (no hotkeys, no clipboard polling, no frontmost tracking), no AX prompt, OS effects (paste, copy, open, keychain, login item) are NOT performed; they set `notice` to `dry-run: ...`. Panel shows at boot; `test.seed` works.
- `e2e`: real helper, watch and one-shots, AX prompt still off; `test.seed` works. Hosted CI only.

Boot: persist restore (`restored` / `fresh_boot` / `restore_failed`) -> `transientReset` -> `Cmd.delay` -> `boot_go` -> `systemLocate` (helper path: override, then `<exe>/../Resources/assets/bin`, then dev `assets/bin`; creates `<data>/clips`, `<data>/tmp`) -> `located` (prunes clips by retention). Then: dry = show the panel only; e2e = show the panel + watch spawn (no app scan: `test.seed` provides apps); normal = `scanApps` -> `detectProviders` -> `launchAtLoginStatus` (read only; launch at login stays OFF unless the user toggles it) -> watch spawn (`Model.appsState` loading -> done).

`Cmd.readFile`/`writeFile`/`deleteFile` paths must stay under the app's own data roots (no `filesystem` permission is declared): `BETTERCAST_DATA_DIR`, when set, must point inside `~/Library/Application Support/dev.pcstyle.bettercast/` (the e2e suite uses `.../e2e-data`). The helper process is not subject to this.

Commands (`commandMsg`): `panel.toggle`, `panel.show`, `panel.hide`, `actions.toggle` (cmd-K), `manage.open` (cmd-,), `manage.snippets`, `manage.settings`, `manage.closed`, `clipboard.open`, `app.quit`, `test.seed` (test modes only). Automation drives them with `native automate menu-command <id>`.

## Key handling (proven by app/harness/keys_test.zig)

The search field (`<search-field key="{searchEpoch}" autofocus="true" ... on-input="query_edit" on-submit="run_selected">`) keeps keyboard focus; the result selection is MODEL state (`selected`, `actionSelected`). A focused editable field consumes every key before the app-level `keyMsg` fallback, so navigation arrives through the field itself:

| Key (field focused) | Arrives as | Core does |
| --- | --- | --- |
| typing, paste, IME, Backspace, Left/Right | `query_edit` with the edit | mirror into `query` (`textedit.ts applyEdit`), reset selection to 0 on text change |
| ArrowDown | `query_edit` `move_caret {end, extend:false}` (runtime stamp for single-line fields) | `select_next` (or next action while the actions menu is open); mirror caret to end |
| ArrowUp | `query_edit` `move_caret {start, extend:false}` | `select_prev`; bump `searchEpoch` (remounts the field so the caret returns to the end) and set the model caret to the end |
| Return | `on-submit` -> `run_selected` | runs the selected row, or the selected action while the menu is open |
| Esc | `query_edit` `clear` (search-field built-in) | close actions (restore query via remount) > clear query > back to root screen > hide panel |
| cmd-K | app.json shortcut `actions.toggle` (AppKit local monitor, before the view) -> `commandMsg` | toggle the actions menu (`dropdown-menu` of `menu-item`s); arrows/Return/Esc then act on `actionSelected` |
| cmd-, | shortcut `manage.open` | open Manage |
| Tab / Shift+Tab | runtime focus traversal with a visible ring | order: search field, (clipboard screen: All/Text/Images chips), Results scroll region, each row, primary-action button (`Open Application ↩`, name without the glyph), Actions, Manage..., wrap |
| Return/Space on a Tab-focused row | row `on-press` -> `row_run:{r.id}` | runs that row |

Known trade-offs: Home/End and Cmd+Left/Right produce the same `move_caret start/end` edits, so they also move the selection. ArrowUp remounts the field (new widget id): automation must re-read the field id from the snapshot; assistive tech re-announces the field. Keys pressed while focus is NOT in a text field (Actions button, Manage window) reach `keyMsg` (used for hotkey capture in Manage > Shortcuts).

Accessible names: field `Search Bettercast` (per screen, `searchLabel`), rows `<title>, <kind>` with `state=[selected]` on the model selection, scroll region `Results`, buttons by their text. Every Tab stop must have a name (the harness asserts it).

Glyphs: the bundled UI font has NO glyphs for ⌘ ⌥ ⌃ ✓ ⌫ ⎋ ⇪, CJK or emoji (tofu boxes). It does have · … ↑ ↓ ← → ↩ ⇥ ⇧ × “ ” — é. Write chords as words (`Cmd+K`, `Opt+Space`; `hotkeyLabel` does). User content (clips) with CJK/emoji renders as tofu in V0.

## Views (owner: views agent)

Files: `app.native`, `windows/manage.native`, `viewmodel.ts`, the binding section at the end of `core.ts`. Markup binds only helpers declared in `core.ts`; they delegate to `viewmodel.ts`.

Launcher panel (720x460, one list, no side pane):
- Header row: Back (screens other than root) + search field. AI screen adds provider chips (installed providers only), "Attach Clipboard Image", attachment chips (press = remove). Clipboard screen adds All / Text / Images chips (`clip_filter`, `Model.clipFilter`, applied in `search.ts clipboardHits`) and a "N clips queued" badge. Queue screen adds "Clear Queue".
- Results: `<list gap="2" padding="8">`, every row `height="44"`, section header rows `height="24"` (root screen only, where the hit kind changes; `search.ts` groups hits by kind). `viewmodel.ts` uses these exact numbers: `resultsOffset` (bound to the scroll `value`) keeps the model selection and its header in view; `thumbWindowClipIds` picks the image rows on screen. Change markup and the constants together.
- Row: leading 36x28 slot (thumbnail `<image>` when loaded, else a built-in icon), title, muted subtitle, badges (`Queued N`, `Pinned`), muted accessory. Accessible name `<title>, <kind>[, Queued N]`.
- Footer: status/notice text, AI Stop / Copy Answer / New Chat (AI screen), primary action button (`primaryLabel` + ` ↩`, runs `run_selected`), Actions (Cmd+K menu), `Cmd+K` hint, Manage….
- Cmd+K actions (`viewmodel.ts actionItems`, run by `update.ts runAction`): app Open / Copy Path; snippet Paste / Copy / Edit in Manage… / Delete Snippet…; clip Paste / Copy / Add to (Remove from) Paste Queue / Pin / Ask AI About This / Delete…; calc Copy Result; AI screen with an answer: Paste Answer / Copy Answer / New Chat; always Manage Bettercast…. Each maps onto an existing Msg (`clip_copy`, `queue_add`, `queue_remove`, `clip_pin`, `ai_attach_clip`, `snippet_edit`-style draft, `ai_paste`, `ai_copy`, `ai_new`); the owners implement those arms.
- Confirm dialog: `Model.confirm` (`none|clip|snippet|clear_history` + id). Opened by the Delete actions, `confirm_clip_delete`, `confirm_snippet_delete`, `confirm_clear_history`. Shown in the panel when it is visible, else in Manage. The destructive button has `autofocus` (Return deletes, Space too); Esc / outside click = `confirm_cancel`; Return in the search field while open = accept. `confirm_accept` dispatches `clip_delete` / `snippet_delete` / `clips_clear` and then clamps the selection. Do not bump `searchEpoch` when opening it (a remounted field steals the focus back).
- Thumbnails: runtime image id = clip id. After every `step` (`withThumbs`), on the clipboard/queue screen, ONE missing visible image row is loaded (`Op thumb_load` -> `Cmd.imageLoad(<clip id>, {path: clips/<sha>.thumb.png}, {event: "thumb_loaded"})`, the helper's 256 px thumbnail, never the full image), evicting the least recently loaded off-screen thumbnail (`Cmd.imageUnregister`) once `MAX_THUMBS` (12 of the 16 registry slots) are loaded. Failed loads are not retried until relaunch; `thumbs` resets on boot.
- Ask AI: Return in the field asks (`ai_ask`) when there is text, else pastes a finished answer (`ai_paste`). The answer renders with `<markdown>`. Files dropped on any window (`dropMsg` -> `files_dropped`, capability `file_drops`) become attachments (max 8; images by extension) and open the AI screen.

Manage window: sidebar `<tree>` of `list-item role="treeitem"` rows (Up/Down switch sections; each row is still its own Tab stop, the SDK roves Tab only for radio groups). Snippets: list + form with visible labels and named fields `Name`, `Keyword`, `Text` (textarea; Cmd+Return saves, Return in Name/Keyword saves), Save / Cancel / Delete… (confirm) in a fixed bar below the scroll, above the notice bar (Tab skips controls scrolled fully out of view, so the actions must never sit below the fold); the Name field autofocuses for a new snippet; `draft.problem` shows under the form (named `problem`: `error` is a keyword in the compiled module). Clipboard: Keep images switch, retention chips (7/30/90 days/Forever -> `set_retention_days`), max-items chips (100/500/1,000/5,000 -> `set_max_items`), Clear History… (confirm). Shortcuts: per hotkey a Record button that toggles to Cancel (`hotkey_capture` toggles, so keyboard focus stays on it; while capturing, chords with Cmd/Opt/Ctrl pass the focused button and reach `keyMsg` -> `key_down`; plain Esc -> `escape` cancels), Reset, an On switch (`hotkey_toggle`), and `hotkeyNotice` as warning text. AI: default provider radio group (uninstalled providers disabled), API key via "Save API Key from Clipboard" (the SDK has no secure text field; a typed key would live in the persisted Model) and Remove. General: Accessibility status + Grant Accessibility…, Open at login (off by default), Export / Import Settings, data folder, version. A notice bar with Dismiss shows `notice`.

Menu-bar item: Open Bettercast (`panel.show`), Clipboard History (`clipboard.open`), Manage Snippets… (`manage.snippets` -> `manage_show snippets`), Settings… (`manage.settings`, Cmd+,), Quit.

## Core flows (owner: core-logic agent)

Files: `update.ts` (all transitions), `search.ts`, `calc.ts`, `snippets.ts`, `clipboard.ts`, `hotkeys.ts`, `ai.ts`, `protocol.ts`, `bytes.ts`, `fixtures.ts`, `model.ts` records. After every `step`: `withThumbs` (views), then `withDeletes` (below); each only acts when the step has no Op. `Step.window` also carries `open_manage` (hide the panel + `Cmd.setDockPresence(true)` so Manage is a normal Cmd+Tab window) and `manage_closed` (`setDockPresence(false)`); every Op case in `core.ts update` batches persist + window + dock + the Op.

- Watch process: hotkey / images / capture changes = `restartWatch` (cancel; `watch_err cancelled` respawns with the current args). While a shortcut is being recorded the spec is `-` (no hotkeys registered, so even the current chord reaches Manage). An unexpected exit respawns after 3 s (`watch_retry` delay), at most 5 times in a row (`watchRetries`, reset by `ready`), then `notice` says so.
- Clipboard index (newest first): `clip` lines dedupe by kind + sha (keeps id, pin, firstMs; moves to the front, lastMs updated); image lines are ignored while `recordImages` is off; the sha must be 64 lowercase hex (it becomes a path). Pruning (on clip add, `tick`, `located`, retention/max-items changes): unpinned clips older than `retentionDays` (by lastMs; 0 = keep) and unpinned clips beyond the newest `maxItems`; pinned clips are never pruned. Removed clips leave the paste queue and their payload files join `deleteQueue` (`ClipFile.kind` `text|image|thumb`: an image queues `<sha>.png` and `<sha>.thumb.png`); `withDeletes` issues ONE `Cmd.deleteFile` at a time (`clip_deleted` / `clip_delete_failed` continue the chain) and skips files a live clip points at again. Pasting or copying a clip moves it to the front.
- Paste: `pasteOrCopy` pastes into `frontPid`; with no known front app (`frontPid <= 0`) it runs `copy` and says "press Cmd+V". Snippets and AI answers go through `<data>/tmp/paste.txt` (`write_paste` -> `paste_written`). Paste queue: `queue_add` refuses unknown or already queued clips; `paste_next` (hotkey or Msg) pastes the head, drops it, skips deleted clips, and reports how many are left.
- Snippets: `validateDraft` = name required, text not empty, keyword without spaces and unique among the other snippets (case/accent-insensitive); the message lands in `draft.problem` and the draft stays open.
- Search (`search.ts` header has the numbers): calculator > exact snippet keyword > exact / prefix / word-start / initials / substring / subsequence name matches, + kind bonus (app > command > snippet), snippet keyword prefix, snippet body and clipboard previews (text only, 2+ chars), frecency (`app:<path>`, `snippet:<id>`, `cmd:<id>`; count + recency), "Ask AI" last; accents fold (é = e). Root hits are grouped by kind in order of each kind's best hit. Clipboard screen: pinned first, then newest, filtered by `clipFilter`; a clip matches when every space-separated query term is a substring of its folded preview (no fuzzy/subsequence matching: long previews would match almost any query).
- Calculator (`calc.ts`): recursive descent over bytes; `x` × ÷ · ** ^ %, `N% of M`, `a + b%`, implicit multiplication, auto-closed `(`, comma decimals and 1,000 grouping; needs at least one operator; 1/0, NaN and overflow are not results. Up to 10 decimals, scientific outside [1e-6, 1e15).
- Hotkeys: `checkHotkey` -> `block` (another enabled Bettercast shortcut; no Cmd/Opt/Ctrl except F-keys; Cmd+C/V/X/Z/Shift+Z/A/S/Q/W/Tab) keeps recording and shows why; `warn` (Spotlight, Finder search, input sources, emoji picker, lock screen, screenshots, Cmd+`, Cmd+H/M, Mission Control/Spaces, Raycast's Opt+Space, ...) applies the chord and shows the warning; `hotkey-error` from the helper becomes a `hotkeyNotice`. `parseHotkeySpec` is the inverse of `hotkeySpec`.
- AI: `ai.status` `idle | running | done | failed | stopped | no_provider`. `ai_ask` (query text) -> provider check (`no_provider` + `failure` saying what to install or where to add a key) -> `write_ai_request` -> `ai_request_written` -> (`api`: `credentials.get` -> `ai_key_loaded`) -> `ai_start` -> `chunk` lines append (answer capped at 256 KiB; lines after Stop are dropped) -> `done` / `ai_exit 0` = done, `error` line or nonzero exit = failed. Esc / `ai_cancel` = stopped (partial answer kept). A question on the AI screen after an answer is a follow-up: `ai.history` (earlier Q/A, last 32 KiB) is sent as context. Attachments (clip files, dropped files; max 8) stay for the conversation; `ai_new` resets. The API key is never in the Model.
- Test mode fixtures (`test.seed`): 6 apps, 4 snippets, 5 clips (one 240-byte preview, unicode, one image, one whitespace-only, one pinned), 2 providers, front pid 4242; on a real clock the clip times shift to "now" so retention does not prune them mid-test.

## Helper CLI: `bettercast-helper`

All stdout lines are ASCII, fields separated by one space, terminated by `\n`, each line < 4 KiB (the spawn line bound). Free text (names, previews, messages, answers) is standard base64 (RFC 4648, with padding); an empty value is `-`. Large payloads go through files in the data dir, never argv or lines. Errors print `error <code> <message-b64>` on stdout. Exit codes: `0` ok, `1` failure, `2` bad arguments, `3` needs Accessibility (paste/ax only). The helper never prompts for Accessibility except in `ax-prompt`, never reads the pasteboard outside `watch`, and exits when its parent dies (poll `getppid()`).

### `watch --hotkeys <spec> --data-dir <dir> --images 0|1` (long-lived; spawn key `watch`)

`<spec>` = `-` or comma-separated `<token>:<carbonKeyCode>:<carbonMods>`; tokens `launcher|clipboard|paste_next|ask_ai`; Carbon mods cmd=256 shift=512 option=2048 control=4096 (`hotkeys.ts hotkeySpec`). Registers with `RegisterEventHotKey`, tracks `NSWorkspace` frontmost app, polls `NSPasteboard.changeCount` (~250 ms). Changing hotkeys or `--images` = `Cmd.cancel("watch")`, then respawn on `watch_err(cancelled)`.

| Line | Meaning |
| --- | --- |
| `ready <version> ax=0\|1` | watch is up |
| `hotkey <token>` | a registered hotkey fired |
| `hotkey-error <token> <osstatus>` | registration failed (conflict) |
| `front <pid> <bundleId-b64> <name-b64>` | frontmost app changed; never the helper's parent (Bettercast) |
| `clip text <atMs> <sha256hex> <bytes> <preview-b64> <sourceBundle-b64>` | new text clip written to `<dir>/clips/<sha>.txt` (UTF-8; preview = first <= 240 bytes) |
| `clip image <atMs> <sha256hex> <bytes> <width> <height> <sourceBundle-b64>` | new image clip written ONCE as compressed PNG to `<dir>/clips/<sha>.png` (sha of the PNG bytes; existing file = dedupe, not rewritten) plus `<dir>/clips/<sha>.thumb.png` (longest side <= 256 px); deleting a clip should delete both |
| `clip-skip <reason>` | `concealed` (org.nspasteboard.ConcealedType), `transient` (TransientType), `autogenerated`, `self` (written by this helper, marker type `dev.pcstyle.bettercast.self`), `images-off`, `too-large` (> 50 MB), `empty`, `unsupported` |
| `ax 0\|1` | Accessibility trust changed |
| `error <code> <msg-b64>` | non-fatal problem |

Watch details (helper-owned): hotkeys register with `kEventHotKeyExclusive`, so a chord another app already holds (e.g. Raycast on Opt+Space) fails with `hotkey-error <token> -9878` (`eventHotKeyExistsErr`) instead of silently sharing; `hotkey-error` lines follow `ready`. The current pasteboard content at startup is not recorded (only later changes). Text wins over an image when both are present with plain text (spreadsheets, rich text); copied files record their name text, never the Finder icon. The watch exits 0 when its parent dies (reparented / pid gone, checked every 0.5 s), on SIGTERM/SIGINT/SIGHUP, and on stdin EOF only when stdin is a pipe or socket (the SDK spawns with /dev/null stdin, which is ignored).

### One-shots (`Cmd.spawn ... collect: true`; exit code + stdout)

| Command | stdout | exit |
| --- | --- | --- |
| `paste --pid <pid> --file <path> --kind text\|image` | `result pasted` or `result copied` | puts the file on the pasteboard (+ `self` marker; images as PNG plus a TIFF fallback rep), activates `<pid>` and waits (<= 500 ms) until it is frontmost, posts Cmd+V via CGEvent (the key that types "v" in the current layout). `0` pasted, `3` copied only (not AX-trusted; content stays on the clipboard), `1` failure (also when the target is gone or never came to the front: `error no-target\|not-front ...` then `result copied`, nothing is typed) |
| `copy --file <path> --kind text\|image` | `result copied` | `0` / `1` |
| `open --path <path>` | `result opened` | NSWorkspace open; `0` / `1` |
| `apps` | `app <name-b64> <path-b64>` per bundle, then `done` | `0` (the core currently scans with `systemScanApps`; this is for selftests/icons) |
| `providers` | `provider <claude\|codex\|gemini\|opencode> <path-b64>` per CLI found, then `done` | `0` |
| `ax-status` | `ax 0\|1` | `0` trusted, `3` not trusted |
| `ax-prompt` | `ax 0\|1` | shows the system prompt (explicit user action only: Manage > General "Grant Accessibility..."), then as `ax-status` |
| `ai --request <path>` (streaming spawn, key `ai`) | `chunk <text-b64>` lines (<= 2048 raw bytes each), then `done`; or `error <code> <msg-b64>` | `0` / `1`. stdin = API key for provider `api` (may be empty). Request file (`ai.ts requestFile`): `provider <token>\nbin <b64\|->\nmodel <b64\|->\n(attach <b64 path>\n)*prompt\n<raw prompt to EOF>`. CLI providers run read-only/tools-off in an empty `<request dir>/ai-cwd`: `claude -p --input-format/--output-format stream-json --tools "" --no-session-persistence` (images/PDFs as base64 blocks, UTF-8 text files inlined), `codex exec --sandbox read-only --ephemeral --json --image=<img>` (other files named in the prompt), `gemini --approval-mode plan -o stream-json -p "<prompt> @<path>..."`, `opencode run --standalone --agent plan -f <path>`. `api` = Anthropic Messages API streaming (default model `claude-opus-5-5`). Optional `--timeout <s>` (default 300) and `--provider <token>` (overrides the file). Provider `fake` (deterministic echo, a prompt containing `FAIL` errors) only with env `BETTERCAST_AI_FAKE=1`. Failure = `error ai-failed <msg-b64>` |
| `debug-pasteboard --file <p> --kind text\|image [--extra-type <uti>]`, `debug-key --code <c> --mods <m>` | `result ...` | CI fixtures only: refuse (exit 2) unless `BETTERCAST_CI=1`. Write synthetic pasteboard content like another app would (images as uncompressed TIFF) / post one key chord. Used by `helper/ci-test.sh` |
| `selftest` | `selftest ok` (else `error selftest <what-b64>` lines, `selftest failed n/m`, exit 1) | headless checks (base64, sha256, UTF-8-safe truncation, line bounds, hotkey spec and request parsing, pasteboard classification, PNG round trip, TIFF->PNG >= 4x smaller, dedupe across formats, store-once in a temp dir); touches no OS state; safe on a dev Mac |
| `--version` | `bettercast-helper <version>` | `0` |

Paste flow in the core: remember the last `front` pid, `Cmd.hideWindow("main")`, then `paste`. Snippets: `Cmd.writeFile(<data>/tmp/paste.txt)` first, then `paste --kind text`. On exit `3` the footer says the content was copied and to grant Accessibility in Manage > General. Exit `1` with `result copied` in the output (target gone / never frontmost) says "Copied ... press Cmd+V there"; other failures show the decoded `error` message. `hotkey-error` status `-9878` reads "Another app already uses it", any other status is shown as `macOS refused it (error N)`.

## Verification

- `native check` (after Model/Msg changes run `native test` first to refresh the model contract).
- `node test/core/run.mjs [name...]` (from `app/`): headless core scenarios under `native dev --core` (`test/core/<name>.ndjson` + `<name>.expect`: calc, search, snippets, clipboard, queue, hotkeys, ai, aifake, persist; CI step `core_scenarios`). The virtual host prints effects instead of performing them; e2e-mode scenarios feed a fake `located` (helper `/fake/bin/bettercast-helper`, data `/fake/data`) so the real spawn/file argv is visible.
- `scripts/harness-test.sh`: builds `app/harness` against the installed SDK and runs `keys_test.zig` headless (null platform, no window, no OS access). Extend it for new keyboard flows; run under `nice`.
- Config file (`exportConfig`/`importConfig`, `src/services/system.ts`): JSON `{"format":"bettercast-config","version":1,"snippets":[{id,name,keyword,body,updatedMs}],"hotkeys":[{action,keyCode,mods,enabled}],"settings":{retentionDays,maxItems,recordImages,aiProvider,aiModel}}`. Never contains API keys, clips, or launch-at-login (import returns `launchAtLogin: false`; the core should keep its current value). Import errors are `{kind,message}` with kind `not_found`, `read_failed`, `invalid_json`, `wrong_format`, `unsupported_version`, `invalid` (field path in the message: duplicate ids/actions, enabled chord conflicts, ranges, byte limits).
- `.github/workflows/macos.yml` (macos-15): Zig (sha256-pinned) + `@native-sdk/cli`, helper build + selftest, `native test`, `native check --strict`, core scenarios, harness, `native build -Dautomation=true`, `native package --archive --signing adhoc`, TCC grants, `helper/ci-test.sh`, then `scripts/e2e/run-all.sh <Bettercast.app> <out>` against the PACKAGED app. Every step lands in `checks.ndjson` → `manifest.json` (commit, image, tool versions, artifact sha256, per-check evidence); the last step fails the job on any required failure. UI names the suite asserts are listed at the top of `run-all.sh`; change them together with the views.
- `scripts/e2e/launcher-keys.sh <app dir> <out>`: the same flow against the running `-Dautomation=true` build on the hosted macOS runner (`native automate widget-key` / `menu-command` / `assert` / `screenshot`). It injects keys at the runtime's gpu-surface seam; the AppKit keyDown hop and the cmd-K shortcut monitor need real CGEvents in a separate CI step.
- Never launch the app, the watch mode, or any GUI locally on Adam's Mac.
