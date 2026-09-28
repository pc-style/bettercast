// Byte helpers the core needs beyond the SDK's byte-text methods:
// concatenation, equality, decimal <-> integer, base64 (helper protocol),
// and hex. Pure subset code; every function is total.

import { utf8Bytes } from "@native-sdk/core";

export const EMPTY: Uint8Array = new Uint8Array(0);

export function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function concat3(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length + c.length);
  out.set(a, 0);
  out.set(b, a.length);
  out.set(c, a.length + b.length);
  return out;
}

/// Join parts with a separator (measure, then fill once).
export function joinBytes(parts: readonly Uint8Array[], sep: Uint8Array): Uint8Array {
  let total = 0;
  for (const [i, p] of parts.entries()) {
    total += p.length;
    if (i > 0) total += sep.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const [i, p] of parts.entries()) {
    if (i > 0) {
      out.set(sep, at);
      at += sep.length;
    }
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && startsWithBytes(a, b);
}

/// Integer to decimal ASCII.
export function decimal(n: number): Uint8Array {
  return utf8Bytes(`${n}`);
}

/// Decimal ASCII (optional leading '-') to integer; -1 for anything else
/// when `fallback` is -1. Stops at the first non-digit.
export function parseDecimal(text: Uint8Array, fallback: number): number {
  if (text.length === 0) return fallback;
  let i = 0;
  let negative = false;
  if (text[0] === 45) {
    negative = true;
    i = 1;
  }
  if (i >= text.length) return fallback;
  let value = 0;
  let digits = 0;
  while (i < text.length) {
    const b = text[i];
    if (b < 48 || b > 57) break;
    value = value * 10 + (b - 48);
    digits += 1;
    i += 1;
  }
  if (digits === 0) return fallback;
  return negative ? -value : value;
}

function b64Char(v: number): number {
  if (v < 26) return 65 + v;
  if (v < 52) return 97 + (v - 26);
  if (v < 62) return 48 + (v - 52);
  if (v === 62) return 43;
  return 47;
}

function b64Value(c: number): number {
  if (c >= 65 && c <= 90) return c - 65;
  if (c >= 97 && c <= 122) return c - 97 + 26;
  if (c >= 48 && c <= 57) return c - 48 + 52;
  if (c === 43 || c === 45) return 62;
  if (c === 47 || c === 95) return 63;
  return -1;
}

/// Standard base64 with padding.
export function base64Encode(data: Uint8Array): Uint8Array {
  let outLen = 0;
  for (let k = 0; k < data.length; k += 3) outLen += 4;
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  while (i + 2 < data.length) {
    const n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out[o] = b64Char((n >> 18) & 63);
    out[o + 1] = b64Char((n >> 12) & 63);
    out[o + 2] = b64Char((n >> 6) & 63);
    out[o + 3] = b64Char(n & 63);
    o += 4;
    i += 3;
  }
  const rest = data.length - i;
  if (rest === 1) {
    const n = data[i] << 16;
    out[o] = b64Char((n >> 18) & 63);
    out[o + 1] = b64Char((n >> 12) & 63);
    out[o + 2] = 61;
    out[o + 3] = 61;
  } else if (rest === 2) {
    const n = (data[i] << 16) | (data[i + 1] << 8);
    out[o] = b64Char((n >> 18) & 63);
    out[o + 1] = b64Char((n >> 12) & 63);
    out[o + 2] = b64Char((n >> 6) & 63);
    out[o + 3] = 61;
  }
  return out;
}

/// Base64 (standard or url-safe, padding optional) to bytes. Invalid
/// characters are skipped; a dangling single sextet is dropped.
export function base64Decode(text: Uint8Array): Uint8Array {
  let size = 0;
  let pending = 0;
  for (const c of text) {
    if (b64Value(c) < 0) continue;
    pending += 1;
    if (pending === 4) {
      size += 3;
      pending = 0;
    }
  }
  if (pending === 2) size += 1;
  if (pending === 3) size += 2;
  const out = new Uint8Array(size);
  let acc = 0;
  let count = 0;
  let o = 0;
  for (const c of text) {
    const v = b64Value(c);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    count += 1;
    if (count === 4) {
      out[o] = (acc >> 16) & 255;
      out[o + 1] = (acc >> 8) & 255;
      out[o + 2] = acc & 255;
      o += 3;
      acc = 0;
      count = 0;
    }
  }
  if (count === 2) {
    out[o] = (acc >> 4) & 255;
  } else if (count === 3) {
    out[o] = (acc >> 10) & 255;
    out[o + 1] = (acc >> 2) & 255;
  }
  return out;
}

/// Split on single ASCII spaces (the helper protocol's field separator).
export function fields(line: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i <= line.length; i++) {
    if (i === line.length || line[i] === 32) {
      if (i > start) out.push(line.subarray(start, i));
      start = i + 1;
    }
  }
  return out;
}

// NOTE (SDK 0.10.1): the byte-text METHODS on Uint8Array documented by the
// ts-core skill (.trim, .startsWith, .toLowerCase, .includes(bytes),
// .indexOf(bytes), .split, ...) do NOT typecheck under the external core
// compiler in this SDK version. Use these functions instead.

export function startsWithBytes(hay: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > hay.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (hay[i] !== prefix[i]) return false;
  }
  return true;
}

/// Byte offset of the first `needle` in `hay`, -1 when absent (0 for an
/// empty needle).
export function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  const last = hay.length - needle.length;
  for (let i = 0; i <= last; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/// ASCII lowercase copy (non-ASCII bytes unchanged).
export function lowerAscii(text: Uint8Array): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const b = text[i];
    out[i] = b >= 65 && b <= 90 ? b + 32 : b;
  }
  return out;
}

function isSpace(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 13 || b === 11 || b === 12;
}

/// Trim ASCII whitespace (space, tab, LF, CR, VT, FF) from both ends; a view.
export function trimBytes(text: Uint8Array): Uint8Array {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text[start])) start += 1;
  while (end > start && isSpace(text[end - 1])) end -= 1;
  return text.subarray(start, end);
}

/// Offset of the first byte equal to `b`, -1 when absent
/// (Uint8Array.prototype.indexOf has no core-compiler lowering in 0.10.1).
export function indexOfByte(text: Uint8Array, b: number): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === b) return i;
  }
  return -1;
}

/// n + 1 for ids and counters, wrapping to 1 at 1e9. The `| 0` is what
/// makes the result provably whole for the core compiler (see
/// contract.md "Integer slots").
export function bump(n: number): number {
  if (n >= 0 && n < 1000000000) return (n + 1) | 0;
  return 1;
}
