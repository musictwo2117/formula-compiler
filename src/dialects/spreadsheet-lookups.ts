/**
 * VLOOKUP / XLOOKUP / MATCH / INDEX for Sheets and Excel. In SQL every lookup
 * is a subquery over the table in `orderBy` order, so "first match" and
 * "row n" mean the same as in JS (ctx.rows order). orderBy must be unique and
 * not null. The subqueries sort by orderBy rather than numbering the rows
 * with a window, which PostgreSQL would redo for every outer row.
 */
import type { BoundCall, BoundNode, RowSpan, Span } from "../core/ast";
import type { Fail } from "../core/errors";
import type { FieldType } from "../core/types";
import { jsString } from "../codegen/js";
import { quoteIdent, quoteText, sqlTimestampSerial, type KindArm, type SqlGen, type SqlVal } from "../codegen/sql";
import type { MatchMode } from "../runtime/spreadsheet-lookups";
import type { SpreadsheetVariant } from "../runtime/spreadsheet";
import { definer } from "./shared";
import { likePatternSql } from "./spreadsheet-functions";

type Range = BoundNode & ({ kind: "column" } | { kind: "table" });
const R = quoteIdent("__fc_r");

/** The table or the rows of a bounded range (in orderBy order), plus typed access to its columns. */
function rowSource(g: SqlGen, range: Span & { rows?: RowSpan }) {
  const span = range;
  const { table, orderBy } = g.options;
  if (!table) return g.fail("INVALID_OPTION", "Lookups need the SQL table name: pass the table option", span.start, span.end);
  if (!orderBy) {
    return g.fail("INVALID_OPTION", "Lookups need the row order in SQL: pass orderBy (a field that numbers the rows)", span.start, span.end);
  }
  const scan = g.rangeScan(range.rows, span);
  const order = `${R}.${quoteIdent(orderBy)}`;
  const col = (name: string): { v: string; t: FieldType } => {
    const t = g.fieldType(name, span);
    const ref = `${R}.${quoteIdent(name)}`;
    return t === "date" ? { v: g.dateFieldSerial(ref), t: "number" } : { v: ref, t };
  };
  /**
   * Position in the range of the row whose orderBy value is `key`: table rows before it, plus one, plus the header
   * rows of a whole column, minus the data rows a bounded range skips.
   */
  const position = (key: string, headerRow: number) => {
    const base = range.rows ? 1 - range.rows.first : headerRow + 1;
    return `(SELECT (count(*) + ${base})::float8 FROM ${quoteIdent(table)} AS "__fc_p" WHERE "__fc_p".${quoteIdent(orderBy)} < ${key})`;
  };
  return { scan, order, col, position };
}

/**
 * SQL condition: does the cell `col` (of type t) match the key arm in this mode? Mirrors findIndex().
 * Only used in WHERE, where NULL means no match, so the bare comparison can use an index on the column.
 */
function matchSql(col: string, t: FieldType, k: KindArm, mode: MatchMode): string {
  if (k.k === "blank" || k.k !== (t === "date" ? "number" : t)) return "FALSE";
  const op = mode === "le" ? "<=" : mode === "ge" ? ">=" : "=";
  if (k.k !== "text") return `${col} ${op} ${k.e}`;
  if (mode === "wildcard") return `lower(${col}) LIKE ${likePatternSql(`lower(${k.e})`)} ESCAPE ${quoteText("\\")}`;
  return `lower(${col}) COLLATE "C" ${op} lower(${k.e}) COLLATE "C"`;
}

/** ORDER BY that picks the row findIndex() picks (`order` is the orderBy column). */
function orderSql(col: string, t: FieldType, order: string, mode: MatchMode, fromEnd: boolean): string {
  const n = `${order} ${fromEnd ? "DESC" : "ASC"}`;
  if (mode === "exact" || mode === "wildcard") return n;
  const key = t === "text" ? `lower(${col}) COLLATE "C"` : col;
  return `${key} ${mode === "le" ? "DESC" : "ASC"}, ${n}`;
}

/** A literal number argument (or the default), as SQL needs it at compile time. */
function literalNumber(c: BoundCall, i: number, fallback: number, g: SqlGen): number {
  const a = c.args[i];
  if (a === undefined) return fallback;
  if (a.kind === "number") return a.value;
  if (a.kind === "boolean") return a.value ? 1 : 0;
  if (a.kind === "unary" && a.operator === "-" && a.operand.kind === "number") return -a.operand.value;
  return g.fail("UNSUPPORTED_IN_SQL", `Argument ${i + 1} of ${c.name} must be a literal for the SQL target in this version`, a.start, a.end, c.name);
}

/**
 * First matching row: the value of `ret` there, and whether any row matched.
 * The key is compared per runtime kind (like the JS runtime).
 */
function lookupSql(g: SqlGen, key: SqlVal, range: Range, lookupName: string, retName: string, mode: MatchMode, fromEnd: boolean) {
  const src = rowSource(g, range);
  const look = src.col(lookupName);
  const ret = src.col(retName);
  const cond = g.dispatch(key, (k) => ({ v: matchSql(look.v, look.t, k, mode), err: null })).v;
  const pick = (what: string) => `(SELECT ${what} ${src.scan(cond)} ORDER BY ${orderSql(look.v, look.t, src.order, mode, fromEnd)} LIMIT 1)`;
  const found: SqlVal = { v: pick(ret.v), t: ret.t === "date" ? "number" : ret.t, err: key.err, nullable: true };
  // The key's own error wins over "not found".
  const exists: SqlVal = { v: `EXISTS (SELECT 1 ${src.scan(cond)})`, t: "boolean", err: key.err, nullable: false };
  return { found, exists, src, pick };
}

const namesOf = (r: Range): string[] => (r.kind === "column" ? [r.name] : r.names);

/** An error result that still reports the key's own error first. */
const failAfter = (g: SqlGen, key: SqlVal, code: string): SqlVal => ({ ...g.error(code), err: `COALESCE(${key.err ?? "NULL"}, ${quoteText(code)})` });

/** XLOOKUP and SUMIF pair their ranges row by row: they must cover the same rows. */
export function sameRows(c: BoundCall, indexes: number[], fail: Fail): void {
  const ranges = indexes.map((i) => c.args[i]).filter((a): a is Range => a !== undefined && (a.kind === "column" || a.kind === "table"));
  const key = (r: Range) => (r.rows ? `${r.rows.first}:${r.rows.count}` : "all");
  const first = ranges[0];
  for (const r of ranges.slice(1)) {
    if (first && key(r) !== key(first)) {
      fail("UNSUPPORTED_FEATURE", `The ranges of ${c.name} must cover the same rows in this version`, r.start, r.end, c.name);
    }
  }
}

export function registerSpreadsheetLookups(variant: SpreadsheetVariant): void {
  const def = definer(variant);
  const headerRow = (g: { options: { headerRow?: number } }) => g.options.headerRow ?? 1;
  /** Rows before the first value of a range: the header rows of a whole column, none for a bounded range. */
  const offset = (r: Range, g: { options: { headerRow?: number } }) => (r.rows ? 0 : headerRow(g));
  // INDEX on a bounded range: row < 1 and row past the end, checked in Sheets and Excel for the web (2026-10-29).
  const indexLow = variant === "sheets" ? "#NUM!" : "#VALUE!";
  const indexPast = variant === "sheets" ? "#NUM!" : "#REF!";

  def({
    name: "VLOOKUP",
    minArgs: 3,
    maxArgs: 4,
    columnArgs: [1],
    tableArgs: [1],
    requiredColumnArgs: [1],
    summary: "VLOOKUP(key, A:C, column, [approximate]) — table must be whole columns; exact match takes * ? wildcards",
    notes: "Approximate match (the default) expects the first column sorted; it returns the largest key <= the search key.",
    validate: (c, fail: Fail) => {
      const t = c.args[1]!;
      if (t.kind !== "column" && t.kind !== "table") fail("INVALID_ARGUMENT", "The VLOOKUP table must be a range such as D:F or D2:F10", t.start, t.end, "VLOOKUP");
    },
    js: (c, g) => g.call("VLOOKUP", c.args.map((a) => g.expr(a))),
    sql: (c, g) => {
      const key = g.expr(c.args[0]!);
      const range = c.args[1] as Range;
      const names = namesOf(range);
      const idx = Math.trunc(literalNumber(c, 2, 1, g));
      const approx = literalNumber(c, 3, 1, g) !== 0;
      if (idx < 1) return failAfter(g, key, "#VALUE!");
      if (idx > names.length) return failAfter(g, key, "#REF!");
      const { found, exists } = lookupSql(g, key, range, names[0]!, names[idx - 1]!, approx ? "le" : "wildcard", approx);
      return g.chain([{ cond: exists, then: found }], g.error("#N/A"));
    },
  });

  def({
    name: "XLOOKUP",
    minArgs: 3,
    maxArgs: 6,
    columnArgs: [1, 2],
    requiredColumnArgs: [1, 2],
    summary: "XLOOKUP(key, lookup_col, result_col, [if_not_found], [match_mode], [search_mode]) — match modes 0, -1, 1, 2; search 1 or -1",
    validate: (c, fail: Fail) => sameRows(c, [1, 2], fail),
    js: (c, g) => {
      const [key, look, ret, notFound, ...rest] = c.args;
      return g.call("XLOOKUP", [g.expr(key!), g.expr(look!), g.expr(ret!), notFound ? g.lazy(notFound) : "undefined", ...rest.map((a) => g.expr(a))]);
    },
    sql: (c, g) => {
      const key = g.expr(c.args[0]!);
      const look = c.args[1] as Range & { kind: "column" };
      const ret = c.args[2] as Range & { kind: "column" };
      const m = Math.trunc(literalNumber(c, 4, 0, g));
      const s = Math.trunc(literalNumber(c, 5, 1, g));
      const mode = ({ 0: "exact", 2: "wildcard", [-1]: "le", 1: "ge" } as Record<number, MatchMode>)[m];
      if (!mode || (s !== 1 && s !== -1)) return failAfter(g, key, "#VALUE!");
      const { found, exists } = lookupSql(g, key, look, look.name, ret.name, mode, s === -1);
      const otherwise = c.args[3] ? g.expr(c.args[3]) : g.error("#N/A");
      return g.chain([{ cond: exists, then: found }], otherwise);
    },
  });

  def({
    name: "MATCH",
    minArgs: 2,
    maxArgs: 3,
    columnArgs: [1],
    requiredColumnArgs: [1],
    summary: "MATCH(key, column, [type]) — position counted from row 1; type 0 exact (wildcards), 1 largest <=, -1 smallest >=",
    js: (c, g) => g.call("MATCH", [g.expr(c.args[0]!), g.expr(c.args[1]!), c.args[2] ? g.expr(c.args[2]) : "1", String(offset(c.args[1] as Range, g))]),
    sql: (c, g) => {
      const key = g.expr(c.args[0]!);
      const col = c.args[1] as Range & { kind: "column" };
      const t = Math.trunc(literalNumber(c, 2, 1, g));
      const mode: MatchMode = t === 0 ? "wildcard" : t > 0 ? "le" : "ge";
      const { exists, src, pick } = lookupSql(g, key, col, col.name, col.name, mode, t !== 0);
      const position: SqlVal = { v: src.position(pick(src.order), headerRow(g)), t: "number", err: key.err, nullable: false };
      return g.chain([{ cond: exists, then: position }], g.error("#N/A"));
    },
  });

  def({
    name: "INDEX",
    minArgs: 2,
    maxArgs: 3,
    columnArgs: [0],
    tableArgs: [0],
    requiredColumnArgs: [0],
    summary: "INDEX(range, row, [column]) — whole columns; row counted from row 1 of the sheet",
    js: (c, g) => {
      const range = c.args[0] as Range;
      const args = [g.expr(range), g.expr(c.args[1]!), c.args[2] ? g.expr(c.args[2]) : "1", String(offset(range, g))];
      if (range.rows) args.push(String(range.rows.count), jsString(indexLow), jsString(indexPast));
      return g.call("INDEX", args);
    },
    sql: (c, g) => {
      const range = c.args[0] as Range;
      const names = namesOf(range);
      const row = g.toNumber(g.expr(c.args[1]!));
      const ci = Math.trunc(literalNumber(c, 2, 1, g));
      if (range.rows) {
        // Row k of a bounded range is OFFSET k - 1 of its rows; rows past the data are blank.
        const src = rowSource(g, range);
        const r = `trunc(${row.v})`;
        const errs = [row.err, `CASE WHEN ${r} < 1 THEN ${quoteText(indexLow)} END`];
        if (ci < 1) return g.make("number", "NULL::float8", [...errs, quoteText("#VALUE!")], true);
        if (ci > names.length) return g.make("number", "NULL::float8", [...errs, quoteText("#REF!")], true);
        const ret = src.col(names[ci - 1]!);
        const v = `CASE WHEN ${r} BETWEEN 1 AND ${range.rows.count} THEN (SELECT ${ret.v} ${src.scan()} ORDER BY ${src.order} OFFSET (${r} - 1)::bigint LIMIT 1) END`;
        return g.make(ret.t as SqlVal["t"], v, [...errs, `CASE WHEN ${r} > ${range.rows.count} THEN ${quoteText(indexPast)} END`], true);
      }
      if (ci < 1) return g.error("#VALUE!");
      if (ci > names.length) return g.error("#REF!");
      const src = rowSource(g, range);
      const ret = src.col(names[ci - 1]!);
      // Data row k (1-based) is OFFSET k - 1; header rows and rows past the end are blank.
      const k = `(trunc(${row.v}) - ${headerRow(g)})`;
      const v = `CASE WHEN ${k} >= 1 THEN (SELECT ${ret.v} ${src.scan()} ORDER BY ${src.order} OFFSET LEAST(${k} - 1, 1e15)::bigint LIMIT 1) END`;
      return g.make(ret.t as SqlVal["t"], v, [row.err, `CASE WHEN trunc(${row.v}) < 1 THEN '#VALUE!' END`], true);
    },
  });
}
