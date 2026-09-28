// Launcher search: builds the ranked hit list for the current screen.
// Pure over the Model; viewmodel.ts turns hits into display rows and
// update.ts uses the SAME list to run the selected row, so what you see is
// exactly what Return runs.
//
// Ranking (root screen), higher first:
//   calculator result                                  1000
//   snippet whose keyword equals the query             300
//   name match: exact 120 > prefix 100 > word start 80 > initials 70 >
//               substring 60 (2+ chars) > in-order subsequence 30 (2+ chars)
//   kind bonus: app +10, command +5, snippet +3
//   snippet keyword prefix 110; snippet body word start 26 / substring 18
//   clipboard preview word start 22 / substring 14 (2+ chars)
//   frecency: min(count, 10) * 3, plus 10 / 6 / 3 when used within the
//             last hour / day / week
//   "Ask AI" row                                       2
// Matching is case-insensitive and folds Latin-1 accents (é -> e, Å -> a).
// Root hits are then grouped by kind in order of each kind's best hit, so
// the top hit stays first and section headers never repeat.

import { asciiBytes, utf8Bytes } from "@native-sdk/core";
import type { Model } from "./core.ts";
import { MAX_RESULTS, type Clip } from "./model.ts";
import { evaluate } from "./calc.ts";
import { bytesEqual, concat2, concat3, decimal, trimBytes } from "./bytes.ts";

export type HitKind = "command" | "app" | "snippet" | "clip" | "calc" | "ai";

export interface Hit {
  readonly kind: HitKind;
  /// command: CMD_* id; app: index into model.apps; snippet/clip: record
  /// id; calc/ai: 0.
  readonly refId: number;
  readonly title: Uint8Array;
  readonly subtitle: Uint8Array;
  readonly score: number;
}

export const CMD_CLIPBOARD = 1;
export const CMD_QUEUE = 2;
export const CMD_MANAGE = 3;
export const CMD_NEW_SNIPPET = 4;
export const CMD_QUIT = 5;

export interface CommandInfo {
  readonly id: number;
  readonly title: Uint8Array;
  readonly subtitle: Uint8Array;
}

export const COMMANDS: readonly CommandInfo[] = [
  { id: 1, title: utf8Bytes("Clipboard History"), subtitle: utf8Bytes("Search, paste, and queue copied text and images") },
  { id: 2, title: utf8Bytes("Paste Queue"), subtitle: utf8Bytes("Clips waiting for Paste Next") },
  { id: 3, title: utf8Bytes("Manage Bettercast…"), subtitle: utf8Bytes("Shortcuts, snippets, clipboard, AI, and general settings") },
  { id: 4, title: utf8Bytes("Create Snippet"), subtitle: utf8Bytes("Save reusable text") },
  { id: 5, title: utf8Bytes("Quit Bettercast"), subtitle: utf8Bytes("") },
];

// ---------------------------------------------------------------- folding

/// ASCII letter for a Latin-1 Supplement scalar (second byte after 0xC3),
/// or 0 to keep the scalar as is.
function latinFold(b: number): number {
  const c = b >= 160 ? b - 32 : b; // lower half mirrors the upper half
  if (c >= 128 && c <= 134) return 97; // À-Æ / à-æ
  if (c === 135) return 99; // Ç
  if (c >= 136 && c <= 139) return 101; // È-Ë
  if (c >= 140 && c <= 143) return 105; // Ì-Ï
  if (c === 144) return 100; // Ð
  if (c === 145) return 110; // Ñ
  if ((c >= 146 && c <= 150) || c === 152) return 111; // Ò-Ö, Ø
  if (c >= 153 && c <= 156) return 117; // Ù-Ü
  if (c === 157) return 121; // Ý
  if (b === 159) return 115; // ß
  if (b === 191) return 121; // ÿ
  return 0;
}

/// Lowercase ASCII and fold Latin-1 accents to their base letter. Other
/// bytes pass through, so any UTF-8 text still matches itself.
export function foldText(text: Uint8Array): Uint8Array {
  const out = new Uint8Array(text.length);
  let o = 0;
  let i = 0;
  while (i < text.length) {
    const b = text[i];
    if (b >= 65 && b <= 90) {
      out[o] = b + 32;
      o += 1;
      i += 1;
      continue;
    }
    if (b === 195 && i + 1 < text.length) {
      const f = latinFold(text[i + 1]);
      if (f > 0) {
        out[o] = f;
        o += 1;
        i += 2;
        continue;
      }
    }
    out[o] = b;
    o += 1;
    i += 1;
  }
  return out.subarray(0, o);
}

// ---------------------------------------------------------------- matching

function isSep(b: number): boolean {
  return b === 32 || b === 45 || b === 95 || b === 46 || b === 47 || b === 40 || b === 41 || b === 44 || b === 58 || b === 10 || b === 9;
}

function matchesAt(h: Uint8Array, n: Uint8Array, at: number): boolean {
  if (at + n.length > h.length) return false;
  for (let j = 0; j < n.length; j++) {
    if (h[at + j] !== n[j]) return false;
  }
  return true;
}

/// Score of folded needle `n` in folded haystack `h` (both from foldText).
/// `fuzzy` enables initials and subsequence matches (names only).
export function scoreFolded(h: Uint8Array, n: Uint8Array, fuzzy: boolean): number {
  if (n.length === 0) return 1;
  if (n.length > h.length) return 0;
  if (matchesAt(h, n, 0)) return h.length === n.length ? 120 : 100;
  let substring = false;
  const last = h.length - n.length;
  for (let i = 1; i <= last; i++) {
    if (h[i] === n[0] && matchesAt(h, n, i)) {
      if (isSep(h[i - 1])) return 80;
      substring = true;
    }
  }
  if (!fuzzy) return substring && n.length >= 2 ? 60 : 0;
  if (n.length >= 2) {
    // Initials: "vsc" -> "Visual Studio Code".
    let j = 0;
    for (let i = 0; i < h.length && j < n.length; i++) {
      const start = i === 0 || isSep(h[i - 1]);
      if (start && !isSep(h[i])) {
        if (h[i] !== n[j]) break;
        j += 1;
      }
    }
    if (j === n.length) return 70;
  }
  if (substring && n.length >= 2) return 60;
  if (n.length < 2) return 0;
  let k = 0;
  for (const b of h) {
    if (k < n.length && b === n[k]) k += 1;
  }
  return k === n.length ? 30 : 0;
}

/// Case/accent-insensitive score of raw `needle` in raw `hay`.
export function matchScore(hay: Uint8Array, needle: Uint8Array): number {
  return scoreFolded(foldText(hay), foldText(needle), true);
}

export function queryOf(model: Model): Uint8Array {
  return trimBytes(model.query.text);
}

// ---------------------------------------------------------------- frecency

const HOUR_MS = 3600000;

export function appKey(path: Uint8Array): Uint8Array {
  return concat2(asciiBytes("app:"), path);
}

export function snippetKey(id: number): Uint8Array {
  return concat2(asciiBytes("snippet:"), decimal(id));
}

export function commandKey(id: number): Uint8Array {
  return concat2(asciiBytes("cmd:"), decimal(id));
}

/// Ranking boost for a frecency key: use count (capped) plus recency.
export function frecencyBoost(model: Model, key: Uint8Array): number {
  const f = model.frecency.find((x) => bytesEqual(x.key, key));
  if (f === undefined) return 0;
  let boost = (f.count > 10 ? 10 : f.count) * 3;
  if (model.nowMs > 0 && f.lastMs > 0) {
    const age = model.nowMs - f.lastMs;
    if (age < HOUR_MS) boost += 10;
    else if (age < 24 * HOUR_MS) boost += 6;
    else if (age < 7 * 24 * HOUR_MS) boost += 3;
  }
  return boost;
}

// ---------------------------------------------------------------- root

export function clipTitle(c: Clip): Uint8Array {
  return c.kind === "image" ? utf8Bytes(`Image ${c.width}×${c.height}`) : c.preview;
}

function kindRank(kind: HitKind, best: readonly Hit[]): number {
  for (const [i, h] of best.entries()) {
    if (h.kind === kind) return i;
  }
  return 99;
}

/// Stable-group a score-sorted list by kind, ordering groups by where
/// their best hit ranks.
function groupByKind(sorted: readonly Hit[]): Hit[] {
  const firsts: Hit[] = [];
  for (const h of sorted) {
    if (!firsts.some((f) => f.kind === h.kind)) firsts.push(h);
  }
  return sorted.toSorted((a, b) => kindRank(a.kind, firsts) - kindRank(b.kind, firsts));
}

function rootHits(model: Model): Hit[] {
  const q = queryOf(model);
  const n = foldText(q);
  const out: Hit[] = [];
  const calc = evaluate(q);
  if (calc.ok) {
    out.push({ kind: "calc", refId: 0, title: calc.display, subtitle: utf8Bytes("Calculator · Return copies the result"), score: 1000 });
  }
  for (const c of COMMANDS) {
    const s = scoreFolded(foldText(c.title), n, true);
    if (s > 0) out.push({ kind: "command", refId: c.id, title: c.title, subtitle: c.subtitle, score: s + 5 + frecencyBoost(model, commandKey(c.id)) });
  }
  for (const sn of model.snippets) {
    let s = scoreFolded(foldText(sn.name), n, true);
    if (s > 0) s += 3;
    if (sn.keyword.length > 0 && n.length > 0) {
      const kw = foldText(sn.keyword);
      if (bytesEqual(kw, n)) s = 300;
      else if (matchesAt(kw, n, 0) && s < 110) s = 110;
    }
    if (s === 0 && n.length >= 2) {
      const body = scoreFolded(foldText(sn.body), n, false);
      if (body === 80 || body === 100 || body === 120) s = 26;
      else if (body === 60) s = 18;
    }
    if (s > 0) {
      const sub = sn.keyword.length > 0 ? concat3(sn.keyword, utf8Bytes(" · "), sn.body) : sn.body;
      out.push({ kind: "snippet", refId: sn.id, title: sn.name, subtitle: sub, score: s + frecencyBoost(model, snippetKey(sn.id)) });
    }
  }
  if (n.length > 0) {
    for (const [i, a] of model.apps.entries()) {
      const s = scoreFolded(foldText(a.name), n, true);
      if (s > 0) out.push({ kind: "app", refId: i, title: a.name, subtitle: a.path, score: s + 10 + frecencyBoost(model, appKey(a.path)) });
    }
    if (n.length >= 2) {
      let found = 0;
      for (const c of model.clips) {
        if (c.kind !== "text" || found >= 5) continue;
        const s = scoreFolded(foldText(c.preview), n, false);
        const score = s >= 80 ? 22 : s === 60 ? 14 : 0;
        if (score > 0) {
          out.push({ kind: "clip", refId: c.id, title: c.preview, subtitle: utf8Bytes("Clipboard history"), score: score });
          found += 1;
        }
      }
    }
    out.push({ kind: "ai", refId: 0, title: concat3(utf8Bytes("Ask AI “"), q, utf8Bytes("”")), subtitle: utf8Bytes("Stream an answer from your AI provider"), score: 2 });
  } else {
    // Empty query: recently used apps join the commands and snippets.
    for (const [i, a] of model.apps.entries()) {
      const boost = frecencyBoost(model, appKey(a.path));
      if (boost > 0) out.push({ kind: "app", refId: i, title: a.name, subtitle: a.path, score: 1 + boost });
    }
  }
  const sorted = out.toSorted((a, b) => b.score - a.score);
  return groupByKind(sorted.slice(0, MAX_RESULTS));
}

// ---------------------------------------------------------------- clipboard / queue

function clipVisible(model: Model, c: Clip): boolean {
  if (model.clipFilter === "text") return c.kind === "text";
  if (model.clipFilter === "image") return c.kind === "image";
  return true;
}

function clipboardHits(model: Model): Hit[] {
  const q = queryOf(model);
  const n = foldText(q);
  const out: Hit[] = [];
  // Pinned first, then newest first (model.clips is kept newest first).
  for (let pass = 0; pass < 2; pass++) {
    for (const c of model.clips) {
      if (out.length >= MAX_RESULTS) break;
      if (c.pinned !== (pass === 0) || !clipVisible(model, c)) continue;
      const title = clipTitle(c);
      const s = n.length === 0 ? 1 : scoreFolded(foldText(title), n, n.length >= 3);
      if (s > 0) out.push({ kind: "clip", refId: c.id, title: title, subtitle: c.sourceBundle, score: s });
    }
  }
  return out;
}

function queueHits(model: Model): Hit[] {
  const out: Hit[] = [];
  for (const [i, item] of model.queue.entries()) {
    const clip = model.clips.find((c) => c.id === item.clipId);
    if (clip === undefined) continue;
    out.push({ kind: "clip", refId: clip.id, title: clipTitle(clip), subtitle: utf8Bytes(`${i + 1} in queue`), score: 1 });
  }
  return out;
}

/// The ranked, capped list for the active screen (empty on the AI screen).
export function hits(model: Model): readonly Hit[] {
  switch (model.screen) {
    case "root": return rootHits(model);
    case "clipboard": return clipboardHits(model);
    case "queue": return queueHits(model);
    case "ai": return [];
  }
}
