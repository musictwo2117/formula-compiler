/**
 * JS side of VLOOKUP / XLOOKUP / MATCH / INDEX for Sheets and Excel (SQL in
 * src/dialects/spreadsheet-lookups.ts). Whole columns are the table's rows in
 * ctx.rows order; positions count the header rows like a real sheet, so with
 * headerRow 1 the first data row is position 2.
 */
import { FormulaError, column, isError, isRefArg, wildcardToRegexSource, type EvalContext, type RefArg, type Value } from "./common";

export interface TableArg {
  readonly table: true;
  readonly columns: readonly (readonly Value[])[];
}

type Plain = Exclude<Value, FormulaError>;
type ToNumber = (x: Value) => number | FormulaError;
type ToBool = (x: Value) => boolean | FormulaError;
type Thunk = () => Value;

/** How a key is compared with a cell. */
export type MatchMode = "exact" | "wildcard" | "le" | "ge";

const NA = () => new FormulaError("#N/A");

function sameKind(a: Plain, b: Plain): boolean {
  return a !== null && b !== null && typeof a === typeof b;
}

/** -1 / 0 / 1 for two non-blank values of the same kind (text ignores case). */
function order(a: Plain, b: Plain): number {
  const x = typeof a === "string" ? a.toLowerCase() : Number(a);
  const y = typeof b === "string" ? (b as string).toLowerCase() : Number(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Index of the matching cell or -1. exact/wildcard: first (or last with
 * fromEnd) equal cell. le: the largest cell <= key; ge: the smallest cell >=
 * key — ties go to the first (or last) row.
 */
export function findIndex(cells: readonly Value[], key: Plain, mode: MatchMode, fromEnd = false): number {
  const regex = mode === "wildcard" && typeof key === "string" ? new RegExp(`^${wildcardToRegexSource(key.toLowerCase())}$`, "u") : undefined;
  let best = -1;
  const indices = cells.map((_, i) => i);
  if (fromEnd) indices.reverse();
  for (const i of indices) {
    const cell = cells[i]!;
    if (isError(cell) || !sameKind(cell, key)) continue;
    if (mode === "exact" || mode === "wildcard") {
      const hit = regex ? regex.test((cell as string).toLowerCase()) : order(cell, key) === 0;
      if (hit) return i;
      continue;
    }
    const c = order(cell, key);
    if (mode === "le" ? c > 0 : c < 0) continue;
    if (best === -1) best = i;
    else {
      const d = order(cell, cells[best] as Plain);
      if (mode === "le" ? d > 0 : d < 0) best = i;
    }
  }
  return best;
}

function columnsOf(range: TableArg | RefArg): readonly (readonly Value[])[] {
  return isRefArg(range) ? [range.values] : range.columns;
}

type Column = (ctx: EvalContext | undefined, name: string, type?: string) => RefArg;

export function spreadsheetLookupFunctions(N: ToNumber, B: ToBool, col: Column = column) {
  return {
    table(ctx: EvalContext | undefined, names: readonly string[], types: readonly (string | undefined)[]): TableArg {
      return { table: true, columns: names.map((n, i) => col(ctx, n, types[i]).values) };
    },

    /** VLOOKUP(key, table, column, [approximate = TRUE]). */
    VLOOKUP(key: Value, range: TableArg | RefArg, index: Value, approximate: Value = true): Value {
      if (isError(key)) return key;
      const k = N(index);
      if (isError(k)) return k;
      const approx = B(approximate);
      if (isError(approx)) return approx;
      const cols = columnsOf(range);
      const c = Math.trunc(k);
      if (c < 1) return new FormulaError("#VALUE!");
      if (c > cols.length) return new FormulaError("#REF!");
      const i = findIndex(cols[0]!, key, approx ? "le" : "wildcard", approx);
      return i < 0 ? NA() : cols[c - 1]![i] ?? null;
    },

    /** XLOOKUP(key, lookup, result, [if_not_found], [match_mode = 0], [search_mode = 1]). */
    XLOOKUP(key: Value, lookup: RefArg, result: RefArg, ifNotFound?: Thunk, matchMode: Value = 0, searchMode: Value = 1): Value {
      if (isError(key)) return key;
      const m = N(matchMode);
      if (isError(m)) return m;
      const s = N(searchMode);
      if (isError(s)) return s;
      const mode = ({ 0: "exact", 2: "wildcard", [-1]: "le", 1: "ge" } as Record<number, MatchMode>)[Math.trunc(m)];
      const fromEnd = Math.trunc(s) === -1;
      if (!mode || (Math.trunc(s) !== 1 && !fromEnd)) return new FormulaError("#VALUE!");
      const i = findIndex(lookup.values, key, mode, fromEnd);
      if (i < 0) return ifNotFound ? ifNotFound() : NA();
      return result.values[i] ?? null;
    },

    /** MATCH(key, range, [type = 1]) — position counted from row 1 of the sheet. */
    MATCH(key: Value, range: RefArg, type: Value, headerRow: number): Value {
      if (isError(key)) return key;
      const t = N(type);
      if (isError(t)) return t;
      const k = Math.trunc(t);
      const mode: MatchMode = k === 0 ? "wildcard" : k > 0 ? "le" : "ge";
      const i = findIndex(range.values, key, mode, k !== 0);
      return i < 0 ? NA() : headerRow + 1 + i;
    },

    /** INDEX(range, row, [column]) — rows counted from row 1 of the sheet; header and empty rows are blank. */
    INDEX(range: TableArg | RefArg, row: Value, col: Value, headerRow: number): Value {
      const r = N(row);
      if (isError(r)) return r;
      const c = N(col);
      if (isError(c)) return c;
      const cols = columnsOf(range);
      const [ri, ci] = [Math.trunc(r), Math.trunc(c)];
      if (ri < 1 || ci < 1) return new FormulaError("#VALUE!");
      if (ci > cols.length) return new FormulaError("#REF!");
      return cols[ci - 1]![ri - headerRow - 1] ?? null;
    },
  };
}
