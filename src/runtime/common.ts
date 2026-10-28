import { msToSerial, wallClockMs } from "./dates";

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
  /** A fixed "now" for TODAY() / NOW(); defaults to the current time. */
  now?: Date | string;
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

/**
 * Airtable field names are case-insensitive ({NUM5} finds "num5"): the exact name wins, otherwise the
 * first name that matches ignoring case, otherwise the name as written.
 */
export function matchFieldName(name: string, known: Iterable<string>): string {
  const lower = name.toLowerCase();
  let found: string | undefined;
  for (const k of known) {
    if (k === name) return k;
    if (found === undefined && k.toLowerCase() === lower) found = k;
  }
  return found ?? name;
}

/** A Sheets/Excel date field as a serial number ("2024-01-15", "2024-01-15T10:30", a Date, or a serial). */
export function dateField(raw: unknown, field: string): Value {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") return normalize(raw, field);
  const ms = wallClockMs(raw);
  if (ms === undefined) throw new TypeError(`Field "${field}" should be a date (YYYY-MM-DD[THH:MM[:SS]] or a Date), got ${JSON.stringify(raw)}`);
  return msToSerial(ms);
}

export function column(ctx: EvalContext | undefined, field: string, type?: string): RefArg {
  if (!ctx?.rows) throw new TypeError(`The formula uses a whole-column range of "${field}"; pass ctx.rows`);
  const read = type === "date" ? dateField : normalize;
  return { ref: true, values: ctx.rows.map((r) => read(r[field], field)) };
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

// ---------------------------------------------------------------- Airtable (JavaScript-like)

/** Decimal / Infinity text as JavaScript's Number() reads it (hex and binary forms are not supported). */
export const JS_NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
export const JS_NUMBER_TEXT_SQL = "^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$";

/** JavaScript Number(text): "" and spaces → 0, "3" → 3, "a" → NaN. Airtable uses this for + - and numeric functions. */
export function jsNumber(s: string): number {
  const t = s.replace(/^\s+|\s+$/g, "");
  if (t === "") return 0;
  if (JS_NUMBER_TEXT.test(t)) return Number(t);
  if (/^[+-]?Infinity$/.test(t)) return Number(t);
  return NaN;
}

/**
 * Airtable VALUE(): keeps only digits and ".", any "-" makes it negative,
 * "%" divides by 100 (VALUE("$1,000") = 1000, VALUE("5-3") = -53, VALUE("abc") = 0).
 */
export function airtableValue(s: string): number {
  const digits = s.replace(/[^0-9.]/g, "");
  if (digits === "") return 0;
  let n = /^\d*\.?\d*$/.test(digits) && digits !== "." ? Number(digits) : NaN;
  if (s.includes("-")) n = -n;
  if (s.includes("%")) n = n / 100;
  return n;
}

// ---------------------------------------------------------------- Google Sheets

/**
 * Text Google Sheets reads as a number in arithmetic and VALUE(): optional
 * sign or (parentheses), "$", thousands commas, decimals, trailing "%".
 * No exponent ("1e3" is not a number). Checked against Sheets.
 */
export const SHEETS_NUMBER_TEXT = /^\s*(\()?([+-])?\$?([+-])?((\d{1,3}(,\d{3})+|\d+)(\.\d*)?|\.\d+)(%)?(\))?\s*$/;
export const SHEETS_NUMBER_TEXT_SQL = "^\\s*(\\()?([+-])?\\$?([+-])?((\\d{1,3}(,\\d{3})+|\\d+)(\\.\\d*)?|\\.\\d+)(%)?(\\))?\\s*$";

export function sheetsNumber(s: string): number | undefined {
  const m = SHEETS_NUMBER_TEXT.exec(s);
  if (!m || Boolean(m[1]) !== Boolean(m[9]) || (m[2] && m[3])) return undefined;
  let n = Number(m[4]!.replace(/,/g, ""));
  if (m[1] || m[2] === "-" || m[3] === "-") n = -n;
  if (m[8]) n = n / 100;
  return n;
}

/** Number literals in Sheets/Excel formulas keep 15 significant digits (the rest become 0). */
export function truncateTo15Digits(text: string): string {
  const [mant, exp] = text.toLowerCase().split("e") as [string, string | undefined];
  let seen = 0;
  let started = false;
  let out = "";
  for (const c of mant) {
    if (c >= "0" && c <= "9") {
      if (c !== "0") started = true;
      if (started) seen++;
      out += started && seen > 15 ? "0" : c;
    } else out += c;
  }
  return exp === undefined ? out : `${out}e${exp}`;
}

// ---------------------------------------------------------------- Excel

/**
 * Text Excel reads as a number: like Sheets ("$1,000", "50%", "(5)", "-$5") plus an exponent
 * ("1e3", "1.5E+3%" = 15); "" and "(-5)" are not numbers. Checked against Excel for the web.
 */
export const EXCEL_NUMBER_TEXT = /^\s*(\()?([+-])?\$?([+-])?((\d{1,3}(,\d{3})+|\d+)(\.\d*)?|\.\d+)([eE][+-]?\d+)?(%)?(\))?\s*$/;
export const EXCEL_NUMBER_TEXT_SQL = "^\\s*(\\()?([+-])?\\$?([+-])?((\\d{1,3}(,\\d{3})+|\\d+)(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?(%)?(\\))?\\s*$";

export function excelNumber(s: string): number | undefined {
  const m = EXCEL_NUMBER_TEXT.exec(s);
  if (!m || Boolean(m[1]) !== Boolean(m[10]) || (m[2] && m[3]) || (m[1] && (m[2] || m[3]))) return undefined;
  let n = Number(s.replace(/[$,()%\s]/g, ""));
  if (m[1]) n = -n;
  if (m[9]) n = n / 100;
  return n;
}
