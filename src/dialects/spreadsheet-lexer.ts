/**
 * Lexer shared by Google Sheets and Excel. The dialect lexers configure it
 * (structured references are Excel-only; separators come from the locale).
 */
import type { CellAddress, ColumnAddress } from "../core/ast";
import type { Fail } from "../core/errors";
import {
  isDigit,
  isIdentPart,
  isIdentStart,
  isSpace,
  readErrorLiteral,
  readIdent,
  readNumber,
  readOperator,
  type Lexer,
  type StructuredTokenValue,
  type Token,
} from "../core/lexer-utils";
import type { LocaleOptions } from "../core/types";

const OPERATORS = ["<=", ">=", "<>", "!=", "==", "=", "<", ">", "+", "-", "*", "/", "^", "&", "%"] as const;

export interface SpreadsheetLexerOptions {
  structuredRefs: boolean;
  locale?: LocaleOptions;
}

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*)/;
const COL = /^(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9])/;
const MAX_COL = colNumber("XFD");

function colNumber(col: string): number {
  let n = 0;
  for (const c of col.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

function cellOf(m: RegExpExecArray): CellAddress {
  return { col: m[2]!.toUpperCase(), row: Number(m[4]), colAbsolute: m[1] === "$", rowAbsolute: m[3] === "$" };
}

function colOf(m: RegExpExecArray): ColumnAddress {
  return { col: m[2]!.toUpperCase(), colAbsolute: m[1] === "$" };
}

/** Is the reference at `end` really finished (not part of a longer name or a call)? */
function refEnds(src: string, end: number): boolean {
  const c = src[end];
  return !isIdentPart(c) && c !== "(" && c !== "[";
}

interface RefMatch {
  token: Omit<Token, "start" | "text">;
  end: number;
}

/** Try to read A1, $A$1, A1:B2 or A:A at pos. */
function readReference(src: string, pos: number, sheet: string | undefined): RefMatch | null {
  const rest = src.slice(pos);
  const a = CELL.exec(rest);
  if (a && colNumber(a[2]!) <= MAX_COL) {
    const afterA = pos + a[0].length;
    if (src[afterA] === ":") {
      const b = CELL.exec(src.slice(afterA + 1));
      if (b && refEnds(src, afterA + 1 + b[0].length)) {
        const end = afterA + 1 + b[0].length;
        return { token: { kind: "range", end, value: { sheet, from: cellOf(a), to: cellOf(b) } }, end };
      }
    }
    if (refEnds(src, afterA)) return { token: { kind: "cell", end: afterA, value: { sheet, address: cellOf(a) } }, end: afterA };
  }
  const c = COL.exec(rest);
  if (c && src[pos + c[0].length] === ":" && colNumber(c[2]!) <= MAX_COL) {
    const start2 = pos + c[0].length + 1;
    const d = COL.exec(src.slice(start2));
    if (d && refEnds(src, start2 + d[0].length)) {
      const end = start2 + d[0].length;
      return { token: { kind: "range", end, value: { sheet, from: colOf(c), to: colOf(d) } }, end };
    }
  }
  return null;
}

/** Reads a structured-reference name inside [...], honouring ' escapes. Returns [name, index of the closing ]]. */
function readBracketName(src: string, pos: number, fail: Fail, start: number): [string, number] {
  let name = "";
  let i = pos;
  for (;;) {
    if (i >= src.length) fail("SYNTAX", 'Unclosed structured reference: missing "]"', start, src.length);
    const c = src[i]!;
    if (c === "'" && i + 1 < src.length) {
      name += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "[") fail("SYNTAX", 'Unexpected "[" inside a structured reference name', i, i + 1);
    if (c === "]") return [name, i];
    name += c;
    i++;
  }
}

/** Reads [col], [@col], [@[col]], [[#This Row],[col]] starting at the "[". */
function readStructured(src: string, pos: number, table: string | undefined, fail: Fail, start: number): { value: StructuredTokenValue; end: number } {
  let i = pos + 1;
  const make = (column: string, thisRow: boolean, end: number) => {
    if (column.trim() === "") fail("SYNTAX", "Empty column name in structured reference", start, end);
    const value: StructuredTokenValue = { column, thisRow };
    if (table !== undefined) value.table = table;
    return { value, end };
  };
  if (src[i] === "@") {
    i++;
    if (src[i] === "[") {
      const [name, close] = readBracketName(src, i + 1, fail, start);
      if (src[close + 1] !== "]") fail("SYNTAX", 'Expected "]" to close the structured reference', close + 1, close + 2);
      return make(name, true, close + 2);
    }
    const [name, close] = readBracketName(src, i, fail, start);
    return make(name, true, close + 1);
  }
  if (src[i] === "[") {
    const items: string[] = [];
    for (;;) {
      if (src[i] !== "[") fail("SYNTAX", 'Expected "[" in structured reference', i, i + 1);
      const [name, close] = readBracketName(src, i + 1, fail, start);
      items.push(name);
      i = close + 1;
      while (isSpace(src[i])) i++;
      if (src[i] === ",") {
        i++;
        while (isSpace(src[i])) i++;
        continue;
      }
      if (src[i] === "]") break;
      fail("SYNTAX", 'Expected "," or "]" in structured reference', i, i + 1);
    }
    const end = i + 1;
    const specials = items.filter((s) => s.startsWith("#")).map((s) => s.toLowerCase());
    const columns = items.filter((s) => !s.startsWith("#"));
    const thisRow = specials.includes("#this row");
    const other = specials.filter((s) => s !== "#this row" && s !== "#data");
    if (other.length || columns.length !== 1) {
      fail("UNSUPPORTED_REFERENCE", "Only single-column structured references ([@col], Table[col], Table[[#This Row],[col]]) are supported", start, end);
    }
    return make(columns[0]!, thisRow, end);
  }
  const [name, close] = readBracketName(src, i, fail, start);
  if (name.startsWith("#")) fail("UNSUPPORTED_REFERENCE", `Structured reference specifier ${name} is not supported`, start, close + 1);
  return make(name, false, close + 1);
}

export function createSpreadsheetLexer(opts: SpreadsheetLexerOptions): Lexer {
  const argSep = opts.locale?.argumentSeparator ?? ",";
  const decimalSep = opts.locale?.decimalSeparator ?? ".";

  return (src: string, fail: Fail): Token[] => {
    const tokens: Token[] = [];
    let i = 0;
    while (isSpace(src[i])) i++;
    if (src[i] === "=") i++; // leading "=" is optional

    const push = (kind: Token["kind"], start: number, end: number, value?: unknown) => {
      const t: Token = { kind, text: src.slice(start, end), start, end };
      if (value !== undefined) t.value = value;
      tokens.push(t);
      i = end;
    };

    const referenceAfterSheet = (sheet: string, start: number, bang: number) => {
      const ref = readReference(src, bang + 1, sheet);
      if (!ref) fail("SYNTAX", `Expected a cell reference after "${src.slice(start, bang + 1)}"`, start, bang + 1);
      push(ref.token.kind, start, ref.end, ref.token.value);
    };

    while (i < src.length) {
      const ch = src[i]!;
      const start = i;
      if (isSpace(ch)) {
        i++;
        continue;
      }
      if (ch === '"') {
        let value = "";
        let j = i + 1;
        for (;;) {
          if (j >= src.length) fail("SYNTAX", 'Unclosed string: missing "', start, src.length);
          if (src[j] === '"') {
            if (src[j + 1] === '"') {
              value += '"';
              j += 2;
              continue;
            }
            break;
          }
          value += src[j];
          j++;
        }
        push("string", start, j + 1, value);
        continue;
      }
      if (ch === "'") {
        let sheet = "";
        let j = i + 1;
        for (;;) {
          if (j >= src.length) fail("SYNTAX", "Unclosed quoted sheet name: missing '", start, src.length);
          if (src[j] === "'") {
            if (src[j + 1] === "'") {
              sheet += "'";
              j += 2;
              continue;
            }
            break;
          }
          sheet += src[j];
          j++;
        }
        if (src[j + 1] !== "!") {
          fail("SYNTAX", "Text must use double quotes; single quotes are only for sheet names like 'My Sheet'!A1", start, j + 1);
        }
        referenceAfterSheet(sheet, start, j + 1);
        continue;
      }
      if (ch === "#") {
        const e = readErrorLiteral(src, i);
        if (!e) fail("SYNTAX", "Unknown error literal", start, start + 1);
        push("error", start, e.end, e.code);
        continue;
      }
      if (ch === "{") fail("UNSUPPORTED_FEATURE", "Array literals {...} are not supported yet", start, start + 1);
      if (ch === "[") {
        if (!opts.structuredRefs) fail("SYNTAX", 'Unexpected "["', start, start + 1);
        const s = readStructured(src, i, undefined, fail, start);
        push("structured", start, s.end, s.value);
        continue;
      }
      if (ch === "$" || isIdentStart(ch)) {
        const ref = readReference(src, i, undefined);
        if (ref) {
          push(ref.token.kind, start, ref.end, ref.token.value);
          continue;
        }
        if (ch === "$") fail("SYNTAX", 'Unexpected "$"', start, start + 1);
        const end = readIdent(src, i);
        const word = src.slice(start, end);
        if (src[end] === "!") {
          referenceAfterSheet(word, start, end);
          continue;
        }
        if (src[end] === "[" && opts.structuredRefs) {
          const s = readStructured(src, end, word, fail, start);
          push("structured", start, s.end, s.value);
          continue;
        }
        push("ident", start, end, word.toUpperCase());
        continue;
      }
      if (isDigit(ch) || (ch === decimalSep && isDigit(src[i + 1]))) {
        const row = /^\$?[0-9]+:\$?[0-9]+/.exec(src.slice(i));
        if (row) fail("UNSUPPORTED_REFERENCE", `Whole-row range ${row[0]} is not supported`, start, start + row[0].length);
        const num = readNumber(src, i, decimalSep)!;
        push("number", start, num.end, num.value);
        continue;
      }
      if (ch === "(") {
        push("lparen", start, i + 1);
        continue;
      }
      if (ch === ")") {
        push("rparen", start, i + 1);
        continue;
      }
      if (ch === argSep) {
        push("sep", start, i + 1);
        continue;
      }
      if (ch === "," || ch === ";") {
        const hint = argSep === ";" ? 'this locale separates arguments with ";"' : 'arguments are separated by "," (pass locale: { argumentSeparator: ";" } for ";")';
        fail("SYNTAX", `Unexpected "${ch}": ${hint}`, start, start + 1);
      }
      const op = readOperator(src, i, OPERATORS);
      if (op) {
        push("op", start, i + op.length);
        continue;
      }
      fail("SYNTAX", `Unexpected character "${ch}"`, start, start + 1);
    }
    tokens.push({ kind: "eof", text: "", start: src.length, end: src.length });
    return tokens;
  };
}
