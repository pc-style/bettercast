# Bettercast

Bettercast is a fork of [Sol](https://github.com/ospfranco/sol), Oscar Franco's open-source macOS launcher. It combines local launcher workflows with an on-demand AI workspace. The integrated test build is developed on `main`; the existing launcher can stay installed and unchanged.

The app implements indexed text/original-image/file-reference clipboard storage, a persistent paste queue, snippets, quicklinks, reviewed Raycast JSON imports, command bindings, confirmed scripts and TypeScript manifests. AI includes streaming, explicit attachments/context, encrypted local history, a text-only Claude CLI adapter, a configurable compatible endpoint, and host-approved MCP HTTP/stdio tool calls. Search requires an actual configured search tool; there are no fabricated search results or bundled provider credentials.

**Initial launch is verified; daily-use acceptance is not.** The integrated product passed native build/storage suites, packaging checks and a 30-second launch smoke after correcting an `AppDelegate.init()` crash. The inspected macOS screenshot shows the welcome screen. Native focus/paste, autocomplete coexistence and full external-provider/tool journeys still require verification. See [implementation status and acceptance checks](docs/bettercast-plan.md).

Clipboard capture is off by default. SQLCipher encrypts the index, and AES-GCM encrypts payloads using a Bettercast-specific Keychain key. Owner-only permissions are additional protection, not encryption. Keep trials synthetic until native privacy acceptance is complete. No automatic history import, shortcut registration, login takeover, updater or telemetry is enabled.

## Test-build installation

On an Apple Silicon Mac running macOS 14 or newer, download the `Bettercast-arm64-adhoc` artifact from the successful [main build workflow](https://github.com/pcstyle-os/bettercast/actions/workflows/macos-build.yml). Check the ZIP against the included `.sha256`, unzip it, and move `Bettercast.app` to a location you choose (for example, Applications). This is an ad-hoc signed, **unnotarized** personal test build, not an automatic update or public release. macOS may block its first launch; only if you trust that specific download, use Finder’s **Open** contextual menu or macOS Privacy & Security’s per-app **Open Anyway**. Do not disable Gatekeeper globally.

The first-run shortcut can remain **Unassigned**. Bettercast does not change Raycast, login items, or existing shortcuts unless you explicitly opt in. Keep your existing launcher while testing; updates require downloading a new CI artifact manually. CI artifacts expire after seven days. The [acceptance checklist](todo.md) distinguishes implemented features from workflows not yet verified in daily use.

## Local development

This is a React Native macOS app for macOS 14 or newer. Native builds require full Xcode, Mise and CocoaPods: `mise install`, `bun install --frozen-lockfile`, `bundle exec pod install` from `macos`, then `bun macos`. Linux can run the TypeScript and synthetic JavaScript checks, but cannot launch this app.

Run `bun run typecheck` and `bun test ./src` for source checks. The macOS workflow builds the production app, tests encrypted storage with 10,000 mixed synthetic records, checks process/transport behavior, validates linked dependencies and signatures, verifies the ZIP roundtrip, and smoke-launches the actual executable. UI browser fixtures are useful layout checks, not macOS interaction evidence.

Upstream `fastlane release` is intentionally disabled in this fork. It previously used upstream signing, release paths, GitHub publishing, git push, and `/Applications/Sol.app`; there is no fork release workflow yet. Do not use upstream releases or `brew install --cask sol` as Bettercast downloads.

## Attribution and license

Bettercast retains Sol's [MIT license](LICENSE) and original copyright notice. Sol and its releases belong to [Oscar Franco and upstream contributors](https://github.com/ospfranco/sol); Bettercast is an independent fork, not an official Sol release.
