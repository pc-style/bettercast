// Records shared by the core and src/services (the service boundary).
// Core-class file: subset TypeScript only. Services import these types;
// the core imports them too, so each shape is declared exactly once.
//
// Persisted user data (snippets, hotkeys, settings) is declared here
// because exportConfig/importConfig carry it across the service boundary.

/// Where the helper binary and the data dir live. `helperOverride` and
/// `dataDir` come from envMsgs (BETTERCAST_HELPER, BETTERCAST_DATA_DIR,
/// NATIVE_SDK_APP_DATA_DIR); empty means "not set".
export interface LocateRequest {
  readonly helperOverride: Uint8Array;
  readonly dataDir: Uint8Array;
}

export interface LocateResult {
  /// Absolute path of bettercast-helper, empty when none was found.
  readonly helperPath: Uint8Array;
  readonly helperFound: boolean;
  /// Absolute data dir; <dataDir>/clips and <dataDir>/tmp exist after locate.
  readonly dataDir: Uint8Array;
  readonly dataDirReady: boolean;
}

export interface ScanAppsRequest {
  /// Newline-separated extra directories to scan (may be empty).
  /// Default roots: /Applications, /Applications/Utilities,
  /// /System/Applications, /System/Applications/Utilities, ~/Applications.
  readonly extraDirs: Uint8Array;
}

export interface AppEntry {
  /// Display name (bundle folder name without ".app").
  readonly name: Uint8Array;
  /// Absolute bundle path, e.g. /Applications/Safari.app
  readonly path: Uint8Array;
}

export interface AppList {
  readonly apps: readonly AppEntry[];
}

export type ProviderId = "claude" | "codex" | "gemini" | "opencode";

export interface DetectProvidersRequest {
  /// Newline-separated extra bin dirs to search besides PATH and the
  /// usual install dirs (~/.local/bin, ~/.bun/bin, /opt/homebrew/bin,
  /// /usr/local/bin, ~/.npm-global/bin, ~/.volta/bin).
  readonly extraDirs: Uint8Array;
}

export interface ProviderInfo {
  readonly id: ProviderId;
  /// Absolute path of the CLI binary.
  readonly binPath: Uint8Array;
}

export interface ProviderList {
  readonly providers: readonly ProviderInfo[];
}

export interface Snippet {
  readonly id: number;
  readonly name: Uint8Array;
  /// Optional short keyword typed in the launcher to find it fast.
  readonly keyword: Uint8Array;
  readonly body: Uint8Array;
  readonly updatedMs: number;
}

export type HotkeyAction = "launcher" | "clipboard" | "paste_next" | "ask_ai";

export interface Hotkey {
  readonly action: HotkeyAction;
  /// Carbon virtual key code (kVK_*), e.g. 49 = Space.
  readonly keyCode: number;
  /// Bitmask of MOD_* in hotkeys.ts (cmd=1, shift=2, option=4, control=8).
  readonly mods: number;
  readonly enabled: boolean;
}

export type AiProviderChoice = "claude" | "codex" | "gemini" | "opencode" | "api";

export interface Settings {
  /// Clipboard history retention; 0 disables the age limit.
  readonly retentionDays: number;
  /// Clipboard history item cap.
  readonly maxItems: number;
  readonly recordImages: boolean;
  /// Mirrors Cmd.launchAtLoginStatus; OFF unless the user toggles it.
  readonly launchAtLogin: boolean;
  readonly aiProvider: AiProviderChoice;
  /// Model name for the API provider (empty = provider default).
  readonly aiModel: Uint8Array;
}

export interface ConfigDoc {
  readonly snippets: readonly Snippet[];
  readonly hotkeys: readonly Hotkey[];
  readonly settings: Settings;
}

export interface ExportConfigRequest {
  readonly path: Uint8Array;
  readonly config: ConfigDoc;
}

export interface ExportConfigResult {
  readonly path: Uint8Array;
  readonly bytes: number;
}

export interface ImportConfigRequest {
  readonly path: Uint8Array;
}
