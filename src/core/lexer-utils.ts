import type { CellAddress, ColumnAddress, ErrorCode } from "./ast";
import type { Fail } from "./errors";

export type TokenKind =
  | "number"
  | "string"
  | "ident"
  | "field"
  | "cell"
  | "range"
  | "structured"
  | "error"
  | "op"
  | "lparen"
  | "rparen"
  | "sep"
  | "eof";

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  /** number for "number", string for "string"/"field"/"ident" (upper-cased), etc. */
  value?: unknown;
}

export interface CellTokenValue { sheet?: string; address: CellAddress }
export interface RangeTokenValue { sheet?: string; from: CellAddress | ColumnAddress; to: CellAddress | ColumnAddress }
export interface StructuredTokenValue { table?: string; column: string; thisRow: boolean }

export type Lexer = (formula: string, fail: Fail) => Token[];

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{M}\p{N}_.]/u;

export function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_START.test(ch);
}

export function isIdentPart(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_PART.test(ch);
}

export function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

export function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/u.test(ch);
}

/** Reads an identifier starting at pos; returns its end offset. */
export function readIdent(src: string, pos: number): number {
  let i = pos;
  while (i < src.length && isIdentPart(src[i])) i++;
  return i;
}

/**
 * Reads a number literal: digits [sep digits] [e[+-]digits], or sep digits.
 * Returns null if there is no number at pos.
 */
export function readNumber(src: string, pos: number, decimalSep: string): { value: number; end: number } | null {
  let i = pos;
  while (isDigit(src[i])) i++;
  const intEnd = i;
  if (src[i] === decimalSep) {
    i++;
    while (isDigit(src[i])) i++;
  }
  if (i === pos || (intEnd === pos && i === pos + 1)) return null; // nothing, or a lone separator
  if (src[i] === "e" || src[i] === "E") {
    let j = i + 1;
    if (src[j] === "+" || src[j] === "-") j++;
    if (isDigit(src[j])) {
      while (isDigit(src[j])) j++;
      i = j;
    }
  }
  const text = src.slice(pos, i).replace(decimalSep, ".");
  return { value: Number(text), end: i };
}

const ERROR_LITERAL = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)/i;

export function readErrorLiteral(src: string, pos: number): { code: ErrorCode; end: number } | null {
  const m = ERROR_LITERAL.exec(src.slice(pos));
  if (!m) return null;
  return { code: m[0].toUpperCase() as ErrorCode, end: pos + m[0].length };
}

/** Comparison and arithmetic operators shared by all dialects, longest first. */
export function readOperator(src: string, pos: number, ops: readonly string[]): string | null {
  for (const op of ops) if (src.startsWith(op, pos)) return op;
  return null;
}

export function describeToken(t: Token): string {
  if (t.kind === "eof") return "end of formula";
  return `"${t.text}"`;
}
