// Forgiving calculator: a byte-level tokenizer plus a recursive-descent
// parser over the token list. No eval, no regex. `evaluate(query)` is total
// and pure and returns ok=false for anything that is not a calculation, so
// plain search text never shows a calculator row.
//
// Grammar (loosest first):
//   expr    := term (('+' | '-') term)*          a + b% = a * (1 + b/100)
//   term    := unary (('*' | 'x' | '×' | '/' | '÷' | 'of') unary | implicit)*
//              implicit multiplication: `2(3+4)`, `(1+2)(3+4)`, `(2)3`
//   unary   := ('-' | '+') unary | power          so -3^2 = -(3^2) = -9
//   power   := postfix ('^' | '**') unary          right-assoc; 2^-1 = 0.5
//   postfix := primary '%'*                        15% = 0.15
//   primary := number | '(' expr [')']            a missing ')' at the end
//                                                  of input auto-closes
// Numbers: `1.5`, `1,5` (comma decimal), `1,000` / `1,000.5` (a comma
// followed by exactly three digits is a thousands separator).
// A calculation needs at least one operator: `42` and `-5` are not results.
// Division by zero, overflow, and NaN are not results either.

import { utf8Bytes } from "@native-sdk/core";
import { EMPTY, concat2, concat3, trimBytes } from "./bytes.ts";

export interface CalcResult {
  readonly ok: boolean;
  readonly display: Uint8Array;
  readonly value: number;
}

const T_NUM = 1;
const T_PLUS = 2;
const T_MINUS = 3;
const T_MUL = 4;
const T_DIV = 5;
const T_POW = 6;
const T_PCT = 7;
const T_LP = 8;
const T_RP = 9;
const T_END = 0;

/// Parser result: value, next token index, whether the parse failed,
/// operators seen, and whether the value is a bare `N%` term.
interface Parsed {
  readonly v: number;
  readonly p: number;
  readonly bad: boolean;
  readonly ops: number;
  readonly pct: boolean;
}

interface Tokens {
  readonly kinds: readonly number[];
  readonly vals: readonly number[];
  readonly bad: boolean;
}

const NOT_CALC: CalcResult = { ok: false, display: EMPTY, value: 0 };

function isDigit(b: number): boolean {
  return b >= 48 && b <= 57;
}

/// The digit's value as a float (the division keeps the byte itself in an
/// integer slot while the accumulators stay fractional).
function digitValue(c: number): number {
  return (c - 48) / 1;
}

function isLetter(b: number): boolean {
  return (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
}

function tokenize(src: Uint8Array): Tokens {
  const kinds: number[] = [];
  const vals: number[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const b = src[i];
    if (b === 32 || b === 9) {
      i += 1;
      continue;
    }
    const startsNumber = isDigit(b) || ((b === 46 || b === 44) && i + 1 < n && isDigit(src[i + 1]));
    if (startsNumber) {
      // Float accumulators (0 / 1 keeps them out of integer slots).
      let whole = 0 / 1;
      let frac = 0 / 1;
      let fracScale = 1 / 1;
      let fracDigits = 0;
      let inFrac = false;
      let wholeDigits = 0;
      while (i < n) {
        const c = src[i];
        if (isDigit(c)) {
          if (inFrac) {
            if (fracDigits < 15) {
              frac = frac * 10 + digitValue(src[i]);
              fracScale = fracScale * 10;
              fracDigits += 1;
            }
          } else {
            whole = whole * 10 + digitValue(src[i]);
            wholeDigits += 1;
          }
          i += 1;
          continue;
        }
        if (c === 44 && !inFrac) {
          // Thousands separator: exactly three digits, then a non-digit.
          const three = wholeDigits > 0 && i + 3 < n && isDigit(src[i + 1]) && isDigit(src[i + 2]) && isDigit(src[i + 3]);
          const after = i + 4 < n ? src[i + 4] : 32;
          if (three && !isDigit(after)) {
            whole = whole * 1000 + digitValue(src[i + 1]) * 100 + digitValue(src[i + 2]) * 10 + digitValue(src[i + 3]);
            i += 4;
            continue;
          }
          if (i + 1 < n && isDigit(src[i + 1])) {
            inFrac = true;
            i += 1;
            continue;
          }
          break;
        }
        if (c === 46 && !inFrac) {
          inFrac = true;
          i += 1;
          continue;
        }
        break;
      }
      kinds.push(T_NUM);
      vals.push(fracDigits > 0 ? whole + frac / fracScale : whole);
      continue;
    }
    if (b === 43) { kinds.push(T_PLUS); vals.push(0); i += 1; continue; }
    if (b === 45) { kinds.push(T_MINUS); vals.push(0); i += 1; continue; }
    if (b === 42) {
      if (i + 1 < n && src[i + 1] === 42) {
        kinds.push(T_POW); vals.push(0); i += 2; continue;
      }
      kinds.push(T_MUL); vals.push(0); i += 1; continue;
    }
    if (b === 47) { kinds.push(T_DIV); vals.push(0); i += 1; continue; }
    if (b === 94) { kinds.push(T_POW); vals.push(0); i += 1; continue; }
    if (b === 37) { kinds.push(T_PCT); vals.push(0); i += 1; continue; }
    if (b === 40) { kinds.push(T_LP); vals.push(0); i += 1; continue; }
    if (b === 41) { kinds.push(T_RP); vals.push(0); i += 1; continue; }
    // × (C3 97) and ÷ (C3 B7).
    if (b === 195 && i + 1 < n && src[i + 1] === 151) { kinds.push(T_MUL); vals.push(0); i += 2; continue; }
    if (b === 195 && i + 1 < n && src[i + 1] === 183) { kinds.push(T_DIV); vals.push(0); i += 2; continue; }
    // − (E2 88 92, minus sign) and · (C2 B7, middle dot as multiply).
    if (b === 226 && i + 2 < n && src[i + 1] === 136 && src[i + 2] === 146) { kinds.push(T_MINUS); vals.push(0); i += 3; continue; }
    if (b === 194 && i + 1 < n && src[i + 1] === 183) { kinds.push(T_MUL); vals.push(0); i += 2; continue; }
    if (isLetter(b)) {
      let j = i;
      while (j < n && isLetter(src[j])) j += 1;
      const len = j - i;
      const prev = kinds.length > 0 ? kinds[kinds.length - 1] : T_END;
      const afterOperand = prev === T_NUM || prev === T_RP || prev === T_PCT;
      // `x` between operands is multiplication (12x4, 3 x 4).
      if (len === 1 && (b | 32) === 120 && afterOperand) {
        kinds.push(T_MUL); vals.push(0); i = j; continue;
      }
      // `of` after a percentage: 15% of 80.
      if (len === 2 && (b | 32) === 111 && (src[i + 1] | 32) === 102 && prev === T_PCT) {
        kinds.push(T_MUL); vals.push(0); i = j; continue;
      }
      return { kinds: [], vals: [], bad: true };
    }
    return { kinds: [], vals: [], bad: true };
  }
  return { kinds: kinds, vals: vals, bad: false };
}

function kindAt(t: Tokens, p: number): number {
  return p >= 0 && p < t.kinds.length ? t.kinds[p] : T_END;
}

function fail(p: number): Parsed {
  return { v: 0, p: p, bad: true, ops: 0, pct: false };
}

function parseExpr(t: Tokens, p0: number, depth: number): Parsed {
  if (depth > 64) return fail(p0);
  const first = parseTerm(t, p0, depth);
  if (first.bad) return first;
  let v = first.v;
  let p = first.p;
  let ops = first.ops;
  let pct = first.pct;
  for (;;) {
    const k = kindAt(t, p);
    if (k !== T_PLUS && k !== T_MINUS) break;
    const rhs = parseTerm(t, p + 1, depth);
    if (rhs.bad) return rhs;
    // a ± b% means a ± (b% of a).
    const r = rhs.pct ? v * rhs.v : rhs.v;
    v = k === T_PLUS ? v + r : v - r;
    p = rhs.p;
    ops += rhs.ops + 1;
    pct = false;
  }
  return { v: v, p: p, bad: false, ops: ops, pct: pct };
}

function parseTerm(t: Tokens, p0: number, depth: number): Parsed {
  const first = parseUnary(t, p0, depth);
  if (first.bad) return first;
  let v = first.v;
  let p = first.p;
  let ops = first.ops;
  let pct = first.pct;
  for (;;) {
    const k = kindAt(t, p);
    if (k === T_MUL || k === T_DIV) {
      const rhs = parseUnary(t, p + 1, depth);
      if (rhs.bad) return rhs;
      v = k === T_MUL ? v * rhs.v : v / rhs.v;
      p = rhs.p;
      ops += rhs.ops + 1;
      pct = false;
      continue;
    }
    const prev = kindAt(t, p - 1);
    const implicit = k === T_LP || (k === T_NUM && (prev === T_RP || prev === T_PCT));
    if (implicit) {
      const rhs = parsePower(t, p, depth);
      if (rhs.bad) return rhs;
      v = v * rhs.v;
      p = rhs.p;
      ops += rhs.ops + 1;
      pct = false;
      continue;
    }
    break;
  }
  return { v: v, p: p, bad: false, ops: ops, pct: pct };
}

function parseUnary(t: Tokens, p: number, depth: number): Parsed {
  const k = kindAt(t, p);
  if (k === T_MINUS || k === T_PLUS) {
    if (depth > 64) return fail(p);
    const inner = parseUnary(t, p + 1, depth + 1);
    if (inner.bad) return inner;
    return { v: k === T_MINUS ? -inner.v : inner.v, p: inner.p, bad: false, ops: inner.ops, pct: inner.pct };
  }
  return parsePower(t, p, depth);
}

function parsePower(t: Tokens, p: number, depth: number): Parsed {
  const base = parsePostfix(t, p, depth);
  if (base.bad) return base;
  if (kindAt(t, base.p) !== T_POW) return base;
  if (depth > 64) return fail(p);
  const exp = parseUnary(t, base.p + 1, depth + 1);
  if (exp.bad) return exp;
  return { v: base.v ** exp.v, p: exp.p, bad: false, ops: base.ops + exp.ops + 1, pct: false };
}

function parsePostfix(t: Tokens, p0: number, depth: number): Parsed {
  const prim = parsePrimary(t, p0, depth);
  if (prim.bad) return prim;
  let v = prim.v;
  let p = prim.p;
  let ops = prim.ops;
  let pct = prim.pct;
  while (kindAt(t, p) === T_PCT) {
    v = v / 100;
    p += 1;
    ops += 1;
    pct = true;
  }
  return { v: v, p: p, bad: false, ops: ops, pct: pct };
}

function parsePrimary(t: Tokens, p: number, depth: number): Parsed {
  const k = kindAt(t, p);
  if (k === T_NUM) return { v: t.vals[p], p: p + 1, bad: false, ops: 0, pct: false };
  if (k === T_LP) {
    if (depth > 64) return fail(p);
    const inner = parseExpr(t, p + 1, depth + 1);
    if (inner.bad) return inner;
    const close = kindAt(t, inner.p);
    // Parentheses alone are not operators: `(3)` is not a result, `(3+4` is.
    if (close === T_RP) return { v: inner.v, p: inner.p + 1, bad: false, ops: inner.ops, pct: false };
    if (close === T_END) return { v: inner.v, p: inner.p, bad: false, ops: inner.ops, pct: false };
    return fail(inner.p);
  }
  return fail(p);
}

// ---------------------------------------------------------------- formatting

/// ASCII digit for a float known to hold a whole value 0..9 (comparisons
/// keep the result integer-classed for the core compiler).
function digitChar(d: number): number {
  if (d < 0.5) return 48;
  if (d < 1.5) return 49;
  if (d < 2.5) return 50;
  if (d < 3.5) return 51;
  if (d < 4.5) return 52;
  if (d < 5.5) return 53;
  if (d < 6.5) return 54;
  if (d < 7.5) return 55;
  if (d < 8.5) return 56;
  return 57;
}

/// Decimal digits of a non-negative whole float (below 1e16), most
/// significant first. % 10 and floor(/ 10) are exact in that range.
function wholeDigits(whole: number): Uint8Array {
  const buf = new Uint8Array(24);
  let k = 24;
  let w = whole;
  if (w < 1) {
    k -= 1;
    buf[k] = 48;
  }
  while (w >= 1 && k > 0) {
    k -= 1;
    buf[k] = digitChar(w % 10);
    w = Math.floor(w / 10);
  }
  return buf.subarray(k, 24);
}

/// Fixed notation with up to `places` decimals (trailing zeros trimmed).
function fixed(a: number, places: number, scale: number): Uint8Array {
  let whole = Math.floor(a);
  let frac = Math.round((a - whole) * scale);
  if (frac >= scale) {
    whole += 1;
    frac = 0;
  }
  const head = wholeDigits(whole);
  if (frac <= 0) return head;
  const fd = new Uint8Array(places + 1);
  fd[0] = 46;
  let f = frac;
  for (let i = places; i >= 1; i--) {
    fd[i] = digitChar(f % 10);
    f = Math.floor(f / 10);
  }
  let end = places + 1;
  while (end > 1 && fd[end - 1] === 48) end -= 1;
  return concat2(head, fd.subarray(0, end));
}

/// Scientific notation with up to 10 significant digits: 1.2345e+20.
function scientific(a: number): Uint8Array {
  let m = a;
  let e = 0;
  while (m >= 10 && e < 400) {
    m = m / 10;
    e += 1;
  }
  while (m < 1 && e > -400) {
    m = m * 10;
    e -= 1;
  }
  const mant = fixed(m, 9, 1e9);
  // Rounding can carry 9.9999999999 up to "10": renormalize to 1e(E+1).
  const carried = mant.length === 2 && mant[0] === 49 && mant[1] === 48;
  const exp = carried ? e + 1 : e;
  const lead = carried ? utf8Bytes("1") : mant;
  const sign = exp < 0 ? utf8Bytes("e-") : utf8Bytes("e+");
  return concat3(lead, sign, wholeDigits(exp < 0 ? -exp : exp));
}

/// Human-readable number: fixed up to 10 decimals, scientific outside
/// [1e-6, 1e15). -0 prints as 0.
export function formatNumber(v: number): Uint8Array {
  if (!Number.isFinite(v)) return utf8Bytes("NaN");
  const neg = v < 0;
  const a = neg ? -v : v;
  if (a === 0) return utf8Bytes("0");
  const body = a >= 1e15 || a < 1e-6 ? scientific(a) : fixed(a, 10, 1e10);
  const isZero = body.length === 1 && body[0] === 48;
  return neg && !isZero ? concat2(utf8Bytes("-"), body) : body;
}

// ---------------------------------------------------------------- entry

export function evaluate(query: Uint8Array): CalcResult {
  const src = trimBytes(query);
  if (src.length === 0 || src.length > 256) return NOT_CALC;
  // Fast reject: a calculation starts with a digit, sign, '(' or '.'/','.
  const b = src[0];
  if (!(isDigit(b) || b === 40 || b === 45 || b === 43 || b === 46 || b === 44 || b === 226)) return NOT_CALC;
  const t = tokenize(src);
  if (t.bad || t.kinds.length === 0) return NOT_CALC;
  const r = parseExpr(t, 0, 0);
  if (r.bad || r.p !== t.kinds.length || r.ops === 0) return NOT_CALC;
  if (!Number.isFinite(r.v)) return NOT_CALC;
  return { ok: true, display: formatNumber(r.v), value: r.v };
}
