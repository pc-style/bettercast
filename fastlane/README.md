# Fork release safety

`fastlane mac release` intentionally stops with an error. The inherited Sol lane used upstream signing credentials, a machine-specific path, upstream GitHub publishing, appcast generation, `git push`, and `/Applications/Sol.app`; none is appropriate for this fork. There is no Bettercast release lane yet.

For a local debug run, install full Xcode and the project dependencies, check the fork's identifiers/signing, then run `bun macos` from the repository root. Do not use fastlane for local development. See [the project README](../README.md) and [implementation plan](../docs/bettercast-plan.md).
