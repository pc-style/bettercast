// Global hotkeys: defaults, key-name <-> Carbon key code table, display
// labels, conflict detection, and the helper's --hotkeys spec encoding.
//
// Owner: hotkeys agent. The table and encodings below ARE the contract
// (see contract.md "watch --hotkeys"); extend the key table, keep the
// shapes.

import { asciiBytes, utf8Bytes } from "@native-sdk/core";
import type { Hotkey, HotkeyAction } from "./shared.ts";
import { concat2, concat3, decimal, joinBytes, parseDecimal, EMPTY, startsWithBytes } from "./bytes.ts";

// Our modifier bits (stable, persisted).
export const MOD_CMD = 1;
export const MOD_SHIFT = 2;
export const MOD_OPTION = 4;
export const MOD_CONTROL = 8;

// Carbon modifier bits (what the helper passes to RegisterEventHotKey).
const CARBON_CMD = 256;
const CARBON_SHIFT = 512;
const CARBON_OPTION = 2048;
const CARBON_CONTROL = 4096;

export const KEY_SPACE = 49;

export interface KeyInfo {
  /// Carbon virtual key code.
  readonly code: number;
  /// Display label, e.g. "Space", "K", "F5".
  readonly label: Uint8Array;
}

/// Index into KEYS for a KeyEvent key name (lowercased runtime names:
/// "a".."z", "0".."9", "space", "f1".."f12", "arrowup", ...). -1 when the
/// key cannot be a global hotkey.
export function keyIndexForName(name: string): number {
  switch (name) {
    case "a": return 0;
    case "b": return 1;
    case "c": return 2;
    case "d": return 3;
    case "e": return 4;
    case "f": return 5;
    case "g": return 6;
    case "h": return 7;
    case "i": return 8;
    case "j": return 9;
    case "k": return 10;
    case "l": return 11;
    case "m": return 12;
    case "n": return 13;
    case "o": return 14;
    case "p": return 15;
    case "q": return 16;
    case "r": return 17;
    case "s": return 18;
    case "t": return 19;
    case "u": return 20;
    case "v": return 21;
    case "w": return 22;
    case "x": return 23;
    case "y": return 24;
    case "z": return 25;
    case "0": return 26;
    case "1": return 27;
    case "2": return 28;
    case "3": return 29;
    case "4": return 30;
    case "5": return 31;
    case "6": return 32;
    case "7": return 33;
    case "8": return 34;
    case "9": return 35;
    case "space": return 36;
    case "f1": return 37;
    case "f2": return 38;
    case "f3": return 39;
    case "f4": return 40;
    case "f5": return 41;
    case "f6": return 42;
    case "f7": return 43;
    case "f8": return 44;
    case "f9": return 45;
    case "f10": return 46;
    case "f11": return 47;
    case "f12": return 48;
    case "arrowleft": return 49;
    case "arrowright": return 50;
    case "arrowdown": return 51;
    case "arrowup": return 52;
    case "enter": return 53;
    case "return": return 53;
    case "tab": return 54;
    case "comma": return 55;
    case ",": return 55;
    case "period": return 56;
    case ".": return 56;
    case "slash": return 57;
    case "/": return 57;
    case "semicolon": return 58;
    case ";": return 58;
    case "backquote": return 59;
    case "`": return 59;
    default: return -1;
  }
}

export const KEYS: readonly KeyInfo[] = [
  { code: 0, label: asciiBytes("A") },
  { code: 11, label: asciiBytes("B") },
  { code: 8, label: asciiBytes("C") },
  { code: 2, label: asciiBytes("D") },
  { code: 14, label: asciiBytes("E") },
  { code: 3, label: asciiBytes("F") },
  { code: 5, label: asciiBytes("G") },
  { code: 4, label: asciiBytes("H") },
  { code: 34, label: asciiBytes("I") },
  { code: 38, label: asciiBytes("J") },
  { code: 40, label: asciiBytes("K") },
  { code: 37, label: asciiBytes("L") },
  { code: 46, label: asciiBytes("M") },
  { code: 45, label: asciiBytes("N") },
  { code: 31, label: asciiBytes("O") },
  { code: 35, label: asciiBytes("P") },
  { code: 12, label: asciiBytes("Q") },
  { code: 15, label: asciiBytes("R") },
  { code: 1, label: asciiBytes("S") },
  { code: 17, label: asciiBytes("T") },
  { code: 32, label: asciiBytes("U") },
  { code: 9, label: asciiBytes("V") },
  { code: 13, label: asciiBytes("W") },
  { code: 7, label: asciiBytes("X") },
  { code: 16, label: asciiBytes("Y") },
  { code: 6, label: asciiBytes("Z") },
  { code: 29, label: asciiBytes("0") },
  { code: 18, label: asciiBytes("1") },
  { code: 19, label: asciiBytes("2") },
  { code: 20, label: asciiBytes("3") },
  { code: 21, label: asciiBytes("4") },
  { code: 23, label: asciiBytes("5") },
  { code: 22, label: asciiBytes("6") },
  { code: 26, label: asciiBytes("7") },
  { code: 28, label: asciiBytes("8") },
  { code: 25, label: asciiBytes("9") },
  { code: 49, label: asciiBytes("Space") },
  { code: 122, label: asciiBytes("F1") },
  { code: 120, label: asciiBytes("F2") },
  { code: 99, label: asciiBytes("F3") },
  { code: 118, label: asciiBytes("F4") },
  { code: 96, label: asciiBytes("F5") },
  { code: 97, label: asciiBytes("F6") },
  { code: 98, label: asciiBytes("F7") },
  { code: 100, label: asciiBytes("F8") },
  { code: 101, label: asciiBytes("F9") },
  { code: 109, label: asciiBytes("F10") },
  { code: 103, label: asciiBytes("F11") },
  { code: 111, label: asciiBytes("F12") },
  { code: 123, label: utf8Bytes("←") },
  { code: 124, label: utf8Bytes("→") },
  { code: 125, label: utf8Bytes("↓") },
  { code: 126, label: utf8Bytes("↑") },
  { code: 36, label: utf8Bytes("↩") },
  { code: 48, label: utf8Bytes("⇥") },
  { code: 43, label: asciiBytes(",") },
  { code: 47, label: asciiBytes(".") },
  { code: 44, label: asciiBytes("/") },
  { code: 41, label: asciiBytes(";") },
  { code: 50, label: asciiBytes("`") },
];

export function defaultHotkeys(): readonly Hotkey[] {
  return [
    // ⌥Space — Adam's choice for the launcher.
    { action: "launcher", keyCode: 49, mods: 4, enabled: true },
    // ⌥⌘V clipboard history.
    { action: "clipboard", keyCode: 9, mods: 5, enabled: true },
    // ⌃⌘V paste the next queued clip.
    { action: "paste_next", keyCode: 9, mods: 9, enabled: true },
    // ⌥⌘I ask AI.
    { action: "ask_ai", keyCode: 34, mods: 5, enabled: true },
  ];
}

export function actionToken(action: HotkeyAction): Uint8Array {
  switch (action) {
    case "launcher": return asciiBytes("launcher");
    case "clipboard": return asciiBytes("clipboard");
    case "paste_next": return asciiBytes("paste_next");
    case "ask_ai": return asciiBytes("ask_ai");
  }
}

export function actionTitle(action: HotkeyAction): Uint8Array {
  switch (action) {
    case "launcher": return utf8Bytes("Open Bettercast");
    case "clipboard": return utf8Bytes("Clipboard History");
    case "paste_next": return utf8Bytes("Paste Next in Queue");
    case "ask_ai": return utf8Bytes("Ask AI");
  }
}

/// Helper token -> action; null for unknown tokens.
export function actionForToken(token: Uint8Array): HotkeyAction | null {
  if (token.length === 8 && startsWithBytes(token, asciiBytes("launcher"))) return "launcher";
  if (token.length === 9 && startsWithBytes(token, asciiBytes("clipboard"))) return "clipboard";
  if (token.length === 10 && startsWithBytes(token, asciiBytes("paste_next"))) return "paste_next";
  if (token.length === 6 && startsWithBytes(token, asciiBytes("ask_ai"))) return "ask_ai";
  return null;
}

export function carbonMods(mods: number): number {
  let out = 0;
  if ((mods & MOD_CMD) !== 0) out = out | CARBON_CMD;
  if ((mods & MOD_SHIFT) !== 0) out = out | CARBON_SHIFT;
  if ((mods & MOD_OPTION) !== 0) out = out | CARBON_OPTION;
  if ((mods & MOD_CONTROL) !== 0) out = out | CARBON_CONTROL;
  return out;
}

/// "Ctrl+Opt+Shift+Cmd+" + key label, in the macOS canonical modifier
/// order. Words, not ⌃⌥⌘ symbols: the bundled UI font has no glyphs for
/// ⌃ ⌥ ⌘ (they render as tofu boxes; see contract.md "Glyphs").
export function hotkeyLabel(keyCode: number, mods: number): Uint8Array {
  let label = EMPTY;
  for (const k of KEYS) {
    if (k.code === keyCode) label = k.label;
  }
  let prefix = EMPTY;
  if ((mods & MOD_CONTROL) !== 0) prefix = concat2(prefix, utf8Bytes("Ctrl+"));
  if ((mods & MOD_OPTION) !== 0) prefix = concat2(prefix, utf8Bytes("Opt+"));
  if ((mods & MOD_SHIFT) !== 0) prefix = concat2(prefix, utf8Bytes("Shift+"));
  if ((mods & MOD_CMD) !== 0) prefix = concat2(prefix, utf8Bytes("Cmd+"));
  return concat2(prefix, label);
}

/// The helper's `--hotkeys` argument: comma-separated
/// `<token>:<carbonKeyCode>:<carbonMods>` for every ENABLED hotkey, or
/// `-` when none are enabled.
export function hotkeySpec(hotkeys: readonly Hotkey[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const h of hotkeys) {
    if (!h.enabled) continue;
    parts.push(joinBytes([actionToken(h.action), decimal(h.keyCode), decimal(carbonMods(h.mods))], asciiBytes(":")));
  }
  if (parts.length === 0) return asciiBytes("-");
  return joinBytes(parts, asciiBytes(","));
}

/// Carbon modifier bits -> our MOD_* bits.
export function modsFromCarbon(carbon: number): number {
  let out = 0;
  if ((carbon & CARBON_CMD) !== 0) out = out | MOD_CMD;
  if ((carbon & CARBON_SHIFT) !== 0) out = out | MOD_SHIFT;
  if ((carbon & CARBON_OPTION) !== 0) out = out | MOD_OPTION;
  if ((carbon & CARBON_CONTROL) !== 0) out = out | MOD_CONTROL;
  return out;
}

/// Decode a `--hotkeys` spec (the inverse of hotkeySpec): every listed
/// token becomes an ENABLED hotkey; malformed entries are skipped; `-`
/// decodes to none. Used by tests and config import.
export function parseHotkeySpec(spec: Uint8Array): readonly Hotkey[] {
  const out: Hotkey[] = [];
  let start = 0;
  for (let i = 0; i <= spec.length; i++) {
    if (i < spec.length && spec[i] !== 44) continue;
    const part = spec.subarray(start, i);
    start = i + 1;
    const c1 = indexOfColon(part, 0);
    const c2 = c1 < 0 ? -1 : indexOfColon(part, c1 + 1);
    if (c1 <= 0 || c2 <= c1 + 1 || c2 >= part.length - 1) continue;
    const action = actionForToken(part.subarray(0, c1));
    const code = parseDecimal(part.subarray(c1 + 1, c2), -1);
    const carbon = parseDecimal(part.subarray(c2 + 1, part.length), -1);
    if (action === null || code < 0 || code > 127 || carbon < 0 || carbon > 65535) continue;
    if (out.some((h) => h.action === action)) continue;
    out.push({ action: action, keyCode: code | 0, mods: modsFromCarbon(carbon | 0) | 0, enabled: true });
  }
  return out;
}

function indexOfColon(text: Uint8Array, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === 58) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- conflicts

/// none: free; warn: usable, but a well-known macOS / Raycast shortcut
/// uses it too (whoever registers first wins, so the user decides); block:
/// cannot be used (another Bettercast shortcut, no modifier, or a chord
/// every app relies on such as Cmd+C).
export type ConflictLevel = "none" | "warn" | "block";

export interface Conflict {
  readonly level: ConflictLevel;
  readonly message: Uint8Array;
}

/// A well-known system or Raycast shortcut.
export interface KnownShortcut {
  readonly code: number;
  readonly mods: number;
  readonly block: boolean;
  readonly owner: Uint8Array;
}

// MOD bits: cmd=1 shift=2 option=4 control=8.
export const KNOWN_SHORTCUTS: readonly KnownShortcut[] = [
  // Chords every app relies on: never allowed as global hotkeys.
  { code: 8, mods: 1, block: true, owner: utf8Bytes("Copy (Cmd+C) in every app") },
  { code: 9, mods: 1, block: true, owner: utf8Bytes("Paste (Cmd+V) in every app") },
  { code: 7, mods: 1, block: true, owner: utf8Bytes("Cut (Cmd+X) in every app") },
  { code: 6, mods: 1, block: true, owner: utf8Bytes("Undo (Cmd+Z) in every app") },
  { code: 6, mods: 3, block: true, owner: utf8Bytes("Redo (Shift+Cmd+Z) in every app") },
  { code: 0, mods: 1, block: true, owner: utf8Bytes("Select All (Cmd+A) in every app") },
  { code: 1, mods: 1, block: true, owner: utf8Bytes("Save (Cmd+S) in every app") },
  { code: 12, mods: 1, block: true, owner: utf8Bytes("Quit (Cmd+Q) in every app") },
  { code: 13, mods: 1, block: true, owner: utf8Bytes("Close Window (Cmd+W) in every app") },
  { code: 48, mods: 1, block: true, owner: utf8Bytes("the macOS app switcher (Cmd+Tab)") },
  { code: 48, mods: 3, block: true, owner: utf8Bytes("the macOS app switcher (Shift+Cmd+Tab)") },
  // macOS system shortcuts (user-changeable in System Settings): warn.
  { code: 49, mods: 1, block: false, owner: utf8Bytes("Spotlight") },
  { code: 49, mods: 5, block: false, owner: utf8Bytes("Finder search") },
  { code: 49, mods: 8, block: false, owner: utf8Bytes("macOS input source switching") },
  { code: 49, mods: 12, block: false, owner: utf8Bytes("macOS input source switching") },
  { code: 49, mods: 9, block: false, owner: utf8Bytes("the macOS emoji picker") },
  { code: 12, mods: 9, block: false, owner: utf8Bytes("Lock Screen") },
  { code: 20, mods: 3, block: false, owner: utf8Bytes("macOS screenshots") },
  { code: 21, mods: 3, block: false, owner: utf8Bytes("macOS screenshots") },
  { code: 23, mods: 3, block: false, owner: utf8Bytes("macOS screenshots") },
  { code: 50, mods: 1, block: false, owner: utf8Bytes("macOS window cycling (Cmd+`)") },
  { code: 4, mods: 1, block: false, owner: utf8Bytes("Hide (Cmd+H) in every app") },
  { code: 46, mods: 1, block: false, owner: utf8Bytes("Minimize (Cmd+M) in every app") },
  { code: 3, mods: 9, block: false, owner: utf8Bytes("Full Screen (Ctrl+Cmd+F)") },
  { code: 2, mods: 5, block: false, owner: utf8Bytes("Dock hiding (Opt+Cmd+D)") },
  { code: 126, mods: 8, block: false, owner: utf8Bytes("Mission Control") },
  { code: 125, mods: 8, block: false, owner: utf8Bytes("App Exposé") },
  { code: 123, mods: 8, block: false, owner: utf8Bytes("macOS Spaces") },
  { code: 124, mods: 8, block: false, owner: utf8Bytes("macOS Spaces") },
  { code: 44, mods: 3, block: false, owner: utf8Bytes("the Help menu (Shift+Cmd+/)") },
  // Raycast defaults: Raycast keeps its own binding; warn so the user knows.
  { code: 49, mods: 4, block: false, owner: utf8Bytes("Raycast (its default launcher shortcut)") },
];

function blocked(message: Uint8Array): Conflict {
  return { level: "block", message: message };
}

function isFunctionKey(code: number): boolean {
  return code === 122 || code === 120 || code === 99 || code === 118 || code === 96 || code === 97 || code === 98 || code === 100 || code === 101 || code === 109 || code === 103 || code === 111;
}

/// Check `candidate` against the other ENABLED Bettercast hotkeys and the
/// table of well-known shortcuts.
export function checkHotkey(hotkeys: readonly Hotkey[], candidate: Hotkey): Conflict {
  const label = hotkeyLabel(candidate.keyCode, candidate.mods);
  const plain = candidate.mods === 0 || candidate.mods === MOD_SHIFT;
  if (plain && !isFunctionKey(candidate.keyCode)) {
    return blocked(concat3(utf8Bytes("Add Cmd, Opt, or Ctrl: "), label, utf8Bytes(" alone would block typing.")));
  }
  for (const h of hotkeys) {
    if (h.action === candidate.action || !h.enabled) continue;
    if (h.keyCode === candidate.keyCode && h.mods === candidate.mods) {
      return blocked(concat3(label, utf8Bytes(" is already used by "), concat2(actionTitle(h.action), utf8Bytes("."))));
    }
  }
  for (const k of KNOWN_SHORTCUTS) {
    if (k.code !== candidate.keyCode || k.mods !== candidate.mods) continue;
    if (k.block) return blocked(concat3(label, utf8Bytes(" is reserved for "), concat2(k.owner, utf8Bytes("."))));
    return {
      level: "warn",
      message: concat3(label, utf8Bytes(" is also used by "), concat2(k.owner, utf8Bytes(". Whichever app registers it first gets it; turn it off there if Bettercast should win."))),
    };
  }
  return { level: "none", message: EMPTY };
}

/// Message-only view of checkHotkey (empty when free).
export function conflictFor(hotkeys: readonly Hotkey[], candidate: Hotkey): Uint8Array {
  return checkHotkey(hotkeys, candidate).message;
}

/// Hotkey for `action` from `index` into KEYS and MOD_* bits (key_down).
export function hotkeyFromKey(action: HotkeyAction, keyIndex: number, mods: number): Hotkey | null {
  if (keyIndex < 0 || keyIndex >= KEYS.length) return null;
  return { action: action, keyCode: KEYS[keyIndex].code | 0, mods: mods & 15, enabled: true };
}

export function withHotkey(hotkeys: readonly Hotkey[], next: Hotkey): readonly Hotkey[] {
  if (!hotkeys.some((h) => h.action === next.action)) return [...hotkeys, next];
  return hotkeys.map((h) => (h.action === next.action ? next : h));
}
