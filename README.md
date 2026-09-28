# Bettercast

Bettercast is a fork of [Sol](https://github.com/ospfranco/sol), Oscar Franco's open-source macOS launcher. The aim is a complete, keyboard-first replacement with a dependable daily launcher **and** a capable AI workspace. The current first slice retains Sol's launcher foundation while building both tracks; it is not the finished replacement.

**Implemented in source, not native-app verified:** text-only, single-turn AI through the installed Claude Code CLI (tools off, no session persistence); snippet CRUD/search/paste integration; script execution confirmation; and fork isolation changes. Review and integration are still underway. **Clipboard capture is intentionally unavailable in the fork at present**, despite inherited clipboard code; it must be rebuilt and verified before trial use. The complete target adds indexed text/image/file-reference history, sequential paste, a command registry and TypeScript extensions, and rich AI with streaming, attachments, provider choice, real search, approved MCP tools, and local history. A chat box alone does not meet it. See [status, gaps, and stages](docs/bettercast-plan.md).

## Local development

This is a React Native macOS app. Install full Xcode (not just Command Line Tools), Mise, and CocoaPods before following Sol's setup: `mise install`, then `bun macos` for a local debug run. Check the fork's bundle identifiers and signing configuration before installing it alongside Sol. **No native build or visual app check has been completed here:** this machine currently has Command Line Tools but not full Xcode (`xcodebuild` cannot run).

Checks completed independently: `bun run typecheck`, 7 Bun tests across the foundation and snippet-persistence suites, targeted Biome lint, a production macOS JS bundle, the standalone Swift AI process synthetic suite, and an opt-in live Claude bridge probe passed. These check source and bridge behavior, **not** a running Bettercast app. Reproduction commands and the remaining validation are in the [plan](docs/bettercast-plan.md#verification).

Upstream `fastlane release` is intentionally disabled in this fork. It previously used upstream signing, release paths, GitHub publishing, git push, and `/Applications/Sol.app`; there is no fork release workflow yet. Do not use upstream releases or `brew install --cask sol` as Bettercast downloads.

## Attribution and license

Bettercast retains Sol's [MIT license](LICENSE) and original copyright notice. Sol and its releases belong to [Oscar Franco and upstream contributors](https://github.com/ospfranco/sol); Bettercast is an independent fork, not an official Sol release.
