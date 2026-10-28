/**
 * JS runtime helpers for compiled Google Sheets and Excel formulas. Keep in
 * step with spreadsheetSemantics in src/codegen/sql.ts and the SQL in
 * src/dialects/spreadsheet-functions.ts.
 */
import {
  FormulaError,
  NUMERIC_TEXT,
  excelNumber,
  sheetsNumber,
  chars,
  column,
  indexOfChars,
  isError,
  isRefArg,
  normalize,
  roundDecimal,
  substituteText,
  wildcardToRegexSource,
  type RefArg,
  type RoundMode,
  type Value,
} from "./common";

export type SpreadsheetVariant = "sheets" | "excel";
type Thunk = () => Value;
type Arg = Value | RefArg;
type Plain = Exclude<Value, FormulaError>;

const VALUE = "#VALUE!";
const e = (code: string) => new FormulaError(code);

/** Text as a number: Excel takes plain decimals; Sheets also "$1,000", "50%", "(5)" and "" (= 0), but not "1e3". */
export function textToNumber(x: string, variant: SpreadsheetVariant): number | undefined {
  return variant === "sheets" ? (x === "" ? 0 : sheetsNumber(x)) : excelNumber(x);
}

export function toNumber(x: Value, variant: SpreadsheetVariant = "excel"): number | FormulaError {
  if (isError(x)) return x;
  if (x === null) return 0;
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  return textToNumber(x, variant) ?? e(VALUE);
}

/** Number → text the way the SQL side does it: 15 significant digits, no exponent. */
export function numberToText(n: number, variant: SpreadsheetVariant = "excel"): string {
  if (n === 0) return "0";
  const a = Math.abs(n);
  const sci = () => n.toExponential(14).replace(/\.?0+e/, "e").toUpperCase();
  if (variant === "sheets") {
    if (a >= 1e21 || a < 1e-10) return sci();
    return n.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 15 });
  }
  // Excel writes the number out in full up to 20 characters, else 1E+20 / 3.33333333333333E-13.
  const plain = n.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 15 });
  return plain.replace("-", "").length > 20 ? sci().replace(/E([+-])(\d)$/, (_, sign: string, d: string) => `E${sign}0${d}`) : plain;
}

export function toText(x: Value, variant: SpreadsheetVariant = "excel"): string | FormulaError {
  if (isError(x)) return x;
  if (x === null) return "";
  if (typeof x === "number") return numberToText(x, variant);
  if (typeof x === "boolean") return x ? "TRUE" : "FALSE";
  return x;
}

export function toBool(x: Value): boolean | FormulaError {
  if (isError(x)) return x;
  if (x === null) return false;
  if (typeof x === "number") return x !== 0;
  if (typeof x === "boolean") return x;
  const u = x.toUpperCase();
  return u === "TRUE" ? true : u === "FALSE" ? false : e(VALUE);
}

const RANK = { number: 1, text: 2, boolean: 3 } as const;
type Kind = keyof typeof RANK;
const kindOf = (x: Exclude<Plain, null>): Kind => (typeof x === "number" ? "number" : typeof x === "boolean" ? "boolean" : "text");

/** Excel/Sheets ordering: blank takes the other side's empty value; numbers < text < booleans; text is case-insensitive. */
export function compare(a: Plain, b: Plain): number {
  if (a === null && b === null) return 0;
  if (a === null) a = kindOf(b!) === "number" ? 0 : kindOf(b!) === "text" ? "" : false;
  if (b === null) b = kindOf(a) === "number" ? 0 : kindOf(a) === "text" ? "" : false;
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) return RANK[ka] - RANK[kb];
  const x = ka === "text" ? (a as string).toLowerCase() : Number(a);
  const y = kb === "text" ? (b as string).toLowerCase() : Number(b);
  return x < y ? -1 : x > y ? 1 : 0;
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

function arith(a: Value, b: Value, f: (x: number, y: number) => number | FormulaError, variant: SpreadsheetVariant): Value {
  const x = toNumber(a, variant);
  if (isError(x)) return x;
  const y = toNumber(b, variant);
  if (isError(y)) return y;
  const r = f(x, y);
  return isError(r) || Number.isFinite(r) ? r : e("#NUM!");
}

function nums(xs: Value[], variant: SpreadsheetVariant): number[] | FormulaError {
  const out: number[] = [];
  for (const x of xs) {
    const n = toNumber(x, variant);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

function texts(xs: Value[], variant: SpreadsheetVariant): string[] | FormulaError {
  const out: string[] = [];
  for (const x of xs) {
    const t = toText(x, variant);
    if (isError(t)) return t;
    out.push(t);
  }
  return out;
}

/**
 * Numbers taken by SUM/AVERAGE/MIN/MAX: references contribute only their
 * numbers (text, booleans and blanks ignored); typed-in values are coerced.
 */
function aggregateNumbers(args: Arg[], variant: SpreadsheetVariant): number[] | FormulaError {
  const out: number[] = [];
  for (const a of args) {
    if (isRefArg(a)) {
      for (const v of a.values) {
        if (isError(v)) return v;
        if (typeof v === "number") out.push(v);
      }
    } else {
      const n = toNumber(a, variant);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** Truncated integer argument; errors pass through. */
function int(x: Value, variant: SpreadsheetVariant): number | FormulaError {
  const n = toNumber(x, variant);
  return isError(n) ? n : Math.trunc(n);
}

// ---------------------------------------------------------------- criteria (COUNTIF/SUMIF)

export type CriterionOperand =
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "blank" }
  /** Sheets: an empty criterion cell matches nothing. */
  | { kind: "nothing" };

export interface Criterion {
  op: "=" | "<>" | "<" | ">" | "<=" | ">=";
  operand: CriterionOperand;
}

export function parseCriterion(c: Plain, variant: SpreadsheetVariant = "excel"): Criterion {
  // An empty criterion cell matches nothing in Sheets and means 0 in Excel.
  if (c === null) return variant === "sheets" ? { op: "=", operand: { kind: "nothing" } } : { op: "=", operand: { kind: "number", value: 0 } };
  if (typeof c === "number") return { op: "=", operand: { kind: "number", value: c } };
  if (typeof c === "boolean") return { op: "=", operand: { kind: "boolean", value: c } };
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c)!;
  const op = (m[1] ?? "=") as Criterion["op"];
  const rest = m[2]!;
  if (rest === "") return { op, operand: { kind: "blank" } };
  if (NUMERIC_TEXT.test(rest)) return { op, operand: { kind: "number", value: Number(rest.trim()) } };
  const u = rest.toUpperCase();
  if (u === "TRUE" || u === "FALSE") return { op, operand: { kind: "boolean", value: u === "TRUE" } };
  return { op, operand: { kind: "text", value: rest } };
}

function ordered(op: Criterion["op"], c: number): boolean {
  return op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
}

/** Does one cell value satisfy the criterion? Mirrors criterionSql(). */
export function matchesCriterion(cell: Value, crit: Criterion, variant: SpreadsheetVariant = "excel"): boolean {
  if (isError(cell)) return false;
  const { op, operand } = crit;
  const isEq = op === "=";
  const isNe = op === "<>";
  switch (operand.kind) {
    case "nothing":
      return false;
    case "blank":
      if (isEq) return cell === null || cell === "";
      if (isNe) return cell !== null && cell !== "";
      return false;
    case "number":
      // "=5" also matches the text "5" (but "<>5" does not exclude it), in Sheets and Excel.
      if (isEq && typeof cell === "string") return cell !== "" && textToNumber(cell, variant) === operand.value;
      if (typeof cell !== "number") return isNe;
      if (isEq) return cell === operand.value;
      if (isNe) return cell !== operand.value;
      return ordered(op, cell < operand.value ? -1 : cell > operand.value ? 1 : 0);
    case "boolean":
      if (typeof cell !== "boolean") return isNe;
      if (isEq) return cell === operand.value;
      if (isNe) return cell !== operand.value;
      return false;
    case "text": {
      if (typeof cell !== "string") return isNe;
      const v = cell.toLowerCase();
      const p = operand.value.toLowerCase();
      if (isEq || isNe) {
        const hit = new RegExp(`^${wildcardToRegexSource(p)}$`, "u").test(v);
        return isEq ? hit : !hit;
      }
      return ordered(op, v < p ? -1 : v > p ? 1 : 0);
    }
  }
}

// ---------------------------------------------------------------- runtime

const findText = (n: string, h: string, from: number): number => indexOfChars(chars(h), chars(n), from);

export function createSpreadsheetRuntime(variant: SpreadsheetVariant) {
  const A = (a: Value, b: Value, f: (x: number, y: number) => number | FormulaError) => arith(a, b, f, variant);
  const N = (x: Value) => toNumber(x, variant);
  const X = (x: Value) => toText(x, variant);
  const TX = (xs: Value[]) => texts(xs, variant);
  const AG = (args: Arg[]) => aggregateNumbers(args, variant);
  const I = (x: Value) => int(x, variant);

  const round = (mode: RoundMode) => (x: Value, d: Value = 0): Value => {
    const n = N(x);
    if (isError(n)) return n;
    const p = N(d);
    if (isError(p)) return p;
    return roundDecimal(n, Math.trunc(p), mode);
  };

  const search = (needle: string, hay: string, from: number): number => {
    const h = hay.toLowerCase();
    const re = new RegExp(wildcardToRegexSource(needle.toLowerCase()), "gu");
    re.lastIndex = chars(h).slice(0, from).join("").length;
    const m = re.exec(h);
    return m ? chars(h.slice(0, m.index)).length : -1;
  };

  const findLike = (f: (needle: string, hay: string, from: number) => number) =>
    (needle: Value, hay: Value, start: Value = 1): Value => {
      const s = I(start);
      if (isError(s)) return s;
      const ts = TX([needle, hay]);
      if (isError(ts)) return ts;
      const [n, h] = ts as [string, string];
      // Excel FIND accepts a start one past the end (FIND("", "abc", 4) = 4); SEARCH and Sheets do not.
      const last = chars(h).length + (variant === "excel" && f === findText ? 1 : 0);
      if (s < 1 || s > last) return e(VALUE);
      const pos = f(n, h, s - 1);
      return pos < 0 ? e(VALUE) : pos + 1;
    };

  return {
    v: normalize,
    err: (code: string): Value => e(code),
    ref: (x: Value): RefArg => ({ ref: true, values: [x] }),
    col: column,
    /** Excel shows an empty referenced cell as 0 when it is the whole result; Sheets shows it empty. */
    result: (x: Value): Value => (variant === "excel" && x === null ? 0 : x),

    neg: (a: Value): Value => A(0, a, (_, y) => -y),
    pos: (a: Value): Value => a,
    percent: (a: Value): Value => A(a, 100, (x, y) => x / y),
    add: (a: Value, b: Value) => A(a, b, (x, y) => x + y),
    sub: (a: Value, b: Value) => A(a, b, (x, y) => x - y),
    mul: (a: Value, b: Value) => A(a, b, (x, y) => x * y),
    div: (a: Value, b: Value) => A(a, b, (x, y) => (y === 0 ? e("#DIV/0!") : x / y)),
    pow: (a: Value, b: Value) =>
      A(a, b, (x, y) => {
        if (x === 0 && y < 0) return e(variant === "sheets" ? "#NUM!" : "#DIV/0!");
        if (x === 0 && y === 0 && variant === "excel") return e("#NUM!");
        if (x < 0 && y !== Math.trunc(y)) return e("#NUM!");
        return Math.pow(x, y);
      }),
    concat: (a: Value, b: Value): Value => {
      const ts = TX([a, b]);
      return isError(ts) ? ts : ts.join("");
    },
    cmp,

    // logical
    IF(c: Value, then: Thunk, otherwise?: Thunk): Value {
      const b = toBool(c);
      if (isError(b)) return b;
      return b ? then() : otherwise ? otherwise() : false;
    },
    IFS(...pairs: Thunk[]): Value {
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        const b = toBool(pairs[i]!());
        if (isError(b)) return b;
        if (b) return pairs[i + 1]!();
      }
      return e("#N/A");
    },
    SWITCH(expr: Value, ...rest: (Value | Thunk)[]): Value {
      if (isError(expr)) return expr;
      let i = 0;
      for (; i + 1 < rest.length; i += 2) {
        const r = cmp("=", expr, rest[i] as Value);
        if (isError(r)) return r;
        if (r) return (rest[i + 1] as Thunk)();
      }
      return i < rest.length ? (rest[i] as Thunk)() : e("#N/A");
    },
    IFERROR: (x: Value, alt: Thunk): Value => (isError(x) ? alt() : x),
    IFNA: (x: Value, alt: Thunk): Value => (isError(x) && x.code === "#N/A" ? alt() : x),
    AND: (...args: Arg[]): Value => logical(args, (bs) => bs.every(Boolean)),
    OR: (...args: Arg[]): Value => logical(args, (bs) => bs.some(Boolean)),
    NOT(x: Value): Value {
      const b = toBool(x);
      return isError(b) ? b : !b;
    },
    TRUE: (): Value => true,
    FALSE: (): Value => false,
    ISBLANK: (x: Value): Value => x === null,
    ISNUMBER: (x: Value): Value => typeof x === "number",
    ISTEXT: (x: Value): Value => typeof x === "string",

    // numbers
    ROUND: round("halfAwayFromZero"),
    ROUNDUP: round("up"),
    ROUNDDOWN: round("down"),
    ABS(x: Value): Value {
      const n = N(x);
      return isError(n) ? n : Math.abs(n);
    },
    INT(x: Value): Value {
      const n = N(x);
      return isError(n) ? n : Math.floor(n);
    },
    MOD: (a: Value, b: Value) => A(a, b, (x, y) => (y === 0 ? e("#DIV/0!") : x - y * Math.floor(x / y))),
    VALUE(x: Value): Value {
      if (isError(x)) return x;
      if (typeof x === "boolean") return e(VALUE);
      return N(x);
    },
    SUM(...args: Arg[]): Value {
      const ns = AG(args);
      return isError(ns) ? ns : ns.reduce((s, n) => s + n, 0);
    },
    AVERAGE(...args: Arg[]): Value {
      const ns = AG(args);
      if (isError(ns)) return ns;
      return ns.length === 0 ? e("#DIV/0!") : ns.reduce((s, n) => s + n, 0) / ns.length;
    },
    MIN(...args: Arg[]): Value {
      const ns = AG(args);
      return isError(ns) ? ns : ns.length ? Math.min(...ns) : 0;
    },
    MAX(...args: Arg[]): Value {
      const ns = AG(args);
      return isError(ns) ? ns : ns.length ? Math.max(...ns) : 0;
    },
    COUNT(...args: Arg[]): Value {
      let n = 0;
      for (const a of args) {
        if (isRefArg(a)) n += a.values.filter((v) => typeof v === "number").length;
        else if (typeof a === "number" || typeof a === "boolean" || (typeof a === "string" && textToNumber(a, variant) !== undefined)) n++;
      }
      return n;
    },
    COUNTA(...args: Arg[]): Value {
      let n = 0;
      for (const a of args) n += isRefArg(a) ? a.values.filter((v) => v !== null).length : 1;
      return n;
    },
    COUNTIF(range: RefArg, criterion: Value): Value {
      if (isError(criterion)) return criterion;
      const c = parseCriterion(criterion, variant);
      return range.values.filter((v) => matchesCriterion(v, c, variant)).length;
    },
    SUMIF(range: RefArg, criterion: Value, sumRange?: RefArg): Value {
      if (isError(criterion)) return criterion;
      const c = parseCriterion(criterion, variant);
      const sums = (sumRange ?? range).values;
      let total = 0;
      range.values.forEach((v, i) => {
        const s = sums[i];
        if (matchesCriterion(v, c, variant) && typeof s === "number") total += s;
      });
      return total;
    },

    // text
    LEN(x: Value): Value {
      const t = X(x);
      return isError(t) ? t : variant === "sheets" ? t.length : chars(t).length;
    },
    UPPER(x: Value): Value {
      const t = X(x);
      return isError(t) ? t : t.toUpperCase();
    },
    LOWER(x: Value): Value {
      const t = X(x);
      return isError(t) ? t : t.toLowerCase();
    },
    TRIM(x: Value): Value {
      const t = X(x);
      const ends = variant === "sheets" ? /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g : /^ +| +$/g;
      return isError(t) ? t : t.replace(ends, "").replace(/ {2,}/g, " ");
    },
    CONCATENATE(...xs: Value[]): Value {
      const ts = TX(xs);
      return isError(ts) ? ts : ts.join("");
    },
    TEXTJOIN(delim: Value, ignoreEmpty: Value, ...xs: Value[]): Value {
      const d = X(delim);
      if (isError(d)) return d;
      const ig = toBool(ignoreEmpty);
      if (isError(ig)) return ig;
      const ts = TX(xs);
      if (isError(ts)) return ts;
      return (ig ? ts.filter((t) => t !== "") : ts).join(d);
    },
    LEFT(x: Value, n: Value = 1): Value {
      const k = I(n);
      if (isError(k)) return k;
      const t = X(x);
      if (isError(t)) return t;
      return k < 0 ? e(VALUE) : chars(t).slice(0, k).join("");
    },
    RIGHT(x: Value, n: Value = 1): Value {
      const k = I(n);
      if (isError(k)) return k;
      const t = X(x);
      if (isError(t)) return t;
      return k < 0 ? e(VALUE) : k === 0 ? "" : chars(t).slice(-k).join("");
    },
    MID(x: Value, start: Value, n: Value): Value {
      const s = I(start);
      if (isError(s)) return s;
      const k = I(n);
      if (isError(k)) return k;
      const t = X(x);
      if (isError(t)) return t;
      if (s < 1 || k < 0) return e(VALUE);
      return chars(t).slice(s - 1, s - 1 + k).join("");
    },
    FIND: findLike(findText),
    SEARCH: findLike(search),
    SUBSTITUTE(x: Value, o: Value, n: Value, instance?: Value): Value {
      let idx: number | undefined;
      if (instance !== undefined) {
        const i = I(instance);
        if (isError(i)) return i;
        if (i < 1) return e(VALUE);
        idx = i;
      }
      const ts = TX([x, o, n]);
      if (isError(ts)) return ts;
      const [t, a, b] = ts as [string, string, string];
      return substituteText(t, a, b, idx);
    },
    REPLACE(x: Value, start: Value, n: Value, repl: Value): Value {
      const s = I(start);
      if (isError(s)) return s;
      const k = I(n);
      if (isError(k)) return k;
      const ts = TX([x, repl]);
      if (isError(ts)) return ts;
      if (s < 1 || k < 0) return e(VALUE);
      const c = chars(ts[0]!);
      return c.slice(0, s - 1).join("") + ts[1] + c.slice(s - 1 + k).join("");
    },
  };
}

/** AND/OR: references ignore text and blanks; nothing left to test → #VALUE!. */
function logical(args: Arg[], f: (bs: boolean[]) => boolean): Value {
  const bs: boolean[] = [];
  for (const a of args) {
    if (isRefArg(a)) {
      for (const v of a.values) {
        if (isError(v)) return v;
        if (typeof v === "number") bs.push(v !== 0);
        else if (typeof v === "boolean") bs.push(v);
      }
    } else {
      const b = toBool(a);
      if (isError(b)) return b;
      bs.push(b);
    }
  }
  return bs.length === 0 ? e(VALUE) : f(bs);
}

export type SpreadsheetRuntime = ReturnType<typeof createSpreadsheetRuntime>;
