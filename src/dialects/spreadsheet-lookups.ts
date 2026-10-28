/**
 * VLOOKUP / XLOOKUP / MATCH / INDEX for Sheets and Excel. In SQL every lookup
 * is a subquery over the table numbered by the `orderBy` field, so "first
 * match" and "row n" mean the same as in JS (ctx.rows order).
 */
import type { BoundCall, BoundNode, Span } from "../core/ast";
import type { Fail } from "../core/errors";
import type { FieldType } from "../core/types";
import { quoteIdent, quoteText, sqlTimestampSerial, type KindArm, type SqlGen, type SqlVal } from "../codegen/sql";
import type { MatchMode } from "../runtime/spreadsheet-lookups";
import type { SpreadsheetVariant } from "../runtime/spreadsheet";
import { definer } from "./shared";
import { likePatternSql } from "./spreadsheet-functions";

type Range = BoundNode & ({ kind: "column" } | { kind: "table" });
const R = quoteIdent("__fc_r");
const N = `${R}.${quoteIdent("__fc_n")}`;

/** The table numbered 1, 2, … by the orderBy field, plus typed access to its columns. */
function rowSource(g: SqlGen, names: string[], span: Span) {
  const { table, orderBy } = g.options;
  if (!table) return g.fail("INVALID_OPTION", "Lookups need the SQL table name: pass the table option", span.start, span.end);
  if (!orderBy) {
    return g.fail("INVALID_OPTION", "Lookups need the row order in SQL: pass orderBy (a field that numbers the rows)", span.start, span.end);
  }
  const cols = [...new Set([...names, orderBy])].map(quoteIdent).join(", ");
  const from = `(SELECT ${cols}, row_number() OVER (ORDER BY ${quoteIdent(orderBy)}) AS "__fc_n" FROM ${quoteIdent(table)}) AS ${R}`;
  const col = (name: string): { v: string; t: FieldType } => {
    const t = g.fieldType(name, span);
    const ref = `${R}.${quoteIdent(name)}`;
    return t === "date" ? { v: g.dateFieldSerial(ref), t: "number" } : { v: ref, t };
  };
  return { from, col };
}

/** SQL condition: does the cell `col` (of type t) match the key arm in this mode? Mirrors findIndex(). */
function matchSql(col: string, t: FieldType, k: KindArm, mode: MatchMode): string {
  if (k.k === "blank" || k.k !== (t === "date" ? "number" : t)) return "FALSE";
  const op = mode === "le" ? "<=" : mode === "ge" ? ">=" : "=";
  if (k.k !== "text") return `COALESCE(${col} ${op} ${k.e}, FALSE)`;
  if (mode === "wildcard") return `COALESCE(lower(${col}) LIKE ${likePatternSql(`lower(${k.e})`)} ESCAPE ${quoteText("\\")}, FALSE)`;
  return `COALESCE(lower(${col}) COLLATE "C" ${op} lower(${k.e}) COLLATE "C", FALSE)`;
}

/** ORDER BY that picks the row findIndex() picks. */
function orderSql(col: string, t: FieldType, mode: MatchMode, fromEnd: boolean): string {
  const n = `${N} ${fromEnd ? "DESC" : "ASC"}`;
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
function lookupSql(g: SqlGen, key: SqlVal, range: { names: string[]; span: Span }, lookupName: string, retName: string, mode: MatchMode, fromEnd: boolean) {
  const src = rowSource(g, range.names, range.span);
  const look = src.col(lookupName);
  const ret = src.col(retName);
  const cond = g.dispatch(key, (k) => ({ v: matchSql(look.v, look.t, k, mode), err: null })).v;
  const found: SqlVal = { v: `(SELECT ${ret.v} FROM ${src.from} WHERE ${cond} ORDER BY ${orderSql(look.v, look.t, mode, fromEnd)} LIMIT 1)`, t: ret.t === "date" ? "number" : ret.t, err: key.err, nullable: true };
  // The key's own error wins over "not found".
  const exists: SqlVal = { v: `EXISTS (SELECT 1 FROM ${src.from} WHERE ${cond})`, t: "boolean", err: key.err, nullable: false };
  return { found, exists, src, look };
}

const namesOf = (r: Range): string[] => (r.kind === "column" ? [r.name] : r.names);

/** An error result that still reports the key's own error first. */
const failAfter = (g: SqlGen, key: SqlVal, code: string): SqlVal => ({ ...g.error(code), err: `COALESCE(${key.err ?? "NULL"}, ${quoteText(code)})` });

export function registerSpreadsheetLookups(variant: SpreadsheetVariant): void {
  const def = definer(variant);
  const headerRow = (g: { options: { headerRow?: number } }) => g.options.headerRow ?? 1;

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
      if (t.kind !== "column" && t.kind !== "table") fail("INVALID_ARGUMENT", "The VLOOKUP table must be whole columns such as D:F", t.start, t.end, "VLOOKUP");
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
      const { found, exists } = lookupSql(g, key, { names, span: range }, names[0]!, names[idx - 1]!, approx ? "le" : "wildcard", approx);
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
      const { found, exists } = lookupSql(g, key, { names: [look.name, ret.name], span: look }, look.name, ret.name, mode, s === -1);
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
    js: (c, g) => g.call("MATCH", [g.expr(c.args[0]!), g.expr(c.args[1]!), c.args[2] ? g.expr(c.args[2]) : "1", String(headerRow(g))]),
    sql: (c, g) => {
      const key = g.expr(c.args[0]!);
      const col = c.args[1] as Range & { kind: "column" };
      const t = Math.trunc(literalNumber(c, 2, 1, g));
      const mode: MatchMode = t === 0 ? "wildcard" : t > 0 ? "le" : "ge";
      const { exists, src, look } = lookupSql(g, key, { names: [col.name], span: col }, col.name, col.name, mode, t !== 0);
      const cond = g.dispatch(key, (k) => ({ v: matchSql(look.v, look.t, k, mode), err: null })).v;
      const position: SqlVal = {
        v: `(SELECT (${N} + ${headerRow(g)})::float8 FROM ${src.from} WHERE ${cond} ORDER BY ${orderSql(look.v, look.t, mode, t !== 0)} LIMIT 1)`,
        t: "number",
        err: key.err,
        nullable: false,
      };
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
    js: (c, g) => g.call("INDEX", [g.expr(c.args[0]!), g.expr(c.args[1]!), c.args[2] ? g.expr(c.args[2]) : "1", String(headerRow(g))]),
    sql: (c, g) => {
      const range = c.args[0] as Range;
      const names = namesOf(range);
      const row = g.toNumber(g.expr(c.args[1]!));
      const ci = Math.trunc(literalNumber(c, 2, 1, g));
      if (ci < 1) return g.error("#VALUE!");
      if (ci > names.length) return g.error("#REF!");
      const src = rowSource(g, names, range);
      const ret = src.col(names[ci - 1]!);
      const v = `(SELECT ${ret.v} FROM ${src.from} WHERE ${N} = trunc(${row.v}) - ${headerRow(g)})`;
      return g.make(ret.t as SqlVal["t"], v, [row.err, `CASE WHEN trunc(${row.v}) < 1 THEN '#VALUE!' END`], true);
    },
  });
}
