// All state transitions. `step(model, msg)` returns the next Model plus an
// effect DESCRIPTION (Step). core.ts's `update` is the only place that turns
// a Step into Cmds (the SDK requires Cmds to be built inline there, NS1017).
//
// Adding an effect: add an Op arm here, then its `case` in core.ts update.
// One Op per Step; chain multi-step flows through result Msgs (e.g.
// write_paste -> paste_written -> paste).

import { asciiBytes, utf8Bytes } from "@native-sdk/core";
import { type TextInputEvent } from "@native-sdk/core/events";
import { applyEdit, clampInt, type EditState } from "./textedit.ts";
import type { Model, Msg } from "./core.ts";
import type { HotkeyAction } from "./shared.ts";
import type {
  DetectProvidersRequest,
  ExportConfigRequest,
  ImportConfigRequest,
  LocateRequest,
  ScanAppsRequest,
} from "./shared.ts";
import {
  MAX_RESULTS,
  QUERY_CAPACITY,
  SNIPPET_BODY_CAPACITY,
  defaultSettings,
  editWithText,
  emptyEdit,
  initialAi,
  initialEnv,
  type Attachment,
  type Clip,
  type Frecency,
  type QueueItem,
  type Screen,
  type Thumb,
  MAX_THUMBS,
  noConfirm,
} from "./model.ts";
import { appKey, commandKey, hits, snippetKey, CMD_CLIPBOARD, CMD_MANAGE, CMD_NEW_SNIPPET, CMD_QUEUE, CMD_QUIT } from "./search.ts";
import { actionItems, isImagePath, selectedHit, thumbWindowClipIds } from "./viewmodel.ts";
import { actionForToken, actionTitle, checkHotkey, defaultHotkeys, hotkeyFromKey, hotkeyLabel, hotkeySpec, withHotkey } from "./hotkeys.ts";
import { parseLine } from "./protocol.ts";
import { MAX_ITEMS_LIMIT, MAX_RETENTION_DAYS, MIN_ITEMS_LIMIT, clearUnpinned, clipPath, thumbPath, fileInUse, filePath, kindWord, pruneClips, pruneQueue, queueDeletes, recordClip, removeClip, togglePin, touchClip, type PruneResult } from "./clipboard.ts";
import { deleteSnippet, draftFor, findSnippet, newDraft, saveDraft, validateDraft, SNIPPET_KEYWORD_CAPACITY, SNIPPET_NAME_CAPACITY } from "./snippets.ts";
import { appendAnswer, binFor, fullPrompt, historyAfter, providerProblem, providerToken, requestFile } from "./ai.ts";
import { FIXTURE_APPS, FIXTURE_CLIPS, FIXTURE_NEXT_ID, FIXTURE_PROVIDERS, FIXTURE_SNIPPETS } from "./fixtures.ts";
import { bump, bytesEqual, concat2, concat3, decimal, indexOfByte, indexOfBytes, joinBytes, EMPTY, trimBytes } from "./bytes.ts";

// ---------------------------------------------------------------- Step / Op

/// Window effects. open_manage = hide the panel and show Bettercast in the
/// Dock while the Manage window exists (a normal, Cmd+Tab-able window);
/// manage_closed = back to a menu-bar-only app.
export type WindowOp = "none" | "show_panel" | "hide_panel" | "show_manage" | "open_manage" | "manage_closed";

export type Op =
  | { readonly kind: "none" }
  /// Cmd.delay("boot", 1, "boot_go"): runs after all envMsgs are delivered.
  | { readonly kind: "boot_delay" }
  | { readonly kind: "locate"; readonly req: LocateRequest }
  | { readonly kind: "scan_apps"; readonly req: ScanAppsRequest }
  | { readonly kind: "detect_providers"; readonly req: DetectProvidersRequest }
  /// Long-lived `bettercast-helper watch` (spawn key "watch").
  | { readonly kind: "watch_start"; readonly helper: Uint8Array; readonly hotkeys: Uint8Array; readonly dataDir: Uint8Array; readonly images: Uint8Array }
  | { readonly kind: "watch_stop" }
  /// Cmd.delay("watch_retry", 3000, "watch_retry"): respawn a watch that
  /// exited on its own (at most 5 times in a row).
  | { readonly kind: "watch_retry" }
  | { readonly kind: "write_paste"; readonly path: Uint8Array; readonly bytes: Uint8Array }
  | { readonly kind: "paste"; readonly helper: Uint8Array; readonly pid: Uint8Array; readonly path: Uint8Array; readonly clipKind: Uint8Array }
  | { readonly kind: "copy"; readonly helper: Uint8Array; readonly path: Uint8Array; readonly clipKind: Uint8Array }
  | { readonly kind: "copy_text"; readonly text: Uint8Array }
  | { readonly kind: "open_path"; readonly helper: Uint8Array; readonly path: Uint8Array }
  | { readonly kind: "ax_status"; readonly helper: Uint8Array }
  | { readonly kind: "ax_prompt"; readonly helper: Uint8Array }
  | { readonly kind: "delete_file"; readonly path: Uint8Array }
  | { readonly kind: "write_ai_request"; readonly path: Uint8Array; readonly bytes: Uint8Array }
  | { readonly kind: "ai_key_get" }
  /// `secret` is the API key for provider "api" (empty otherwise); it goes
  /// to the helper's stdin and is NEVER stored in the Model.
  /// `fake`: e2e only (BETTERCAST_AI_FAKE=1), adds `--provider fake`.
  | { readonly kind: "ai_start"; readonly helper: Uint8Array; readonly requestPath: Uint8Array; readonly secret: Uint8Array; readonly fake: boolean }
  | { readonly kind: "ai_cancel" }
  | { readonly kind: "api_key_read" }
  | { readonly kind: "api_key_set"; readonly secret: Uint8Array }
  | { readonly kind: "api_key_delete" }
  | { readonly kind: "login_status" }
  | { readonly kind: "login_set"; readonly enabled: boolean }
  | { readonly kind: "export_config"; readonly req: ExportConfigRequest }
  | { readonly kind: "import_config"; readonly req: ImportConfigRequest }
  | { readonly kind: "quit" }
  /// Cmd.imageLoad of a clipboard thumbnail (id = clip id), after
  /// Cmd.imageUnregister(evictId) when evictId > 0. See withThumbs.
  | { readonly kind: "thumb_load"; readonly imageId: number; readonly path: Uint8Array; readonly evictId: number };

export interface Step {
  readonly model: Model;
  readonly persist: boolean;
  readonly window: WindowOp;
  readonly op: Op;
}

/// Host exit codes are f64 on the wire; clamp before comparing.
function exitCode(code: number): number {
  return clampInt(code, -1, 255);
}

function just(model: Model): Step {
  return { model: model, persist: false, window: "none", op: { kind: "none" } };
}

function saved(model: Model): Step {
  return { model: model, persist: true, window: "none", op: { kind: "none" } };
}

function withWindow(model: Model, window: WindowOp): Step {
  return { model: model, persist: false, window: window, op: { kind: "none" } };
}

function withOp(model: Model, op: Op): Step {
  return { model: model, persist: false, window: "none", op: op };
}

function full(model: Model, persist: boolean, window: WindowOp, op: Op): Step {
  return { model: model, persist: persist, window: window, op: op };
}

function dryRun(model: Model, what: Uint8Array): Step {
  return just({ ...model, notice: concat2(utf8Bytes("dry-run: "), what) });
}

function isDry(model: Model): boolean {
  return model.env.testMode === "dry";
}

/// The helper's deterministic fake AI provider: e2e mode on CI only.
function fakeAi(model: Model): boolean {
  return model.env.testMode === "e2e" && model.env.aiFake;
}

// ---------------------------------------------------------------- initial model

export function initialState(): Model {
  return {
    panelVisible: false,
    screen: "root",
    query: emptyEdit(),
    searchEpoch: 1,
    selected: 0,
    resultsScroll: 0.5,
    resultsViewport: 0.5,
    actionsOpen: false,
    actionSelected: 0,
    env: initialEnv(),
    watchState: "off",
    frontPid: -1,
    frontName: EMPTY,
    axTrusted: false,
    nowMs: 0,
    apps: [],
    snippets: [],
    clips: [],
    queue: [],
    frecency: [],
    settings: defaultSettings(),
    hotkeys: defaultHotkeys(),
    nextId: 1,
    providers: [],
    ai: initialAi(),
    manageOpen: false,
    manageTab: "general",
    draft: null,
    capturing: "none",
    hotkeyNotice: EMPTY,
    notice: EMPTY,
    clipFilter: "all",
    confirm: noConfirm(),
    thumbs: [],
    thumbSeq: 1,
    deleteQueue: [],
    deleting: false,
    appsState: "idle",
    watchRetries: 0,
  };
}

/// Reset everything that must not survive a restart (the persisted
/// snapshot is the whole Model).
function transientReset(model: Model): Model {
  return {
    ...model,
    panelVisible: false,
    screen: "root",
    query: emptyEdit(),
    searchEpoch: bump(model.searchEpoch) | 0,
    selected: 0,
    actionsOpen: false,
    actionSelected: 0,
    env: initialEnv(),
    watchState: "off",
    frontPid: -1,
    frontName: EMPTY,
    ai: { ...model.ai, status: model.ai.status === "running" ? "stopped" : model.ai.status },
    manageOpen: false,
    draft: null,
    capturing: "none",
    hotkeyNotice: EMPTY,
    notice: EMPTY,
    confirm: noConfirm(),
    // The runtime image registry is empty after every launch.
    thumbs: [],
    thumbSeq: 1,
    deleting: false,
    appsState: "idle",
    watchRetries: 0,
  };
}

// ---------------------------------------------------------------- helpers

/// Record one use of a frecency key (launch count + last use), most
/// recent first, capped at 200 keys.
function useKey(model: Model, key: Uint8Array): readonly Frecency[] {
  const cur = model.frecency.find((f) => bytesEqual(f.key, key));
  const count = cur === undefined ? 1 : cur.count < 1000000 ? (cur.count + 1) | 0 : cur.count;
  const rest = model.frecency.filter((f) => !bytesEqual(f.key, key));
  const next: readonly Frecency[] = [{ key: key, count: count, lastMs: model.nowMs }, ...rest];
  return next.length > 200 ? next.slice(0, 200) : next;
}

/// Apply a clip removal/prune: drop queue entries of removed clips and
/// queue their payload files for deletion (withDeletes drains the queue).
function applyRemoval(model: Model, r: PruneResult): Model {
  if (r.removed.length === 0) return model;
  return { ...model, clips: r.clips, queue: pruneQueue(model.queue, r.clips), deleteQueue: queueDeletes(model.deleteQueue, r.removed, r.clips) };
}

/// Paste `path` into the last frontmost app, or just copy it when no
/// target app is known (the helper then leaves it on the clipboard).
function pasteOrCopy(model: Model, persist: boolean, window: WindowOp, path: Uint8Array, clipKind: Uint8Array): Step {
  if (model.env.helperPath.length === 0) return full({ ...model, notice: utf8Bytes("The Bettercast helper is missing, so it cannot paste.") }, persist, window, { kind: "none" });
  if (model.frontPid <= 0) {
    return full({ ...model, notice: utf8Bytes("Copied. No app to paste into, so press Cmd+V where you want it.") }, persist, window, { kind: "copy", helper: model.env.helperPath, path: path, clipKind: clipKind });
  }
  return full(model, persist, window, { kind: "paste", helper: model.env.helperPath, pid: decimal(model.frontPid), path: path, clipKind: clipKind });
}

function captureAction(c: Model["capturing"]): HotkeyAction | null {
  switch (c) {
    case "none": return null;
    case "launcher": return "launcher";
    case "clipboard": return "clipboard";
    case "paste_next": return "paste_next";
    case "ask_ai": return "ask_ai";
  }
}

/// Stop capturing a shortcut; the watch respawns with the real hotkeys.
function endCapture(model: Model): Step {
  if (model.capturing === "none") return just(model);
  return restartWatch({ ...model, capturing: "none" });
}

function tmpPath(model: Model, name: Uint8Array): Uint8Array {
  return joinBytes([model.env.dataDir, asciiBytes("tmp"), name], asciiBytes("/"));
}

function resultCount(model: Model): number {
  if (model.screen === "ai") return 0;
  return hits(model).length;
}

function clampSelection(model: Model): Model {
  const n = resultCount(model);
  const sel = n === 0 ? 0 : model.selected >= n ? n - 1 : model.selected < 0 ? 0 : model.selected;
  return sel === model.selected ? model : { ...model, selected: sel | 0 };
}

/// Move the result (or open actions-menu) selection by delta, clamped.
function moveSelection(model: Model, delta: number): Model {
  if (model.actionsOpen) {
    const n = actionItems(model).length;
    let a = model.actionSelected + delta;
    if (a < 0) a = 0;
    if (a >= n) a = n - 1;
    return { ...model, actionSelected: a | 0 };
  }
  const n = resultCount(model);
  if (n === 0) return model;
  let s = model.selected + delta;
  if (s < 0) s = 0;
  if (s >= n) s = n - 1;
  return { ...model, selected: s | 0 };
}

function setQuery(model: Model, query: EditState): Model {
  const changed = !bytesEqual(query.text, model.query.text);
  if (!changed) return { ...model, query: query };
  return { ...model, query: query, selected: 0, actionsOpen: false, actionSelected: 0 };
}

function reduceEdit(state: EditState, edit: TextInputEvent, capacity: number): EditState {
  return applyEdit(state, edit, capacity);
}

function showPanel(model: Model): Step {
  const m = clampSelection({ ...model, panelVisible: true, searchEpoch: bump(model.searchEpoch) | 0 });
  return withWindow(m, "show_panel");
}

function hidePanel(model: Model): Step {
  return withWindow({ ...model, panelVisible: false, actionsOpen: false, screen: "root", query: emptyEdit(), selected: 0, searchEpoch: bump(model.searchEpoch) | 0 }, "hide_panel");
}

function openScreen(model: Model, screen: Screen): Model {
  return { ...model, screen: screen, query: emptyEdit(), selected: 0, actionsOpen: false, actionSelected: 0, searchEpoch: bump(model.searchEpoch) | 0 };
}

/// Esc: close actions > clear query > back to root > hide panel.
/// `runtimeCleared` is true when the Esc arrived as the search field's
/// `clear` edit (the runtime already emptied its copy of the text).
function escape(model: Model, runtimeCleared: boolean): Step {
  if (model.confirm.kind !== "none") {
    return just({ ...model, confirm: noConfirm(), searchEpoch: bump(model.searchEpoch) | 0 });
  }
  if (model.actionsOpen) {
    // Keep the query; remount the field so the runtime's cleared echo is
    // replaced by the model's text.
    return just({ ...model, actionsOpen: false, actionSelected: 0, searchEpoch: runtimeCleared ? bump(model.searchEpoch) | 0 : model.searchEpoch });
  }
  if (model.screen === "ai" && model.ai.status === "running") {
    return full({ ...model, ai: { ...model.ai, status: "stopped" }, searchEpoch: bump(model.searchEpoch) | 0 }, false, "none", { kind: "ai_cancel" });
  }
  if (model.query.text.length > 0) return just(setQuery(model, emptyEdit()));
  if (model.screen !== "root") return just(openScreen(model, "root"));
  return hidePanel(model);
}

// ---------------------------------------------------------------- running rows

function runHit(model: Model, index: number): Step {
  const list = hits(model);
  if (index < 0 || index >= list.length) return just(model);
  const h = list[index];
  const m = { ...model, selected: index | 0 };
  switch (h.kind) {
    case "command": {
      const mc = { ...m, frecency: useKey(m, commandKey(h.refId)) };
      if (h.refId === CMD_CLIPBOARD) return saved(openScreen(mc, "clipboard"));
      if (h.refId === CMD_QUEUE) return saved(openScreen(mc, "queue"));
      if (h.refId === CMD_MANAGE) return { ...openManage(mc, "general"), persist: true };
      if (h.refId === CMD_NEW_SNIPPET) return { ...openManage({ ...mc, draft: newDraft() }, "snippets"), persist: true };
      if (h.refId === CMD_QUIT) return full(mc, true, "none", { kind: "quit" });
      return just(m);
    }
    case "app": {
      if (h.refId < 0 || h.refId >= model.apps.length) return just(m);
      const app = model.apps[h.refId];
      const used = hidePanel({ ...m, frecency: useKey(m, appKey(app.path)) }).model;
      if (isDry(model)) return { ...dryRun(used, concat2(utf8Bytes("open "), app.path)), persist: true };
      if (model.env.helperPath.length === 0) return full({ ...used, notice: utf8Bytes("The Bettercast helper is missing, so it cannot open apps.") }, true, "hide_panel", { kind: "none" });
      return full(used, true, "hide_panel", { kind: "open_path", helper: model.env.helperPath, path: app.path });
    }
    case "snippet":
      return pasteSnippet(m, h.refId);
    case "clip":
      return pasteClip(m, h.refId);
    case "calc":
      if (isDry(model)) return dryRun(m, concat2(utf8Bytes("copy "), h.title));
      return full({ ...m, notice: concat2(utf8Bytes("Copied "), h.title) }, false, "none", { kind: "copy_text", text: h.title });
    case "ai":
      return askAi(m);
  }
}

function pasteSnippet(model: Model, id: number): Step {
  const s = findSnippet(model.snippets, id);
  if (s === null) return just(model);
  const hidden = hidePanel({ ...model, frecency: useKey(model, snippetKey(s.id)) }).model;
  if (isDry(model)) return { ...dryRun(hidden, concat3(utf8Bytes("paste snippet "), s.name, utf8Bytes(` into pid ${model.frontPid}`))), persist: true };
  return full(hidden, true, "hide_panel", { kind: "write_paste", path: tmpPath(model, asciiBytes("paste.txt")), bytes: s.body });
}

function pasteClip(model: Model, id: number): Step {
  const c = model.clips.find((x) => x.id === id);
  if (c === undefined) return just(model);
  const hidden = hidePanel({ ...model, clips: touchClip(model.clips, c.id, model.nowMs) }).model;
  if (isDry(model)) return { ...dryRun(hidden, concat3(utf8Bytes("paste clip "), c.sha.subarray(0, 8), utf8Bytes(` into pid ${model.frontPid}`))), persist: true };
  return pasteOrCopy(hidden, true, "hide_panel", clipPath(model.env.dataDir, c), kindWord(c));
}

/// Ask the chosen provider about the launcher query. On the AI screen a
/// question after a finished (or stopped) answer is a follow-up: earlier
/// turns ride along as context. Attachments stay for the conversation.
function askAi(model: Model): Step {
  const question = trimBytes(model.query.text);
  if (question.length === 0) return model.screen === "ai" ? just(model) : just(openScreen(model, "ai"));
  if (model.ai.status === "running") return just({ ...model, notice: utf8Bytes("An answer is still streaming. Press Esc to stop it first.") });
  const provider = model.settings.aiProvider;
  const followUp = model.screen === "ai" && (model.ai.status === "done" || model.ai.status === "stopped") && model.ai.answer.length > 0;
  const history = followUp ? historyAfter(model.ai) : EMPTY;
  const problem = providerProblem(model.providers, model.ai.apiKeySet, provider);
  if (problem.length > 0) {
    return just(openScreen({ ...model, ai: { ...model.ai, status: "no_provider", prompt: question, answer: EMPTY, failure: problem, provider: provider, history: history } }, "ai"));
  }
  const m = openScreen({ ...model, ai: { ...model.ai, status: "running", prompt: question, answer: EMPTY, failure: EMPTY, provider: provider, history: history } }, "ai");
  if (isDry(model)) return dryRun(m, concat3(utf8Bytes("ai "), providerToken(provider), utf8Bytes(` with ${m.ai.attachments.length} attachments`)));
  if (model.env.helperPath.length === 0) {
    return just({ ...m, ai: { ...m.ai, status: "failed", failure: utf8Bytes("The Bettercast helper is missing, so AI cannot run.") } });
  }
  const request = requestFile(provider, binFor(model.providers, provider), model.settings.aiModel, m.ai.attachments, fullPrompt(history, question));
  return withOp(m, { kind: "write_ai_request", path: tmpPath(model, asciiBytes("ai-request.txt")), bytes: request });
}

function aiFailed(model: Model, why: Uint8Array): Step {
  return just({ ...model, ai: { ...model.ai, status: "failed", failure: why } });
}

function openManage(model: Model, tab: Model["manageTab"]): Step {
  // The panel hides while Manage is in front (Raycast behaviour).
  const m = { ...model, manageOpen: true, manageTab: tab, panelVisible: false, actionsOpen: false };
  return withWindow(m, model.manageOpen ? "show_manage" : "open_manage");
}

function runAction(model: Model, index: number): Step {
  const items = actionItems(model);
  if (index < 0 || index >= items.length) return just({ ...model, actionsOpen: false });
  const verb = items[index].verb;
  const m = { ...model, actionsOpen: false, actionSelected: 0, searchEpoch: bump(model.searchEpoch) | 0 };
  // Views agent: every Cmd+K action maps onto an existing Msg (the owners
  // implement those arms); deletes go through the confirm dialog.
  const h = selectedHit(model);
  switch (verb) {
    case "run":
    case "open":
    case "paste":
      return runHit(m, model.selected);
    case "ask_ai":
      if (h !== null && h.kind === "clip") {
        const fresh = openScreen({ ...m, ai: { ...m.ai, status: "idle", prompt: EMPTY, answer: EMPTY, failure: EMPTY } }, "ai");
        return step(fresh, { kind: "ai_attach_clip", attachClipId: h.refId | 0 });
      }
      return runHit(m, model.selected);
    case "manage":
      return openManage(m, "general");
    case "ai_paste":
      return step(m, { kind: "ai_paste" });
    case "ai_copy":
      return step(m, { kind: "ai_copy" });
    case "ai_new":
      return step(m, { kind: "ai_new" });
    case "copy":
      if (h === null) return just(m);
      switch (h.kind) {
        case "clip": return step(m, { kind: "clip_copy", copyClipId: h.refId | 0 });
        case "calc": return runHit(m, model.selected);
        case "app": return copyText(m, model.apps[h.refId].path);
        case "snippet": {
          const sn = findSnippet(model.snippets, h.refId);
          return sn === null ? just(m) : copyText(m, sn.body);
        }
        case "command":
        case "ai":
          return copyText(m, h.title);
      }
    case "queue":
      return h !== null && h.kind === "clip" ? step(m, { kind: "queue_add", queueClipId: h.refId | 0 }) : just(m);
    case "unqueue":
      return h !== null && h.kind === "clip" ? step(m, { kind: "queue_remove", unqueueClipId: h.refId | 0 }) : just(m);
    case "pin":
      return h !== null && h.kind === "clip" ? step(m, { kind: "clip_pin", pinClipId: h.refId | 0 }) : just(m);
    case "delete":
      // No searchEpoch bump here: the dialog's destructive button takes
      // focus (autofocus) and a remounted search field would steal it back.
      if (h !== null && h.kind === "clip") return just({ ...m, searchEpoch: model.searchEpoch, confirm: { kind: "clip", targetId: h.refId | 0 } });
      if (h !== null && h.kind === "snippet") return just({ ...m, searchEpoch: model.searchEpoch, confirm: { kind: "snippet", targetId: h.refId | 0 } });
      return just(m);
    case "edit":
      if (h !== null && h.kind === "snippet") return openManage({ ...m, draft: draftFor(model.snippets, h.refId) }, "snippets");
      return just(m);
  }
}

function copyText(model: Model, text: Uint8Array): Step {
  if (isDry(model)) return dryRun(model, concat2(utf8Bytes("copy "), firstLineOf(text)));
  return full({ ...model, notice: utf8Bytes("Copied to the clipboard") }, false, "none", { kind: "copy_text", text: text });
}

/// The first `error <code> <msg-b64>` line of a one-shot's stdout, decoded
/// (else the raw output trimmed).
function helperMessage(out: Uint8Array): Uint8Array {
  let rest = out;
  while (rest.length > 0) {
    const nl = indexOfByte(rest, 10);
    const line = nl < 0 ? rest : rest.subarray(0, nl);
    const ev = parseLine(line);
    if (ev.kind === "helper_error") return ev.message.length > 0 ? ev.message : ev.code;
    rest = nl < 0 ? EMPTY : rest.subarray(nl + 1);
  }
  return trimBytes(out);
}

function firstLineOf(text: Uint8Array): Uint8Array {
  for (const [i, b] of text.entries()) {
    if (b === 10) return text.subarray(0, i);
  }
  return text;
}

// ---------------------------------------------------------------- thumbnails

/// After every step: when the clipboard/queue screen shows image rows
/// without a registered thumbnail, load ONE (id = clip id), evicting the
/// least recently loaded off-screen thumbnail when MAX_THUMBS are loaded.
/// Loads chain through thumb_loaded, one at a time (16-slot registry).
function withThumbs(s: Step): Step {
  if (s.op.kind !== "none") return s;
  const m = s.model;
  if (!m.panelVisible || !m.env.located || (m.screen !== "clipboard" && m.screen !== "queue")) return s;
  if (m.thumbs.some((t) => t.state === "loading")) return s;
  const wanted = thumbWindowClipIds(m);
  for (const w of wanted) {
    if (m.thumbs.some((t) => t.clipId === w.clipId)) continue;
    const clip = m.clips.find((c) => c.id === w.clipId);
    if (clip === undefined) continue;
    let evict = 0;
    let rest = m.thumbs;
    const loaded = m.thumbs.filter((t) => t.state === "loaded");
    if (loaded.length >= MAX_THUMBS) {
      let oldestId = 0;
      let oldestAt = 0;
      for (const t of loaded) {
        if (wanted.some((x) => x.clipId === t.clipId)) continue;
        if (oldestId === 0 || t.usedAt < oldestAt) {
          oldestId = t.clipId;
          oldestAt = t.usedAt;
        }
      }
      if (oldestId === 0) return s;
      evict = oldestId;
      rest = m.thumbs.filter((t) => t.clipId !== oldestId);
    }
    const thumbs: readonly Thumb[] = [...rest, { clipId: w.clipId, state: "loading", usedAt: m.thumbSeq }];
    return { ...s, model: { ...m, thumbs: thumbs, thumbSeq: bump(m.thumbSeq) | 0 }, op: { kind: "thumb_load", imageId: w.clipId, path: thumbPath(m.env.dataDir, clip), evictId: evict } };
  }
  return s;
}

// ---------------------------------------------------------------- helper watch

function startWatch(model: Model): Step {
  if (model.env.testMode === "dry" || model.env.helperPath.length === 0) return just(model);
  return withOp({ ...model, watchState: "starting" }, {
    kind: "watch_start",
    helper: model.env.helperPath,
    // While a shortcut is being recorded no hotkey is registered, so the
    // chord being pressed (even the current one) reaches the Manage window.
    hotkeys: model.capturing !== "none" ? asciiBytes("-") : hotkeySpec(model.hotkeys),
    dataDir: model.env.dataDir,
    images: model.settings.recordImages ? asciiBytes("1") : asciiBytes("0"),
  });
}

/// Apply hotkey/settings changes to the running watch process: cancel it;
/// watch_err(cancelled) then respawns with the new arguments.
function restartWatch(model: Model): Step {
  if (model.watchState === "running" || model.watchState === "starting") {
    return full({ ...model, watchState: "restarting" }, true, "none", { kind: "watch_stop" });
  }
  return saved(model);
}

function onWatchLine(model: Model, line: Uint8Array): Step {
  const ev = parseLine(line);
  switch (ev.kind) {
    case "ready":
      return just({ ...model, watchState: "running", axTrusted: ev.axTrusted, watchRetries: 0 });
    case "hotkey": {
      const action = actionForToken(ev.token);
      if (action === null) return just(model);
      switch (action) {
        case "launcher": return model.panelVisible ? hidePanel(model) : showPanel(model);
        case "clipboard": return showPanel(openScreen(model, "clipboard"));
        case "paste_next": return pasteNext(model);
        case "ask_ai": return showPanel(openScreen(model, "ai"));
      }
    }
    case "hotkey_error": {
      const action = actionForToken(ev.token);
      const h = action === null ? undefined : model.hotkeys.find((x) => x.action === action);
      if (action === null || h === undefined) return just({ ...model, hotkeyNotice: concat2(utf8Bytes("Could not register a shortcut: "), ev.token) });
      const what = concat3(hotkeyLabel(h.keyCode, h.mods), utf8Bytes(" could not be registered for "), actionTitle(action));
      const why = ev.status === -9878 ? utf8Bytes(". Another app already uses it; choose another shortcut in Manage > Shortcuts.") : utf8Bytes(`. macOS refused it (error ${ev.status | 0}); choose another shortcut in Manage > Shortcuts.`);
      return just({ ...model, hotkeyNotice: concat2(what, why) });
    }
    case "front":
      return just({ ...model, frontPid: ev.pid | 0, frontName: ev.name });
    case "clip": {
      const at = ev.atMs >= 0 && ev.atMs <= 4102444800000 ? Math.trunc(ev.atMs) : 0;
      const incoming: Clip = {
        id: 0,
        kind: ev.clipKind,
        sha: ev.sha,
        size: ev.size | 0,
        width: ev.width | 0,
        height: ev.height | 0,
        preview: ev.preview,
        sourceBundle: ev.sourceBundle,
        firstMs: at,
        lastMs: at,
        pinned: false,
      };
      const r = recordClip(model.clips, incoming, model.nextId, model.settings);
      if (!r.recorded) return just(model);
      const m = { ...model, clips: r.clips, nextId: r.nextId | 0, nowMs: at > model.nowMs ? at : model.nowMs };
      return saved(applyRemoval(m, pruneClips(m.clips, m.settings, m.nowMs)));
    }
    case "ax":
      return just({ ...model, axTrusted: ev.trusted });
    case "clip_skip":
    case "result":
    case "chunk":
    case "done":
    case "unknown":
      return just(model);
    case "helper_error":
      return just({ ...model, notice: concat3(utf8Bytes("Helper: "), ev.code, ev.message.length > 0 ? concat2(utf8Bytes(" · "), ev.message) : EMPTY) });
  }
}

/// Paste the head of the queue into the frontmost app and drop it from the
/// queue (clips deleted meanwhile are skipped).
function pasteNext(model: Model): Step {
  const live = pruneQueue(model.queue, model.clips);
  if (live.length === 0) return just({ ...model, queue: live, notice: utf8Bytes("The paste queue is empty.") });
  const c = model.clips.find((x) => x.id === live[0].clipId);
  if (c === undefined) return just(model);
  const rest = live.slice(1);
  const left = rest.length;
  const m = {
    ...model,
    queue: rest,
    clips: touchClip(model.clips, c.id, model.nowMs),
    notice: left === 0 ? utf8Bytes("Pasted the last queued clip.") : utf8Bytes(`Pasted a queued clip, ${left} left.`),
  };
  if (isDry(model)) return { ...dryRun(m, concat3(utf8Bytes("paste next "), c.sha.subarray(0, 8), utf8Bytes(` (${left} left)`))), persist: true };
  return pasteOrCopy(m, true, "none", clipPath(model.env.dataDir, c), kindWord(c));
}

// ---------------------------------------------------------------- file deletes

/// After every step: when payload files wait for deletion and none is in
/// flight, delete ONE (clip_deleted / clip_delete_failed continue the
/// chain). Files a live clip points at again are skipped.
function withDeletes(s: Step): Step {
  if (s.op.kind !== "none") return s;
  const m = s.model;
  if (m.deleting || m.deleteQueue.length === 0 || !m.env.located || m.env.dataDir.length === 0) return s;
  let i = 0;
  while (i < m.deleteQueue.length && fileInUse(m.clips, m.deleteQueue[i])) i += 1;
  if (i >= m.deleteQueue.length) return { ...s, model: { ...m, deleteQueue: [] } };
  const f = m.deleteQueue[i];
  return { ...s, model: { ...m, deleting: true, deleteQueue: m.deleteQueue.slice(i + 1) }, op: { kind: "delete_file", path: filePath(m.env.dataDir, f.kind, f.sha) } };
}

// ---------------------------------------------------------------- step

export function step(model: Model, msg: Msg): Step {
  return withDeletes(withThumbs(stepMsg(model, msg)));
}

function stepMsg(model: Model, msg: Msg): Step {
  switch (msg.kind) {
    // ---- boot
    case "env_app_data_dir":
      return just({ ...model, env: { ...model.env, appDataDir: msg.value } });
    case "env_data_dir":
      return just({ ...model, env: { ...model.env, dataDirOverride: msg.value } });
    case "env_helper":
      return just({ ...model, env: { ...model.env, helperOverride: msg.value } });
    case "env_ai_fake":
      return just({ ...model, env: { ...model.env, aiFake: bytesEqual(trimBytes(msg.value), asciiBytes("1")) } });
    case "env_test_mode": {
      const v = trimBytes(msg.value);
      const mode = bytesEqual(v, asciiBytes("e2e")) ? "e2e" : v.length > 0 && !bytesEqual(v, asciiBytes("0")) ? "dry" : "off";
      return just({ ...model, env: { ...model.env, testMode: mode } });
    }
    case "restored":
    case "fresh_boot":
      return full(transientReset(model), false, "none", { kind: "boot_delay" });
    case "restore_failed":
      return full({ ...transientReset(model), notice: concat2(utf8Bytes("Settings could not be restored: "), msg.reason) }, false, "none", { kind: "boot_delay" });
    case "boot_go": {
      const dataDir = model.env.dataDirOverride.length > 0 ? model.env.dataDirOverride : model.env.appDataDir;
      return withOp({ ...model, nowMs: msg.bootAt >= 0 && msg.bootAt <= 4102444800000 ? Math.trunc(msg.bootAt) : 0 }, { kind: "locate", req: { helperOverride: model.env.helperOverride, dataDir: dataDir } });
    }
    case "located": {
      const r = msg.result;
      const base = { ...model, env: { ...model.env, dataDir: r.dataDir, helperPath: r.helperPath, located: true }, watchRetries: 0 };
      const m = applyRemoval(base, pruneClips(base.clips, base.settings, base.nowMs));
      const missing = r.helperFound ? EMPTY : utf8Bytes("The Bettercast helper was not found: global shortcuts, clipboard history, and paste are off.");
      if (m.env.testMode === "dry") {
        // Test modes show the panel at boot so automation can drive it.
        return showPanel({ ...m, notice: r.helperFound ? EMPTY : utf8Bytes("helper not found") });
      }
      if (m.env.testMode === "e2e") {
        // Real helper, synthetic data: no app scan (test.seed provides apps).
        const w = startWatch(showPanel({ ...m, notice: r.helperFound ? EMPTY : utf8Bytes("helper not found") }).model);
        return { ...w, window: "show_panel" };
      }
      // Boot chain: scan apps -> detect providers -> login status -> watch.
      return withOp({ ...m, appsState: "loading", notice: missing }, { kind: "scan_apps", req: { extraDirs: EMPTY } });
    }
    case "locate_failed":
      return just({ ...model, notice: concat2(utf8Bytes("Startup failed: "), msg.reason) });
    case "apps_scanned":
      return full({ ...model, apps: msg.result.apps }, true, "none", { kind: "detect_providers", req: { extraDirs: EMPTY } });
    case "apps_scan_failed":
      return withOp({ ...model, notice: concat2(utf8Bytes("App scan failed: "), msg.reason) }, { kind: "detect_providers", req: { extraDirs: EMPTY } });
    case "providers_detected": {
      const ai = model.ai.status === "no_provider" ? { ...model.ai, status: "idle" as const, failure: EMPTY } : model.ai;
      return full({ ...model, providers: msg.result.providers, ai: ai }, true, "none", { kind: "login_status" });
    }
    case "providers_failed":
      return withOp(model, { kind: "login_status" });
    case "tick": {
      const m = { ...model, nowMs: msg.tickAt >= 0 && msg.tickAt <= 4102444800000 ? Math.trunc(msg.tickAt) : 0 };
      const now = m.nowMs;
      const pr = pruneClips(m.clips, m.settings, now);
      return pr.removed.length === 0 ? just(m) : saved(applyRemoval(m, pr));
    }
    case "test_seed": {
      if (model.env.testMode === "off") return just(model);
      // Fixture times are 2023; on a real clock shift them to "now" so the
      // 30-day retention does not prune them mid-test.
      const shift = model.nowMs > 1700000800000 ? model.nowMs - 1700000800000 : 0;
      const clips = FIXTURE_CLIPS.map((c) => {
        const first = c.firstMs + shift;
        const last = c.lastMs + shift;
        return { ...c, firstMs: first >= 0 && first <= 4102444800000 ? Math.trunc(first) : 0, lastMs: last >= 0 && last <= 4102444800000 ? Math.trunc(last) : 0 };
      });
      return saved(clampSelection({
        ...model,
        apps: FIXTURE_APPS,
        snippets: FIXTURE_SNIPPETS,
        clips: clips,
        providers: FIXTURE_PROVIDERS,
        queue: [],
        frecency: [],
        deleteQueue: [],
        nextId: FIXTURE_NEXT_ID | 0,
        frontPid: 4242,
        frontName: utf8Bytes("Fixture Editor"),
        notice: utf8Bytes("seeded"),
      }));
    }
    case "quit":
      return full(model, true, "none", { kind: "quit" });

    // ---- panel + keyboard
    case "panel_toggle":
      return model.panelVisible ? hidePanel(model) : showPanel(model);
    case "panel_show":
      return showPanel(model);
    case "panel_hide":
      return hidePanel(model);
    case "query_edit": {
      const e = msg.edit;
      // KEY MECHANISM (contract.md "Key handling"): in the focused single-line
      // search field the runtime turns ArrowUp/ArrowDown into
      // move_caret{start|end}; we read them as list navigation and remount
      // the field (searchEpoch) so the runtime's caret jump is discarded.
      // Home/End and ⌘←/⌘→ produce the same events and navigate too.
      // ArrowDown = move_caret{end}: the runtime caret lands at the end,
      // where typing continues anyway, so mirror it and keep the field.
      // ArrowUp = move_caret{start}: remount the field (searchEpoch) so the
      // caret returns to the end, and put the model's caret there too.
      if (e.kind === "move_caret" && !e.move.extend && e.move.direction === "start") {
        const moved = moveSelection(model, -1);
        return just({ ...moved, query: editWithText(model.query.text), searchEpoch: bump(model.searchEpoch) | 0 });
      }
      if (e.kind === "move_caret" && !e.move.extend && e.move.direction === "end") {
        return just({ ...moveSelection(model, 1), query: reduceEdit(model.query, e, QUERY_CAPACITY) });
      }
      // Esc in a search-field (and its clear button) arrives as `clear`.
      if (e.kind === "clear") return escape(model, true);
      return just(clampSelection(setQuery(model, reduceEdit(model.query, e, QUERY_CAPACITY))));
    }
    case "select_next":
      return just(moveSelection(model, 1));
    case "select_prev":
      return just(moveSelection(model, -1));
    case "select_row":
      return just(clampSelection({ ...model, selected: clampInt(msg.selectIndex, 0, 1000) | 0 }));
    case "row_run":
      return runHit(model, clampInt(msg.runIndex, 0, 1000));
    case "run_selected":
      if (model.confirm.kind !== "none") return step(model, { kind: "confirm_accept" });
      if (model.actionsOpen) return runAction(model, model.actionSelected);
      if (model.screen === "ai") {
        // Return asks when there is a question; otherwise pastes a finished answer.
        if (trimBytes(model.query.text).length > 0) return step(model, { kind: "ai_ask" });
        if (model.ai.status === "done" && model.ai.answer.length > 0) return step(model, { kind: "ai_paste" });
        return just(model);
      }
      return runHit(model, model.selected);
    case "escape":
      if (model.capturing !== "none") return endCapture(model);
      return escape(model, false);
    case "go_back":
      return just(openScreen(model, "root"));
    case "open_screen":
      return model.panelVisible ? just(openScreen(model, msg.screen)) : showPanel(openScreen(model, msg.screen));
    case "actions_toggle":
      if (!model.panelVisible) return just(model);
      return just({ ...model, actionsOpen: !model.actionsOpen, actionSelected: 0 });
    case "actions_close":
      return just({ ...model, actionsOpen: false, actionSelected: 0 });
    case "action_run":
      return runAction(model, clampInt(msg.actionIndex, 0, 64));
    case "results_scrolled":
      return just({ ...model, resultsScroll: msg.scroll.offsetY, resultsViewport: msg.scroll.viewportExtentY });
    case "key_down": {
      // Manage > Shortcuts recording: the chord arrives through keyMsg.
      const action = captureAction(model.capturing);
      if (action === null) return just(model);
      const candidate = hotkeyFromKey(action, clampInt(msg.keyIndex, 0, 255) | 0, clampInt(msg.mods, 0, 15) | 0);
      if (candidate === null) return just(model);
      const c = checkHotkey(model.hotkeys, candidate);
      // Blocked: keep recording so the user can press another chord.
      if (c.level === "block") return just({ ...model, hotkeyNotice: c.message });
      return restartWatch({ ...model, hotkeys: withHotkey(model.hotkeys, candidate), capturing: "none", hotkeyNotice: c.message });
    }

    // ---- helper watch
    case "watch_line":
      return onWatchLine(model, msg.line);
    case "watch_exit":
    case "watch_err": {
      if (model.watchState === "restarting") return startWatch({ ...model, watchState: "off" });
      const off: Model = { ...model, watchState: "off" };
      if (model.env.testMode === "dry" || model.env.helperPath.length === 0) return just(off);
      if (model.watchRetries >= 5) {
        return just({ ...off, notice: utf8Bytes("Global shortcuts and clipboard history stopped: the helper keeps exiting. Quit and reopen Bettercast.") });
      }
      return withOp({ ...off, watchRetries: bump(model.watchRetries) | 0 }, { kind: "watch_retry" });
    }
    case "watch_retry":
      if (model.watchState !== "off") return just(model);
      return startWatch(model);

    // ---- paste / copy / open results
    case "paste_written":
      if (isDry(model)) return just(model);
      return pasteOrCopy(model, false, "none", tmpPath(model, asciiBytes("paste.txt")), asciiBytes("text"));
    case "paste_write_failed":
      return just({ ...model, notice: concat2(utf8Bytes("Paste failed: "), msg.reason) });
    case "paste_done":
      // exit 0 = pasted, 3 = copied only (no Accessibility access).
      if (exitCode(msg.pasteCode) === 3) return just({ ...model, axTrusted: false, notice: utf8Bytes("Copied. Press Cmd+V to paste (grant Accessibility in Manage > General to paste automatically).") });
      // exit 1 with `result copied`: the target app was gone or never came
      // to the front; the content is on the clipboard, nothing was typed.
      if (exitCode(msg.pasteCode) !== 0 && indexOfBytes(msg.out, asciiBytes("result copied")) >= 0) {
        return just({ ...model, notice: utf8Bytes("Copied. The app to paste into did not come to the front, so press Cmd+V there.") });
      }
      if (exitCode(msg.pasteCode) !== 0) return just({ ...model, notice: concat2(utf8Bytes("Paste failed: "), helperMessage(msg.out)) });
      return just(model);
    case "paste_failed":
    case "copy_failed":
    case "open_failed":
    case "ax_failed":
      return just({ ...model, notice: concat2(utf8Bytes("Helper failed: "), msg.reason) });
    case "copy_done":
      if (exitCode(msg.copyCode) !== 0) return just({ ...model, notice: concat2(utf8Bytes("Copy failed: "), helperMessage(msg.out)) });
      return just(model);
    case "open_done":
      if (exitCode(msg.openCode) !== 0) return just({ ...model, notice: concat2(utf8Bytes("Could not open it: "), helperMessage(msg.out)) });
      return just(model);
    case "ax_done":
      return just({ ...model, axTrusted: exitCode(msg.axCode) === 0 });
    case "ax_request":
      if (model.env.testMode !== "off") return dryRun(model, utf8Bytes("ax-prompt"));
      return withOp(model, { kind: "ax_prompt", helper: model.env.helperPath });

    // ---- clipboard (STUBS: clipboard agent)
    case "clip_paste":
      return pasteClip(model, clampInt(msg.pasteClipId, 0, 1000000000));
    case "clip_copy": {
      const c = model.clips.find((x) => x.id === clampInt(msg.copyClipId, 0, 1000000000));
      if (c === undefined) return just(model);
      const m = { ...model, clips: touchClip(model.clips, c.id, model.nowMs), notice: utf8Bytes("Copied to the clipboard") };
      if (isDry(model)) return { ...dryRun(m, concat2(utf8Bytes("copy clip "), c.sha.subarray(0, 8))), persist: true };
      if (model.env.helperPath.length === 0) return just({ ...model, notice: utf8Bytes("The Bettercast helper is missing, so it cannot copy.") });
      return full(m, true, "none", { kind: "copy", helper: model.env.helperPath, path: clipPath(model.env.dataDir, c), clipKind: kindWord(c) });
    }
    case "clip_pin":
      return saved({ ...model, clips: togglePin(model.clips, clampInt(msg.pinClipId, 0, 1000000000)) });
    case "clip_delete": {
      const r = removeClip(model.clips, clampInt(msg.deleteClipId, 0, 1000000000));
      if (r.removed.length === 0) return just(model);
      return saved(clampSelection({ ...applyRemoval(model, r), notice: utf8Bytes("Deleted from clipboard history") }));
    }
    case "clips_clear": {
      const r = clearUnpinned(model.clips);
      const kept = r.clips.length;
      return saved(clampSelection({ ...applyRemoval(model, r), notice: kept === 0 ? utf8Bytes("Clipboard history cleared") : utf8Bytes(`Clipboard history cleared (${kept} pinned kept)`) }));
    }
    case "clip_deleted":
    case "clip_delete_failed":
      // A missing file (not_found) is fine: the goal is that it is gone.
      return just({ ...model, deleting: false });
    case "set_retention_days": {
      const m = { ...model, settings: { ...model.settings, retentionDays: clampInt(msg.retentionDays, 0, MAX_RETENTION_DAYS) | 0 } };
      return saved(clampSelection(applyRemoval(m, pruneClips(m.clips, m.settings, m.nowMs))));
    }
    case "set_max_items": {
      const m = { ...model, settings: { ...model.settings, maxItems: clampInt(msg.maxItems, MIN_ITEMS_LIMIT, MAX_ITEMS_LIMIT) | 0 } };
      return saved(clampSelection(applyRemoval(m, pruneClips(m.clips, m.settings, m.nowMs))));
    }
    case "toggle_record_images":
      return restartWatch({ ...model, settings: { ...model.settings, recordImages: !model.settings.recordImages } });
    case "queue_add": {
      const id = clampInt(msg.queueClipId, 0, 1000000000);
      const clip = model.clips.find((c) => c.id === id);
      if (clip === undefined) return just(model);
      if (model.queue.some((q) => q.clipId === clip.id)) return just({ ...model, notice: utf8Bytes("Already in the paste queue") });
      const queue: readonly QueueItem[] = [...model.queue, { clipId: clip.id }];
      return saved({ ...model, queue: queue, notice: utf8Bytes(`Added to the paste queue (${queue.length})`) });
    }
    case "queue_remove":
      return saved({ ...model, queue: model.queue.filter((q) => q.clipId !== clampInt(msg.unqueueClipId, 0, 1000000000)) });
    case "queue_clear":
      return saved({ ...model, queue: [] });
    case "paste_next":
      return pasteNext(model);

    // ---- snippets
    case "snippet_new":
      return openManage({ ...model, draft: newDraft() }, "snippets");
    case "snippet_edit": {
      const d = draftFor(model.snippets, clampInt(msg.editSnippetId, 0, 1000000000));
      if (d === null) return just(model);
      return openManage({ ...model, draft: d }, "snippets");
    }
    case "snippet_delete": {
      const id = clampInt(msg.deleteSnippetId, 0, 1000000000);
      const sn = findSnippet(model.snippets, id);
      if (sn === null) return just(model);
      const key = snippetKey(sn.id);
      return saved(clampSelection({
        ...model,
        snippets: deleteSnippet(model.snippets, id),
        frecency: model.frecency.filter((f) => !bytesEqual(f.key, key)),
        draft: model.draft !== null && model.draft.id === sn.id ? null : model.draft,
        notice: concat3(utf8Bytes("Deleted snippet “"), sn.name, utf8Bytes("”")),
      }));
    }
    case "snippet_paste":
      return pasteSnippet(model, clampInt(msg.pasteSnippetId, 0, 1000000000));
    case "draft_name":
      if (model.draft === null) return just(model);
      return just({ ...model, draft: { ...model.draft, name: reduceEdit(model.draft.name, msg.edit, SNIPPET_NAME_CAPACITY) } });
    case "draft_keyword":
      if (model.draft === null) return just(model);
      return just({ ...model, draft: { ...model.draft, keyword: reduceEdit(model.draft.keyword, msg.edit, SNIPPET_KEYWORD_CAPACITY) } });
    case "draft_body":
      if (model.draft === null) return just(model);
      return just({ ...model, draft: { ...model.draft, body: reduceEdit(model.draft.body, msg.edit, SNIPPET_BODY_CAPACITY) } });
    case "draft_save": {
      const d = model.draft;
      if (d === null) return just(model);
      const problem = validateDraft(model.snippets, d);
      if (problem.length > 0) return just({ ...model, draft: { ...d, problem: problem } });
      const isNew = d.id === 0;
      return saved({
        ...model,
        snippets: saveDraft(model.snippets, d, model.nextId, model.nowMs),
        nextId: isNew ? bump(model.nextId) | 0 : model.nextId,
        draft: null,
        notice: concat3(utf8Bytes("Saved snippet “"), trimBytes(d.name.text), utf8Bytes("”")),
      });
    }
    case "draft_cancel":
      return just({ ...model, draft: null });

    // ---- hotkeys (STUBS: hotkeys agent)
    case "hotkey_capture":
      // The Record button toggles (it reads "Cancel" while recording), so
      // keyboard focus can stay on it; the chord arrives through keyMsg.
      // Recording suspends every global hotkey (restartWatch respawns the
      // watch with an empty spec) so even the current chord can be pressed.
      if (model.capturing === msg.action) return endCapture({ ...model, hotkeyNotice: EMPTY });
      return restartWatch({ ...model, capturing: msg.action, hotkeyNotice: EMPTY });
    case "hotkey_capture_cancel":
      return endCapture(model);
    case "hotkey_toggle": {
      const cur = model.hotkeys.find((h) => h.action === msg.action);
      if (cur === undefined) return just(model);
      if (cur.enabled) return restartWatch({ ...model, hotkeys: withHotkey(model.hotkeys, { ...cur, enabled: false }), hotkeyNotice: EMPTY });
      const on = { ...cur, enabled: true };
      const c = checkHotkey(model.hotkeys, on);
      if (c.level === "block") return just({ ...model, hotkeyNotice: c.message });
      return restartWatch({ ...model, hotkeys: withHotkey(model.hotkeys, on), hotkeyNotice: c.message });
    }
    case "hotkey_reset": {
      const d = defaultHotkeys().find((h) => h.action === msg.action);
      if (d === undefined) return just(model);
      const c = checkHotkey(model.hotkeys, d);
      if (c.level === "block") return just({ ...model, hotkeyNotice: c.message });
      return restartWatch({ ...model, hotkeys: withHotkey(model.hotkeys, d), capturing: "none", hotkeyNotice: c.message });
    }

    // ---- AI (STUBS: AI agent)
    case "ai_ask":
      return askAi(model);
    case "ai_request_written":
      if (model.ai.status !== "running") return just(model);
      if (model.ai.provider === "api") return withOp(model, { kind: "ai_key_get" });
      return withOp(model, { kind: "ai_start", helper: model.env.helperPath, requestPath: tmpPath(model, asciiBytes("ai-request.txt")), secret: EMPTY, fake: fakeAi(model) });
    case "ai_write_failed":
      if (model.ai.status !== "running") return just(model);
      return aiFailed(model, concat2(utf8Bytes("Could not write the AI request: "), msg.reason));
    case "ai_key_missing":
      if (model.ai.status !== "running") return just(model);
      return just({ ...model, ai: { ...model.ai, status: "no_provider", apiKeySet: false, failure: concat3(utf8Bytes("No API key found in the Keychain ("), msg.reason, utf8Bytes("). Save one in Manage > AI.")) } });
    case "ai_exit": {
      if (model.ai.status !== "running") return just(model);
      const code = exitCode(msg.aiCode) | 0;
      if (code === 0) return just({ ...model, ai: { ...model.ai, status: "done" } });
      return aiFailed(model, utf8Bytes(`The provider stopped with exit code ${code}.`));
    }
    case "ai_err":
      if (model.ai.status !== "running") return just(model);
      return aiFailed(model, concat2(utf8Bytes("Could not run the provider: "), msg.reason));
    case "ai_copy":
      if (model.ai.answer.length === 0) return just({ ...model, notice: utf8Bytes("There is no answer to copy yet") });
      return copyText(model, model.ai.answer);
    case "ai_paste": {
      if (model.ai.answer.length === 0) return just({ ...model, notice: utf8Bytes("There is no answer to paste yet") });
      const hidden = hidePanel(model).model;
      if (isDry(model)) return dryRun(hidden, utf8Bytes(`paste answer into pid ${model.frontPid}`));
      return full(hidden, false, "hide_panel", { kind: "write_paste", path: tmpPath(model, asciiBytes("paste.txt")), bytes: model.ai.answer });
    }
    case "ai_attach_latest": {
      if (model.clips.length === 0) return just({ ...model, notice: utf8Bytes("Clipboard history is empty") });
      return step(model, { kind: "ai_attach_clip", attachClipId: model.clips[0].id });
    }
    case "ai_attach_clip": {
      const c = model.clips.find((x) => x.id === clampInt(msg.attachClipId, 0, 1000000000));
      if (c === undefined) return just(model);
      const path = clipPath(model.env.dataDir, c);
      if (model.ai.attachments.some((a) => bytesEqual(a.path, path)) || model.ai.attachments.length >= 8) return just(model);
      const attachments: readonly Attachment[] = [...model.ai.attachments, { path: path, isImage: c.kind === "image" }];
      const m = { ...model, ai: { ...model.ai, attachments: attachments } };
      if (model.screen === "ai") return just(m);
      return model.panelVisible ? just(openScreen(m, "ai")) : showPanel(openScreen(m, "ai"));
    }
    case "ai_detach": {
      const at = clampInt(msg.detachIndex, 0, 64);
      const attachments = model.ai.attachments.filter((a, i) => i !== at);
      return just({ ...model, ai: { ...model.ai, attachments: attachments }, searchEpoch: bump(model.searchEpoch) | 0 });
    }
    case "ai_key_loaded":
      // The secret goes straight into the spawn's stdin, never the Model.
      if (model.ai.status !== "running") return just(model);
      return withOp(model, { kind: "ai_start", helper: model.env.helperPath, requestPath: tmpPath(model, asciiBytes("ai-request.txt")), secret: msg.secret, fake: fakeAi(model) });
    case "ai_line": {
      // Lines after Stop (the spawn is being cancelled) are dropped.
      if (model.ai.status !== "running") return just(model);
      const ev = parseLine(msg.line);
      if (ev.kind === "chunk") return just({ ...model, ai: appendAnswer(model.ai, ev.text) });
      if (ev.kind === "done") return just({ ...model, ai: { ...model.ai, status: "done" } });
      if (ev.kind === "helper_error") return aiFailed(model, ev.message.length > 0 ? ev.message : concat2(utf8Bytes("The provider failed: "), ev.code));
      return just(model);
    }
    case "ai_cancel":
      if (model.ai.status !== "running") return just(model);
      return full({ ...model, ai: { ...model.ai, status: "stopped" } }, false, "none", { kind: "ai_cancel" });
    case "ai_set_provider": {
      const ai = model.ai.status === "no_provider" ? { ...model.ai, status: "idle" as const, failure: EMPTY } : model.ai;
      return saved({ ...model, settings: { ...model.settings, aiProvider: msg.provider }, ai: ai });
    }
    case "api_key_from_clipboard":
      if (model.env.testMode !== "off") return dryRun(model, utf8Bytes("read API key from clipboard"));
      return withOp(model, { kind: "api_key_read" });
    case "api_key_read":
      // Straight into the keychain; never stored in the Model.
      return withOp(model, { kind: "api_key_set", secret: trimBytes(msg.text) });
    case "api_key_read_failed":
    case "api_key_failed":
      return just({ ...model, notice: utf8Bytes("Could not store the API key") });
    case "api_key_saved":
      return saved({ ...model, ai: { ...model.ai, apiKeySet: true }, notice: utf8Bytes("API key saved in the Keychain") });
    case "api_key_delete":
      if (model.env.testMode !== "off") return dryRun({ ...model, ai: { ...model.ai, apiKeySet: false } }, utf8Bytes("delete API key"));
      return withOp(model, { kind: "api_key_delete" });
    case "api_key_deleted":
      return saved({ ...model, ai: { ...model.ai, apiKeySet: false }, notice: utf8Bytes("API key removed from the Keychain") });

    // ---- manage window
    case "manage_open":
      return openManage(model, model.manageTab);
    case "manage_closed":
      return { ...endCapture({ ...model, manageOpen: false, draft: null }), window: "manage_closed" };
    case "manage_tab":
      return endCapture({ ...model, manageTab: msg.tab });
    case "login_toggle": {
      const enabled = !model.settings.launchAtLogin;
      if (model.env.testMode !== "off") return dryRun({ ...model, settings: { ...model.settings, launchAtLogin: enabled } }, enabled ? utf8Bytes("launch at login on") : utf8Bytes("launch at login off"));
      return withOp(model, { kind: "login_set", enabled: enabled });
    }
    case "login_status": {
      const on = bytesEqual(msg.state, asciiBytes("enabled"));
      const m = { ...model, settings: { ...model.settings, launchAtLogin: on } };
      // The last step of the boot chain starts the watch process.
      if (model.appsState === "loading") return { ...startWatch({ ...m, appsState: "done" }), persist: true };
      return saved(m);
    }
    case "login_failed": {
      const m = { ...model, notice: concat2(utf8Bytes("Launch at login: "), msg.reason) };
      if (model.appsState === "loading") return startWatch({ ...m, appsState: "done" });
      return just(m);
    }
    case "config_export":
      return withOp(model, { kind: "export_config", req: { path: tmpPath(model, asciiBytes("bettercast-config.json")), config: { snippets: model.snippets, hotkeys: model.hotkeys, settings: model.settings } } });
    case "config_exported":
      return just({ ...model, notice: concat2(utf8Bytes("Exported to "), msg.result.path) });
    case "config_import":
      return withOp(model, { kind: "import_config", req: { path: tmpPath(model, asciiBytes("bettercast-config.json")) } });
    case "config_imported": {
      // Launch at login is never imported (the core keeps the real state);
      // new ids stay ahead of every imported snippet id.
      const doc = msg.result;
      let maxId = model.nextId;
      for (const sn of doc.snippets) {
        if (sn.id >= maxId && sn.id < 1000000000) maxId = bump(sn.id) | 0;
      }
      const settings = { ...doc.settings, launchAtLogin: model.settings.launchAtLogin };
      const m = { ...model, snippets: doc.snippets, hotkeys: doc.hotkeys, settings: settings, nextId: maxId | 0, notice: utf8Bytes("Settings imported") };
      return restartWatch(clampSelection(applyRemoval(m, pruneClips(m.clips, m.settings, m.nowMs))));
    }
    case "config_failed":
      return just({ ...model, notice: concat2(utf8Bytes("Config: "), msg.reason) });
    case "notice_clear":
      return just({ ...model, notice: EMPTY });

    // ---- view-driven (views agent; contract.md "Views")
    case "clip_filter":
      return just({ ...model, clipFilter: msg.filter, selected: 0, actionsOpen: false, actionSelected: 0, searchEpoch: bump(model.searchEpoch) | 0 });
    case "confirm_clip_delete":
      return just({ ...model, actionsOpen: false, confirm: { kind: "clip", targetId: clampInt(msg.confirmClipId, 0, 1000000000) | 0 } });
    case "confirm_snippet_delete":
      return just({ ...model, actionsOpen: false, confirm: { kind: "snippet", targetId: clampInt(msg.confirmSnippetId, 0, 1000000000) | 0 } });
    case "confirm_clear_history":
      return just({ ...model, actionsOpen: false, confirm: { kind: "clear_history", targetId: 0 } });
    case "confirm_cancel":
      return just({ ...model, confirm: noConfirm(), searchEpoch: bump(model.searchEpoch) | 0 });
    case "confirm_accept": {
      const c = model.confirm;
      const m = { ...model, confirm: noConfirm(), searchEpoch: bump(model.searchEpoch) | 0 };
      switch (c.kind) {
        case "none":
          return just(m);
        case "clip": {
          const r = step(m, { kind: "clip_delete", deleteClipId: c.targetId });
          return { ...r, model: clampSelection(r.model) };
        }
        case "snippet": {
          const cleared = { ...m, draft: m.draft !== null && m.draft.id === c.targetId ? null : m.draft };
          const r = step(cleared, { kind: "snippet_delete", deleteSnippetId: c.targetId });
          return { ...r, model: clampSelection(r.model) };
        }
        case "clear_history": {
          const r = step(m, { kind: "clips_clear" });
          return { ...r, model: clampSelection(r.model) };
        }
      }
    }
    case "thumb_loaded": {
      const id = clampInt(msg.id, 0, 1000000000);
      const ok = msg.state === "loaded";
      return just({ ...model, thumbs: model.thumbs.map((t) => (t.clipId === id ? { ...t, state: ok ? "loaded" : "failed" } : t)) });
    }
    case "ai_new": {
      const fresh = { ...initialAi(), provider: model.settings.aiProvider, apiKeySet: model.ai.apiKeySet };
      const m = { ...model, ai: fresh, query: emptyEdit(), selected: 0, actionsOpen: false, searchEpoch: bump(model.searchEpoch) | 0 };
      if (model.ai.status === "running") return withOp(m, { kind: "ai_cancel" });
      return just(m);
    }
    case "files_dropped": {
      const added: Attachment[] = [];
      for (const p of msg.dropped.paths) {
        if (p.length > 0 && model.ai.attachments.length + added.length < 8) added.push({ path: p, isImage: isImagePath(p) });
      }
      if (added.length === 0) return just(model);
      const attachments: readonly Attachment[] = [...model.ai.attachments, ...added];
      const m = { ...model, ai: { ...model.ai, attachments: attachments } };
      if (model.screen === "ai") return just(m);
      return model.panelVisible ? just(openScreen(m, "ai")) : showPanel(openScreen(m, "ai"));
    }
    case "manage_show":
      return openManage(model, msg.tab);
  }
}
