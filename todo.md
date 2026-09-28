# To do

Goal: Bettercast replaces Raycast for my everyday use—not just opens successfully.

Unchecked means not yet accepted as working in the real app. Some tasks already have code or automated tests.

## Current delivery status (September 28, 2026)

- Snippets can be created, edited, searched by name or content, deleted, and pasted from their screen; launcher search also indexes them. Pasting replaces the system clipboard. Source checks pass, but the new screen and destination focus have not been exercised in a native app.
- AI history now has a confirmed delete action in compact history and the expanded sidebar. It removes the encrypted conversation document after saving the updated index; synthetic tests cover restart and storage failures. The full conversation and provider/tool journey remains unverified in the app.
- Existing code covers selective import with preview and rollback, encrypted clipboard storage and queue, confirmed scripts, and an on-demand AI workspace. These remain unchecked below because source tests and a launch smoke are not proof of everyday use.
- The macOS CI build checks packaging, native storage, a fresh launch, and an onboarded launch. It cannot verify real destination paste, permissions, external provider/tool journeys, or coexistence with the owner's launcher and Hyper/autocomplete setup.
- Do not enable a global shortcut or login item, import private history, or replace the existing launcher automatically. Section 9 still requires the owner's eventual acceptance and explicit cutover approval.

## 1. Get the basics right

- [ ] Download, open, and reopen the app without crashes.
- [ ] Finish onboarding and reach a usable launcher.
- [ ] Make the app easy to find and open from the menu bar.
- [ ] Choose a shortcut without taking over existing shortcuts.
- [ ] Search for and open apps quickly.
- [ ] Navigate, select, go back, and dismiss using the keyboard.
- [ ] Return focus to the previous app correctly.
- [ ] Keep settings after quitting and restarting.
- [ ] Show clear errors and recovery options instead of silently failing.

## 2. Bring over my Raycast setup

- [ ] Preview a Raycast import before changing anything.
- [ ] Choose what to import and clearly see what is unsupported.
- [ ] Import supported snippets, quicklinks, aliases, and shortcuts.
- [ ] Handle duplicates and conflicts without losing existing data.
- [ ] Cancel or undo an import safely.
- [ ] Keep private exports and imported data out of the public repository.
- [ ] Check that my essential Raycast workflows have working replacements.

## 3. Make clipboard history dependable

- [ ] Enable capture only after explicit consent.
- [ ] Save and retrieve text, original images, and file references.
- [ ] Search and filter a large history quickly.
- [ ] Keep history across app and Mac restarts.
- [ ] Paste into the intended app without losing focus or changing content.
- [ ] Clearly explain when paste replaces the current clipboard.
- [ ] Queue items and paste them in order.
- [ ] Pause, skip, reverse, restart, and recover an interrupted paste queue.
- [ ] Apply a 30-day default retention period and configurable storage limit.
- [ ] Show storage usage and let me delete individual items or all history.
- [ ] Pause capture and exclude sensitive apps or content.
- [ ] Protect saved history and handle unavailable storage safely.
- [ ] Stay responsive with at least 10,000 mixed history items.

## 4. Finish everyday launcher tools

- [ ] Create, edit, search, delete, and paste snippets.
- [ ] Create and use quicklinks, aliases, and custom shortcuts.
- [ ] Find and run scripts with clear confirmation and results.
- [ ] Use the window-management and everyday commands I rely on.
- [ ] Enable optional file search, bookmarks, and calendar access individually.
- [ ] Keep local tools usable offline and without AI running.

## 5. Make AI a useful workspace

- [ ] Connect supported providers and choose available models.
- [ ] Clearly distinguish supported providers from unavailable ones.
- [ ] Stream responses and continue a conversation.
- [ ] Stop, retry, copy, and explicitly insert responses.
- [ ] Attach supported files and images with a preview of what will be sent.
- [ ] Search the web and show real, usable source links.
- [ ] Save, reopen, and delete local conversations.
- [ ] Run useful AI actions on explicitly selected text or context.
- [ ] Connect supported local and remote MCP tools.
- [ ] Require approval before tool calls and show their results.
- [ ] Deny and revoke access reliably.
- [ ] Handle missing login, provider errors, timeouts, and cancellation clearly.
- [ ] Verify a complete conversation and approved tool action in the actual app.

## 6. Make it extensible

- [ ] Install, enable, disable, and remove extensions.
- [ ] Add commands without modifying the main app.
- [ ] Show extension permissions before granting access.
- [ ] Keep broken extensions from freezing or crashing the launcher.
- [ ] Replace the extensions I actually depend on.
- [ ] Add remaining personal tools, such as OCR, translation, or notes, where needed.
- [ ] Keep generated extensions disabled until reviewed and approved.

## 7. Make it feel finished

- [ ] Make every screen readable and usable at the normal launcher size.
- [ ] Check keyboard focus, scrolling, long content, and empty states.
- [ ] Make loading, success, and failure states obvious.
- [ ] Support accessibility and the appearance settings I use.
- [ ] Measure launch speed, search speed, idle memory, and background activity.
- [ ] Avoid unnecessary background helpers and permission requests.
- [ ] Recover cleanly after sleep, focus changes, and interrupted input.
- [ ] Work alongside autocomplete without freezing or leaving Hyper held.
- [ ] Recover safely from corrupt settings or unavailable data.

## 8. Deliver and prove it works

- [ ] Combine the product, UI, and build work into one tested version.
- [ ] Test the packaged app—not just the source code.
- [ ] Keep startup and post-onboarding checks in CI.
- [ ] Exercise import, clipboard, snippets, scripts, and AI end to end.
- [ ] Fix blocking bugs found during real use.
- [ ] Push the finished changes.
- [ ] Merge all intended work into main without losing changes.
- [ ] Build and download a tested version from main.
- [ ] Make installation and future updates clear and safe.

## 9. Replace Raycast only when I am happy

- [ ] Try Bettercast alongside the existing launcher without changing it.
- [ ] Complete my normal daily workflows without falling back for missing essentials.
- [ ] Confirm autocomplete and Hyper work reliably on my Mac.
- [ ] Confirm my data, permissions, shortcuts, and resource use are acceptable.
- [ ] Keep a backup and a clear way to return to the old setup.
- [ ] Get my explicit approval before switching shortcuts or login behavior.
- [ ] Use Bettercast as my daily launcher and confirm I am happy with the replacement.
