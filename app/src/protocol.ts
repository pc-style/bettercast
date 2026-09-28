// bettercast-helper stdout protocol: one ASCII line per event, fields
// separated by single spaces, free text base64-encoded (see contract.md).
// parseLine is total: anything unrecognized becomes { kind: "unknown" }.

import { asciiBytes } from "@native-sdk/core";
import { base64Decode, fields, parseDecimal, EMPTY, startsWithBytes } from "./bytes.ts";

export type ClipKind = "text" | "image";

export type HelperEvent =
  | { readonly kind: "ready"; readonly version: Uint8Array; readonly axTrusted: boolean }
  | { readonly kind: "hotkey"; readonly token: Uint8Array }
  | { readonly kind: "hotkey_error"; readonly token: Uint8Array; readonly status: number }
  | { readonly kind: "front"; readonly pid: number; readonly bundleId: Uint8Array; readonly name: Uint8Array }
  | {
      readonly kind: "clip";
      readonly clipKind: ClipKind;
      readonly atMs: number;
      /// lowercase hex sha256 of the stored payload; file is
      /// <dataDir>/clips/<sha>.txt or .png
      readonly sha: Uint8Array;
      readonly size: number;
      readonly width: number;
      readonly height: number;
      /// text: first <= 240 bytes of the UTF-8 text; image: empty
      readonly preview: Uint8Array;
      readonly sourceBundle: Uint8Array;
    }
  | { readonly kind: "clip_skip"; readonly reason: Uint8Array }
  | { readonly kind: "ax"; readonly trusted: boolean }
  | { readonly kind: "result"; readonly word: Uint8Array }
  | { readonly kind: "chunk"; readonly text: Uint8Array }
  | { readonly kind: "done" }
  | { readonly kind: "helper_error"; readonly code: Uint8Array; readonly message: Uint8Array }
  | { readonly kind: "unknown"; readonly line: Uint8Array };

function is(word: Uint8Array, literal: Uint8Array): boolean {
  return word.length === literal.length && startsWithBytes(word, literal);
}

/// Base64 field, where `-` (or a missing field) means empty.
function dashOr(value: Uint8Array): Uint8Array {
  if (value.length === 0 || (value.length === 1 && value[0] === 45)) return EMPTY;
  return base64Decode(value);
}

function field(parts: readonly Uint8Array[], i: number): Uint8Array {
  return i < parts.length ? parts[i] : EMPTY;
}

/// A clip sha must be exactly 64 lowercase hex digits: it becomes part of
/// a file path, so anything else is rejected (no traversal, no spaces).
export function isSha(text: Uint8Array): boolean {
  if (text.length !== 64) return false;
  for (const b of text) {
    const hex = (b >= 48 && b <= 57) || (b >= 97 && b <= 102);
    if (!hex) return false;
  }
  return true;
}

/// Longest preview the core keeps (the helper sends <= 240 bytes).
const MAX_PREVIEW = 256;

function bounded(text: Uint8Array, max: number): Uint8Array {
  if (text.length <= max) return text;
  let end = max;
  while (end > 0 && (text[end] & 192) === 128) end -= 1;
  return text.subarray(0, end);
}

export function parseLine(raw: Uint8Array): HelperEvent {
  // Tolerate a trailing CR.
  const line = raw.length > 0 && raw[raw.length - 1] === 13 ? raw.subarray(0, raw.length - 1) : raw;
  const parts = fields(line);
  if (parts.length === 0) return { kind: "unknown", line: line };
  const head = parts[0];
  if (is(head, asciiBytes("ready"))) {
    return { kind: "ready", version: field(parts, 1), axTrusted: is(field(parts, 2), asciiBytes("ax=1")) };
  }
  if (is(head, asciiBytes("hotkey"))) return { kind: "hotkey", token: field(parts, 1) };
  if (is(head, asciiBytes("hotkey-error"))) {
    return { kind: "hotkey_error", token: field(parts, 1), status: parseDecimal(field(parts, 2), -1) };
  }
  if (is(head, asciiBytes("front"))) {
    return {
      kind: "front",
      pid: parseDecimal(field(parts, 1), -1),
      bundleId: dashOr(field(parts, 2)),
      name: dashOr(field(parts, 3)),
    };
  }
  if (is(head, asciiBytes("clip"))) {
    // clip text  <atMs> <sha> <size> <preview-b64> <source-b64>
    // clip image <atMs> <sha> <size> <width> <height> <source-b64>
    const kindWord = field(parts, 1);
    if (!isSha(field(parts, 3))) return { kind: "unknown", line: line };
    if (is(kindWord, asciiBytes("text"))) {
      return {
        kind: "clip",
        clipKind: "text",
        atMs: parseDecimal(field(parts, 2), 0),
        sha: field(parts, 3),
        size: parseDecimal(field(parts, 4), 0),
        width: 0,
        height: 0,
        preview: bounded(dashOr(field(parts, 5)), MAX_PREVIEW),
        sourceBundle: bounded(dashOr(field(parts, 6)), MAX_PREVIEW),
      };
    }
    if (is(kindWord, asciiBytes("image"))) {
      return {
        kind: "clip",
        clipKind: "image",
        atMs: parseDecimal(field(parts, 2), 0),
        sha: field(parts, 3),
        size: parseDecimal(field(parts, 4), 0),
        width: parseDecimal(field(parts, 5), 0),
        height: parseDecimal(field(parts, 6), 0),
        preview: EMPTY,
        sourceBundle: bounded(dashOr(field(parts, 7)), MAX_PREVIEW),
      };
    }
    return { kind: "unknown", line: line };
  }
  if (is(head, asciiBytes("clip-skip"))) return { kind: "clip_skip", reason: field(parts, 1) };
  if (is(head, asciiBytes("ax"))) return { kind: "ax", trusted: is(field(parts, 1), asciiBytes("1")) };
  if (is(head, asciiBytes("result"))) return { kind: "result", word: field(parts, 1) };
  if (is(head, asciiBytes("chunk"))) return { kind: "chunk", text: dashOr(field(parts, 1)) };
  if (is(head, asciiBytes("done"))) return { kind: "done" };
  if (is(head, asciiBytes("error"))) {
    return { kind: "helper_error", code: field(parts, 1), message: dashOr(field(parts, 2)) };
  }
  return { kind: "unknown", line: line };
}
