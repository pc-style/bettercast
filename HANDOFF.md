# Bettercast continuation

## Goal

Deliver a dependable personal Raycast replacement by September 29, 2026. Use `todo.md` as the plain-language acceptance checklist. Continue existing work rather than rebuilding the app or writing another plan.

## Starting point

- Repository: https://github.com/pc-style/bettercast
- Start from freshly fetched `origin/main`, which consolidates the foundation, product, UI, and native build work.
- Stack: React Native macOS, TypeScript, Swift, Bun. Builds use standard GitHub-hosted macOS Actions.
- Existing features include selective Raycast import, clipboard history and paste queue, snippets, commands, streaming AI, attachments, and approved MCP calls. Implementation does not imply complete acceptance.
- Native CI has built the product, tested encrypted storage with 10,000 clipboard entries, verified packaging, and launched to the welcome screen. Inspect the latest run for current evidence and the second-launch result.
- The prior AppDelegate startup crash is fixed. Preserve actual packaged-app launch checks; compilation alone is not enough.
- `docs/bettercast-plan.md` contains background but may describe older checkpoints. Recheck source and CI rather than treating old status prose as current.

## Model and spending rules

- Use GPT-6 Sol for straightforward work and built-in medium or low for implementation.
- Reserve Astra for the hardest problems or reasoning, not routine edits, searches, or status checks.
- Never enable Fast, Plaid, or Pro serving features. When creating a thread, explicitly use `features: []`.
- Do not use Opus. Avoid duplicate agents, unnecessary reviews, and repeated expensive investigations.
- If a requested mode is unavailable, use an available medium or low mode; do not silently upgrade to an expensive model.

## Working rules

- Recheck remote branches, working tree, CI, and outstanding agent work before acting. Previous product/build agents were asked to stop for this handoff.
- Inspect what already works, then implement the missing checklist items in useful groups. Update the checklist honestly.
- Manual acceptance is waived by the user for this delivery. Do not wait for manual testing or claim an unrun test passed. Keep automated tests and native launch checks.
- Run `bun run typecheck`, `bun test ./src`, and `bun test ./scripts/test-ai-lifecycle.js` for relevant changes. Use the workflow for native build/storage/launch validation unavailable in Linux orbs.
- Keep private exports, credentials, histories, and private requirements out of Git and logs. Use synthetic data for tests.
- Do not alter existing launchers, global shortcuts, login behavior, or personal data without explicit approval. No automatic cutover.
- Keep the existing ad-hoc test-build distribution separate from notarization or a public release.
- Prefer a working integrated build over more scaffolding. Report actual remaining gaps; do not promise a deadline unsupported by evidence.

## Next action

Fetch `origin/main`, inspect `todo.md` against the current implementation and latest macOS CI results, then fix the highest-impact missing daily workflow. Continue through implementation and verification rather than stopping at a plan. At handoff, provide the exact tested commit, downloadable build, completed tasks, and remaining limitations.
