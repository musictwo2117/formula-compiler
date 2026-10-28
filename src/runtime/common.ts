/** A spreadsheet/Airtable error value such as #DIV/0!. Errors are values, not exceptions. */
export class FormulaError {
  constructor(readonly code: string) {}
  toString(): string {
    return this.code;
  }
  toJSON(): { error: string } {
    return { error: this.code };
  }
}

export type Value = number | string | boolean | null | FormulaError;

/** A reference argument: values read from cells/columns rather than typed in. */
export interface RefArg {
  readonly ref: true;
  readonly values: readonly Value[];
}

export interface EvalContext {
  /** All rows of the table, for whole-column ranges (A:A, Table1[col]). */
  rows?: readonly Record<string, unknown>[];
}

export function isError(x: unknown): x is FormulaError {
  return x instanceof FormulaError;
}

export function isRefArg(x: unknown): x is RefArg {
  return typeof x === "object" && x !== null && (x as RefArg).ref === true;
}

/** Normalises a raw record value into a formula value. */
export function normalize(raw: unknown, field: string): Value {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new TypeError(`Field "${field}" holds a non-finite number`);
    return raw;
  }
  if (typeof raw === "string" || typeof raw === "boolean") return raw;
  if (raw instanceof FormulaError) return raw;
  throw new TypeError(`Field "${field}" holds a ${Array.isArray(raw) ? "list" : typeof raw}; only numbers, text, booleans and null are supported`);
}

export function column(ctx: EvalContext | undefined, field: string): RefArg {
  if (!ctx?.rows) throw new TypeError(`The formula uses a whole-column range of "${field}"; pass ctx.rows`);
  return { ref: true, values: ctx.rows.map((r) => normalize(r[field], field)) };
}

/** Numeric text as accepted by the coercion rules (both JS and SQL use this pattern). */
export const NUMERIC_TEXT = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
export const NUMERIC_TEXT_SQL = "^\\s*[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?\\s*$";

/** Airtable VALUE("$1000") = 1000 (documented): a "$" after an optional sign is dropped. */
export function stripCurrency(s: string): string {
  return s.replace(/^(\s*[+-]?)\$/, "$1");
}
export const STRIP_CURRENCY_SQL = { pattern: "^(\\s*[+-]?)\\$", replacement: "\\1" };

export type RoundMode = "halfAwayFromZero" | "halfUp" | "up" | "down";

/**
 * Decimal rounding that first snaps the binary double to 15 significant
 * digits (like Excel and like PostgreSQL's float8 → numeric cast), so
 * ROUND(2.675, 2) is 2.68 and the JS and SQL outputs agree.
 */
export function roundDecimal(x: number, places: number, mode: RoundMode): number {
  if (x === 0 || !Number.isFinite(x)) return x === 0 ? 0 : x;
  const digits = Math.max(-400, Math.min(400, Math.trunc(places))); // same clamp as the SQL side
  const negative = x < 0;
  const [mant, expPart] = Math.abs(x).toExponential(14).split("e") as [string, string];
  const allDigits = mant.replace(".", ""); // 15 digits
  const exp = Number(expPart);
  // value = 0.d1d2...d15 × 10^(exp+1); keep `keep` digits
  const keep = exp + 1 + digits;
  if (keep >= 15) return Number(`${negative ? "-" : ""}${mant}e${exp}`);
  const padded = keep < 0 ? "0".repeat(-keep) + allDigits : allDigits;
  const k = Math.max(keep, 0);
  const kept = padded.slice(0, k);
  const rest = padded.slice(k);
  const first = Number(rest[0] ?? "0");
  const anyNonZero = /[1-9]/.test(rest);
  const tailNonZero = /[1-9]/.test(rest.slice(1));
  let inc = false;
  switch (mode) {
    case "down":
      inc = false;
      break;
    case "up":
      inc = anyNonZero;
      break;
    case "halfAwayFromZero":
      inc = first >= 5;
      break;
    case "halfUp": // ties toward +infinity
      inc = negative ? first > 5 || (first === 5 && tailNonZero) : first >= 5;
      break;
  }
  const keptInt = (kept === "" ? 0 : Number(kept)) + (inc ? 1 : 0);
  const result = Number(`${keptInt}e${-digits}`);
  return negative && result !== 0 ? -result : result;
}

/** Strings are handled as code points so JS lengths match PostgreSQL length(). */
export function chars(s: string): string[] {
  return Array.from(s);
}

/** Position (0-based, in code points) of needle in hay at or after from; -1 if absent. */
export function indexOfChars(hay: string[], needle: string[], from: number): number {
  outer: for (let i = Math.max(0, from); i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function substituteText(text: string, oldText: string, newText: string, instance: number | undefined): string {
  if (oldText === "") return text;
  const parts = text.split(oldText);
  if (instance === undefined) return parts.join(newText);
  if (parts.length <= instance) return text;
  return parts.slice(0, instance).join(oldText) + newText + parts.slice(instance).join(oldText);
}

/** Excel wildcard pattern (*, ?, ~ escapes) → RegExp source. */
export function wildcardToRegexSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    const n = pattern[i + 1];
    if (c === "~" && (n === "*" || n === "?" || n === "~")) {
      out += escapeRegex(n);
      i++;
    } else if (c === "*") out += "[\\s\\S]*";
    else if (c === "?") out += "[\\s\\S]";
    else out += escapeRegex(c);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}

export const ASCII_SPACE_TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
