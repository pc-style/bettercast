// Text-field mirror engine: reduces the runtime's TextInputEvent stream
// over the model's copy of a field (text + selection + IME composition).
//
// Why not @native-sdk/core/text's applyTextInputEvent: in SDK 0.10.1 that
// module does NOT compile under the external core compiler (its TextRange
// offsets fail the integer-slot proofs, SC4022/SC4023, even in a one-field
// app). This engine keeps every offset provably whole and in range: host
// numbers are clamped with `clampInt` before use.
//
// Offsets are BYTE offsets snapped to UTF-8 scalar boundaries.

import { type TextInputEvent } from "@native-sdk/core/events";
import { EMPTY } from "./bytes.ts";

export interface EditState {
  readonly text: Uint8Array;
  readonly anchor: number;
  readonly focus: number;
  /// IME composition range [compStart, compEnd); compStart = -1 when none.
  readonly compStart: number;
  readonly compEnd: number;
}

/// Largest offset/length the engine accepts (fields are capacity-bound far
/// below this).
const MAX_OFFSET = 1048576;

export function emptyEditState(): EditState {
  return { text: EMPTY, anchor: 0, focus: 0, compStart: -1, compEnd: -1 };
}

export function editStateWith(text: Uint8Array): EditState {
  const n = boundedLen(text);
  return { text: text, anchor: n | 0, focus: n | 0, compStart: -1, compEnd: -1 };
}

/// Whole number in [lo, hi]; NaN and out-of-range values clamp.
export function clampInt(x: number, lo: number, hi: number): number {
  if (x >= lo && x <= hi) return Math.trunc(x);
  if (x > hi) return hi;
  return lo;
}

function boundedLen(text: Uint8Array): number {
  const n = text.length;
  return n > MAX_OFFSET ? MAX_OFFSET : n;
}

function isCont(b: number): boolean {
  return (b & 192) === 128;
}

/// Snap an offset down to a scalar boundary.
function snap(text: Uint8Array, off: number): number {
  const n = boundedLen(text);
  let i = clampInt(off, 0, n);
  while (i > 0 && i < n && isCont(text[i])) i -= 1;
  return i;
}

function prevScalar(text: Uint8Array, off: number): number {
  let i = snap(text, off);
  if (i === 0) return 0;
  i -= 1;
  while (i > 0 && isCont(text[i])) i -= 1;
  return i;
}

function nextScalar(text: Uint8Array, off: number): number {
  const n = boundedLen(text);
  let i = snap(text, off);
  if (i >= n) return n;
  i += 1;
  while (i < n && isCont(text[i])) i += 1;
  return i;
}

function isWordByte(b: number): boolean {
  // ASCII letters/digits/underscore, and every non-ASCII byte (so words in
  // other scripts move as words).
  return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95 || b >= 128;
}

function prevWord(text: Uint8Array, off: number): number {
  let i = snap(text, off);
  while (i > 0 && !isWordByte(text[i - 1])) i -= 1;
  while (i > 0 && isWordByte(text[i - 1])) i -= 1;
  return snap(text, i);
}

function nextWord(text: Uint8Array, off: number): number {
  const n = boundedLen(text);
  let i = snap(text, off);
  while (i < n && !isWordByte(text[i])) i += 1;
  while (i < n && isWordByte(text[i])) i += 1;
  return snap(text, i);
}

function lineStart(text: Uint8Array, off: number): number {
  let i = snap(text, off);
  while (i > 0 && text[i - 1] !== 10) i -= 1;
  return i;
}

function selStart(s: EditState): number {
  return s.anchor < s.focus ? s.anchor : s.focus;
}

function selEnd(s: EditState): number {
  return s.anchor < s.focus ? s.focus : s.anchor;
}

function hasComposition(s: EditState): boolean {
  return s.compStart >= 0 && s.compEnd >= s.compStart;
}

/// Replace [start, end) with `insert` (clamped to `capacity` at a UTF-8
/// boundary). Caret lands after the insertion; composition cleared.
function replaceRange(s: EditState, start: number, end: number, insert: Uint8Array, capacity: number): EditState {
  const n = boundedLen(s.text);
  const a = snap(s.text, start);
  const b0 = snap(s.text, end);
  const b = b0 < a ? a : b0;
  const kept = n - (b - a);
  const room = capacity - kept;
  let take = boundedLen(insert);
  if (room <= 0) take = 0;
  else if (take > room) take = room;
  while (take > 0 && take < insert.length && isCont(insert[take])) take -= 1;
  const out = new Uint8Array(kept + take);
  out.set(s.text.subarray(0, a), 0);
  out.set(insert.subarray(0, take), a);
  out.set(s.text.subarray(b, n), a + take);
  const caret = a + take;
  return { text: out, anchor: caret | 0, focus: caret | 0, compStart: -1, compEnd: -1 };
}

function collapse(s: EditState, at: number): EditState {
  const c = snap(s.text, at);
  return { text: s.text, anchor: c | 0, focus: c | 0, compStart: -1, compEnd: -1 };
}

function moveTo(s: EditState, at: number, extend: boolean): EditState {
  const c = snap(s.text, at);
  return { text: s.text, anchor: (extend ? s.anchor : c) | 0, focus: c | 0, compStart: -1, compEnd: -1 };
}

/// Apply one runtime text-input event. `capacity` is the field's byte cap.
export function applyEdit(s: EditState, e: TextInputEvent, capacity: number): EditState {
  const n = boundedLen(s.text);
  const lo = selStart(s);
  const hi = selEnd(s);
  const collapsed = lo === hi;
  switch (e.kind) {
    case "insert_text":
      if (hasComposition(s)) return replaceRange(s, s.compStart, s.compEnd, e.text, capacity);
      return replaceRange(s, lo, hi, e.text, capacity);
    case "delete_backward":
      if (!collapsed) return replaceRange(s, lo, hi, EMPTY, capacity);
      return replaceRange(s, prevScalar(s.text, s.focus), s.focus, EMPTY, capacity);
    case "delete_forward":
      if (!collapsed) return replaceRange(s, lo, hi, EMPTY, capacity);
      return replaceRange(s, s.focus, nextScalar(s.text, s.focus), EMPTY, capacity);
    case "delete_word_backward":
      if (!collapsed) return replaceRange(s, lo, hi, EMPTY, capacity);
      return replaceRange(s, prevWord(s.text, s.focus), s.focus, EMPTY, capacity);
    case "delete_word_forward":
      if (!collapsed) return replaceRange(s, lo, hi, EMPTY, capacity);
      return replaceRange(s, s.focus, nextWord(s.text, s.focus), EMPTY, capacity);
    case "delete_to_start":
      if (!collapsed) return replaceRange(s, lo, hi, EMPTY, capacity);
      return replaceRange(s, 0, s.focus, EMPTY, capacity);
    case "delete_to_line_start":
      if (!collapsed) return replaceRange(s, lo, hi, EMPTY, capacity);
      return replaceRange(s, lineStart(s.text, s.focus), s.focus, EMPTY, capacity);
    case "clear":
      return emptyEditState();
    case "move_caret": {
      const extend = e.move.extend;
      switch (e.move.direction) {
        case "previous":
          if (!extend && !collapsed) return collapse(s, lo);
          return moveTo(s, prevScalar(s.text, s.focus), extend);
        case "next":
          if (!extend && !collapsed) return collapse(s, hi);
          return moveTo(s, nextScalar(s.text, s.focus), extend);
        case "previous_word":
          return moveTo(s, prevWord(s.text, s.focus), extend);
        case "next_word":
          return moveTo(s, nextWord(s.text, s.focus), extend);
        case "start":
          return moveTo(s, 0, extend);
        case "end":
          return moveTo(s, n, extend);
      }
    }
    case "set_selection": {
      const a = snap(s.text, clampInt(e.selection.anchor, 0, n));
      const f = snap(s.text, clampInt(e.selection.focus, 0, n));
      return { text: s.text, anchor: a | 0, focus: f | 0, compStart: -1, compEnd: -1 };
    }
    case "set_composition": {
      const start = hasComposition(s) ? s.compStart : lo;
      const end = hasComposition(s) ? s.compEnd : hi;
      const r = replaceRange(s, start, end, e.text, capacity);
      const a = snap(s.text, start);
      const insertedEnd = r.focus;
      const len = insertedEnd - a;
      const cursor = e.cursor === null ? len : clampInt(e.cursor, 0, len);
      const caret = snap(r.text, a + cursor);
      if (len === 0) return { text: r.text, anchor: caret | 0, focus: caret | 0, compStart: -1, compEnd: -1 };
      return { text: r.text, anchor: caret | 0, focus: caret | 0, compStart: a | 0, compEnd: insertedEnd | 0 };
    }
    case "commit_composition":
      return { text: s.text, anchor: s.anchor, focus: s.focus, compStart: -1, compEnd: -1 };
    case "cancel_composition":
      if (!hasComposition(s)) return s;
      return replaceRange(s, s.compStart, s.compEnd, EMPTY, capacity);
  }
}
