# Bettercast

Bettercast is a fork of [Sol](https://github.com/ospfranco/sol), Oscar Franco's open-source macOS launcher. It combines local launcher workflows with an on-demand AI workspace. Product development is on `bettercast-product`; the existing launcher can stay installed and unchanged.

The product branch implements indexed text/original-image/file-reference clipboard storage, a persistent paste queue, snippets, quicklinks, reviewed Raycast JSON imports, command bindings, confirmed scripts and TypeScript manifests. AI includes streaming, explicit attachments/context, encrypted local history, a text-only Claude CLI adapter, a configurable compatible endpoint, and host-approved MCP HTTP/stdio tool calls. Search requires an actual configured search tool; there are no fabricated search results or bundled provider credentials.

**Build success is not runtime acceptance.** The first integrated macOS CI build and native storage suites passed, but the foundation artifact exposed an `AppDelegate.init()` startup crash. The product branch includes the initializer correction and an actual launch smoke step; inspect the latest branch run before downloading. Native focus/paste, autocomplete coexistence and external-provider/tool journeys still require verification. See [implementation status and acceptance checks](docs/bettercast-plan.md).

Clipboard capture is off by default. SQLCipher encrypts the index, and AES-GCM encrypts payloads using a Bettercast-specific Keychain key. Owner-only permissions are additional protection, not encryption. Keep trials synthetic until native privacy acceptance is complete. No automatic history import, shortcut registration, login takeover, updater or telemetry is enabled.

## Local development

This is a React Native macOS app for macOS 14 or newer. Native builds require full Xcode, Mise and CocoaPods: `mise install`, `bun install --frozen-lockfile`, `bundle exec pod install` from `macos`, then `bun macos`. Linux can run the TypeScript and synthetic JavaScript checks, but cannot launch this app.

Run `bun run typecheck` and `bun test ./src` for source checks. The macOS workflow builds the production app, tests encrypted storage with 10,000 mixed synthetic records, checks process/transport behavior, validates linked dependencies and signatures, verifies the ZIP roundtrip, and smoke-launches the actual executable. UI browser fixtures are useful layout checks, not macOS interaction evidence.

Upstream `fastlane release` is intentionally disabled in this fork. It previously used upstream signing, release paths, GitHub publishing, git push, and `/Applications/Sol.app`; there is no fork release workflow yet. Do not use upstream releases or `brew install --cask sol` as Bettercast downloads.

## Attribution and license

Bettercast retains Sol's [MIT license](LICENSE) and original copyright notice. Sol and its releases belong to [Oscar Franco and upstream contributors](https://github.com/ospfranco/sol); Bettercast is an independent fork, not an official Sol release.
