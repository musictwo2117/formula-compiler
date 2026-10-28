/**
 * JS runtime helpers for compiled Airtable formulas. The rules here must stay
 * in step with the Airtable semantics in src/codegen/sql.ts — the test-suite
 * runs every case through both.
 */
import {
  ASCII_SPACE_TRIM,
  FormulaError,
  NUMERIC_TEXT,
  chars,
  indexOfChars,
  isError,
  normalize,
  roundDecimal,
  stripCurrency,
  substituteText,
  type EvalContext,
  type RoundMode,
  type Value,
} from "./common";

type Thunk = () => Value;
const ERR = "#ERROR!";
const err = () => new FormulaError(ERR);

/** Airtable treats an empty string like an empty field. */
const isBlank = (x: Value): x is null | "" => x === null || x === "";

function num(x: Value): number | FormulaError {
  if (isError(x)) return x;
  if (isBlank(x)) return 0;
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  return err(); // text in arithmetic: see docs/behavior-notes.md (unverified)
}

function text(x: Value): string | FormulaError {
  if (isError(x)) return x;
  if (isBlank(x)) return "";
  if (typeof x === "number") return String(x);
  if (typeof x === "boolean") return x ? "1" : "0";
  return x;
}

function truthy(x: Value): boolean | FormulaError {
  if (isError(x)) return x;
  if (isBlank(x)) return false;
  if (typeof x === "number") return x !== 0;
  if (typeof x === "boolean") return x;
  return true;
}

function finite(n: number): number | FormulaError {
  return Number.isFinite(n) ? n : err();
}

function arith(a: Value, b: Value, f: (x: number, y: number) => number | FormulaError): Value {
  const x = num(a);
  if (isError(x)) return x;
  const y = num(b);
  if (isError(y)) return y;
  const r = f(x, y);
  return isError(r) ? r : finite(r);
}

type Kind = "blank" | "number" | "text" | "boolean";
const kindOf = (x: Exclude<Value, FormulaError>): Kind =>
  isBlank(x) ? "blank" : typeof x === "number" ? "number" : typeof x === "boolean" ? "boolean" : "text";

function order(a: number | string, b: number | string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** -1 / 0 / 1 comparison following Airtable's rules (see behavior notes). */
function compare(a: Exclude<Value, FormulaError>, b: Exclude<Value, FormulaError>): number {
  let ka = kindOf(a);
  let kb = kindOf(b);
  if (ka === "blank" && kb === "blank") return 0;
  if (ka === "blank") {
    a = kb === "number" ? 0 : kb === "boolean" ? false : "";
    ka = kb;
  } else if (kb === "blank") {
    b = ka === "number" ? 0 : ka === "boolean" ? false : "";
    kb = ka;
  }
  if (ka === "text" || kb === "text") return order(text(a) as string, text(b) as string);
  return order(num(a) as number, num(b) as number);
}

function cmp(op: string, a: Value, b: Value): Value {
  if (isError(a)) return a;
  if (isError(b)) return b;
  const c = compare(a, b);
  switch (op) {
    case "=": return c === 0;
    case "<>": return c !== 0;
    case "<": return c < 0;
    case ">": return c > 0;
    case "<=": return c <= 0;
    default: return c >= 0;
  }
}

function firstError(xs: Value[]): FormulaError | undefined {
  return xs.find(isError);
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

function round(mode: RoundMode) {
  return (x: Value, d: Value): Value => {
    const n = num(x);
    if (isError(n)) return n;
    const p = num(d);
    if (isError(p)) return p;
    return roundDecimal(n, Math.trunc(p), mode);
  };
}

function strArgs<T>(xs: Value[], f: (...s: string[]) => T): T | FormulaError {
  const out: string[] = [];
  for (const x of xs) {
    const t = text(x);
    if (isError(t)) return t;
    out.push(t);
  }
  return f(...out);
}

function count(x: Value): number | FormulaError {
  const n = num(x);
  return isError(n) ? n : Math.max(0, Math.trunc(n));
}

export const airtableRuntime = {
  v: normalize,
  err: (code: string): Value => new FormulaError(code),
  result: (x: Value): Value => x,
  col: (): never => {
    throw new TypeError("Airtable formulas have no column ranges");
  },
  ref: (x: Value) => x,
  neg: (a: Value): Value => arith(0, a, (_, y) => -y),
  pos: (a: Value): Value => a,
  percent: (a: Value): Value => arith(a, 100, (x, y) => x / y),
  add: (a: Value, b: Value) => arith(a, b, (x, y) => x + y),
  sub: (a: Value, b: Value) => arith(a, b, (x, y) => x - y),
  mul: (a: Value, b: Value) => arith(a, b, (x, y) => x * y),
  div: (a: Value, b: Value) => arith(a, b, (x, y) => (y === 0 ? err() : x / y)),
  pow: (a: Value, b: Value) => arith(a, b, (x, y) => Math.pow(x, y)),
  concat: (a: Value, b: Value): Value => strArgs([a, b], (x, y) => x + y),
  cmp,

  IF(c: Value, then: Thunk, otherwise?: Thunk): Value {
    const t = truthy(c);
    if (isError(t)) return t;
    return t ? then() : otherwise ? otherwise() : null;
  },
  AND(...xs: Value[]): Value {
    const e = firstError(xs);
    return e ?? xs.every((x) => truthy(x) === true);
  },
  OR(...xs: Value[]): Value {
    const e = firstError(xs);
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
  ISERROR: (x: Value): Value => isError(x),
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

  ROUND: round("halfUp"),
  ROUNDUP: round("up"),
  ROUNDDOWN: round("down"),
  ABS: (x: Value): Value => {
    const n = num(x);
    return isError(n) ? n : Math.abs(n);
  },
  INT: (x: Value): Value => {
    const n = num(x);
    return isError(n) ? n : Math.floor(n);
  },
  MOD: (a: Value, b: Value) => arith(a, b, (x, y) => (y === 0 ? err() : x - y * Math.trunc(x / y))),
  SUM(...xs: Value[]): Value {
    const ns = numbers(xs);
    return isError(ns) ? ns : finite(ns.reduce((s, n) => s + n, 0));
  },
  AVERAGE(...xs: Value[]): Value {
    const ns = numbers(xs);
    return isError(ns) ? ns : finite(ns.reduce((s, n) => s + n, 0) / ns.length);
  },
  MIN(...xs: Value[]): Value {
    const ns = numbers(xs);
    return isError(ns) ? ns : Math.min(...ns);
  },
  MAX(...xs: Value[]): Value {
    const ns = numbers(xs);
    return isError(ns) ? ns : Math.max(...ns);
  },
  VALUE(x: Value): Value {
    if (isError(x)) return x;
    if (typeof x === "number") return x;
    if (isBlank(x)) return 0;
    if (typeof x === "boolean") return x ? 1 : 0;
    const t = stripCurrency(x);
    return NUMERIC_TEXT.test(t) ? Number(t.trim()) : err();
  },

  LEN: (x: Value): Value => strArgs([x], (s) => chars(s).length),
  UPPER: (x: Value): Value => strArgs([x], (s) => s.toUpperCase()),
  LOWER: (x: Value): Value => strArgs([x], (s) => s.toLowerCase()),
  TRIM: (x: Value): Value => strArgs([x], (s) => s.replace(ASCII_SPACE_TRIM, "")),
  CONCATENATE: (...xs: Value[]): Value => strArgs(xs, (...s) => s.join("")),
  LEFT(x: Value, n: Value): Value {
    const k = count(n);
    return isError(k) ? k : strArgs([x], (s) => chars(s).slice(0, k).join(""));
  },
  RIGHT(x: Value, n: Value): Value {
    const k = count(n);
    return isError(k) ? k : strArgs([x], (s) => (k === 0 ? "" : chars(s).slice(-k).join("")));
  },
  MID(x: Value, start: Value, n: Value): Value {
    const s0 = num(start);
    if (isError(s0)) return s0;
    const k = count(n);
    if (isError(k)) return k;
    const from = Math.max(1, Math.trunc(s0)) - 1;
    return strArgs([x], (s) => chars(s).slice(from, from + k).join(""));
  },
  FIND(needle: Value, hay: Value, start?: Value): Value {
    const from = start === undefined ? 0 : count(start);
    if (isError(from)) return from;
    return strArgs([needle, hay], (n, h) => indexOfChars(chars(h), chars(n), from) + 1);
  },
  SEARCH(needle: Value, hay: Value, start?: Value): Value {
    const from = start === undefined ? 0 : count(start);
    if (isError(from)) return from;
    const r = strArgs([needle, hay], (n, h) => indexOfChars(chars(h), chars(n), from) + 1);
    return r === 0 ? null : r;
  },
  SUBSTITUTE(x: Value, o: Value, n: Value, index?: Value): Value {
    let idx: number | undefined;
    if (index !== undefined) {
      const i = num(index);
      if (isError(i)) return i;
      idx = Math.trunc(i);
      if (idx < 1) return err();
    }
    return strArgs([x, o, n], (s, a, b) => substituteText(s, a, b, idx));
  },
  REPLACE(x: Value, start: Value, n: Value, repl: Value): Value {
    const s0 = num(start);
    if (isError(s0)) return s0;
    const k = count(n);
    if (isError(k)) return k;
    const from = Math.max(1, Math.trunc(s0)) - 1;
    return strArgs([x, repl], (s, r) => {
      const c = chars(s);
      return c.slice(0, from).join("") + r + c.slice(from + k).join("");
    });
  },
};

export type AirtableRuntime = typeof airtableRuntime;
export type { EvalContext };
