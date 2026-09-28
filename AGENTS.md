# Project guidance

This repository was intentionally reset after the Bettercast/Sol experiment. The previous app is preserved at `backup/pre-reset-2026-09-28` and in Git history; do not restore it as the starting point for a new app without asking. This branch contains a preference worksheet and this editable guidance, not a launcher implementation.

## What Adam has actually asked for

- Build a dependable *personal* Raycast replacement, not a prototype or a large plan. Work in useful integrated batches and show a build that can actually be operated before calling a workflow complete.
- Keep the existing launcher, shortcuts, login behavior, permissions, and private data untouched unless Adam explicitly approves a change to them. Use synthetic test data; never commit personal exports or credentials.
- Make keyboard-first use and discoverable accessibility controls acceptance criteria, including Tab order, visible focus, activation, Back/Escape, and a way to open the app without stealing a shortcut.
- Ask short, concrete questions when a product choice is genuinely missing. Offer A/B/C/D answers and clearly mark a recommendation without treating it as Adam's answer. Favor tiny visual comparisons over long prose.
- Manual acceptance can be waived for a build iteration, but do not confuse that with proof of daily usability. State what was automated, what was visually inspected, and what remains unverified.

## Failures worth not repeating

- Sol's React Native macOS base used a floating non-activating panel. It built and stayed alive, but conventional window-finding agents struggled with it. Do not choose a framework or panel-only UI before proving keyboard navigation, focus, accessibility-tree discoverability, and practical automation in a packaged app.
- The new snippet form relied on unlabeled buttons and placeholders and lacked an end-to-end keyboard path. A screenshot and passing source tests did not establish that Tab, Save, Edit, Delete, or paste worked for a user. Test these with asymmetric synthetic data in the actual app before claiming them.
- A 30-second process-alive launch smoke is not a responsiveness or feature test. The Blacksmith macOS 15 trial built and passed native tests quickly, but its screenshots were black; the GitHub macOS 15 runner produced visible onboarding and launcher screenshots. Do not report a blank capture as visual verification.
- Building one tiny change per native CI run was slow. Batch related workflows, then verify the integrated build; keep the exact tested commit and downloadable artifact together.

## Delivery boundaries

- If a new native Mac app is chosen, use a hosted macOS build loop until an actual Mac with full Xcode is available. The connected Mac previously had Command Line Tools only; it could run source tests but not compile this app.
- Prefer a normal, agent-discoverable editing/settings surface; treat any transient launcher panel as a separate interaction to verify. The worksheet records Adam's final choice—do not infer it from this suggestion.
- Keep this file short and decision-changing. Put transient status in the work discussion, not here. Adam's current request and his answers in the worksheet override earlier recommendations.
