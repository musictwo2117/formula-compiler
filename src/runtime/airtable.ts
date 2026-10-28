/**
 * JS runtime helpers for compiled Airtable formulas. Airtable behaves much
 * like JavaScript (checked against a real base, see docs/behavior-notes.md):
 * + and - read text with Number(), * and / reject text, x/0 is Infinity,
 * mixed comparisons are numeric. Keep in step with airtableSemantics in
 * src/codegen/sql.ts — the test-suite runs every case through both.
 */
import {
  FormulaError,
  airtableValue,
  chars,
  indexOfChars,
  isError,
  jsNumber,
  matchFieldName,
  normalize,
  substituteText,
  type EvalContext,
  type Value,
} from "./common";
import type { FieldType } from "../core/types";

type Thunk = () => Value;
const ERR = "#ERROR!";
const err = () => new FormulaError(ERR);

/** Airtable treats an empty string like an empty field. */
const isBlank = (x: Value): x is null | "" => x === null || x === "";

/** Number for + - and numeric functions: text goes through Number(). */
function num(x: Value): number | FormulaError {
  if (isError(x)) return x;
  if (isBlank(x)) return 0;
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  return jsNumber(x);
}

/** Number for * and /: any text, even empty, is an error. */
function strictNum(x: Value): number | FormulaError {
  return typeof x === "string" ? err() : num(x);
}

/** Text for & and CONCATENATE. */
function text(x: Value): string | FormulaError {
  if (isError(x)) return x;
  if (isBlank(x)) return "";
  if (typeof x === "number") return String(x);
  if (typeof x === "boolean") return x ? "TRUE" : "FALSE";
  return x;
}

/** Text argument of a text function (LEN, LEFT, ...): numbers and booleans are errors. */
function textArg(x: Value): string | FormulaError {
  if (isError(x)) return x;
  if (isBlank(x)) return "";
  return typeof x === "string" ? x : err();
}

function truthy(x: Value): boolean | FormulaError {
  if (isError(x)) return x;
  if (isBlank(x)) return false;
  if (typeof x === "number") return x !== 0 && !Number.isNaN(x);
  if (typeof x === "boolean") return x;
  return true;
}

function arith(a: Value, b: Value, f: (x: number, y: number) => number, strict = false): Value {
  const conv = strict ? strictNum : num;
  const x = conv(a);
  if (isError(x)) return x;
  const y = conv(b);
  if (isError(y)) return y;
  return f(x, y);
}

type Plain = Exclude<Value, FormulaError>;

/** JavaScript-style loose comparison: -1 / 0 / 1, or NaN when not comparable. */
function compare(a: Plain, b: Plain): number {
  if (isBlank(a) && isBlank(b)) return 0;
  if (isBlank(a)) a = typeof b === "string" ? "" : 0;
  if (isBlank(b)) b = typeof a === "string" ? "" : 0;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  const x = num(a) as number;
  const y = num(b) as number;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  return x < y ? -1 : x > y ? 1 : 0;
}

function cmp(op: string, a: Value, b: Value): Value {
  if (isError(a)) return a;
  if (isError(b)) return b;
  const c = compare(a, b);
  if (Number.isNaN(c)) return op === "<>";
  switch (op) {
    case "=": return c === 0;
    case "<>": return c !== 0;
    case "<": return c < 0;
    case ">": return c > 0;
    case "<=": return c <= 0;
    default: return c >= 0;
  }
}

function numbers(xs: Value[]): number[] | FormulaError {
  const out: number[] = [];
  for (const x of xs) {
    const n = num(x);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

/** MIN / MAX / AVERAGE skip blanks and text. */
function countedNumbers(xs: Value[]): number[] | FormulaError {
  const out: number[] = [];
  for (const x of xs) {
    if (isError(x)) return x;
    if (typeof x === "number") out.push(x);
    else if (typeof x === "boolean") out.push(x ? 1 : 0);
  }
  return out;
}

function strArgs<T>(xs: Value[], f: (...s: string[]) => T, conv: (x: Value) => string | FormulaError = textArg): T | FormulaError {
  const out: string[] = [];
  for (const x of xs) {
    const t = conv(x);
    if (isError(t)) return t;
    out.push(t);
  }
  return f(...out);
}

/** Field read: blank text fields are "", unchecked checkboxes are blank. */
function field(raw: unknown, name: string, type?: FieldType): Value {
  const v = normalize(raw, name);
  if (v === false) return null;
  if (v === null && type === "text") return "";
  return v;
}

/** JavaScript substring() on code points: arguments truncated, clamped to [0, length], swapped if reversed. */
function substring(c: string[], start: number, end = c.length): string {
  const clamp = (n: number) => Math.min(Math.max(Number.isNaN(n) ? 0 : Math.trunc(n), 0), c.length);
  const [a, b] = [clamp(start), clamp(end)];
  return c.slice(Math.min(a, b), Math.max(a, b)).join("");
}

export const airtableRuntime = {
  v: (raw: unknown, name: string): Value => field(raw, name),
  /** The record key for a field name, ignoring case like Airtable does. */
  key: (record: Record<string, unknown>, name: string): string => (name in record ? name : matchFieldName(name, Object.keys(record))),
  f: field,
  err: (code: string): Value => new FormulaError(code),
  result: (x: Value): Value => x,
  /** A not-found SEARCH shows as empty when it is the whole formula (but is 0 inside expressions). */
  searchResult: (x: Value): Value => (x === 0 ? null : x),
  col: (): never => {
    throw new TypeError("Airtable formulas have no column ranges");
  },
  ref: (x: Value) => x,
  neg: (a: Value): Value => arith(0, a, (_, y) => -y),
  pos: (a: Value): Value => a,
  percent: (a: Value): Value => arith(a, 100, (x, y) => x / y),
  add: (a: Value, b: Value) => arith(a, b, (x, y) => x + y),
  sub: (a: Value, b: Value) => arith(a, b, (x, y) => x - y),
  mul: (a: Value, b: Value) => arith(a, b, (x, y) => x * y, true),
  div: (a: Value, b: Value) => arith(a, b, (x, y) => x / y, true),
  pow: (a: Value, b: Value) => arith(a, b, (x, y) => Math.pow(x, y)),
  concat: (a: Value, b: Value): Value => strArgs([a, b], (x, y) => x + y, text),
  cmp,

  IF(c: Value, then: Thunk, otherwise?: Thunk): Value {
    const t = truthy(c);
    if (isError(t)) return t;
    return t ? then() : otherwise ? otherwise() : null;
  },
  AND(...xs: Value[]): Value {
    const e = xs.find(isError);
    return e ?? xs.every((x) => truthy(x) === true);
  },
  OR(...xs: Value[]): Value {
    const e = xs.find(isError);
    return e ?? xs.some((x) => truthy(x) === true);
  },
  NOT(x: Value): Value {
    const t = truthy(x);
    return isError(t) ? t : !t;
  },
  TRUE: (): Value => true,
  FALSE: (): Value => false,
  BLANK: (): Value => null,
  ERROR: (): Value => err(),
  /** 1 for errors and for Infinity / NaN, else 0 (Airtable returns a number). */
  ISERROR: (x: Value): Value => (isError(x) || (typeof x === "number" && !Number.isFinite(x)) ? 1 : 0),
  T: (x: Value): Value => (isError(x) ? x : typeof x === "string" && x !== "" ? x : null),
  SWITCH(expr: Value, ...rest: (Value | Thunk)[]): Value {
    if (isError(expr)) return expr;
    let i = 0;
    for (; i + 1 < rest.length; i += 2) {
      const r = cmp("=", expr, rest[i] as Value);
      if (isError(r)) return r;
      if (r) return (rest[i + 1] as Thunk)();
    }
    return i < rest.length ? (rest[i] as Thunk)() : null;
  },

  /** Math.round(value × 10^precision) / 10^precision on doubles: ROUND(1.005, 2) = 1, ROUND(2.675, 2) = 2.68. */
  ROUND: (x: Value, d: Value) => arith(x, d, (n, p) => Math.round(n * 10 ** p) / 10 ** p),
  ROUNDUP: (x: Value, d: Value) => arith(x, d, (n, p) => (Math.sign(n) * Math.ceil(Math.abs(n) * 10 ** p)) / 10 ** p + 0),
  ROUNDDOWN: (x: Value, d: Value) => arith(x, d, (n, p) => (Math.sign(n) * Math.floor(Math.abs(n) * 10 ** p)) / 10 ** p + 0),
  ABS: (x: Value): Value => arith(x, 0, (n) => Math.abs(n)),
  INT: (x: Value): Value => arith(x, 0, (n) => Math.floor(n)),
  /** Sign of the divisor applied to |a| mod |b|: MOD(-7, 3) = 1, MOD(7, -3) = -1. */
  MOD: (a: Value, b: Value) =>
    arith(a, b, (x, y) => {
      const [ax, ay] = [Math.abs(x), Math.abs(y)];
      if (ay === 0) return NaN;
      return Math.sign(y) * (ax - ay * Math.trunc(ax / ay)) + 0;
    }),
  /** Blanks count as 0; numeric text counts; other text is skipped. */
  SUM(...xs: Value[]): Value {
    let total = 0;
    for (const x of xs) {
      if (isError(x)) return x;
      const n = num(x) as number;
      if (!(typeof x === "string" && Number.isNaN(n))) total += n;
    }
    return total;
  },
  AVERAGE(...xs: Value[]): Value {
    const ns = countedNumbers(xs);
    return isError(ns) ? ns : ns.reduce((s, n) => s + n, 0) / ns.length;
  },
  MIN(...xs: Value[]): Value {
    const ns = countedNumbers(xs);
    return isError(ns) ? ns : Math.min(...ns);
  },
  MAX(...xs: Value[]): Value {
    const ns = countedNumbers(xs);
    return isError(ns) ? ns : Math.max(...ns);
  },
  VALUE(x: Value): Value {
    if (isError(x)) return x;
    if (typeof x === "number") return x;
    if (isBlank(x)) return 0;
    if (typeof x === "boolean") return x ? 1 : 0;
    return airtableValue(x);
  },

  LEN: (x: Value): Value => strArgs([x], (s) => chars(s).length),
  UPPER: (x: Value): Value => strArgs([x], (s) => s.toUpperCase()),
  LOWER: (x: Value): Value => strArgs([x], (s) => s.toLowerCase()),
  TRIM: (x: Value): Value => strArgs([x], (s) => s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "")),
  CONCATENATE: (...xs: Value[]): Value => strArgs(xs, (...s) => s.join(""), text),
  LEFT(x: Value, n: Value): Value {
    const k = numbers([n]);
    if (isError(k)) return k;
    return strArgs([x], (s) => substring(chars(s), 0, k[0]!));
  },
  /** RIGHT("abc", 4) is "" in Airtable. */
  RIGHT(x: Value, n: Value): Value {
    const k = numbers([n]);
    if (isError(k)) return k;
    return strArgs([x], (s) => {
      const c = chars(s);
      const start = c.length - k[0]!;
      return start < 0 ? "" : substring(c, start);
    });
  },
  /** MID with whereToStart < 1 is "". */
  MID(x: Value, start: Value, n: Value): Value {
    const ks = numbers([start, n]);
    if (isError(ks)) return ks;
    const [st, k] = [Math.trunc(ks[0]!), Math.max(0, Math.trunc(ks[1]!))];
    return strArgs([x], (s) => (st < 1 ? "" : chars(s).slice(st - 1, st - 1 + k).join("")));
  },
  /** startFromPosition is 1-based (0 behaves like 1); 0 when not found. */
  FIND(needle: Value, hay: Value, start?: Value): Value {
    const ks = numbers([start ?? 1]);
    if (isError(ks)) return ks;
    const from = Math.max(Math.trunc(ks[0]!), 1) - 1;
    return strArgs([needle, hay], (n, h) => indexOfChars(chars(h), chars(n), from) + 1);
  },
  SEARCH(needle: Value, hay: Value, start?: Value): Value {
    return airtableRuntime.FIND(needle, hay, start);
  },
  /** index <= 0 or past the last occurrence changes nothing. */
  SUBSTITUTE(x: Value, o: Value, n: Value, index?: Value): Value {
    let idx: number | undefined;
    if (index !== undefined) {
      const i = numbers([index]);
      if (isError(i)) return i;
      idx = Math.trunc(i[0]!);
    }
    return strArgs([x, o, n], (s, a, b) => (idx !== undefined && idx < 1 ? s : substituteText(s, a, b, idx)));
  },
  /** string.substring(0, start-1) + replacement + string.substring(start-1+count). */
  REPLACE(x: Value, start: Value, n: Value, repl: Value): Value {
    const ks = numbers([start, n]);
    if (isError(ks)) return ks;
    const [st, k] = ks as [number, number];
    return strArgs([x, repl], (s, r) => {
      const c = chars(s);
      return substring(c, 0, st - 1) + r + substring(c, st - 1 + k);
    });
  },
};

export type AirtableRuntime = typeof airtableRuntime;
export type { EvalContext };
