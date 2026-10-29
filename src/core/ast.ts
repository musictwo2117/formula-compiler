/**
 * The shared tree. Every dialect parses into these nodes; every node carries
 * start/end offsets (0-based, end exclusive) into the original formula.
 */

export interface Span {
  start: number;
  end: number;
}

export interface CellAddress {
  col: string; // upper-case letters, e.g. "B"
  row: number; // 1-based
  colAbsolute: boolean;
  rowAbsolute: boolean;
}

export interface ColumnAddress {
  col: string;
  colAbsolute: boolean;
}

export type BinaryOperator = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export const ERROR_CODES = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#ERROR!"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface NumberLiteral extends Span { type: "Number"; value: number; raw: string }
export interface StringLiteral extends Span { type: "String"; value: string }
export interface BooleanLiteral extends Span { type: "Boolean"; value: boolean }
export interface ErrorLiteral extends Span { type: "Error"; code: ErrorCode }
/** Airtable {Field name}. */
export interface FieldRef extends Span { type: "Field"; name: string }
/** Sheets/Excel A1, $B$2, Sheet1!C3. */
export interface CellRef extends Span { type: "Cell"; sheet?: string; address: CellAddress }
/** Sheets/Excel A1:B10 or A:A. */
export interface RangeRef extends Span {
  type: "Range";
  sheet?: string;
  from: CellAddress | ColumnAddress;
  to: CellAddress | ColumnAddress;
}
/** Excel Table1[col], [@col], Table1[@col]. */
export interface StructuredRef extends Span { type: "StructuredRef"; table?: string; column: string; thisRow: boolean }
export interface UnaryExpr extends Span { type: "Unary"; operator: "-" | "+"; operand: Node }
export interface PercentExpr extends Span { type: "Percent"; operand: Node }
export interface BinaryExpr extends Span { type: "Binary"; operator: BinaryOperator; left: Node; right: Node }
export interface CallExpr extends Span { type: "Call"; name: string; nameStart: number; nameEnd: number; args: Node[] }

export type Node =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | ErrorLiteral
  | FieldRef
  | CellRef
  | RangeRef
  | StructuredRef
  | UnaryExpr
  | PercentExpr
  | BinaryExpr
  | CallExpr;

export function isCellAddress(a: CellAddress | ColumnAddress): a is CellAddress {
  return "row" in a;
}

/** Rows of a bounded range (A2:A10): data rows `first` (0-based, row headerRow + 1 is 0) to first + count - 1. */
export interface RowSpan {
  first: number;
  count: number;
}

/**
 * The resolved tree that code generators consume: references are turned into
 * field names, functions are looked up in the registry.
 */
export type BoundNode =
  | (Span & { kind: "number"; value: number })
  | (Span & { kind: "string"; value: string })
  | (Span & { kind: "boolean"; value: boolean })
  | (Span & { kind: "error"; code: ErrorCode })
  /** A value of the current record (Airtable field, same-row cell, [@col]). */
  | (Span & { kind: "field"; name: string })
  /** Every value of a field across all rows (whole-column range), or the rows of a bounded range. */
  | (Span & { kind: "column"; name: string; rows?: RowSpan })
  /** Several columns side by side (D:F, D2:F10), for lookups. */
  | (Span & { kind: "table"; names: string[]; rows?: RowSpan })
  | (Span & { kind: "unary"; operator: "-" | "+"; operand: BoundNode })
  | (Span & { kind: "percent"; operand: BoundNode })
  | (Span & { kind: "binary"; operator: BinaryOperator; left: BoundNode; right: BoundNode })
  | (Span & { kind: "call"; name: string; args: BoundNode[] });

export type BoundCall = Extract<BoundNode, { kind: "call" }>;
