# Bettercast implementation plan

This is a staged plan for a complete daily launcher **and** AI workspace, not a list of shipped features. The first-slice source exists, but review and integration are ongoing and the running native app has not been verified. Clipboard capture is intentionally unavailable in the fork right now: inherited clipboard code is not wired into native startup. This checkout has only Command Line Tools: `xcodebuild` fails without full Xcode, so app build/runtime and visual checks are blocked. The private product brief and personal inventory remain outside this repository; only general requirements and synthetic fixtures belong here. No automatic shortcut takeover, import, or cutover.

The selected base is [Sol at `5a3034b`](https://github.com/ospfranco/sol/commit/5a3034b511ba83c3225f662496f78fe5e3b8f661), retained under MIT with `upstream` pointing to `https://github.com/ospfranco/sol.git`. Preserve attribution, review upstream fixes, and keep later feature commits small enough to merge them. No commit or release is implied by this plan.

## Foundation and ordering

0. **Buildable, isolated base — incomplete.** Preserve app/command search, keyboard navigation, existing actions, shortcuts, and window management without overwriting Sol's identity, data, or installed app. Typecheck and JS bundling pass, but full Xcode is absent, so even an unmodified native base build was not established here; the fork's debug build (`bun macos`) and launch/search smoke test remain open. Use a temporary nonconflicting shortcut during development.
1. **Dependable daily core — source slice only.** Snippet CRUD/search/paste integration and script confirmation are in source; verify their UI/focus/cancel behavior. Restore clipboard capture deliberately, then build indexed, paged history for text, original images, and file references with 30-day default retention, visible configurable disk budget, restart persistence, type/time filters, privacy pause/exclusions/deletion, and no full archive in hot memory. Add ordered sequential paste (paste-next, pause, skip, reverse/restart, interruption state), quicklinks, aliases, hotkeys, and a shared command registry with a minimal TypeScript extension path that does not require editing core. Test a representative synthetic mixed archive of at least 10,000 items; no real personal history by default. Daily retrieval must work offline and independently of AI.
2. **Capable AI workspace — source slice only.** Text-only, single-turn installed-Claude CLI source and native process bridge are implemented with tools-off safe mode and no session persistence. Synthetic process tests cover stdin as data, errors, output limits, cancellation, and timeouts; an opt-in live bridge probe returned `BETTERCAST_AI_OK`. This does not verify UI behavior or the complete AI journey. The replacement target adds streaming chat and quick actions, provider/model choice via verified legitimate adapters (installed CLI first, no assumed API access), attachments with explicit content/size preview, actual web search with source links, local conversation history, and stop/retry/copy/explicit insertion. Add actual local and remote MCP tool discovery/invocation only with enforced, revocable, per-action approvals and visible tool results. Read-only network calls can disclose data; a decorative permission screen is not enforcement. Codex remains deferred because its read-only sandbox allows tools; Grok support is unconfirmed. AI and extension hosts start on demand and must not block local search.
3. **Mature modules later.** Optional OCR, selected extension ports, richer file/context actions, translation, notes, and optional AI-assisted extension authoring follow only after core reliability. Generated extensions start disabled and require review and approval. Avoid an always-running runtime per extension.

Each stage should have targeted automated checks plus a native smoke/visual check where UI changes; none of these checks should use a personal Raycast export, credential, or clipboard record. Release engineering (fork identity, signing, notarization, updater feed, and distribution) is a separate later decision; the inherited upstream lane is disabled.

## Acceptance gaps and budgets

The first slice is **not P0 replacement readiness**. Still open: native base build and UI checks; verified clipboard capture/search/retention/privacy and mixed sequential paste; shared command registry and installable TypeScript extension with failure isolation; rich AI streaming, attachments, provider choice, real cited search, local history and enforced MCP approvals; migration preview and rollback. A text chat box does not satisfy the AI target. Validate shortcuts and any import against the user's current setup privately; never infer them from an old inventory. Trial and cutover require explicit user approval, with the existing launcher left installed and a restoration path.

**Known first-slice limits:** Snippet paste uses upstream clipboard overwrite and simulated insertion; it neither restores the prior clipboard nor verifies delivery to the destination. Corrupt shared runtime state fails closed, but only the snippets screen shows a read-only status; other consumers currently report to the console. Claude cancellation is not a process-tree sandbox. The installed Claude CLI bridge passed a live probe, but portability of its PATH-dependent Node wrapper has not been tested. None of these checks establishes native app behavior.

| Measure | Proposed target, **not measured** | Current evidence |
| --- | --- | --- |
| Idle resident memory, all owned processes | Aim 50–75 MB; investigate sustained >100 MB | No running native app measurement. |
| Warm activation to accepting input | p95 <100 ms, stretch <50 ms | No runtime measurement. |
| First usable clipboard result page, 10k mixed synthetic items | p95 <100 ms | Capture/index and workload test not implemented. |
| Clipboard retention/storage | 30 days by default, configurable cap with visible conflict handling | Capture unavailable; no retention benchmark. |
| Idle AI/OCR/extension helpers | Exit/unload after task, initial grace period ≤60 s | Swift process synthetic tests pass; no app-wide lifecycle measurement. |

Use the same memory metric and include child processes; active AI memory is separate from the idle target. A target miss needs an explained tradeoff, not a hidden reduction in retention or a narrowed measurement.

## Verification

From the repository root, the following commands reproduce the independently reported source checks (the last probe uses an installed, authenticated Claude CLI and is optional):

```sh
bun run typecheck
bun test ./src/lib/foundation.test.js ./src/stores/snippet-persistence.test.js
bunx react-native bundle --platform macos --dev false --entry-file index.js --bundle-output .amp/in/artifacts/bettercast.jsbundle --assets-dest .amp/in/artifacts/assets
swiftc macos/sol-macOS/lib/AIProcess.swift scripts/test-ai-process.swift -o .amp/in/artifacts/test-ai-process
.amp/in/artifacts/test-ai-process
# Optional live provider check; sends only the synthetic probe prompt to Claude:
.amp/in/artifacts/test-ai-process --claude-probe
```

The final typecheck passed; the combined Bun suites passed 7 tests with 23 assertions (foundation alone: 4 tests, 13 assertions); targeted Biome lint on seven new files and the production JS bundle passed. Swift compilation and the synthetic process suite passed after SIGPIPE and drain/cancel race fixes, as did the optional live Claude bridge probe. This does not mean a complete native build passed. `xcodebuild -version` fails here because full Xcode is missing. After installing Xcode, build and run the fork, verify search, snippets, paste, script confirm/cancel, and AI success/error/cancel in the UI, inspect representative rendered states, and review permissions and isolation before treating these as shipped.

## Why this foundation

Snapshot comparison for choosing a fork, not a feature parity claim:

| Project | Licensing / shape | Relevance |
| --- | --- | --- |
| [Sol](https://github.com/ospfranco/sol) ([license](https://github.com/ospfranco/sol/blob/main/LICENSE), [releases](https://github.com/ospfranco/sol/releases/tag/2.1.362)) | MIT, native macOS/React Native launcher; roughly 35.5k source LOC in the comparison snapshot; release 2.1.362 on September 20, 2026 | Small, recently released daily launcher foundation. |
| [SuperCmd](https://github.com/SuperCmdLabs/SuperCmd) ([license](https://github.com/SuperCmdLabs/SuperCmd/blob/main/LICENSE)) | MIT, Electron; roughly 84.7k source LOC in the comparison snapshot | More built-in AI and extension breadth, but a larger Electron base. |
| [Kunkun](https://github.com/kunkunsh/kunkun) ([license](https://github.com/kunkunsh/kunkun/blob/develop/LICENSE), [commits](https://github.com/kunkunsh/kunkun/commits/develop/)) | GPL-3.0, cross-platform Tauri; latest visible develop commit January 18, 2026 | Different licensing and older visible activity than Sol's September release. |
| [Tinycast](https://github.com/abue-ammar/tinycast) ([license](https://github.com/abue-ammar/tinycast/blob/main/LICENSE)) | AGPL-3.0-or-later, native Swift | Interesting reference for specific workflows, not an MIT-compatible code source to copy into this fork. |

LOC figures are approximate source-snapshot estimates, not a reproducible live GitHub metric. Keep licenses separate: do not copy GPL/AGPL implementation code into this MIT fork without a deliberate license decision.
