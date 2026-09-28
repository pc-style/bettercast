// Derived view data. core.ts re-exports these as markup bindings (markup
// can only bind helpers DECLARED in core.ts). Pure; never stored.
// Owner: views agent. Row geometry here must match app.native (see
// contract.md "Views": fixed row/header heights drive scroll-into-view and
// the visible-thumbnail window).

import { asciiBytes, utf8Bytes } from "@native-sdk/core";
import type { Model } from "./core.ts";
import type { HotkeyAction, AiProviderChoice } from "./shared.ts";
import type { Clip, ClipFilter, ManageTab } from "./model.ts";
import { hits, type Hit, type HitKind, COMMANDS } from "./search.ts";
import { hotkeyLabel, actionTitle } from "./hotkeys.ts";
import { concat2, concat3, decimal, indexOfByte, lowerAscii, trimBytes, EMPTY } from "./bytes.ts";

// ---------------------------------------------------------------- geometry
// Must match app.native: <list gap="2" padding="8">, rows height="44",
// section headers height="24". Float-classed on purpose (NS1016): these
// only meet the runtime's float scroll offsets.
const LIST_PAD = 8.5 - 0.5;
const ROW_H = 44.5 - 0.5;
const HEADER_H = 24.5 - 0.5;
const GAP = 2.5 - 0.5;
const DEFAULT_VIEWPORT = 340.5 - 0.5;

// ---------------------------------------------------------------- results

export interface ResultRow {
  /// Row index in the visible list (what row_run carries).
  readonly id: number;
  readonly kind: HitKind;
  readonly title: Uint8Array;
  readonly subtitle: Uint8Array;
  /// Right-aligned muted label.
  readonly accessory: Uint8Array;
  /// Built-in icon name for the list-item leading slot.
  readonly icon: Uint8Array;
  readonly selected: boolean;
  /// Accessible name: "<title>, <kind>[, queued N]".
  readonly a11y: Uint8Array;
  /// First row of a section on the root screen.
  readonly hasHeader: boolean;
  readonly header: Uint8Array;
  /// Image clip row with a loaded thumbnail (id = runtime ImageId).
  readonly hasThumb: boolean;
  readonly thumb: number;
  readonly queued: boolean;
  readonly queueBadge: Uint8Array;
  readonly pinned: boolean;
}

export type ActionVerb =
  | "run" | "open" | "paste" | "copy" | "queue" | "unqueue" | "pin" | "delete" | "edit" | "ask_ai" | "manage"
  | "ai_paste" | "ai_copy" | "ai_new";

export interface ActionItem {
  readonly verb: ActionVerb;
  readonly title: Uint8Array;
  /// Display-only shortcut hint ("↩", ...).
  readonly hint: Uint8Array;
}

export interface ActionRow {
  readonly id: number;
  readonly title: Uint8Array;
  readonly hint: Uint8Array;
  readonly selected: boolean;
}

export function vmQueryText(model: Model): Uint8Array {
  return model.query.text;
}

export function vmSearchPlaceholder(model: Model): Uint8Array {
  switch (model.screen) {
    case "root": return utf8Bytes("Search apps, snippets, commands, or calculate…");
    case "clipboard": return utf8Bytes("Search clipboard history…");
    case "queue": return utf8Bytes("Paste queue");
    case "ai": return model.ai.status === "idle" ? utf8Bytes("Ask anything…") : utf8Bytes("Ask a follow-up…");
  }
}

export function vmSearchLabel(model: Model): Uint8Array {
  switch (model.screen) {
    case "root": return utf8Bytes("Search Bettercast");
    case "clipboard": return utf8Bytes("Search clipboard history");
    case "queue": return utf8Bytes("Filter paste queue");
    case "ai": return utf8Bytes("Ask AI");
  }
}

function kindLabel(kind: HitKind): Uint8Array {
  switch (kind) {
    case "command": return utf8Bytes("Command");
    case "app": return utf8Bytes("Application");
    case "snippet": return utf8Bytes("Snippet");
    case "clip": return utf8Bytes("Clipboard");
    case "calc": return utf8Bytes("Calculator");
    case "ai": return utf8Bytes("AI");
  }
}

function sectionTitle(kind: HitKind): Uint8Array {
  switch (kind) {
    case "command": return utf8Bytes("Commands");
    case "app": return utf8Bytes("Applications");
    case "snippet": return utf8Bytes("Snippets");
    case "clip": return utf8Bytes("Clipboard");
    case "calc": return utf8Bytes("Calculator");
    case "ai": return utf8Bytes("Ask AI");
  }
}

function kindIcon(kind: HitKind): Uint8Array {
  switch (kind) {
    case "command": return asciiBytes("terminal");
    case "app": return asciiBytes("external-link");
    case "snippet": return asciiBytes("file-text");
    case "clip": return asciiBytes("copy");
    case "calc": return asciiBytes("check");
    case "ai": return asciiBytes("send");
  }
}

/// First line of `text`, at most `max` bytes (UTF-8 safe: cuts only at a
/// non-continuation byte).
export function firstLine(text: Uint8Array, max: number): Uint8Array {
  let end = indexOfByte(text, 10);
  if (end < 0) end = text.length;
  if (end > max) {
    end = max;
    while (end > 0 && (text[end] & 192) === 128) end -= 1;
  }
  return text.subarray(0, end);
}

/// Whole-number division for non-negative integers (NS1016: no float
/// division in integer slots).
function intDiv(n: number, d: number): number {
  let q = 0;
  let r = n;
  while (r >= d) {
    let step = d;
    let count = 1;
    while (step + step <= r) {
      step += step;
      count += count;
    }
    r -= step;
    q += count;
  }
  return q;
}

export function sizeLabel(bytes: number): Uint8Array {
  if (bytes < 1024) return utf8Bytes(`${bytes} B`);
  if (bytes < 1048576) return utf8Bytes(`${intDiv(bytes, 1024)} KB`);
  return utf8Bytes(`${intDiv(bytes, 1048576)} MB`);
}

function findClip(model: Model, id: number): Clip | null {
  return model.clips.find((c) => c.id === id) ?? null;
}

function queuePosition(model: Model, clipId: number): number {
  let pos = 0;
  for (const [i, q] of model.queue.entries()) {
    if (pos === 0 && q.clipId === clipId) pos = (i + 1) | 0;
  }
  return pos;
}

function thumbLoaded(model: Model, clipId: number): boolean {
  return model.thumbs.some((t) => t.clipId === clipId && t.state === "loaded");
}

/// Display title of a clip: its first line, or a readable stand-in for
/// images and whitespace-only text.
export function clipDisplayTitle(c: Clip): Uint8Array {
  if (c.kind === "image") return utf8Bytes(`Image ${c.width}×${c.height}`);
  const line = firstLine(c.preview, 160);
  if (trimBytes(line).length === 0) return utf8Bytes("(blank text)");
  return line;
}

function clipSubtitle(c: Clip): Uint8Array {
  if (c.kind === "image") return concat2(utf8Bytes("Image · PNG · "), sizeLabel(c.size));
  return concat2(utf8Bytes("Text · "), sizeLabel(c.size));
}

function rowFor(model: Model, h: Hit, i: number, hasHeader: boolean): ResultRow {
  const accessory = kindLabel(h.kind);
  if (h.kind === "clip") {
    const c = findClip(model, h.refId);
    const title = c === null ? firstLine(h.title, 160) : clipDisplayTitle(c);
    const pos = queuePosition(model, h.refId);
    const queueBadge = pos > 0 ? utf8Bytes(`Queued ${pos}`) : EMPTY;
    const base = concat3(title, utf8Bytes(", "), accessory);
    return {
      id: i | 0,
      kind: h.kind,
      title: title,
      subtitle: c === null ? EMPTY : clipSubtitle(c),
      accessory: EMPTY,
      icon: c !== null && c.kind === "image" ? asciiBytes("eye") : asciiBytes("copy"),
      selected: i === model.selected,
      a11y: pos > 0 ? concat3(base, utf8Bytes(", "), queueBadge) : base,
      hasHeader: hasHeader,
      header: hasHeader ? sectionTitle(h.kind) : EMPTY,
      hasThumb: c !== null && c.kind === "image" && thumbLoaded(model, c.id),
      thumb: c !== null && c.kind === "image" && thumbLoaded(model, c.id) ? c.id : 0,
      queued: pos > 0,
      queueBadge: queueBadge,
      pinned: c !== null && c.pinned,
    };
  }
  const title = firstLine(h.title, 160);
  return {
    id: i | 0,
    kind: h.kind,
    title: title,
    subtitle: firstLine(h.subtitle, 160),
    accessory: accessory,
    icon: kindIcon(h.kind),
    selected: i === model.selected,
    a11y: concat3(title, utf8Bytes(", "), accessory),
    hasHeader: hasHeader,
    header: hasHeader ? sectionTitle(h.kind) : EMPTY,
    hasThumb: false,
    thumb: 0,
    queued: false,
    queueBadge: EMPTY,
    pinned: false,
  };
}

export function vmResults(model: Model): readonly ResultRow[] {
  const list = hits(model);
  const grouped = model.screen === "root";
  return list.map((h, i) => rowFor(model, h, i, grouped && (i === 0 || list[i - 1].kind !== h.kind)));
}

export function selectedHit(model: Model): Hit | null {
  const list = hits(model);
  if (model.selected < 0 || model.selected >= list.length) return null;
  return list[model.selected];
}

function viewport(model: Model): number {
  return model.resultsViewport > 60 ? model.resultsViewport : DEFAULT_VIEWPORT;
}

/// The results scroll offset: the user's offset, moved just enough to keep
/// the SELECTED row (and its section header) in view. Keyboard selection
/// is model state, so the list follows it here.
export function vmResultsOffset(model: Model): number {
  const cur = model.resultsScroll;
  const vp = viewport(model);
  const rows = vmResults(model);
  let top = LIST_PAD;
  for (const r of rows) {
    const headerExtent = r.hasHeader ? HEADER_H + GAP : LIST_PAD - LIST_PAD;
    top += headerExtent;
    if (r.selected) {
      const wantTop = top - headerExtent - LIST_PAD;
      if (wantTop < cur) return wantTop > 0 ? wantTop : LIST_PAD - LIST_PAD;
      const bottom = top + ROW_H + LIST_PAD;
      if (bottom > cur + vp) return bottom - vp;
      return cur;
    }
    top += ROW_H + GAP;
  }
  return cur;
}

export interface ClipRef {
  readonly clipId: number;
}

/// Image clips whose rows are on screen (plus a two-row margin) on the
/// clipboard/queue screens: the only thumbnails worth a registry slot.
export function thumbWindowClipIds(model: Model): readonly ClipRef[] {
  const out: ClipRef[] = [];
  if (model.screen !== "clipboard" && model.screen !== "queue") return out;
  const offset = vmResultsOffset(model);
  const lo = offset - ROW_H - ROW_H;
  const hi = offset + viewport(model) + ROW_H + ROW_H;
  let top = LIST_PAD;
  for (const h of hits(model)) {
    if (top > hi) break;
    if (h.kind === "clip" && top + ROW_H >= lo) {
      const c = findClip(model, h.refId);
      if (c !== null && c.kind === "image") out.push({ clipId: c.id });
    }
    top += ROW_H + GAP;
  }
  return out;
}

export function vmEmptyText(model: Model): Uint8Array {
  switch (model.screen) {
    case "root": return model.query.text.length === 0 ? utf8Bytes("Type to search") : utf8Bytes("No results");
    case "clipboard":
      if (model.query.text.length > 0) return utf8Bytes("No matching clips");
      if (model.clipFilter === "image") return utf8Bytes("No images in clipboard history");
      if (model.clipFilter === "text") return utf8Bytes("No text in clipboard history");
      return utf8Bytes("Clipboard history is empty. Copy something and it shows up here.");
    case "queue": return utf8Bytes("The paste queue is empty. In Clipboard History, press Cmd+K and choose Add to Paste Queue.");
    case "ai": return EMPTY;
  }
}

// ---------------------------------------------------------------- actions (Cmd+K)

const MANAGE_ACTION: ActionItem = { verb: "manage", title: utf8Bytes("Manage Bettercast…"), hint: utf8Bytes("Cmd+,") };

/// The Cmd+K actions for the selected row (index = ActionRow.id). The first
/// item is always the row's primary (Return) action.
export function actionItems(model: Model): readonly ActionItem[] {
  if (model.screen === "ai") {
    if (model.ai.answer.length === 0) return [MANAGE_ACTION];
    return [
      { verb: "ai_paste", title: utf8Bytes("Paste Answer"), hint: utf8Bytes("↩") },
      { verb: "ai_copy", title: utf8Bytes("Copy Answer"), hint: EMPTY },
      { verb: "ai_new", title: utf8Bytes("New Chat"), hint: EMPTY },
      MANAGE_ACTION,
    ];
  }
  const h = selectedHit(model);
  if (h === null) return [MANAGE_ACTION];
  switch (h.kind) {
    case "app":
      return [
        { verb: "open", title: utf8Bytes("Open"), hint: utf8Bytes("↩") },
        { verb: "copy", title: utf8Bytes("Copy Path"), hint: EMPTY },
        MANAGE_ACTION,
      ];
    case "snippet":
      return [
        { verb: "paste", title: utf8Bytes("Paste"), hint: utf8Bytes("↩") },
        { verb: "copy", title: utf8Bytes("Copy"), hint: EMPTY },
        { verb: "edit", title: utf8Bytes("Edit in Manage…"), hint: EMPTY },
        { verb: "delete", title: utf8Bytes("Delete Snippet…"), hint: EMPTY },
        MANAGE_ACTION,
      ];
    case "clip": {
      const c = findClip(model, h.refId);
      const queued = queuePosition(model, h.refId) > 0;
      return [
        { verb: "paste", title: utf8Bytes("Paste"), hint: utf8Bytes("↩") },
        { verb: "copy", title: utf8Bytes("Copy"), hint: EMPTY },
        queued
          ? { verb: "unqueue", title: utf8Bytes("Remove from Paste Queue"), hint: EMPTY }
          : { verb: "queue", title: utf8Bytes("Add to Paste Queue"), hint: EMPTY },
        { verb: "pin", title: c !== null && c.pinned ? utf8Bytes("Unpin") : utf8Bytes("Pin"), hint: EMPTY },
        { verb: "ask_ai", title: utf8Bytes("Ask AI About This"), hint: EMPTY },
        { verb: "delete", title: utf8Bytes("Delete…"), hint: EMPTY },
        MANAGE_ACTION,
      ];
    }
    case "calc":
      return [{ verb: "copy", title: utf8Bytes("Copy Result"), hint: utf8Bytes("↩") }, MANAGE_ACTION];
    case "ai":
      return [{ verb: "ask_ai", title: utf8Bytes("Ask AI"), hint: utf8Bytes("↩") }, MANAGE_ACTION];
    case "command":
      return [{ verb: "run", title: utf8Bytes("Open Command"), hint: utf8Bytes("↩") }, MANAGE_ACTION];
  }
}

export function vmActions(model: Model): readonly ActionRow[] {
  return actionItems(model).map((a, i) => ({ id: i | 0, title: a.title, hint: a.hint, selected: i === model.actionSelected }));
}

// ---------------------------------------------------------------- footer

/// Primary (Return) action label for the footer button; empty = none.
export function vmPrimaryLabel(model: Model): Uint8Array {
  if (model.actionsOpen) return utf8Bytes("Run Action");
  if (model.screen === "ai") {
    if (trimBytes(model.query.text).length > 0) return utf8Bytes("Ask");
    if (model.ai.status === "done" && model.ai.answer.length > 0) return utf8Bytes("Paste Answer");
    return EMPTY;
  }
  const h = selectedHit(model);
  if (h === null) return EMPTY;
  switch (h.kind) {
    case "app": return utf8Bytes("Open Application");
    case "snippet": return utf8Bytes("Paste Snippet");
    case "clip": return utf8Bytes("Paste");
    case "calc": return utf8Bytes("Copy Result");
    case "ai": return utf8Bytes("Ask AI");
    case "command": return utf8Bytes("Open Command");
  }
}

export function vmFooterHint(model: Model): Uint8Array {
  if (model.notice.length > 0) return model.notice;
  if (model.actionsOpen) return utf8Bytes("↑↓ choose · esc close");
  switch (model.screen) {
    case "root": return utf8Bytes("↑↓ select · esc hide");
    case "clipboard": return utf8Bytes("↑↓ select · esc back");
    case "queue": return utf8Bytes("↑↓ select · esc back");
    case "ai": return vmAiStatusLine(model);
  }
}

// ---------------------------------------------------------------- clipboard screen

export interface FilterChip {
  readonly filter: ClipFilter;
  readonly title: Uint8Array;
  readonly selected: boolean;
}

const FILTERS: readonly ClipFilter[] = ["all", "text", "image"];

function filterTitle(f: ClipFilter): Uint8Array {
  switch (f) {
    case "all": return utf8Bytes("All");
    case "text": return utf8Bytes("Text");
    case "image": return utf8Bytes("Images");
  }
}

export function vmClipFilters(model: Model): readonly FilterChip[] {
  return FILTERS.map((f) => ({ filter: f, title: filterTitle(f), selected: f === model.clipFilter }));
}

export function vmQueueSummary(model: Model): Uint8Array {
  const n = model.queue.length;
  if (n === 0) return EMPTY;
  return n === 1 ? utf8Bytes("1 clip queued") : utf8Bytes(`${n} clips queued`);
}

// ---------------------------------------------------------------- AI screen

function providerTitle(p: AiProviderChoice): Uint8Array {
  switch (p) {
    case "claude": return utf8Bytes("Claude Code");
    case "codex": return utf8Bytes("Codex");
    case "gemini": return utf8Bytes("Gemini CLI");
    case "opencode": return utf8Bytes("OpenCode");
    case "api": return utf8Bytes("API key");
  }
}

export function vmAiAnswer(model: Model): Uint8Array {
  return model.ai.answer;
}

export function vmAiStatusLine(model: Model): Uint8Array {
  switch (model.ai.status) {
    case "idle": return concat3(utf8Bytes("Ask with "), providerTitle(model.settings.aiProvider), utf8Bytes(" · drop files to attach"));
    case "running": return concat3(utf8Bytes("Answering with "), providerTitle(model.ai.provider), utf8Bytes("… esc stops"));
    case "done": return utf8Bytes("Cmd+K for more · esc back");
    case "failed": return model.ai.failure.length > 0 ? model.ai.failure : utf8Bytes("The AI request failed");
    case "stopped": return utf8Bytes("Stopped · ask again or esc back");
    case "no_provider": return model.ai.failure.length > 0 ? model.ai.failure : utf8Bytes("No AI provider is set up. Open Manage > AI.");
  }
}

export interface ProviderChip {
  readonly provider: AiProviderChoice;
  readonly title: Uint8Array;
  readonly selected: boolean;
}

const PROVIDER_ORDER: readonly AiProviderChoice[] = ["claude", "codex", "gemini", "opencode", "api"];

function providerAvailable(model: Model, p: AiProviderChoice): boolean {
  if (p === "api") return model.ai.apiKeySet;
  return model.providers.some((x) => x.id === p);
}

/// Installed providers only (the panel's chips).
export function vmAiProviderChips(model: Model): readonly ProviderChip[] {
  return PROVIDER_ORDER.filter((p) => providerAvailable(model, p)).map((p) => ({
    provider: p,
    title: providerTitle(p),
    selected: p === model.settings.aiProvider,
  }));
}

export interface AttachmentRow {
  readonly index: number;
  readonly title: Uint8Array;
  /// Accessible name of the remove button.
  readonly removeLabel: Uint8Array;
}

function baseName(path: Uint8Array): Uint8Array {
  let start = 0;
  for (const [i, b] of path.entries()) {
    if (b === 47) start = (i + 1) | 0;
  }
  return path.subarray(start);
}

export function vmAiAttachments(model: Model): readonly AttachmentRow[] {
  return model.ai.attachments.map((a, i) => {
    const name = a.isImage ? concat2(utf8Bytes("Image · "), firstLine(baseName(a.path), 40)) : firstLine(baseName(a.path), 48);
    return { index: i | 0, title: name, removeLabel: concat2(utf8Bytes("Remove attachment "), name) };
  });
}

/// Newest image clip (for "Attach Clipboard Image"), 0 when none.
export function vmLatestImageClipId(model: Model): number {
  const c = model.clips.find((x) => x.kind === "image");
  return c === undefined ? 0 : c.id;
}

export function vmAiNoProviderText(model: Model): Uint8Array {
  if (model.providers.length > 0 || model.ai.apiKeySet) return EMPTY;
  return utf8Bytes("No AI provider found. Install Claude Code, Codex, Gemini CLI, or OpenCode, or add an API key in Manage > AI.");
}

// ---------------------------------------------------------------- confirm dialog

export function vmConfirmTitle(model: Model): Uint8Array {
  switch (model.confirm.kind) {
    case "none": return EMPTY;
    case "clip": return utf8Bytes("Delete this clip?");
    case "snippet": return utf8Bytes("Delete this snippet?");
    case "clear_history": return utf8Bytes("Clear clipboard history?");
  }
}

export function vmConfirmBody(model: Model): Uint8Array {
  const c = model.confirm;
  switch (c.kind) {
    case "none": return EMPTY;
    case "clip": {
      const clip = findClip(model, c.targetId);
      return clip === null ? utf8Bytes("It is removed from history.") : concat3(utf8Bytes("“"), firstLine(clipDisplayTitle(clip), 80), utf8Bytes("” is removed from history. This can't be undone."));
    }
    case "snippet": {
      const s = model.snippets.find((x) => x.id === c.targetId);
      return s === undefined ? utf8Bytes("This can't be undone.") : concat3(utf8Bytes("“"), firstLine(s.name, 80), utf8Bytes("” is deleted. This can't be undone."));
    }
    case "clear_history":
      return utf8Bytes(`All ${model.clips.length} unpinned clips are removed. Pinned clips stay. This can't be undone.`);
  }
}

export function vmConfirmButton(model: Model): Uint8Array {
  return model.confirm.kind === "clear_history" ? utf8Bytes("Clear History") : utf8Bytes("Delete");
}

// ---------------------------------------------------------------- Manage window

export interface TabRow {
  readonly tab: ManageTab;
  readonly title: Uint8Array;
  readonly icon: Uint8Array;
  readonly selected: boolean;
}

const TAB_ORDER: readonly ManageTab[] = ["snippets", "clipboard", "shortcuts", "ai", "general"];

function tabTitle(tab: ManageTab): Uint8Array {
  switch (tab) {
    case "general": return utf8Bytes("General");
    case "shortcuts": return utf8Bytes("Shortcuts");
    case "snippets": return utf8Bytes("Snippets");
    case "clipboard": return utf8Bytes("Clipboard");
    case "ai": return utf8Bytes("AI");
    case "about": return utf8Bytes("About");
  }
}

function tabIcon(tab: ManageTab): Uint8Array {
  switch (tab) {
    case "general": return asciiBytes("settings");
    case "shortcuts": return asciiBytes("wrench");
    case "snippets": return asciiBytes("file-text");
    case "clipboard": return asciiBytes("copy");
    case "ai": return asciiBytes("send");
    case "about": return asciiBytes("info");
  }
}

export function vmManageTabs(model: Model): readonly TabRow[] {
  // "about" is folded into General.
  const current: ManageTab = model.manageTab === "about" ? "general" : model.manageTab;
  return TAB_ORDER.map((t) => ({ tab: t, title: tabTitle(t), icon: tabIcon(t), selected: t === current }));
}

export interface HotkeyRow {
  readonly action: HotkeyAction;
  readonly title: Uint8Array;
  readonly chord: Uint8Array;
  readonly enabled: boolean;
  readonly capturing: boolean;
  /// Visible text of the record button ("Record" / "Cancel").
  readonly recordText: Uint8Array;
  /// Accessible names (unique per row).
  readonly recordLabel: Uint8Array;
  readonly resetLabel: Uint8Array;
  readonly enableLabel: Uint8Array;
}

export function vmHotkeyRows(model: Model): readonly HotkeyRow[] {
  return model.hotkeys.map((h) => {
    const capturing = model.capturing === h.action;
    const title = actionTitle(h.action);
    return {
      action: h.action,
      title: title,
      chord: capturing ? utf8Bytes("Press the new shortcut… (esc cancels)") : h.enabled ? hotkeyLabel(h.keyCode, h.mods) : utf8Bytes("Off"),
      enabled: h.enabled,
      capturing: capturing,
      recordText: capturing ? utf8Bytes("Cancel") : utf8Bytes("Record"),
      recordLabel: capturing ? concat2(utf8Bytes("Cancel recording for "), title) : concat2(utf8Bytes("Record shortcut for "), title),
      resetLabel: concat2(utf8Bytes("Reset shortcut for "), title),
      enableLabel: concat2(utf8Bytes("Enable shortcut for "), title),
    };
  });
}

export interface SnippetRow {
  readonly id: number;
  readonly name: Uint8Array;
  readonly keyword: Uint8Array;
  readonly preview: Uint8Array;
  readonly selected: boolean;
  readonly a11y: Uint8Array;
}

export function vmSnippetRows(model: Model): readonly SnippetRow[] {
  const editing = model.draft === null ? -1 : model.draft.id;
  return model.snippets.map((s) => {
    const name = firstLine(s.name, 80);
    return {
      id: s.id,
      name: name,
      keyword: s.keyword,
      preview: firstLine(s.body, 80),
      selected: s.id === editing,
      a11y: s.keyword.length > 0 ? concat3(name, utf8Bytes(", keyword "), s.keyword) : name,
    };
  });
}

export function vmDraftError(model: Model): Uint8Array {
  return model.draft === null ? EMPTY : model.draft.problem;
}

export function vmDraftTitle(model: Model): Uint8Array {
  if (model.draft === null) return EMPTY;
  return model.draft.id === 0 ? utf8Bytes("New Snippet") : utf8Bytes("Edit Snippet");
}

export interface ChoiceRow {
  readonly value: number;
  readonly title: Uint8Array;
  readonly selected: boolean;
}

export function vmRetentionChoices(model: Model): readonly ChoiceRow[] {
  const d = model.settings.retentionDays;
  return [
    { value: 7, title: utf8Bytes("7 days"), selected: d === 7 },
    { value: 30, title: utf8Bytes("30 days"), selected: d === 30 },
    { value: 90, title: utf8Bytes("90 days"), selected: d === 90 },
    { value: 0, title: utf8Bytes("Forever"), selected: d === 0 },
  ];
}

export function vmMaxItemChoices(model: Model): readonly ChoiceRow[] {
  const n = model.settings.maxItems;
  return [
    { value: 100, title: utf8Bytes("100"), selected: n === 100 },
    { value: 500, title: utf8Bytes("500"), selected: n === 500 },
    { value: 1000, title: utf8Bytes("1,000"), selected: n === 1000 },
    { value: 5000, title: utf8Bytes("5,000"), selected: n === 5000 },
  ];
}

export interface ProviderRow {
  readonly provider: AiProviderChoice;
  readonly title: Uint8Array;
  readonly detail: Uint8Array;
  readonly available: boolean;
  readonly unavailable: boolean;
  readonly selected: boolean;
}

export function vmProviderRows(model: Model): readonly ProviderRow[] {
  return PROVIDER_ORDER.map((p) => {
    const found = model.providers.find((x) => x.id === p);
    const available = providerAvailable(model, p);
    const detail = p === "api"
      ? (model.ai.apiKeySet ? utf8Bytes("Key stored in the macOS Keychain") : utf8Bytes("No key stored"))
      : (found !== undefined ? found.binPath : utf8Bytes("Not installed"));
    return { provider: p, title: providerTitle(p), detail: detail, available: available, unavailable: !available, selected: p === model.settings.aiProvider };
  });
}

export function vmApiKeyStatus(model: Model): Uint8Array {
  return model.ai.apiKeySet
    ? utf8Bytes("An API key is stored in the macOS Keychain. Bettercast never shows or saves it anywhere else.")
    : utf8Bytes("Optional. Copy your key, then press Save API Key from Clipboard. It goes straight into the macOS Keychain.");
}

export function vmAxStatusLine(model: Model): Uint8Array {
  return model.axTrusted
    ? utf8Bytes("Accessibility access is on: Bettercast pastes into the app you were using.")
    : utf8Bytes("Accessibility access is off: Bettercast copies to the clipboard and you press Cmd+V yourself.");
}

export function vmRetentionLine(model: Model): Uint8Array {
  const n = model.clips.length;
  const images = model.clips.filter((c) => c.kind === "image").length;
  return utf8Bytes(`${n} clips stored (${images} images)`);
}

export function vmLauncherHotkeyLabel(model: Model): Uint8Array {
  const h = model.hotkeys.find((k) => k.action === "launcher");
  if (h === undefined || !h.enabled) return EMPTY;
  return hotkeyLabel(h.keyCode, h.mods);
}

export function vmVersionLine(model: Model): Uint8Array {
  const hk = vmLauncherHotkeyLabel(model);
  const open = hk.length > 0 ? concat3(utf8Bytes(" · Open with "), hk, EMPTY) : utf8Bytes(" · Open from the menu bar");
  return concat2(utf8Bytes("Bettercast 0.1.0"), open);
}

export function commandTitle(id: number): Uint8Array {
  const c = COMMANDS.find((x) => x.id === id);
  return c === undefined ? EMPTY : c.title;
}

export function countLabel(n: number): Uint8Array {
  return decimal(n);
}

/// Lowercased extension check for dropped files (attachments).
export function isImagePath(path: Uint8Array): boolean {
  const lower = lowerAscii(baseName(path));
  const exts: readonly Uint8Array[] = [asciiBytes(".png"), asciiBytes(".jpg"), asciiBytes(".jpeg"), asciiBytes(".gif"), asciiBytes(".heic"), asciiBytes(".webp"), asciiBytes(".tiff"), asciiBytes(".tif"), asciiBytes(".bmp")];
  for (const e of exts) {
    if (endsWithBytes(lower, e)) return true;
  }
  return false;
}

function endsWithBytes(hay: Uint8Array, suffix: Uint8Array): boolean {
  if (hay.length < suffix.length) return false;
  const off = hay.length - suffix.length;
  for (const [i, b] of suffix.entries()) {
    if (hay[off + i] !== b) return false;
  }
  return true;
}
