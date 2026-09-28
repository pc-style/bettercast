// System service ops (ordinary TypeScript, compiled by scriptc; reached
// from the core through the generated @native-sdk/services clients:
// systemLocate, systemScanApps, systemDetectProviders, systemExportConfig,
// systemImportConfig). Only filesystem work lives here — anything that
// needs AppKit/Carbon/Accessibility goes through bettercast-helper.
//
// Owners: locate/exportConfig/importConfig = CI/services agent;
// scanApps/detectProviders = search/AI agents may refine.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AiProviderChoice,
  AppEntry,
  AppList,
  ConfigDoc,
  DetectProvidersRequest,
  ExportConfigRequest,
  ExportConfigResult,
  Hotkey,
  HotkeyAction,
  ImportConfigRequest,
  LocateRequest,
  LocateResult,
  ProviderInfo,
  ProviderList,
  ScanAppsRequest,
  Snippet,
} from "../shared.ts";

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/// True when `p` is a regular file this process may execute. A helper that
/// lost its exec bit (an archive tool, a copy) gets u+x/g+x/o+x back once.
function ensureExecutable(p: string): boolean {
  if (!isFile(p)) return false;
  try {
    fs.accessSync(p, 1); // X_OK
    return true;
  } catch {
    // fall through: try to restore the exec bit
  }
  try {
    fs.chmodSync(p, 0o755);
    fs.accessSync(p, 1);
    return true;
  } catch {
    return false;
  }
}

/// Find bettercast-helper and prepare the data dir.
/// Helper search order: request override (BETTERCAST_HELPER), then relative
/// to this executable: ../Resources/assets/bin (packaged .app, executable in
/// Contents/MacOS), then the dev layouts (zig-out/bin next to app/assets,
/// or a binary sitting in app/). The first candidate that exists and is (or
/// can be made) executable wins; `helperFound` is false otherwise.
/// Data dir: the core passes BETTERCAST_DATA_DIR when set, else
/// NATIVE_SDK_APP_DATA_DIR; locate creates <data>/clips and <data>/tmp.
export function locate(request: LocateRequest): LocateResult {
  const candidates: string[] = [];
  const override = text(request.helperOverride);
  if (override.length > 0) candidates.push(override);
  const exeDir = path.dirname(process.execPath);
  candidates.push(path.join(exeDir, "..", "Resources", "assets", "bin", "bettercast-helper"));
  candidates.push(path.join(exeDir, "assets", "bin", "bettercast-helper"));
  candidates.push(path.join(exeDir, "..", "assets", "bin", "bettercast-helper"));
  candidates.push(path.join(exeDir, "..", "..", "assets", "bin", "bettercast-helper"));
  let helper = "";
  for (const c of candidates) {
    if (ensureExecutable(c)) {
      helper = path.resolve(c);
      break;
    }
  }
  const dataDir = text(request.dataDir);
  let ready = false;
  if (dataDir.length > 0 && path.isAbsolute(dataDir)) {
    try {
      fs.mkdirSync(path.join(dataDir, "clips"), { recursive: true });
      fs.mkdirSync(path.join(dataDir, "tmp"), { recursive: true });
      ready = isDir(path.join(dataDir, "clips")) && isDir(path.join(dataDir, "tmp"));
    } catch {
      ready = false;
    }
  }
  return { helperPath: bytes(helper), helperFound: helper.length > 0, dataDir: request.dataDir, dataDirReady: ready };
}

/// List .app bundles in the standard application folders (one level deep).
export function scanApps(request: ScanAppsRequest): AppList {
  const roots: string[] = [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    path.join(os.homedir(), "Applications"),
  ];
  for (const extra of text(request.extraDirs).split("\n")) {
    if (extra.length > 0) roots.push(extra);
  }
  const apps: AppEntry[] = [];
  const seen: string[] = [];
  for (const root of roots) {
    if (!isDir(root)) continue;
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".app")) continue;
      const full = path.join(root, name);
      if (seen.includes(full)) continue;
      seen.push(full);
      apps.push({ name: bytes(name.slice(0, name.length - 4)), path: bytes(full) });
    }
  }
  apps.sort((a, b) => (text(a.name).toLowerCase() < text(b.name).toLowerCase() ? -1 : 1));
  return { apps: apps };
}

/// Find installed noninteractive AI CLIs.
export function detectProviders(request: DetectProvidersRequest): ProviderList {
  const home = os.homedir();
  const dirs: string[] = [];
  const envPath = process.env.PATH ?? "";
  for (const d of envPath.split(":")) {
    if (d.length > 0) dirs.push(d);
  }
  dirs.push(path.join(home, ".local", "bin"));
  dirs.push(path.join(home, ".bun", "bin"));
  dirs.push(path.join(home, ".npm-global", "bin"));
  dirs.push(path.join(home, ".volta", "bin"));
  dirs.push(path.join(home, ".opencode", "bin"));
  dirs.push("/opt/homebrew/bin");
  dirs.push("/usr/local/bin");
  for (const extra of text(request.extraDirs).split("\n")) {
    if (extra.length > 0) dirs.push(extra);
  }
  const ids: string[] = ["claude", "codex", "gemini", "opencode"];
  const found: ProviderInfo[] = [];
  for (const id of ids) {
    for (const d of dirs) {
      const p = path.join(d, id);
      if (isFile(p)) {
        if (id === "claude") found.push({ id: "claude", binPath: bytes(p) });
        if (id === "codex") found.push({ id: "codex", binPath: bytes(p) });
        if (id === "gemini") found.push({ id: "gemini", binPath: bytes(p) });
        if (id === "opencode") found.push({ id: "opencode", binPath: bytes(p) });
        break;
      }
    }
  }
  return { providers: found };
}

// ---------------------------------------------------------------- config
//
// Portable config file (snippets, hotkeys, settings), versioned JSON:
//
//   { "format": "bettercast-config", "version": 1,
//     "snippets": [{ "id", "name", "keyword", "body", "updatedMs" }],
//     "hotkeys":  [{ "action", "keyCode", "mods", "enabled" }],
//     "settings": { "retentionDays", "maxItems", "recordImages",
//                   "aiProvider", "aiModel" } }
//
// Never exported: API keys (credentials store only), clipboard history,
// launch-at-login (a machine-local choice; import always reports false and
// the core keeps its current value). Import failures throw
// { kind, message } with kind one of: not_found, read_failed, invalid_json,
// wrong_format, unsupported_version, invalid. Limits mirror the core
// (snippets.ts SNIPPET_*_CAPACITY, model.ts SNIPPET_BODY_CAPACITY).

const CONFIG_FORMAT = "bettercast-config";
const CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_SNIPPETS = 5000;
const NAME_CAPACITY = 256;
const KEYWORD_CAPACITY = 64;
const BODY_CAPACITY = 65536;
const MODEL_CAPACITY = 256;

interface ConfigHeaderJson {
  readonly format: string;
  readonly version: number;
}

interface SnippetJson {
  readonly id: number;
  readonly name: string;
  readonly keyword: string;
  readonly body: string;
  readonly updatedMs: number;
}

interface HotkeyJson {
  readonly action: string;
  readonly keyCode: number;
  readonly mods: number;
  readonly enabled: boolean;
}

interface SettingsJson {
  readonly retentionDays: number;
  readonly maxItems: number;
  readonly recordImages: boolean;
  readonly aiProvider: string;
  readonly aiModel: string;
}

interface ConfigJsonV1 {
  readonly format: string;
  readonly version: number;
  readonly snippets: readonly SnippetJson[];
  readonly hotkeys: readonly HotkeyJson[];
  readonly settings: SettingsJson;
}

function utf8Len(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isWhole(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

function hotkeyAction(value: string): HotkeyAction | null {
  if (value === "launcher") return "launcher";
  if (value === "clipboard") return "clipboard";
  if (value === "paste_next") return "paste_next";
  if (value === "ask_ai") return "ask_ai";
  return null;
}

function providerChoice(value: string): AiProviderChoice | null {
  if (value === "claude") return "claude";
  if (value === "codex") return "codex";
  if (value === "gemini") return "gemini";
  if (value === "opencode") return "opencode";
  if (value === "api") return "api";
  return null;
}

/// Pure: the JSON text for a config (2-space indent, trailing newline).
function encodeConfig(config: ConfigDoc): string {
  const snippets: SnippetJson[] = [];
  for (const s of config.snippets) {
    snippets.push({ id: s.id, name: text(s.name), keyword: text(s.keyword), body: text(s.body), updatedMs: s.updatedMs });
  }
  const hotkeys: HotkeyJson[] = [];
  for (const h of config.hotkeys) {
    hotkeys.push({ action: h.action, keyCode: h.keyCode, mods: h.mods, enabled: h.enabled });
  }
  const st = config.settings;
  const doc: ConfigJsonV1 = {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    snippets: snippets,
    hotkeys: hotkeys,
    settings: {
      retentionDays: st.retentionDays,
      maxItems: st.maxItems,
      recordImages: st.recordImages,
      aiProvider: st.aiProvider,
      aiModel: text(st.aiModel),
    },
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/// Pure: parse and validate config JSON text. Throws { kind, message }.
function decodeConfig(source: string): ConfigDoc {
  let header: ConfigHeaderJson = { format: "", version: 0 };
  try {
    header = JSON.parse(source) as ConfigHeaderJson;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (e instanceof SyntaxError) throw { kind: "invalid_json", message: "not valid JSON: " + detail };
    throw { kind: "wrong_format", message: "not a Bettercast config file (" + detail + ")" };
  }
  if (header.format !== CONFIG_FORMAT) {
    throw { kind: "wrong_format", message: "not a Bettercast config file (format is not \"" + CONFIG_FORMAT + "\")" };
  }
  if (header.version !== CONFIG_VERSION) {
    throw { kind: "unsupported_version", message: "config version " + String(header.version) + " is not supported (expected " + String(CONFIG_VERSION) + ")" };
  }
  let doc: ConfigJsonV1 = { format: "", version: 0, snippets: [], hotkeys: [], settings: { retentionDays: 0, maxItems: 0, recordImages: false, aiProvider: "", aiModel: "" } };
  try {
    doc = JSON.parse(source) as ConfigJsonV1;
  } catch (e) {
    throw { kind: "invalid", message: e instanceof Error ? e.message : String(e) };
  }

  if (doc.snippets.length > MAX_SNIPPETS) throw { kind: "invalid", message: "too many snippets (max " + String(MAX_SNIPPETS) + ")" };
  const snippets: Snippet[] = [];
  const ids: number[] = [];
  for (let i = 0; i < doc.snippets.length; i++) {
    const s = doc.snippets[i];
    const at = "snippets[" + String(i) + "]";
    if (!isWhole(s.id, 1, 2147483647)) throw { kind: "invalid", message: at + ".id must be a whole number >= 1" };
    if (ids.includes(s.id)) throw { kind: "invalid", message: at + ".id " + String(s.id) + " is used twice" };
    ids.push(s.id);
    if (s.name.trim().length === 0) throw { kind: "invalid", message: at + ".name must not be empty" };
    if (utf8Len(s.name) > NAME_CAPACITY) throw { kind: "invalid", message: at + ".name is longer than " + String(NAME_CAPACITY) + " bytes" };
    if (utf8Len(s.keyword) > KEYWORD_CAPACITY) throw { kind: "invalid", message: at + ".keyword is longer than " + String(KEYWORD_CAPACITY) + " bytes" };
    if (utf8Len(s.body) > BODY_CAPACITY) throw { kind: "invalid", message: at + ".body is longer than " + String(BODY_CAPACITY) + " bytes" };
    if (!isWhole(s.updatedMs, 0, 4102444800000)) throw { kind: "invalid", message: at + ".updatedMs must be a timestamp in milliseconds" };
    snippets.push({ id: s.id, name: bytes(s.name), keyword: bytes(s.keyword), body: bytes(s.body), updatedMs: s.updatedMs });
  }

  const hotkeys: Hotkey[] = [];
  const seen: string[] = [];
  const chords: string[] = [];
  for (let i = 0; i < doc.hotkeys.length; i++) {
    const h = doc.hotkeys[i];
    const at = "hotkeys[" + String(i) + "]";
    const action = hotkeyAction(h.action);
    if (action === null) throw { kind: "invalid", message: at + ".action \"" + h.action + "\" is not one of launcher, clipboard, paste_next, ask_ai" };
    if (seen.includes(h.action)) throw { kind: "invalid", message: at + ".action " + h.action + " appears twice" };
    seen.push(h.action);
    if (!isWhole(h.keyCode, 0, 127)) throw { kind: "invalid", message: at + ".keyCode must be a key code from 0 to 127" };
    if (!isWhole(h.mods, 0, 15)) throw { kind: "invalid", message: at + ".mods must be a modifier mask from 0 to 15" };
    if (h.enabled) {
      const chord = String(h.keyCode) + ":" + String(h.mods);
      if (chords.includes(chord)) throw { kind: "invalid", message: at + " uses the same key as another enabled shortcut" };
      chords.push(chord);
    }
    hotkeys.push({ action: action, keyCode: h.keyCode, mods: h.mods, enabled: h.enabled });
  }

  const st = doc.settings;
  if (!isWhole(st.retentionDays, 0, 3650)) throw { kind: "invalid", message: "settings.retentionDays must be from 0 to 3650" };
  if (!isWhole(st.maxItems, 1, 100000)) throw { kind: "invalid", message: "settings.maxItems must be from 1 to 100000" };
  const provider = providerChoice(st.aiProvider);
  if (provider === null) throw { kind: "invalid", message: "settings.aiProvider \"" + st.aiProvider + "\" is not one of claude, codex, gemini, opencode, api" };
  if (utf8Len(st.aiModel) > MODEL_CAPACITY) throw { kind: "invalid", message: "settings.aiModel is longer than " + String(MODEL_CAPACITY) + " bytes" };

  return {
    snippets: snippets,
    hotkeys: hotkeys,
    settings: {
      retentionDays: st.retentionDays,
      maxItems: st.maxItems,
      recordImages: st.recordImages,
      launchAtLogin: false,
      aiProvider: provider,
      aiModel: bytes(st.aiModel),
    },
  };
}

/// Write snippets/hotkeys/settings as versioned JSON (atomic: temp file +
/// rename). Throws { kind: "write_failed", message } on I/O errors.
export function exportConfig(request: ExportConfigRequest): ExportConfigResult {
  const out = text(request.path);
  if (out.length === 0 || !path.isAbsolute(out)) throw { kind: "invalid_path", message: "export path must be absolute" };
  const body = bytes(encodeConfig(request.config));
  const tmp = out + ".tmp";
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, out);
  } catch (e) {
    throw { kind: "write_failed", message: e instanceof Error ? e.message : String(e) };
  }
  return { path: request.path, bytes: body.length };
}

/// Read and validate a file written by exportConfig (or by hand).
export function importConfig(request: ImportConfigRequest): ConfigDoc {
  const p = text(request.path);
  if (!isFile(p)) throw { kind: "not_found", message: "config file not found: " + p };
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch (e) {
    throw { kind: "read_failed", message: e instanceof Error ? e.message : String(e) };
  }
  if (size > MAX_CONFIG_BYTES) throw { kind: "invalid", message: "config file is larger than 8 MB" };
  let source = "";
  try {
    source = text(fs.readFileSync(p));
  } catch (e) {
    throw { kind: "read_failed", message: e instanceof Error ? e.message : String(e) };
  }
  return decodeConfig(source);
}
