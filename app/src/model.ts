// Component records of the Model and their initial values. The Model
// itself and the Msg union live in core.ts (the entry); everything they
// are built from lives here or in shared.ts (service boundary records).
//
// PERSISTENCE: Cmd.persist() snapshots the WHOLE Model. Any change to the
// Model tree (a field added/removed/retyped here, in shared.ts, or in
// core.ts) must bump `persist.version` in app.json (NS1068 warns until you
// do). Never store secrets (API keys) in the Model.

import { type EditState, editStateWith, emptyEditState } from "./textedit.ts";
import type { Settings, AiProviderChoice } from "./shared.ts";
import { EMPTY } from "./bytes.ts";

/// Launcher panel screens. "root" is the search list; the others are
/// pushed with Return on a command row and popped with Esc.
export type Screen = "root" | "clipboard" | "queue" | "ai";

export type ManageTab = "general" | "shortcuts" | "snippets" | "clipboard" | "ai" | "about";

export type WatchState = "off" | "starting" | "running" | "restarting";

/// BETTERCAST_TEST_MODE values:
///   unset -> "off"  normal app.
///   "1"   -> "dry"  local/dev safety mode: no watch process (no global
///                    hotkeys, no pasteboard polling, no frontmost tracking),
///                    no AX prompts, no scans of the real machine, and every
///                    OS-touching effect (paste, copy, open, clipboard write,
///                    keychain, login item) is recorded into Model.notice as
///                    "dry-run: ..." instead of being performed. test.seed on.
///   "e2e" -> "e2e"  hosted CI only: real helper (watch + one-shots) but the
///                    AX prompt stays off; test.seed on.
export type TestMode = "off" | "dry" | "e2e";

/// Launch environment, rebuilt on every boot from envMsgs + locate.
export interface Env {
  /// NATIVE_SDK_APP_DATA_DIR (always delivered by the runner).
  readonly appDataDir: Uint8Array;
  /// BETTERCAST_DATA_DIR override (tests); empty when unset.
  readonly dataDirOverride: Uint8Array;
  /// BETTERCAST_HELPER override (dev/CI); empty when unset.
  readonly helperOverride: Uint8Array;
  /// BETTERCAST_TEST_MODE: see TestMode.
  readonly testMode: TestMode;
  /// BETTERCAST_AI_FAKE=1 in e2e mode: Ask AI runs the helper's
  /// deterministic `fake` provider (CI only; ignored outside e2e).
  readonly aiFake: boolean;
  /// Resolved by system.locate.
  readonly dataDir: Uint8Array;
  readonly helperPath: Uint8Array;
  readonly located: boolean;
}

export type ClipKindTag = "text" | "image";

export interface Clip {
  /// Monotonic id (Model.nextId). Stable across dedupe bumps.
  readonly id: number;
  readonly kind: ClipKindTag;
  /// Hex sha256 of the payload; file at <dataDir>/clips/<sha>.txt|.png.
  readonly sha: Uint8Array;
  readonly size: number;
  readonly width: number;
  readonly height: number;
  /// First <= 240 bytes of text (single line for display is derived).
  readonly preview: Uint8Array;
  readonly sourceBundle: Uint8Array;
  readonly firstMs: number;
  readonly lastMs: number;
  readonly pinned: boolean;
}

export interface QueueItem {
  readonly clipId: number;
}

/// Launch counts for ranking ("app:/Applications/Safari.app",
/// "snippet:12", "cmd:clipboard").
export interface Frecency {
  readonly key: Uint8Array;
  readonly count: number;
  readonly lastMs: number;
}

/// idle: nothing asked yet (or cleared); running: streaming; done: the
/// provider finished; failed: `failure` says why; stopped: the user
/// pressed Esc/Stop mid-answer (the partial answer stays); no_provider:
/// the chosen CLI is not installed or no API key is stored (`failure` says
/// which and where to fix it).
export type AiStatus = "idle" | "running" | "done" | "failed" | "stopped" | "no_provider";

export interface Attachment {
  readonly path: Uint8Array;
  readonly isImage: boolean;
}

export interface AiState {
  readonly status: AiStatus;
  /// The question as sent (the launcher query at ask time).
  readonly prompt: Uint8Array;
  /// Streamed answer so far.
  readonly answer: Uint8Array;
  readonly failure: Uint8Array;
  /// Provider used for the current/last answer.
  readonly provider: AiProviderChoice;
  readonly attachments: readonly Attachment[];
  /// True when an API key is stored in the keychain (never the key).
  readonly apiKeySet: boolean;
  /// Earlier turns of this conversation ("Q: ...\n\nA: ...") sent as
  /// context with a follow-up; empty for a fresh question.
  readonly history: Uint8Array;
}

export interface SnippetDraft {
  /// 0 = new snippet.
  readonly id: number;
  readonly name: EditState;
  readonly keyword: EditState;
  readonly body: EditState;
  /// Validation message from the last Save (empty = none).
  readonly problem: Uint8Array;
}

/// A clip payload file waiting to be deleted (Model.deleteQueue).
/// Payload files of a clip: text = <sha>.txt, image = <sha>.png plus the
/// helper's 256 px <sha>.thumb.png.
export type ClipFileKind = "text" | "image" | "thumb";

export interface ClipFile {
  readonly kind: ClipFileKind;
  readonly sha: Uint8Array;
}

/// App scan / provider detection progress for this launch.
export type LoadState = "idle" | "loading" | "done";

export type CaptureTarget = "none" | "launcher" | "clipboard" | "paste_next" | "ask_ai";

export const QUERY_CAPACITY = 1024;
export const SNIPPET_BODY_CAPACITY = 65536;
export const MAX_RESULTS = 60;

export function emptyEdit(): EditState {
  return emptyEditState();
}

export function editWithText(text: Uint8Array): EditState {
  return editStateWith(text);
}

export function initialEnv(): Env {
  return {
    appDataDir: EMPTY,
    dataDirOverride: EMPTY,
    helperOverride: EMPTY,
    testMode: "off",
    aiFake: false,
    dataDir: EMPTY,
    helperPath: EMPTY,
    located: false,
  };
}

export function defaultSettings(): Settings {
  return {
    retentionDays: 30,
    maxItems: 500,
    recordImages: true,
    launchAtLogin: false,
    aiProvider: "claude",
    aiModel: EMPTY,
  };
}

export function initialAi(): AiState {
  return {
    status: "idle",
    prompt: EMPTY,
    answer: EMPTY,
    failure: EMPTY,
    provider: "claude",
    attachments: [],
    apiKeySet: false,
    history: EMPTY,
  };
}

// ---------------------------------------------------------------- view state
// Owner: views agent (app.native, windows/manage.native, viewmodel.ts).

/// Clipboard History filter chips (All / Text / Images).
export type ClipFilter = "all" | "text" | "image";

/// What the confirm-delete dialog is asking about. `none` = closed.
export type ConfirmKind = "none" | "clip" | "snippet" | "clear_history";

export interface Confirm {
  readonly kind: ConfirmKind;
  /// Clip or snippet id (0 for clear_history).
  readonly targetId: number;
}

/// Runtime image registry bookkeeping for clipboard thumbnails. The image
/// id IS the clip id. The registry has 16 slots and is empty after every
/// launch, so `thumbs` is reset by transientReset.
export type ThumbState = "loading" | "loaded" | "failed";

export interface Thumb {
  readonly clipId: number;
  readonly state: ThumbState;
  /// LRU stamp (Model.thumbSeq at last use).
  readonly usedAt: number;
}

/// Loaded thumbnails kept at once (leaves slots for other images).
export const MAX_THUMBS = 12;

export function noConfirm(): Confirm {
  return { kind: "none", targetId: 0 };
}
