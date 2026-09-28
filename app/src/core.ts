// Bettercast app core — the ENTRY module. Thin by design:
//   * Model and Msg (the whole V0 surface) are declared here.
//   * All transitions live in update.ts: `step(model, msg)` returns the next
//     model plus an effect DESCRIPTION (Step: persist flag, window op, one
//     Op). The SDK only allows Cmd values to be constructed inline in
//     update's return path in this file (NS1017), so `update` below is the
//     one place that turns an Op into a Cmd. Add an Op arm in update.ts and
//     its Cmd case here; never build Cmds anywhere else.
//   * View bindings are exported single-model helpers declared here (markup
//     can only bind helpers declared in core.ts) delegating to viewmodel.ts.
// Read app/src/contract.md before changing anything here.

import { Cmd, Sub, asciiBytes, utf8Bytes, windowDescriptor } from "@native-sdk/core";
import {
  type FileDropEvent,
  type KeyEvent,
  type ScrollState,
  type StatusItemState,
  type WindowDescriptor,
} from "@native-sdk/core/events";
import { type TextInputEvent } from "@native-sdk/core/events";
import { type EditState } from "./textedit.ts";
import { systemDetectProviders, systemExportConfig, systemImportConfig, systemLocate, systemScanApps } from "@native-sdk/services";
import type {
  AiProviderChoice,
  AppEntry,
  AppList,
  ConfigDoc,
  ExportConfigResult,
  Hotkey,
  HotkeyAction,
  LocateResult,
  ProviderInfo,
  ProviderList,
  Settings,
  Snippet,
} from "./shared.ts";
import type {
  AiState,
  CaptureTarget,
  Clip,
  ClipFile,
  ClipFilter,
  Confirm,
  Thumb,
  Env,
  Frecency,
  LoadState,
  ManageTab,
  QueueItem,
  Screen,
  SnippetDraft,
  WatchState,
} from "./model.ts";
import { initialState, step } from "./update.ts";
import * as vm from "./viewmodel.ts";
import { keyIndexForName, MOD_CMD, MOD_CONTROL, MOD_OPTION, MOD_SHIFT } from "./hotkeys.ts";

// ---------------------------------------------------------------- Model

export interface Model {
  // Launcher panel (window label "main").
  readonly panelVisible: boolean;
  readonly screen: Screen;
  /// The search field's editor state; the MODEL is the source of truth.
  readonly query: EditState;
  /// Bumped to remount the search field (key="{searchEpoch}") when the
  /// runtime's optimistic caret/text echo must be discarded — see
  /// contract.md "Key handling".
  readonly searchEpoch: number;
  /// Index into results(model) (or into the active screen's list).
  readonly selected: number;
  readonly resultsScroll: number;
  readonly resultsViewport: number;
  readonly actionsOpen: boolean;
  readonly actionSelected: number;

  // Environment and helper process.
  readonly env: Env;
  readonly watchState: WatchState;
  /// Last frontmost app that is not Bettercast (paste target).
  readonly frontPid: number;
  readonly frontName: Uint8Array;
  readonly axTrusted: boolean;
  /// Wall clock (ms) from the last tick / helper event; 0 before the first.
  readonly nowMs: number;

  // User data (persisted).
  readonly apps: readonly AppEntry[];
  readonly snippets: readonly Snippet[];
  readonly clips: readonly Clip[];
  readonly queue: readonly QueueItem[];
  readonly frecency: readonly Frecency[];
  readonly settings: Settings;
  readonly hotkeys: readonly Hotkey[];
  /// Next id for snippets and clips (one counter).
  readonly nextId: number;

  // AI.
  readonly providers: readonly ProviderInfo[];
  readonly ai: AiState;

  // Manage window (label "manage", src/windows/manage.native).
  readonly manageOpen: boolean;
  readonly manageTab: ManageTab;
  readonly draft: SnippetDraft | null;
  readonly capturing: CaptureTarget;
  /// Conflict/validation message for the Shortcuts tab.
  readonly hotkeyNotice: Uint8Array;

  /// One-line transient status shown in the panel footer / Manage.
  readonly notice: Uint8Array;

  // View state (views agent; contract.md "Views").
  readonly clipFilter: ClipFilter;
  /// Confirm-delete dialog (panel or Manage, whichever is in front).
  readonly confirm: Confirm;
  /// Clipboard thumbnails in the runtime image registry (id = clip id).
  readonly thumbs: readonly Thumb[];
  readonly thumbSeq: number;

  // Core bookkeeping (core-logic agent; contract.md "Core flows").
  /// Clip payload files waiting for Cmd.deleteFile (one in flight).
  readonly deleteQueue: readonly ClipFile[];
  readonly deleting: boolean;
  /// Boot chain: scan apps -> providers -> login status -> watch.
  readonly appsState: LoadState;
  /// Consecutive unexpected watch exits (respawned up to 5 times).
  readonly watchRetries: number;
}

// ---------------------------------------------------------------- Msg

/// Cmd.imageLoad result states (exactly the SDK's fifteen ImageState
/// members; a local alias because the imported one does not cross the
/// contract sidecar, NS1063).
export type ThumbLoadState = "loaded" | "rejected" | "not_found" | "io_failed" | "connect_failed" | "tls_failed" | "protocol_failed" | "timed_out" | "http_status" | "cancelled" | "too_large" | "unsupported" | "decode_failed" | "registry_full" | "alloc_failed";

/// Paths of files dropped on a window (dropMsg), as one named record
/// (array payloads need a named record, NS1063).
export type DroppedFiles = { readonly paths: readonly Uint8Array[] };

export type Msg =
  // Boot and environment.
  | { readonly kind: "env_app_data_dir"; readonly value: Uint8Array }
  | { readonly kind: "env_data_dir"; readonly value: Uint8Array }
  | { readonly kind: "env_helper"; readonly value: Uint8Array }
  | { readonly kind: "env_test_mode"; readonly value: Uint8Array }
  | { readonly kind: "env_ai_fake"; readonly value: Uint8Array }
  | { readonly kind: "restored" }
  | { readonly kind: "fresh_boot" }
  | { readonly kind: "restore_failed"; readonly reason: Uint8Array }
  | { readonly kind: "boot_go"; readonly bootAt: number }
  | { readonly kind: "located"; readonly result: LocateResult }
  | { readonly kind: "locate_failed"; readonly reason: Uint8Array }
  | { readonly kind: "apps_scanned"; readonly result: AppList }
  | { readonly kind: "apps_scan_failed"; readonly reason: Uint8Array }
  | { readonly kind: "providers_detected"; readonly result: ProviderList }
  | { readonly kind: "providers_failed"; readonly reason: Uint8Array }
  | { readonly kind: "tick"; readonly tickAt: number }
  | { readonly kind: "test_seed" }
  | { readonly kind: "quit" }
  // Launcher panel and keyboard navigation.
  | { readonly kind: "panel_toggle" }
  | { readonly kind: "panel_show" }
  | { readonly kind: "panel_hide" }
  | { readonly kind: "query_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "select_next" }
  | { readonly kind: "select_prev" }
  | { readonly kind: "select_row"; readonly selectIndex: number }
  | { readonly kind: "row_run"; readonly runIndex: number }
  | { readonly kind: "run_selected" }
  | { readonly kind: "escape" }
  | { readonly kind: "go_back" }
  | { readonly kind: "open_screen"; readonly screen: Screen }
  | { readonly kind: "actions_toggle" }
  | { readonly kind: "actions_close" }
  | { readonly kind: "action_run"; readonly actionIndex: number }
  | { readonly kind: "results_scrolled"; readonly scroll: ScrollState }
  | { readonly kind: "key_down"; readonly keyIndex: number; readonly mods: number }
  // Helper watch process (hotkeys, frontmost app, pasteboard).
  | { readonly kind: "watch_line"; readonly line: Uint8Array }
  | { readonly kind: "watch_exit"; readonly watchCode: number }
  | { readonly kind: "watch_err"; readonly reason: Uint8Array }
  // One-shot helper commands (collect spawns: exit code + stdout).
  | { readonly kind: "paste_written" }
  | { readonly kind: "paste_write_failed"; readonly reason: Uint8Array }
  | { readonly kind: "paste_done"; readonly pasteCode: number; readonly out: Uint8Array }
  | { readonly kind: "paste_failed"; readonly reason: Uint8Array }
  | { readonly kind: "copy_done"; readonly copyCode: number; readonly out: Uint8Array }
  | { readonly kind: "copy_failed"; readonly reason: Uint8Array }
  | { readonly kind: "open_done"; readonly openCode: number; readonly out: Uint8Array }
  | { readonly kind: "open_failed"; readonly reason: Uint8Array }
  | { readonly kind: "ax_done"; readonly axCode: number; readonly out: Uint8Array }
  | { readonly kind: "ax_failed"; readonly reason: Uint8Array }
  | { readonly kind: "ax_request" }
  // Clipboard history and sequential paste.
  | { readonly kind: "clip_paste"; readonly pasteClipId: number }
  | { readonly kind: "clip_copy"; readonly copyClipId: number }
  | { readonly kind: "clip_delete"; readonly deleteClipId: number }
  | { readonly kind: "clip_pin"; readonly pinClipId: number }
  | { readonly kind: "clips_clear" }
  | { readonly kind: "clip_deleted" }
  | { readonly kind: "clip_delete_failed"; readonly reason: Uint8Array }
  | { readonly kind: "queue_add"; readonly queueClipId: number }
  | { readonly kind: "queue_remove"; readonly unqueueClipId: number }
  | { readonly kind: "queue_clear" }
  | { readonly kind: "paste_next" }
  | { readonly kind: "set_retention_days"; readonly retentionDays: number }
  | { readonly kind: "set_max_items"; readonly maxItems: number }
  | { readonly kind: "toggle_record_images" }
  // Snippets.
  | { readonly kind: "snippet_new" }
  | { readonly kind: "snippet_edit"; readonly editSnippetId: number }
  | { readonly kind: "snippet_delete"; readonly deleteSnippetId: number }
  | { readonly kind: "snippet_paste"; readonly pasteSnippetId: number }
  | { readonly kind: "draft_name"; readonly edit: TextInputEvent }
  | { readonly kind: "draft_keyword"; readonly edit: TextInputEvent }
  | { readonly kind: "draft_body"; readonly edit: TextInputEvent }
  | { readonly kind: "draft_save" }
  | { readonly kind: "draft_cancel" }
  // Hotkeys (Manage > Shortcuts).
  | { readonly kind: "hotkey_capture"; readonly action: HotkeyAction }
  | { readonly kind: "hotkey_capture_cancel" }
  | { readonly kind: "hotkey_toggle"; readonly action: HotkeyAction }
  | { readonly kind: "hotkey_reset"; readonly action: HotkeyAction }
  // Quick AI.
  | { readonly kind: "ai_ask" }
  | { readonly kind: "ai_request_written" }
  | { readonly kind: "ai_write_failed"; readonly reason: Uint8Array }
  | { readonly kind: "ai_key_loaded"; readonly secret: Uint8Array }
  | { readonly kind: "ai_key_missing"; readonly reason: Uint8Array }
  | { readonly kind: "ai_line"; readonly line: Uint8Array }
  | { readonly kind: "ai_exit"; readonly aiCode: number }
  | { readonly kind: "ai_err"; readonly reason: Uint8Array }
  | { readonly kind: "ai_cancel" }
  | { readonly kind: "ai_copy" }
  | { readonly kind: "ai_paste" }
  | { readonly kind: "ai_attach_clip"; readonly attachClipId: number }
  | { readonly kind: "ai_detach"; readonly detachIndex: number }
  | { readonly kind: "ai_set_provider"; readonly provider: AiProviderChoice }
  | { readonly kind: "api_key_from_clipboard" }
  | { readonly kind: "api_key_read"; readonly text: Uint8Array }
  | { readonly kind: "api_key_read_failed"; readonly reason: Uint8Array }
  | { readonly kind: "api_key_saved" }
  | { readonly kind: "api_key_failed"; readonly reason: Uint8Array }
  | { readonly kind: "api_key_delete" }
  // Manage window.
  | { readonly kind: "manage_open" }
  | { readonly kind: "manage_closed" }
  | { readonly kind: "manage_tab"; readonly tab: ManageTab }
  | { readonly kind: "login_toggle" }
  | { readonly kind: "login_status"; readonly state: Uint8Array }
  | { readonly kind: "login_failed"; readonly reason: Uint8Array }
  | { readonly kind: "config_export" }
  | { readonly kind: "config_exported"; readonly result: ExportConfigResult }
  | { readonly kind: "config_import" }
  | { readonly kind: "config_imported"; readonly result: ConfigDoc }
  | { readonly kind: "config_failed"; readonly reason: Uint8Array }
  | { readonly kind: "notice_clear" }
  // View-driven (views agent; contract.md "Views").
  | { readonly kind: "clip_filter"; readonly filter: ClipFilter }
  | { readonly kind: "confirm_clip_delete"; readonly confirmClipId: number }
  | { readonly kind: "confirm_snippet_delete"; readonly confirmSnippetId: number }
  | { readonly kind: "confirm_clear_history" }
  | { readonly kind: "confirm_accept" }
  | { readonly kind: "confirm_cancel" }
  | { readonly kind: "thumb_loaded"; readonly id: number; readonly state: ThumbLoadState; readonly width: number; readonly height: number; readonly status: number }
  | { readonly kind: "ai_new" }
  | { readonly kind: "files_dropped"; readonly dropped: DroppedFiles }
  | { readonly kind: "manage_show"; readonly tab: ManageTab }
  // Core flows (core-logic agent).
  | { readonly kind: "watch_retry"; readonly retryAt: number }
  | { readonly kind: "api_key_deleted" }
  | { readonly kind: "ai_attach_latest" };

// Msgs and fields nothing in markup binds or dispatches.
export const viewUnbound = [
  "env_app_data_dir", "env_data_dir", "env_helper", "env_test_mode", "env_ai_fake",
  "restored", "fresh_boot", "restore_failed", "boot_go",
  "located", "locate_failed", "apps_scanned", "apps_scan_failed",
  "providers_detected", "providers_failed", "tick", "test_seed", "quit",
  "panel_toggle", "panel_show", "panel_hide", "select_next", "select_prev",
  "escape", "key_down",
  "watch_line", "watch_exit", "watch_err",
  "paste_written", "paste_write_failed", "paste_done", "paste_failed",
  "copy_done", "copy_failed", "open_done", "open_failed", "ax_done", "ax_failed",
  "clip_deleted", "clip_delete_failed", "paste_next",
  "ai_request_written", "ai_write_failed", "ai_key_loaded", "ai_key_missing",
  "ai_line", "ai_exit", "ai_err",
  "api_key_read", "api_key_read_failed", "api_key_saved", "api_key_failed",
  "manage_closed", "login_status", "login_failed",
  "config_exported", "config_imported", "config_failed",
  "query", "resultsViewport", "env", "watchState", "frontPid", "frontName", "nowMs",
  "apps", "snippets", "clips", "queue", "frecency", "settings", "hotkeys", "nextId",
  "providers", "ai", "draft", "capturing", "panelVisible", "screen", "selected",
  "actionSelected", "manageOpen", "manageTab", "hotkeyNotice", "axTrusted",
  // Views agent: state and Msgs reached through derived helpers, the Cmd+K
  // actions (update.ts runAction), host channels, or effects.
  "resultsScroll", "clipFilter", "confirm", "thumbs", "thumbSeq",
  "select_row", "open_screen", "clip_paste", "clip_copy", "clip_delete", "clip_pin", "clips_clear",
  "queue_add", "queue_remove", "snippet_delete", "snippet_paste", "hotkey_capture_cancel",
  "ai_ask", "ai_paste", "confirm_clip_delete", "thumb_loaded", "files_dropped", "manage_show",
  // Core-logic agent: boot/delete/watch bookkeeping.
  "deleteQueue", "deleting", "appsState", "watchRetries", "watch_retry", "api_key_deleted",
] as const;

export const envMsgs = [
  { env: "NATIVE_SDK_APP_DATA_DIR", msg: "env_app_data_dir" },
  { env: "BETTERCAST_DATA_DIR", msg: "env_data_dir" },
  { env: "BETTERCAST_HELPER", msg: "env_helper" },
  { env: "BETTERCAST_TEST_MODE", msg: "env_test_mode" },
  { env: "BETTERCAST_AI_FAKE", msg: "env_ai_fake" },
] as const;

export function initialModel(): Model {
  return initialState();
}

// ---------------------------------------------------------------- update

export function update(model: Model, msg: Msg): Model | [Model, Cmd<Msg>] {
  const s = step(model, msg);
  const next = s.model;
  const op = s.op;
  // Every case batches the Step's persist flag and window/dock effects
  // with its Op (Cmds must be built inline here, NS1017).
  switch (op.kind) {
    case "none":
      if (!s.persist && s.window === "none") return next;
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
      ])];
    case "boot_delay":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.delay("boot", 1, "boot_go"),
      ])];
    case "locate":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        systemLocate(op.req, { key: "locate", ok: "located", err: "locate_failed" }),
      ])];
    case "scan_apps":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        systemScanApps(op.req, { key: "scan_apps", ok: "apps_scanned", err: "apps_scan_failed" }),
      ])];
    case "detect_providers":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        systemDetectProviders(op.req, { key: "providers", ok: "providers_detected", err: "providers_failed" }),
      ])];
    case "watch_start":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.spawn(
          [op.helper, asciiBytes("watch"), asciiBytes("--hotkeys"), op.hotkeys, asciiBytes("--data-dir"), op.dataDir, asciiBytes("--images"), op.images],
          { key: "watch", line: "watch_line", exit: "watch_exit", err: "watch_err" },
        ),
      ])];
    case "watch_stop":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.cancel("watch"),
      ])];
    case "watch_retry":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.delay("watch_retry", 3000, "watch_retry"),
      ])];
    case "write_paste":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.writeFile(op.path, op.bytes, { key: "paste_write", ok: "paste_written", err: "paste_write_failed" }),
      ])];
    case "paste":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.spawn(
          [op.helper, asciiBytes("paste"), asciiBytes("--pid"), op.pid, asciiBytes("--file"), op.path, asciiBytes("--kind"), op.clipKind],
          { key: "paste", collect: true, exit: "paste_done", err: "paste_failed" },
        ),
      ])];
    case "copy":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.spawn(
          [op.helper, asciiBytes("copy"), asciiBytes("--file"), op.path, asciiBytes("--kind"), op.clipKind],
          { key: "copy", collect: true, exit: "copy_done", err: "copy_failed" },
        ),
      ])];
    case "copy_text":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.clipboardWrite(op.text),
      ])];
    case "open_path":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.spawn(
          [op.helper, asciiBytes("open"), asciiBytes("--path"), op.path],
          { key: "open", collect: true, exit: "open_done", err: "open_failed" },
        ),
      ])];
    case "ax_status":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.spawn([op.helper, asciiBytes("ax-status")], { key: "ax", collect: true, exit: "ax_done", err: "ax_failed" }),
      ])];
    case "ax_prompt":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.spawn([op.helper, asciiBytes("ax-prompt")], { key: "ax", collect: true, exit: "ax_done", err: "ax_failed" }),
      ])];
    case "delete_file":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.deleteFile(op.path, { ok: "clip_deleted", err: "clip_delete_failed" }),
      ])];
    case "write_ai_request":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.writeFile(op.path, op.bytes, { key: "ai_write", ok: "ai_request_written", err: "ai_write_failed" }),
      ])];
    case "ai_key_get":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.credentials.get("ai-api-key", { key: "cred", ok: "ai_key_loaded", err: "ai_key_missing" }),
      ])];
    case "ai_start":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        op.fake
          ? Cmd.spawn(
              [op.helper, asciiBytes("ai"), asciiBytes("--request"), op.requestPath, asciiBytes("--provider"), asciiBytes("fake")],
              { key: "ai", stdin: op.secret, line: "ai_line", exit: "ai_exit", err: "ai_err" },
            )
          : Cmd.spawn(
              [op.helper, asciiBytes("ai"), asciiBytes("--request"), op.requestPath],
              { key: "ai", stdin: op.secret, line: "ai_line", exit: "ai_exit", err: "ai_err" },
            ),
      ])];
    case "ai_cancel":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.cancel("ai"),
      ])];
    case "api_key_read":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.clipboardRead({ key: "api_key_read", ok: "api_key_read", err: "api_key_read_failed" }),
      ])];
    case "api_key_set":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.credentials.set("ai-api-key", op.secret, { key: "cred", ok: "api_key_saved", err: "api_key_failed" }),
      ])];
    case "api_key_delete":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.credentials.delete("ai-api-key", { key: "cred", ok: "api_key_deleted", err: "api_key_failed" }),
      ])];
    case "login_status":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.launchAtLoginStatus({ key: "login", ok: "login_status", err: "login_failed" }),
      ])];
    case "login_set":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        Cmd.setLaunchAtLogin(op.enabled, { key: "login", ok: "login_status", err: "login_failed" }),
      ])];
    case "export_config":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        systemExportConfig(op.req, { key: "config", ok: "config_exported", err: "config_failed" }),
      ])];
    case "import_config":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        systemImportConfig(op.req, { key: "config", ok: "config_imported", err: "config_failed" }),
      ])];
    case "quit":
      return [next, Cmd.batch([Cmd.persist(), Cmd.quitApp()])];
    case "thumb_load":
      return [next, Cmd.batch([
        s.persist ? Cmd.persist() : Cmd.none,
        s.window === "show_panel" ? Cmd.showWindow("main") : s.window === "hide_panel" || s.window === "open_manage" ? Cmd.hideWindow("main") : s.window === "show_manage" ? Cmd.showWindow("manage") : Cmd.none,
        s.window === "open_manage" ? Cmd.setDockPresence(true) : s.window === "manage_closed" ? Cmd.setDockPresence(false) : Cmd.none,
        op.evictId > 0 ? Cmd.imageUnregister(op.evictId) : Cmd.none,
        Cmd.imageLoad(op.imageId, { path: op.path }, { event: "thumb_loaded" }),
      ])];
  }
}

// ---------------------------------------------------------------- subscriptions

export function subscriptions(model: Model): Sub<Msg> {
  // Minute clock: retention pruning and relative times. Off until boot.
  if (!model.env.located) return Sub.none;
  return Sub.timer("clock", 60000, "tick");
}

// ---------------------------------------------------------------- host channels

export function commandMsg(name: string): Msg | null {
  switch (name) {
    case "panel.toggle": return { kind: "panel_toggle" };
    case "panel.show": return { kind: "panel_show" };
    case "panel.hide": return { kind: "panel_hide" };
    case "actions.toggle": return { kind: "actions_toggle" };
    case "manage.open": return { kind: "manage_open" };
    case "manage.snippets": return { kind: "manage_show", tab: "snippets" };
    case "manage.settings": return { kind: "manage_show", tab: "general" };
    case "manage.closed": return { kind: "manage_closed" };
    case "clipboard.open": return { kind: "open_screen", screen: "clipboard" };
    case "app.quit": return { kind: "quit" };
    case "test.seed": return { kind: "test_seed" };
    default: return null;
  }
}

/// App-level key FALLBACK: only keys no focused widget claimed arrive here
/// (a focused search field claims every key). See contract.md.
export function keyMsg(key: KeyEvent): Msg | null {
  const plain = !key.shift && !key.control && !key.alt && !key.super;
  if (plain && key.key === "arrowdown") return { kind: "select_next" };
  if (plain && key.key === "arrowup") return { kind: "select_prev" };
  if (plain && key.key === "escape") return { kind: "escape" };
  if (plain && (key.key === "enter" || key.key === "return")) return { kind: "run_selected" };
  if (key.super && !key.shift && !key.control && !key.alt && key.key === "k") return { kind: "actions_toggle" };
  const index = keyIndexForName(key.key);
  if (index < 0) return null;
  let mods = 0;
  if (key.super) mods = mods | MOD_CMD;
  if (key.shift) mods = mods | MOD_SHIFT;
  if (key.alt) mods = mods | MOD_OPTION;
  if (key.control) mods = mods | MOD_CONTROL;
  return { kind: "key_down", keyIndex: index | 0, mods: mods | 0 };
}

/// Files dropped on the launcher panel become Ask AI attachments.
export function dropMsg(drop: FileDropEvent): Msg | null {
  const paths: Uint8Array[] = [];
  for (const p of drop.paths) {
    if (paths.length < 16) paths.push(p);
  }
  if (paths.length === 0) return null;
  return { kind: "files_dropped", dropped: { paths: paths } };
}

export function statusItem(model: Model): StatusItemState {
  const none = { primary: false, command: false, control: false, option: false, shift: false };
  return {
    iconPath: asciiBytes("assets/menu-bar.svg"),
    tooltip: utf8Bytes("Bettercast"),
    activationCommand: asciiBytes(""),
    alternateActivationCommand: asciiBytes(""),
    openCommand: asciiBytes(""),
    presentation: { title: asciiBytes(""), width: 0, tone: "normal", iconOpacity: 1, monospaced: false },
    items: [
      { id: 1, label: utf8Bytes("Open Bettercast"), command: asciiBytes("panel.show"), separator: false, enabled: true, detail: asciiBytes(""), role: "command", key: asciiBytes(""), modifiers: none },
      { id: 2, label: utf8Bytes("Clipboard History"), command: asciiBytes("clipboard.open"), separator: false, enabled: true, detail: asciiBytes(""), role: "command", key: asciiBytes(""), modifiers: none },
      { id: 3, label: utf8Bytes("Manage Snippets…"), command: asciiBytes("manage.snippets"), separator: false, enabled: true, detail: asciiBytes(""), role: "command", key: asciiBytes(""), modifiers: none },
      { id: 5, label: utf8Bytes("Settings…"), command: asciiBytes("manage.settings"), separator: false, enabled: true, detail: asciiBytes(""), role: "command", key: asciiBytes(","), modifiers: { primary: true, command: false, control: false, option: false, shift: false } },
      { id: 0, label: asciiBytes(""), command: asciiBytes(""), separator: true, enabled: false, detail: asciiBytes(""), role: "command", key: asciiBytes(""), modifiers: none },
      { id: 4, label: utf8Bytes("Quit Bettercast"), command: asciiBytes("app.quit"), separator: false, enabled: true, detail: asciiBytes(""), role: "command", key: asciiBytes("q"), modifiers: { primary: true, command: false, control: false, option: false, shift: false } },
    ],
  };
}

export function windows(model: Model): readonly WindowDescriptor[] {
  if (!model.manageOpen) return [];
  return [windowDescriptor({
    label: asciiBytes("manage"),
    canvasLabel: asciiBytes("manage-canvas"),
    title: utf8Bytes("Bettercast Settings"),
    width: 760,
    height: 540,
    minWidth: 640,
    minHeight: 420,
    resizable: true,
    restorePolicy: "center_on_primary",
    allowsFullscreen: false,
    closePolicy: "quit",
    onCloseCommand: asciiBytes("manage.closed"),
  })];
}

// ---------------------------------------------------------------- view bindings
// Owner: views agent. Markup binds only helpers DECLARED here; they
// delegate to viewmodel.ts.
// Launcher panel (src/app.native).

export function queryText(model: Model): Uint8Array { return vm.vmQueryText(model); }
export function searchPlaceholder(model: Model): Uint8Array { return vm.vmSearchPlaceholder(model); }
export function searchLabel(model: Model): Uint8Array { return vm.vmSearchLabel(model); }
export function results(model: Model): readonly vm.ResultRow[] { return vm.vmResults(model); }
export function hasResults(model: Model): boolean { return vm.vmResults(model).length > 0; }
export function resultsOffset(model: Model): number { return vm.vmResultsOffset(model); }
export function emptyText(model: Model): Uint8Array { return vm.vmEmptyText(model); }
export function actions(model: Model): readonly vm.ActionRow[] { return vm.vmActions(model); }
export function footerHint(model: Model): Uint8Array { return vm.vmFooterHint(model); }
export function primaryLabel(model: Model): Uint8Array { return vm.vmPrimaryLabel(model); }
export function hasPrimary(model: Model): boolean { return vm.vmPrimaryLabel(model).length > 0; }
export function showBack(model: Model): boolean { return model.screen !== "root"; }
export function isAiScreen(model: Model): boolean { return model.screen === "ai"; }
export function isClipboardScreen(model: Model): boolean { return model.screen === "clipboard"; }
export function isQueueScreen(model: Model): boolean { return model.screen === "queue"; }
export function clipFilters(model: Model): readonly vm.FilterChip[] { return vm.vmClipFilters(model); }
export function queueSummary(model: Model): Uint8Array { return vm.vmQueueSummary(model); }
export function hasQueue(model: Model): boolean { return model.queue.length > 0; }
// Ask AI screen.
export function aiQuestion(model: Model): Uint8Array { return model.ai.prompt; }
export function hasAiQuestion(model: Model): boolean { return model.ai.prompt.length > 0 && model.ai.status !== "idle"; }
export function aiAnswer(model: Model): Uint8Array { return vm.vmAiAnswer(model); }
export function hasAiAnswer(model: Model): boolean { return model.ai.answer.length > 0; }
export function aiRunning(model: Model): boolean { return model.ai.status === "running"; }
export function aiWaiting(model: Model): boolean { return model.ai.status === "running" && model.ai.answer.length === 0; }
export function aiProviderChips(model: Model): readonly vm.ProviderChip[] { return vm.vmAiProviderChips(model); }
export function hasAiProviders(model: Model): boolean { return vm.vmAiProviderChips(model).length > 0; }
export function aiNoProviderText(model: Model): Uint8Array { return vm.vmAiNoProviderText(model); }
export function aiAttachments(model: Model): readonly vm.AttachmentRow[] { return vm.vmAiAttachments(model); }
export function hasAttachments(model: Model): boolean { return model.ai.attachments.length > 0; }
export function aiIdle(model: Model): boolean { return model.ai.status === "idle" && model.ai.answer.length === 0 && model.ai.prompt.length === 0; }
export function showAiTools(model: Model): boolean { return model.screen === "ai" && model.ai.answer.length > 0 && model.ai.status !== "running"; }
export function latestImageClipId(model: Model): number { return vm.vmLatestImageClipId(model); }
export function hasClips(model: Model): boolean { return model.clips.length > 0; }
export function attachLatestLabel(model: Model): Uint8Array { return model.clips.length > 0 && model.clips[0].kind === "image" ? utf8Bytes("Attach Clipboard Image") : utf8Bytes("Attach Clipboard Text"); }
export function hasOlderImage(model: Model): boolean { return model.clips.length > 0 && model.clips[0].kind !== "image" && vm.vmLatestImageClipId(model) > 0; }
// Confirm-delete dialog (shown in whichever window is in front).
export function confirmInPanel(model: Model): boolean { return model.confirm.kind !== "none" && model.panelVisible; }
export function confirmInManage(model: Model): boolean { return model.confirm.kind !== "none" && !model.panelVisible; }
export function confirmTitle(model: Model): Uint8Array { return vm.vmConfirmTitle(model); }
export function confirmBody(model: Model): Uint8Array { return vm.vmConfirmBody(model); }
export function confirmButton(model: Model): Uint8Array { return vm.vmConfirmButton(model); }
export function hasNotice(model: Model): boolean { return model.notice.length > 0; }

// Manage window (src/windows/manage.native).
export function manageTabs(model: Model): readonly vm.TabRow[] { return vm.vmManageTabs(model); }
export function hotkeyRows(model: Model): readonly vm.HotkeyRow[] { return vm.vmHotkeyRows(model); }
export function hasHotkeyNotice(model: Model): boolean { return model.hotkeyNotice.length > 0; }
export function snippetRows(model: Model): readonly vm.SnippetRow[] { return vm.vmSnippetRows(model); }
export function hasSnippets(model: Model): boolean { return model.snippets.length > 0; }
export function hasDraft(model: Model): boolean { return model.draft !== null; }
export function draftIsNew(model: Model): boolean { return model.draft !== null && model.draft.id === 0; }
export function draftIsSaved(model: Model): boolean { return model.draft !== null && model.draft.id !== 0; }
export function draftId(model: Model): number { return model.draft === null ? 0 : model.draft.id; }
export function draftTitle(model: Model): Uint8Array { return vm.vmDraftTitle(model); }
export function draftError(model: Model): Uint8Array { return vm.vmDraftError(model); }
export function hasDraftError(model: Model): boolean { return vm.vmDraftError(model).length > 0; }
export function draftName(model: Model): Uint8Array { return model.draft === null ? asciiBytes("") : model.draft.name.text; }
export function draftKeyword(model: Model): Uint8Array { return model.draft === null ? asciiBytes("") : model.draft.keyword.text; }
export function draftBody(model: Model): Uint8Array { return model.draft === null ? asciiBytes("") : model.draft.body.text; }
export function retentionChoices(model: Model): readonly vm.ChoiceRow[] { return vm.vmRetentionChoices(model); }
export function maxItemChoices(model: Model): readonly vm.ChoiceRow[] { return vm.vmMaxItemChoices(model); }
export function providerRows(model: Model): readonly vm.ProviderRow[] { return vm.vmProviderRows(model); }
export function apiKeyStatus(model: Model): Uint8Array { return vm.vmApiKeyStatus(model); }
export function apiKeySet(model: Model): boolean { return model.ai.apiKeySet; }
export function axStatusLine(model: Model): Uint8Array { return vm.vmAxStatusLine(model); }
export function dataDirLine(model: Model): Uint8Array { return model.env.dataDir; }
export function versionLine(model: Model): Uint8Array { return vm.vmVersionLine(model); }
export function tabIsGeneral(model: Model): boolean { return model.manageTab === "general" || model.manageTab === "about"; }
export function tabIsShortcuts(model: Model): boolean { return model.manageTab === "shortcuts"; }
export function tabIsSnippets(model: Model): boolean { return model.manageTab === "snippets"; }
export function tabIsClipboard(model: Model): boolean { return model.manageTab === "clipboard"; }
export function tabIsAi(model: Model): boolean { return model.manageTab === "ai"; }
export function launchAtLogin(model: Model): boolean { return model.settings.launchAtLogin; }
export function recordImages(model: Model): boolean { return model.settings.recordImages; }
export function retentionLine(model: Model): Uint8Array { return vm.vmRetentionLine(model); }
