/**
 * Function table shared by Google Sheets and Excel. Each dialect's
 * functions.ts calls registerSpreadsheetFunctions() with its own variant;
 * the per-program differences are the `variant` checks below.
 */
import type { BoundCall, BoundNode } from "../core/ast";
import type { Fail } from "../core/errors";
import { registry } from "../core/registry";
import type { FieldType } from "../core/types";
import type { JsGen } from "../codegen/js";
import { errorIf, quoteText, sqlNumber, type SqlGen, type SqlVal } from "../codegen/sql";
import { NUMERIC_TEXT_SQL, type RoundMode } from "../runtime/common";
import { parseCriterion, type Criterion, type SpreadsheetVariant } from "../runtime/spreadsheet";
import { DATE_FUNCTIONS, definer, lazyArgsJs, numericSql, roundDigits, roundSql, sqlArgs, substituteNthSql, textSql } from "./shared";

const RE = quoteText(NUMERIC_TEXT_SQL);
const VALUE = "#VALUE!";

/** Aggregate arguments keep "reference" semantics in JS. */
const refArgsJs = (c: BoundCall, g: JsGen) => g.call(c.name, c.args.map((a) => g.refArg(a)));

/** SWITCH: expression and patterns are eager, results and default are lazy. */
export const switchJs = (c: BoundCall, g: JsGen) => {
  const last = c.args.length - 1;
  const hasDefault = c.args.length % 2 === 0;
  return g.call(
    c.name,
    c.args.map((a, i) => (i === 0 || (i % 2 === 1 && !(hasDefault && i === last)) ? g.expr(a) : g.lazy(a))),
  );
};

type AggArg =
  | { kind: "column"; node: BoundNode & { kind: "column" }; type: FieldType }
  | { kind: "ref"; v: string; type: FieldType }
  | { kind: "value"; val: SqlVal };

function aggArgs(c: BoundCall, g: SqlGen): AggArg[] {
  return c.args.map((a): AggArg => {
    if (a.kind === "column") return { kind: "column", node: a, type: g.fieldType(a.name, a) };
    if (a.kind === "field") return { kind: "ref", v: g.fieldRef(a.name), type: g.fieldType(a.name, a) };
    return { kind: "value", val: g.expr(a) };
  });
}

function isLiteral(n: BoundNode): number | string | boolean | undefined {
  if (n.kind === "number" || n.kind === "string" || n.kind === "boolean") return n.value;
  if (n.kind === "unary" && n.operator === "-" && n.operand.kind === "number") return -n.operand.value;
  return undefined;
}

function likePattern(wildcard: string): string {
  let out = "";
  for (let i = 0; i < wildcard.length; i++) {
    const c = wildcard[i]!;
    const n = wildcard[i + 1];
    if (c === "~" && (n === "*" || n === "?" || n === "~")) {
      out += n;
      i++;
    } else if (c === "*") out += "%";
    else if (c === "?") out += "_";
    else if (c === "%" || c === "_" || c === "\\") out += `\\${c}`;
    else out += c;
  }
  return out;
}

/** A criterion operand as SQL expressions (literal or computed per outer row). */
type SqlOperand =
  | { kind: "blank" }
  | { kind: "number"; sql: string }
  | { kind: "boolean"; sql: string }
  /** `lower` is the lower-cased text, `like` the LIKE pattern built from it. */
  | { kind: "text"; lower: string; like: string };

const CRITERION_OPS = ["=", "<>", "<", ">", "<=", ">="] as const;
type CriterionOp = (typeof CRITERION_OPS)[number];

/** SQL condition for one row of a COUNTIF/SUMIF range. Mirrors matchesCriterion(). */
function operandSql(col: string, type: FieldType, op: CriterionOp, operand: SqlOperand): string {
  const ne = op === "<>" ? "TRUE" : "FALSE";
  switch (operand.kind) {
    case "blank":
      if (op === "=") return type === "text" ? `(${col} IS NULL OR ${col} = '')` : `${col} IS NULL`;
      if (op === "<>") return type === "text" ? `COALESCE(${col} <> '', FALSE)` : `${col} IS NOT NULL`;
      return "FALSE";
    case "number":
      if (type !== "number") return ne;
      if (op === "<>") return `(${col} IS NULL OR ${col} <> ${operand.sql})`;
      return `COALESCE(${col} ${op} ${operand.sql}, FALSE)`;
    case "boolean":
      if (type !== "boolean") return ne;
      if (op === "=") return `COALESCE(${col} = ${operand.sql}, FALSE)`;
      if (op === "<>") return `(${col} IS NULL OR ${col} <> ${operand.sql})`;
      return "FALSE";
    case "text": {
      if (type !== "text") return ne;
      const like = `COALESCE(lower(${col}) LIKE ${operand.like} ESCAPE ${quoteText("\\")}, FALSE)`;
      if (op === "=") return like;
      if (op === "<>") return `(NOT ${like})`;
      return `COALESCE(lower(${col}) COLLATE "C" ${op} ${operand.lower} COLLATE "C", FALSE)`;
    }
  }
}

export function criterionSql(col: string, type: FieldType, crit: Criterion): string {
  const o = crit.operand;
  const operand: SqlOperand =
    o.kind === "blank" ? o
    : o.kind === "number" ? { kind: "number", sql: sqlNumber(o.value) }
    : o.kind === "boolean" ? { kind: "boolean", sql: o.value ? "TRUE" : "FALSE" }
    : { kind: "text", lower: quoteText(o.value.toLowerCase()), like: quoteText(likePattern(o.value.toLowerCase())) };
  return operandSql(col, type, crit.op, operand);
}

/** Same as likePattern(), computed by PostgreSQL for a text expression. */
function likePatternSql(x: string): string {
  const p1 = `replace(replace(replace(${x}, '~~', chr(3)), '~*', chr(1)), '~?', chr(2))`;
  const p2 = `replace(replace(replace(${p1}, ${quoteText("\\")}, ${quoteText("\\\\")}), '%', ${quoteText("\\%")}), '_', ${quoteText("\\_")})`;
  const p3 = `replace(replace(${p2}, '*', '%'), '?', '_')`;
  return `replace(replace(replace(${p3}, chr(1), '*'), chr(2), '?'), chr(3), '~')`;
}

/** Criterion text parsed by PostgreSQL at run time (">"&C2). Mirrors parseCriterion(). */
function dynamicTextCriterionSql(col: string, type: FieldType, text: string): string {
  const op = `COALESCE(substring(${text} from '^(<=|>=|<>|<|>|=)'), '=')`;
  const rest = `substring(${text} from '^(?:<=|>=|<>|<|>|=)?(.*)$')`;
  const byOp = (f: (o: CriterionOp) => string) => `CASE ${op} ${CRITERION_OPS.map((o) => `WHEN '${o}' THEN ${f(o)}`).join(" ")} END`;
  const lower = `lower(${rest})`;
  return `CASE WHEN ${rest} = '' THEN ${byOp((o) => operandSql(col, type, o, { kind: "blank" }))}`
    + ` WHEN ${rest} ~ ${RE} THEN ${byOp((o) => operandSql(col, type, o, { kind: "number", sql: `(${rest})::float8` }))}`
    + ` WHEN upper(${rest}) IN ('TRUE', 'FALSE') THEN ${byOp((o) => operandSql(col, type, o, { kind: "boolean", sql: `(upper(${rest}) = 'TRUE')` }))}`
    + ` ELSE ${byOp((o) => operandSql(col, type, o, { kind: "text", lower, like: likePatternSql(lower) }))} END`;
}

/** Converts an Excel wildcard pattern to a PostgreSQL regex at run time. */
function wildcardRegexSql(pattern: string): string {
  const p1 = `replace(replace(replace(${pattern}, '~~', chr(3)), '~*', chr(1)), '~?', chr(2))`;
  const p2 = `regexp_replace(${p1}, ${quoteText("([.^$+(){}\\[\\]\\\\|])")}, ${quoteText("\\\\\\1")}, 'g')`;
  const p3 = `replace(replace(${p2}, '*', '.*'), '?', '.')`;
  return `replace(replace(replace(${p3}, chr(1), ${quoteText("\\*")}), chr(2), ${quoteText("\\?")}), chr(3), '~')`;
}

export function registerSpreadsheetFunctions(variant: SpreadsheetVariant): void {
  const def = definer(variant);
  const optionalDigits = variant === "sheets";

  // ------------------------------------------------------------ logical
  def({
    name: "IF",
    minArgs: 2,
    maxArgs: 3,
    summary: "IF(condition, value_if_true, [value_if_false])",
    notes: "Without value_if_false the result is FALSE.",
    js: (c, g) => lazyArgsJs(c, g, [0]),
    sql: (c, g) => {
      const [cond, then, otherwise] = c.args;
      return g.chain([{ cond: g.toBool(g.expr(cond!)), then: g.expr(then!) }], otherwise ? g.expr(otherwise) : g.boolean(false));
    },
  });

  def({
    name: "IFS",
    minArgs: 2,
    maxArgs: Infinity,
    summary: "IFS(condition1, value1, ...) — #N/A when nothing matches",
    validate: (c, fail: Fail) => {
      if (c.args.length % 2 !== 0) fail("ARITY", "IFS expects condition/value pairs", c.start, c.end, "IFS");
    },
    js: (c, g) => lazyArgsJs(c, g, []),
    sql: (c, g) => {
      const arms: { cond: SqlVal; then: SqlVal }[] = [];
      for (let i = 0; i + 1 < c.args.length; i += 2) arms.push({ cond: g.toBool(g.expr(c.args[i]!)), then: g.expr(c.args[i + 1]!) });
      return g.chain(arms, g.error("#N/A"));
    },
  });

  def({
    name: "SWITCH",
    minArgs: 3,
    maxArgs: Infinity,
    summary: "SWITCH(expression, case1, value1, ..., [default]) — #N/A when nothing matches",
    js: switchJs,
    sql: (c, g) => {
      const [e, ...rest] = sqlArgs(c, g);
      const arms: { cond: SqlVal; then: SqlVal }[] = [];
      let i = 0;
      for (; i + 1 < rest.length; i += 2) arms.push({ cond: g.compare("=", e!, rest[i]!), then: rest[i + 1]! });
      return g.chain(arms, i < rest.length ? rest[i]! : g.error("#N/A"));
    },
  });

  for (const [name, test] of [
    ["IFERROR", (err: string) => `${err} IS NOT NULL`],
    ["IFNA", (err: string) => `COALESCE(${err} = '#N/A', FALSE)`],
  ] as const) {
    def({
      name,
      minArgs: 2,
      maxArgs: 2,
      summary: name === "IFERROR" ? "IFERROR(value, value_if_error)" : "IFNA(value, value_if_na)",
      js: (c, g) => lazyArgsJs(c, g, [0]),
      sql: (c, g) => {
        const x = g.expr(c.args[0]!);
        if (x.err === null) return x;
        const cond: SqlVal = { v: test(x.err), t: "boolean", err: null, nullable: false };
        return g.chain([{ cond, then: g.expr(c.args[1]!) }], x);
      },
    });
  }

  for (const [name, joiner, neutral] of [["AND", "AND", "TRUE"], ["OR", "OR", "FALSE"]] as const) {
    def({
      name,
      minArgs: 1,
      maxArgs: Infinity,
      summary: `${name}(logical1, ...)`,
      notes: "Text and empty cells in references are ignored; #VALUE! if nothing is left.",
      js: refArgsJs,
      sql: (c, g) => {
        const parts: { v: string; err: string | null; ignorable: boolean }[] = aggArgs(c, g).map((a) => {
          if (a.kind === "ref") {
            if (a.type === "number") return { v: `(${a.v} <> 0)`, err: null, ignorable: true };
            if (a.type === "boolean") return { v: a.v, err: null, ignorable: true };
            return { v: "NULL::boolean", err: null, ignorable: true };
          }
          if (a.kind === "column") return g.fail("INVALID_ARGUMENT", "ranges in AND/OR are not supported", a.node.start, a.node.end, name);
          const b = g.toBool(a.val);
          return { v: b.v, err: b.err, ignorable: false };
        });
        const v = `(${parts.map((p) => (p.ignorable ? `COALESCE(${p.v}, ${neutral})` : p.v)).join(` ${joiner} `)})`;
        const none = parts.every((p) => p.ignorable) ? errorIf(parts.map((p) => `${p.v} IS NULL`).join(" AND "), VALUE) : null;
        return g.make("boolean", v, [...parts.map((p) => p.err), none]);
      },
    });
  }

  def({
    name: "NOT",
    minArgs: 1,
    maxArgs: 1,
    summary: "NOT(logical)",
    sql: (c, g) => {
      const b = g.toBool(g.expr(c.args[0]!));
      return g.make("boolean", `(NOT ${b.v})`, [b.err]);
    },
  });
  def({ name: "TRUE", minArgs: 0, maxArgs: 0, summary: "TRUE()", sql: (_, g) => g.boolean(true) });
  def({ name: "FALSE", minArgs: 0, maxArgs: 0, summary: "FALSE()", sql: (_, g) => g.boolean(false) });

  def({
    name: "ISBLANK",
    minArgs: 1,
    maxArgs: 1,
    summary: "ISBLANK(value) — TRUE only for an empty cell (not for \"\")",
    sql: (c, g) => {
      const x = g.expr(c.args[0]!);
      const blank = x.t === "blank" ? "TRUE" : x.nullable ? `(${x.v} IS NULL)` : "FALSE";
      return g.make("boolean", x.err === null ? blank : `(${x.err} IS NULL AND ${blank})`, []);
    },
  });
  for (const [name, kind] of [["ISNUMBER", "number"], ["ISTEXT", "text"]] as const) {
    def({
      name,
      minArgs: 1,
      maxArgs: 1,
      summary: `${name}(value)`,
      sql: (c, g) => {
        const x = g.expr(c.args[0]!);
        const p = g.dispatch(x, (a) => ({ v: a.k === kind ? "TRUE" : "FALSE", err: null }));
        return g.make("boolean", x.err === null ? p.v : `(${x.err} IS NULL AND ${p.v})`, []);
      },
    });
  }

  // ------------------------------------------------------------ numbers
  const ROUNDS: [string, RoundMode][] = [["ROUND", "halfAwayFromZero"], ["ROUNDUP", "up"], ["ROUNDDOWN", "down"]];
  for (const [name, mode] of ROUNDS) {
    def({
      name,
      minArgs: optionalDigits ? 1 : 2,
      maxArgs: 2,
      summary: optionalDigits ? `${name}(value, [places])` : `${name}(number, num_digits)`,
      notes: mode === "halfAwayFromZero" ? "Ties round away from zero." : mode === "up" ? "Away from zero." : "Toward zero.",
      sql: (c, g) => {
        const [x, d] = sqlArgs(c, g).map((a) => g.toNumber(a));
        const digits = d ?? g.number(0);
        return g.make("number", roundSql(mode, x!.v, roundDigits(g, digits)), [x!.err, digits.err]);
      },
    });
  }
  def({ name: "ABS", minArgs: 1, maxArgs: 1, summary: "ABS(value)", sql: (c, g) => numericSql(g, sqlArgs(c, g), (x) => `abs(${x})`) });
  def({ name: "INT", minArgs: 1, maxArgs: 1, summary: "INT(value) — round down", sql: (c, g) => numericSql(g, sqlArgs(c, g), (x) => `floor(${x})`) });
  def({
    name: "MOD",
    minArgs: 2,
    maxArgs: 2,
    summary: "MOD(dividend, divisor) — result has the sign of the divisor",
    sql: (c, g) => numericSql(g, sqlArgs(c, g), (a, b) => `(${a} - ${b} * floor(${a} / NULLIF(${b}, 0)))`, (_, b) => errorIf(`${b} = 0`, "#DIV/0!")),
  });
  def({
    name: "VALUE",
    minArgs: 1,
    maxArgs: 1,
    summary: "VALUE(text)",
    sql: (c, g) => {
      const x = g.expr(c.args[0]!);
      const p = g.dispatch(x, (a) => (a.k === "boolean" ? { v: "NULL::float8", err: quoteText(VALUE) } : g.sem.toNumber(a)));
      return g.make("number", p.v, [x.err, p.err]);
    },
  });

  def({
    name: "SUM",
    minArgs: 1,
    maxArgs: Infinity,
    columnArgs: "all",
    summary: "SUM(value1, ...) — whole columns allowed",
    js: refArgsJs,
    sql: (c, g) => {
      const errs: (string | null)[] = [];
      const terms = aggArgs(c, g).map((a) => {
        if (a.kind === "column") return a.type === "number" ? g.columnQuery(a.node.name, a.node, (col) => `COALESCE(SUM(${col}), 0::float8)`) : "0::float8";
        if (a.kind === "ref") return a.type === "number" ? `COALESCE(${a.v}, 0::float8)` : "0::float8";
        const n = g.toNumber(a.val);
        errs.push(n.err);
        return n.v;
      });
      return g.make("number", `(${terms.join(" + ")})`, errs);
    },
  });

  def({
    name: "AVERAGE",
    minArgs: 1,
    maxArgs: Infinity,
    columnArgs: "all",
    summary: "AVERAGE(value1, ...) — #DIV/0! when there are no numbers",
    js: refArgsJs,
    sql: (c, g) => {
      const errs: (string | null)[] = [];
      const sums: string[] = [];
      const counts: string[] = [];
      for (const a of aggArgs(c, g)) {
        if (a.kind === "column") {
          if (a.type !== "number") continue;
          sums.push(g.columnQuery(a.node.name, a.node, (col) => `COALESCE(SUM(${col}), 0::float8)`));
          counts.push(g.columnQuery(a.node.name, a.node, (col) => `COUNT(${col})::float8`));
        } else if (a.kind === "ref") {
          if (a.type !== "number") continue;
          sums.push(`COALESCE(${a.v}, 0::float8)`);
          counts.push(`CASE WHEN ${a.v} IS NULL THEN 0::float8 ELSE 1::float8 END`);
        } else {
          const n = g.toNumber(a.val);
          errs.push(n.err);
          sums.push(n.v);
          counts.push("1::float8");
        }
      }
      const total = sums.length ? `(${sums.join(" + ")})` : "0::float8";
      const count = counts.length ? `(${counts.join(" + ")})` : "0::float8";
      return g.make("number", `(${total} / NULLIF(${count}, 0))`, [...errs, errorIf(`${count} = 0`, "#DIV/0!")]);
    },
  });

  for (const [name, fn, agg] of [["MIN", "LEAST", "MIN"], ["MAX", "GREATEST", "MAX"]] as const) {
    def({
      name,
      minArgs: 1,
      maxArgs: Infinity,
      columnArgs: "all",
      summary: `${name}(value1, ...) — 0 when there are no numbers`,
      js: refArgsJs,
      sql: (c, g) => {
        const errs: (string | null)[] = [];
        const parts = aggArgs(c, g).map((a) => {
          if (a.kind === "column") return a.type === "number" ? g.columnQuery(a.node.name, a.node, (col) => `${agg}(${col})`) : "NULL::float8";
          if (a.kind === "ref") return a.type === "number" ? a.v : "NULL::float8";
          const n = g.toNumber(a.val);
          errs.push(n.err);
          return n.v;
        });
        return g.make("number", `COALESCE(${fn}(${parts.join(", ")}), 0::float8)`, errs);
      },
    });
  }

  def({
    name: "COUNT",
    minArgs: 1,
    maxArgs: Infinity,
    columnArgs: "all",
    summary: "COUNT(value1, ...) — counts numbers",
    js: refArgsJs,
    sql: (c, g) => {
      const parts = aggArgs(c, g).map((a) => {
        if (a.kind === "column") return a.type === "number" ? g.columnQuery(a.node.name, a.node, (col) => `COUNT(${col})::float8`) : "0::float8";
        if (a.kind === "ref") return a.type === "number" ? `CASE WHEN ${a.v} IS NULL THEN 0::float8 ELSE 1::float8 END` : "0::float8";
        const p = g.dispatch(a.val, (k) => ({
          v: k.k === "number" || k.k === "boolean" ? "1::float8" : k.k === "text" ? `CASE WHEN ${k.e} ~ ${RE} THEN 1::float8 ELSE 0::float8 END` : "0::float8",
          err: null,
        }));
        return a.val.err === null ? p.v : `CASE WHEN ${a.val.err} IS NOT NULL THEN 0::float8 ELSE ${p.v} END`;
      });
      return g.make("number", `(${parts.join(" + ")})`, []);
    },
  });

  def({
    name: "COUNTA",
    minArgs: 1,
    maxArgs: Infinity,
    columnArgs: "all",
    summary: "COUNTA(value1, ...) — counts non-empty values",
    js: refArgsJs,
    sql: (c, g) => {
      const parts = aggArgs(c, g).map((a) => {
        if (a.kind === "column") return g.columnQuery(a.node.name, a.node, (col) => `COUNT(${col})::float8`);
        if (a.kind === "ref") return `CASE WHEN ${a.v} IS NULL THEN 0::float8 ELSE 1::float8 END`;
        return "1::float8";
      });
      return g.make("number", `(${parts.join(" + ")})`, []);
    },
  });

  /** WHERE builder for a criterion: literal criteria compile to plain SQL, others are parsed per row. */
  const criterionOf = (g: SqlGen, crit: BoundNode): { where: (col: string, t: FieldType) => string; err: string | null } => {
    const lit = isLiteral(crit);
    if (lit !== undefined) {
      const parsed = parseCriterion(lit);
      return { where: (col, t) => criterionSql(col, t, parsed), err: null };
    }
    const val = g.expr(crit);
    const where = (col: string, t: FieldType) =>
      g.dispatch(val, (a) => {
        switch (a.k) {
          case "blank": return { v: operandSql(col, t, "=", { kind: "blank" }), err: null };
          case "number": return { v: operandSql(col, t, "=", { kind: "number", sql: a.e }), err: null };
          case "boolean": return { v: operandSql(col, t, "=", { kind: "boolean", sql: a.e }), err: null };
          case "text": return { v: dynamicTextCriterionSql(col, t, a.e), err: null };
        }
      }).v;
    return { where, err: val.err };
  };

  def({
    name: "COUNTIF",
    minArgs: 2,
    maxArgs: 2,
    columnArgs: [0],
    requiredColumnArgs: [0],
    summary: 'COUNTIF(range, criterion) — range must be a whole column; criteria like ">5", "<>x", "a*", ">"&C2',
    js: (c, g) => g.call("COUNTIF", [g.expr(c.args[0]!), g.expr(c.args[1]!)]),
    sql: (c, g) => {
      const range = c.args[0] as BoundNode & { kind: "column" };
      const crit = criterionOf(g, c.args[1]!);
      return g.make("number", g.columnQuery(range.name, range, () => "COUNT(*)::float8", crit.where), [crit.err]);
    },
  });

  def({
    name: "SUMIF",
    minArgs: 2,
    maxArgs: 3,
    columnArgs: [0, 2],
    requiredColumnArgs: [0, 2],
    summary: "SUMIF(range, criterion, [sum_range]) — ranges must be whole columns",
    js: (c, g) => g.call("SUMIF", c.args.map((a) => g.expr(a))),
    sql: (c, g) => {
      const range = c.args[0] as BoundNode & { kind: "column" };
      const sumRange = (c.args[2] ?? range) as BoundNode & { kind: "column" };
      const crit = criterionOf(g, c.args[1]!);
      const rangeType = g.fieldType(range.name, range);
      const sumType = g.fieldType(sumRange.name, sumRange);
      if (sumType !== "number") return g.make("number", "0::float8", [crit.err]);
      const select = () => `COALESCE(SUM(${g.innerColumn(sumRange.name)}), 0::float8)`;
      return g.make("number", g.columnQuery(range.name, range, select, (col) => crit.where(col, rangeType)), [crit.err]);
    },
  });

  // ------------------------------------------------------------ text
  def({ name: "LEN", minArgs: 1, maxArgs: 1, summary: "LEN(text)", sql: (c, g) => { const t = textSql(g, sqlArgs(c, g), (s) => s); return g.make("number", `length(${t.v})::float8`, [t.err]); } });
  def({ name: "UPPER", minArgs: 1, maxArgs: 1, summary: "UPPER(text)", sql: (c, g) => textSql(g, sqlArgs(c, g), (s) => `upper(${s})`) });
  def({ name: "LOWER", minArgs: 1, maxArgs: 1, summary: "LOWER(text)", sql: (c, g) => textSql(g, sqlArgs(c, g), (s) => `lower(${s})`) });
  def({
    name: "TRIM",
    minArgs: 1,
    maxArgs: 1,
    summary: "TRIM(text) — also collapses inner runs of spaces",
    sql: (c, g) => textSql(g, sqlArgs(c, g), (s) => `regexp_replace(btrim(${s}, ' '), ' {2,}', ' ', 'g')`),
  });
  def({ name: "CONCATENATE", minArgs: 1, maxArgs: Infinity, summary: "CONCATENATE(text1, ...)", sql: (c, g) => textSql(g, sqlArgs(c, g), (...xs) => `(${xs.join(" || ")})`) });
  def({
    name: "TEXTJOIN",
    minArgs: 3,
    maxArgs: Infinity,
    summary: "TEXTJOIN(delimiter, ignore_empty, text1, ...) — ranges not supported yet",
    sql: (c, g) => {
      const [d, ig, ...xs] = sqlArgs(c, g);
      const delim = g.toText(d!);
      const ignore = g.toBool(ig!);
      const ts = xs.map((x) => g.toText(x));
      const items = ts.map((t) => `CASE WHEN ${ignore.v} AND ${t.v} = '' THEN NULL ELSE ${t.v} END`);
      return g.make("text", `array_to_string(ARRAY[${items.join(", ")}]::text[], ${delim.v})`, [delim.err, ignore.err, ...ts.map((t) => t.err)]);
    },
  });

  for (const fn of ["LEFT", "RIGHT"] as const) {
    def({
      name: fn,
      minArgs: 1,
      maxArgs: 2,
      summary: `${fn}(text, [num_chars])`,
      sql: (c, g) => {
        const [s, n] = sqlArgs(c, g);
        const k = g.toNumber(n ?? g.number(1));
        const t = g.toText(s!);
        return g.make("text", `${fn.toLowerCase()}(${t.v}, GREATEST(${g.int(k)}, 0))`, [k.err, t.err, errorIf(`trunc(${k.v}) < 0`, VALUE)]);
      },
    });
  }
  def({
    name: "MID",
    minArgs: 3,
    maxArgs: 3,
    summary: "MID(text, start, num_chars)",
    sql: (c, g) => {
      const [s, st, n] = sqlArgs(c, g);
      const start = g.toNumber(st!);
      const k = g.toNumber(n!);
      const t = g.toText(s!);
      return g.make("text", `substr(${t.v}, GREATEST(${g.int(start)}, 1), GREATEST(${g.int(k)}, 0))`, [
        start.err, k.err, t.err, errorIf(`trunc(${start.v}) < 1 OR trunc(${k.v}) < 0`, VALUE),
      ]);
    },
  });

  for (const name of ["FIND", "SEARCH"] as const) {
    def({
      name,
      minArgs: 2,
      maxArgs: 3,
      summary: `${name}(search_for, text, [start])`,
      notes: name === "FIND"
        ? "Case-sensitive; #VALUE! when not found."
        : variant === "excel" ? "Case-insensitive, supports * ? ~ wildcards; #VALUE! when not found." : "Case-insensitive; #VALUE! when not found.",
      sql: (c, g) => {
        const [f, w, st] = sqlArgs(c, g);
        const start = g.toNumber(st ?? g.number(1));
        const [needle, hay] = [g.toText(f!), g.toText(w!)];
        const S = `GREATEST(${g.int(start)}, 1)`;
        let p: string;
        let v: string;
        if (name === "SEARCH" && variant === "excel") {
          p = `regexp_instr(lower(${hay.v}), ${wildcardRegexSql(`lower(${needle.v})`)}, LEAST(${S}, length(${hay.v}) + 1))`;
          v = `${p}::float8`;
        } else {
          p = name === "FIND" ? `strpos(substr(${hay.v}, ${S}), ${needle.v})` : `strpos(substr(lower(${hay.v}), ${S}), lower(${needle.v}))`;
          v = `(${p} + ${S} - 1)::float8`;
        }
        const err = `CASE WHEN trunc(${start.v}) < 1 OR trunc(${start.v}) > length(${hay.v}) THEN '#VALUE!' WHEN ${p} = 0 THEN '#VALUE!' END`;
        return g.make("number", v, [start.err, needle.err, hay.err, err]);
      },
    });
  }

  def({
    name: "SUBSTITUTE",
    minArgs: 3,
    maxArgs: 4,
    summary: "SUBSTITUTE(text, old_text, new_text, [instance])",
    sql: (c, g) => {
      const [s, o, n, idx] = sqlArgs(c, g);
      const i = idx ? g.toNumber(idx) : null;
      const ts = [g.toText(s!), g.toText(o!), g.toText(n!)];
      const [t, old, rep] = ts.map((x) => x.v) as [string, string, string];
      if (!i) return g.make("text", `CASE WHEN ${old} = '' THEN ${t} ELSE replace(${t}, ${old}, ${rep}) END`, ts.map((x) => x.err));
      const iv = g.int(i);
      return g.make("text", substituteNthSql(t, old, rep, iv), [i.err, errorIf(`trunc(${i.v}) < 1`, VALUE), ...ts.map((x) => x.err)]);
    },
  });

  def({
    name: "REPLACE",
    minArgs: 4,
    maxArgs: 4,
    summary: "REPLACE(text, position, length, new_text)",
    sql: (c, g) => {
      const [s, st, n, r] = sqlArgs(c, g);
      const start = g.toNumber(st!);
      const k = g.toNumber(n!);
      const [t, rep] = [g.toText(s!), g.toText(r!)];
      const from = `GREATEST(${g.int(start)}, 1)`;
      return g.make("text", `(substr(${t.v}, 1, ${from} - 1) || ${rep.v} || substr(${t.v}, ${from} + GREATEST(${g.int(k)}, 0)))`, [
        start.err, k.err, t.err, rep.err, errorIf(`trunc(${start.v}) < 1 OR trunc(${k.v}) < 0`, VALUE),
      ]);
    },
  });

  registry.markUnsupported(variant, DATE_FUNCTIONS, "date and time functions are planned");
  registry.markUnsupported(variant, [
    "VLOOKUP", "HLOOKUP", "XLOOKUP", "LOOKUP", "INDEX", "MATCH", "XMATCH", "OFFSET", "INDIRECT", "CHOOSE",
    "FILTER", "SORT", "SORTBY", "UNIQUE", "ROW", "COLUMN", "ROWS", "COLUMNS",
  ], "lookup and reference functions are planned");
  registry.markUnsupported(variant, ["ARRAYFORMULA", "LAMBDA", "LET", "MAP", "REDUCE", "SCAN", "BYROW", "BYCOL", "MAKEARRAY", "SEQUENCE"], "array formulas and LAMBDA are planned");
  registry.markUnsupported(variant, [
    "SUMIFS", "COUNTIFS", "AVERAGEIF", "AVERAGEIFS", "MAXIFS", "MINIFS", "SUMPRODUCT", "COUNTBLANK", "PRODUCT",
    "POWER", "SQRT", "EXP", "LN", "LOG", "LOG10", "CEILING", "FLOOR", "TRUNC", "SIGN", "PI", "RAND", "RANDBETWEEN",
    "ISERROR", "ISERR", "ISNA", "ISLOGICAL", "N", "T", "XOR", "EXACT", "PROPER", "REPT", "CHAR", "CODE", "CONCAT",
    "FIXED", "DOLLAR", "NUMBERVALUE", "MEDIAN", "STDEV", "VAR", "LARGE", "SMALL", "RANK",
  ], "not implemented yet");
}
