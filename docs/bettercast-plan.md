# Bettercast implementation and acceptance

The product branch is `bettercast-product`, based on the isolated `bettercast-foundation` branch. It retains [Sol's MIT-licensed foundation](https://github.com/ospfranco/sol/commit/5a3034b511ba83c3225f662496f78fe5e3b8f661). The private brief, exports, credentials and personal history must stay outside Git and build artifacts. No automatic import, shortcut/login takeover, installation or cutover is part of development.

## Implemented product paths

- Local launcher/search and existing window actions remain available independently of AI. Shared command metadata drives aliases, reviewed direct hotkeys, snippets, URL-encoded quicklinks and confirmed scripts. TypeScript manifests declare a runtime and entry point; execution starts only after confirmation. This is not a sandbox for untrusted code.
- Readable Raycast JSON gets a selective preview, unsupported-field reporting, explicit command mapping and a persisted rollback receipt. Snippets and supported quicklink templates are imported selectively. Aliases and shortcuts are staged disabled for review. Encrypted Raycast archives, keyword expansion, history and setting behaviors without a safe mapping are reported rather than guessed or activated. Rollback refuses to overwrite later edits.
- Clipboard capture defaults off. The encrypted SQLCipher FTS index pages text, original-image and file-reference occurrences without loading the archive into JavaScript. Original payloads and thumbnails use AES-GCM with a Bettercast-specific Keychain key. Default retention is 30 days with a configurable cap, pins, exclusions, pause and private mode. The cap can shorten retention and pinned data can exceed it; both are visible. File references do not copy file contents.
- The paste queue keeps resolved snapshots in user order and persists its position. Before delivery it records an interruption checkpoint; a restart never repeats a paste automatically. Focus changes stop delivery. A dispatched keystroke is not proof the destination accepted it. Deleting clipboard records also removes their queue previews.
- AI starts on demand. Drafts and conversations persist encrypted locally. The installed Claude CLI adapter supports streaming text with its tools disabled. A user-configured chat-completions endpoint can accept images and tools when declared supported. Attachments have content/size preview and aggregate limits; unsupported PDF extraction is explicit. Stop, retry, copy and focus-guarded insertion are implemented. Selection replacement, selection capture, conversation export/edit/delete are not yet available.
- MCP uses actual HTTP or stdio JSON-RPC initialize/discovery/call paths, bounded streams and cancellation. Every model-requested call requires exact per-call host approval. Session/always grants are not offered. A real enabled search tool is required for web search; source cards come from returned URLs, not invented citations. Providers and MCP servers are never configured automatically. Process helpers are on demand, not per-extension residents.

## Evidence and remaining acceptance

[The integrated product CI run with the initializer correction](https://github.com/pc-style/bettercast/actions/runs/36387260636) built the production arm64 app with Xcode 16.4 on macOS 15 and passed native process/storage suites, including 10,000 mixed synthetic clipboard records and encrypted reopen/wrong-key checks. Signature, dependency and archive-roundtrip checks passed. The actual packaged executable survived 30 seconds, and its inspected macOS screenshot shows the welcome screen without a crash/redbox. This fixes the reproduced missing `AppDelegate.init()` startup failure; it does not establish behavior past onboarding.

Source suites cover selective imports, rollback conflicts, shortcut collisions, queue interruption, missed modifier key-up, attachment/provider preflight, streaming/cancel cleanup and MCP approval boundaries. The opt-in `bun scripts/probe-public-mcp.js --public-learn` probe additionally contacted Microsoft's public Learn MCP server, negotiated `2025-06-18`, discovered tools and performed an approved read-only search with actual source URLs; denial invoked no tool. That probe uses a synthetic model/approval callback and Bun HTTP, not native transport or a real AI provider. Browser-rendered production components were inspected at 700×450, including bounded keyboard-scroll actions, interrupted queue, import mapping, providers and empty/error states. They provide layout evidence, not macOS behavior.

Before daily use, verify on a disposable native profile with synthetic data:

1. Launch, search, keyboard navigation, panel show/hide and error screens. Check the actual app render; a live process alone is insufficient.
2. Enable capture explicitly, then copy text, original PNG/JPEG/TIFF and file references. Search, preview, copy/save, delete, pin and restart. Verify pause/exclusions and the no-capture startup default. Inspect encrypted database/WAL/payload behavior and Keychain failure handling. SQLCipher closes the plaintext-index design gap, but this is not yet complete privacy acceptance or a forensic-erasure guarantee.
3. Exercise mixed sequential paste, focus changes, crash/restart, skip/reverse/pause and deletion of queued items. Never infer destination success from simulated keys alone.
4. Preview synthetic Raycast JSON, map commands, selectively import, inspect disabled bindings, then rollback. Do not use a real export or history as a fixture.
5. Use explicitly configured provider access to test streaming, image attachments, Stop/retry, error recovery and persisted history. Approve and deny actual read/network/write tool calls and inspect real sources. No credentials or provider spending is assumed by CI.
6. Reproduce generic autocomplete/held-Hyper scenarios: modifier key-up, hiding while held, switching focus, sleep/wake, event-tap timeout/disable and recovery. Source changes reset held state; they do not establish the cause of the reported Tinycast/Goldfish freeze.

## Reproducible checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun test ./src
bun test ./scripts/test-ai-lifecycle.js
scripts/ci/check-macho-deps.test.sh
```

The macOS workflow compiles the standalone AIProcess and AIWorkspace suites, then compiles ClipboardRepository with the pinned SQLCipher framework and `CLIPBOARD_TEST`. See `.github/workflows/macos-build.yml` for exact compiler/linker inputs. It also compiles the production app, signs it ad hoc, verifies its extracted ZIP and launches the packaged executable in a disposable runner without granting Accessibility or TCC permissions. A screenshot is inspected separately when available.

Performance budgets remain targets, not measured claims: warm activation p95 under 100 ms, first clipboard result page p95 under 100 ms at 10,000 records, and idle resident memory around 50–75 MB including owned helpers. Measure the actual app and all children before claiming these. Synthetic database timings do not establish end-to-end latency.

## Distribution is separate from cutover

CI artifacts are Apple Silicon, ad hoc signed and not notarized. They are temporary test downloads, not a release channel. Leave the existing launcher installed and unchanged. No default global shortcut is registered. Never disable Gatekeeper globally; use Apple's per-app approval only after deciding to trust a specific artifact. The upstream release lane, updater and publishing paths remain disabled.
