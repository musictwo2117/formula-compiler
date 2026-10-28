/**
 * PostgreSQL code generation.
 *
 * Every expression compiles to an SqlVal: a value expression `v`, its static
 * type `t`, and `err` — an SQL expression giving the error code (e.g.
 * '#DIV/0!') or NULL. Errors are carried alongside values so IFERROR / ISERROR
 * can catch them, exactly like the JS runtime. Blank is SQL NULL.
 *
 * When branches of IF/SWITCH/IFERROR have different types the value is
 * carried as jsonb (type "any") and coerced at run time.
 */
import type { BinaryOperator, BoundCall, BoundNode, Span } from "../core/ast";
import type { Fail } from "../core/errors";
import { registry } from "../core/registry";
import type { CompileOptions, Dialect, FieldType } from "../core/types";
import { JS_NUMBER_TEXT_SQL, NUMERIC_TEXT, NUMERIC_TEXT_SQL, SHEETS_NUMBER_TEXT_SQL, jsNumber, sheetsNumber } from "../runtime/common";

export type SqlType = "number" | "text" | "boolean" | "blank" | "any";

export interface SqlVal {
  v: string;
  t: SqlType;
  err: string | null;
  nullable: boolean;
  /** Set for literals so coercions can be folded at compile time. */
  lit?: number | string | boolean;
}

export type Kind = "blank" | "number" | "text" | "boolean";

/** One possible runtime kind of a value and the condition under which it applies. */
export interface KindArm {
  k: Kind;
  /** null = "otherwise" (always the last arm). */
  when: string | null;
  e: string;
  lit?: number | string | boolean;
}

export interface Part {
  v: string;
  err: string | null;
}

export const SQL_TYPE_NAMES: Record<Exclude<SqlType, "blank">, string> = {
  number: "double precision",
  text: "text",
  boolean: "boolean",
  any: "jsonb",
};

// ---------------------------------------------------------------- quoting

export function quoteIdent(name: string): string {
  if (name.includes("\0")) throw new TypeError("Identifiers cannot contain NUL characters");
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteText(s: string): string {
  if (s.includes("\0")) throw new TypeError("Text cannot contain NUL characters");
  const body = s.replace(/'/g, "''");
  // E'' strings keep backslashes safe whatever standard_conforming_strings is.
  return s.includes("\\") ? `E'${body.replace(/\\/g, "\\\\")}'` : `'${body}'`;
}

export function sqlNumber(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError(`Cannot emit non-finite number ${n}`);
  return `${String(n)}::float8`;
}

export function coalesce(errs: (string | null | undefined)[]): string | null {
  const list = errs.filter((e): e is string => e !== null && e !== undefined && e !== "NULL");
  if (list.length === 0) return null;
  if (list.length === 1) return list[0]!;
  return `COALESCE(${list.join(", ")})`;
}

export function caseOf(arms: { when: string | null; then: string }[]): string {
  if (arms.length === 0) return "NULL";
  const last = arms[arms.length - 1]!;
  if (arms.length === 1 && last.when === null) return last.then;
  if (last.when === null && arms.every((a) => a.then === last.then)) return last.then;
  if (last.when !== null && arms.every((a) => a.then === "NULL")) return "NULL";
  let out = "CASE";
  for (const a of arms) out += a.when === null ? ` ELSE ${a.then}` : ` WHEN ${a.when} THEN ${a.then}`;
  return `${out} END`;
}

export function errorIf(cond: string, code: string): string {
  return `CASE WHEN ${cond} THEN ${quoteText(code)} END`;
}

// ---------------------------------------------------------------- semantics

/** Per-program coercion and comparison rules. Mirrors src/runtime/*.ts. */
export interface Semantics {
  /** Airtable treats '' like blank. */
  emptyTextIsBlank: boolean;
  /** Airtable: text (even empty) in * and / is #ERROR!. */
  strictMulDiv: boolean;
  /** Division by zero: an error code, or IEEE Infinity/NaN (Airtable). */
  divZero: "ieee" | string;
  toNumber(a: KindArm): Part;
  toText(a: KindArm): Part;
  toBool(a: KindArm): Part;
  /** SQL boolean comparing two non-blank arms of the same kind. */
  compareSame(op: BinaryOperator, a: KindArm, b: KindArm): string;
  /** SQL boolean comparing two non-blank arms of different kinds. */
  compareMixed(op: BinaryOperator, a: KindArm, b: KindArm): string;
}

const RE = quoteText(NUMERIC_TEXT_SQL);

function opResult(op: BinaryOperator, c: number): string {
  const r = op === "=" ? c === 0 : op === "<>" ? c !== 0 : op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
  return r ? "TRUE" : "FALSE";
}

const RANK: Record<Kind, number> = { blank: 0, number: 1, text: 2, boolean: 3 };

/** A double literal, including Infinity and NaN. */
export function sqlFloat(n: number): string {
  if (Number.isNaN(n)) return "'NaN'::float8";
  if (n === Infinity) return "'Infinity'::float8";
  if (n === -Infinity) return "'-Infinity'::float8";
  return sqlNumber(n);
}

/** Google Sheets text → number (see sheetsNumber()); value and validity as SQL. */
export function sheetsNumberSql(e: string): { v: string; valid: string } {
  const valid = `(${e} ~ ${quoteText(SHEETS_NUMBER_TEXT_SQL)} AND (${e} ~ '\\(') = (${e} ~ '\\)') AND ${e} !~ '[+-].*[+-]')`;
  const digits = `regexp_replace(${e}, '[^0-9.]', '', 'g')::float8`;
  const v = `(${digits} * CASE WHEN ${e} ~ '[-(]' THEN -1 ELSE 1 END / CASE WHEN ${e} ~ '%' THEN 100 ELSE 1 END)`;
  return { v, valid };
}

/** Number → text: 15 significant digits; Sheets switches to 1E+21 / 1E-11 outside [1e-10, 1e21). */
function spreadsheetNumberText(e: string, variant: "sheets" | "excel"): string {
  const plain = `trim_scale((${e})::numeric)::text`;
  if (variant === "excel") return plain;
  const sci = `upper(regexp_replace(btrim(to_char(${e}, '9.99999999999999EEEE')), '\\.?0*e', 'e'))`;
  return `CASE WHEN ${e} = 0 THEN '0' WHEN abs(${e}) >= 1e21 OR abs(${e}) < 1e-10 THEN ${sci} ELSE ${plain} END`;
}

export const spreadsheetSemantics = (variant: "sheets" | "excel"): Semantics => ({
  emptyTextIsBlank: false,
  strictMulDiv: false,
  divZero: "#DIV/0!",
  toNumber(a) {
    switch (a.k) {
      case "blank": return { v: "0::float8", err: null };
      case "number": return { v: a.e, err: null };
      case "boolean": return { v: `CASE WHEN ${a.e} THEN 1::float8 ELSE 0::float8 END`, err: null };
      case "text":
        if (variant === "sheets") {
          if (typeof a.lit === "string") {
            const n = a.lit === "" ? 0 : sheetsNumber(a.lit);
            return n === undefined ? { v: "NULL::float8", err: "'#VALUE!'" } : { v: sqlNumber(n), err: null };
          }
          const p = sheetsNumberSql(a.e);
          return {
            v: `CASE WHEN ${a.e} = '' THEN 0::float8 WHEN ${p.valid} THEN ${p.v} END`,
            err: `CASE WHEN ${a.e} = '' OR ${p.valid} THEN NULL ELSE '#VALUE!' END`,
          };
        }
        if (typeof a.lit === "string") {
          return NUMERIC_TEXT.test(a.lit) ? { v: sqlNumber(Number(a.lit.trim())), err: null } : { v: "NULL::float8", err: "'#VALUE!'" };
        }
        return { v: `CASE WHEN ${a.e} ~ ${RE} THEN (${a.e})::float8 END`, err: `CASE WHEN ${a.e} ~ ${RE} THEN NULL ELSE '#VALUE!' END` };
    }
  },
  toText(a) {
    switch (a.k) {
      case "blank": return { v: "''", err: null };
      case "text": return { v: a.e, err: null };
      case "boolean": return { v: `CASE WHEN ${a.e} THEN 'TRUE' ELSE 'FALSE' END`, err: null };
      case "number": return { v: spreadsheetNumberText(a.e, variant), err: null };
    }
  },
  toBool(a) {
    switch (a.k) {
      case "blank": return { v: "FALSE", err: null };
      case "boolean": return { v: a.e, err: null };
      case "number": return { v: `(${a.e} <> 0)`, err: null };
      case "text": {
        if (typeof a.lit === "string") {
          const u = a.lit.toUpperCase();
          return u === "TRUE" || u === "FALSE" ? { v: u, err: null } : { v: "NULL::boolean", err: "'#VALUE!'" };
        }
        return {
          v: `CASE WHEN upper(${a.e}) = 'TRUE' THEN TRUE WHEN upper(${a.e}) = 'FALSE' THEN FALSE END`,
          err: `CASE WHEN upper(${a.e}) IN ('TRUE', 'FALSE') THEN NULL ELSE '#VALUE!' END`,
        };
      }
    }
  },
  compareSame(op, a, b) {
    if (a.k === "text") return `(lower(${a.e}) COLLATE "C" ${op} lower(${b.e}) COLLATE "C")`;
    return `(${a.e} ${op} ${b.e})`;
  },
  compareMixed(op, a, b) {
    // Different kinds never coerce: numbers < text < booleans.
    return opResult(op, RANK[a.k] - RANK[b.k]);
  },
});

/** JavaScript Number(text) in SQL (see jsNumber()). */
export function jsNumberSql(e: string): string {
  const t = `regexp_replace(${e}, '^\\s+|\\s+$', '', 'g')`;
  return `CASE WHEN ${t} = '' THEN 0::float8 WHEN ${t} ~ ${quoteText(JS_NUMBER_TEXT_SQL)} OR ${t} ~ '^[+-]?Infinity$' THEN (${t})::float8 ELSE 'NaN'::float8 END`;
}

/** A float expression that cannot be NaN (a literal or a plain column), so comparisons need no NaN guard. */
function surelyNotNaN(e: string): boolean {
  return /^-?[0-9.]+(e[+-]?[0-9]+)?::float8$/.test(e) || /^(COALESCE\()?("[^"]*(?:""[^"]*)*"\.)?"[^"]*(?:""[^"]*)*"(, 0::float8\))?$/.test(e);
}

/** Numeric comparison with JavaScript NaN rules (every comparison with NaN is false except <>). */
function jsNumericCompare(op: BinaryOperator, x: string, y: string): string {
  const guards = [x, y].filter((e) => !surelyNotNaN(e)).map((e) => `${e} = 'NaN'::float8`);
  if (guards.length === 0) return `(${x} ${op} ${y})`;
  const anyNaN = guards.join(" OR ");
  return op === "<>" ? `(${x} <> ${y} OR ${anyNaN})` : `(${x} ${op} ${y} AND NOT (${anyNaN}))`;
}

export const airtableSemantics: Semantics = {
  emptyTextIsBlank: true,
  strictMulDiv: true,
  divZero: "ieee",
  toNumber(a) {
    switch (a.k) {
      case "blank": return { v: "0::float8", err: null };
      case "number": return { v: a.e, err: null };
      case "boolean": return { v: `CASE WHEN ${a.e} THEN 1::float8 ELSE 0::float8 END`, err: null };
      case "text":
        if (typeof a.lit === "string") return { v: sqlFloat(jsNumber(a.lit)), err: null };
        return { v: jsNumberSql(a.e), err: null };
    }
  },
  toText(a) {
    switch (a.k) {
      case "blank": return { v: "''", err: null };
      case "text": return { v: a.e, err: null };
      case "boolean": return { v: `CASE WHEN ${a.e} THEN 'TRUE' ELSE 'FALSE' END`, err: null };
      case "number":
        // Same text as JavaScript's String(n).
        return {
          v: `CASE WHEN abs(${a.e}) >= 1e21 OR (${a.e} <> 0 AND abs(${a.e}) < 1e-6) THEN regexp_replace((${a.e})::text, ${quoteText("e([+-])0*(\\d)")}, ${quoteText("e\\1\\2")}) ELSE ((${a.e})::text::numeric)::text END`,
          err: null,
        };
    }
  },
  toBool(a) {
    switch (a.k) {
      case "blank": return { v: "FALSE", err: null };
      case "boolean": return { v: a.e, err: null };
      case "number": return { v: surelyNotNaN(a.e) ? `(${a.e} <> 0)` : `(${a.e} <> 0 AND ${a.e} <> 'NaN'::float8)`, err: null };
      case "text": return { v: "TRUE", err: null };
    }
  },
  compareSame(op, a, b) {
    if (a.k === "text") return `(${a.e} COLLATE "C" ${op} ${b.e} COLLATE "C")`;
    const x = airtableSemantics.toNumber(a).v;
    const y = airtableSemantics.toNumber(b).v;
    return jsNumericCompare(op, x, y);
  },
  compareMixed(op, a, b) {
    // JavaScript loose comparison: text against a number/boolean is compared as Number(text).
    return jsNumericCompare(op, airtableSemantics.toNumber(a).v, airtableSemantics.toNumber(b).v);
  },
};

// ---------------------------------------------------------------- generator

const INNER = quoteIdent("__fc_r");

export class SqlGen {
  readonly sem: Semantics;

  constructor(
    readonly dialect: Dialect,
    readonly options: CompileOptions,
    readonly fail: Fail,
  ) {
    this.sem = dialect === "airtable" ? airtableSemantics : spreadsheetSemantics(dialect);
  }

  // ---- literals
  number(n: number): SqlVal {
    return { v: sqlNumber(n), t: "number", err: null, nullable: false, lit: n };
  }
  text(s: string): SqlVal {
    return { v: quoteText(s), t: "text", err: null, nullable: false, lit: s };
  }
  boolean(b: boolean): SqlVal {
    return { v: b ? "TRUE" : "FALSE", t: "boolean", err: null, nullable: false, lit: b };
  }
  blank(): SqlVal {
    return { v: "NULL", t: "blank", err: null, nullable: true };
  }
  error(code: string): SqlVal {
    return { v: "NULL", t: "blank", err: quoteText(code), nullable: true };
  }
  make(t: SqlType, v: string, errs: (string | null)[], nullable = false): SqlVal {
    return { v, t, err: coalesce(errs), nullable };
  }

  // ---- references
  fieldType(name: string, span: Span): FieldType {
    const t = this.options.fieldTypes?.[name];
    if (t === undefined) {
      return this.fail(
        "MISSING_FIELD_TYPE",
        `SQL target needs the type of field "${name}": pass fieldTypes: { ${JSON.stringify(name)}: "number" | "text" | "boolean" }`,
        span.start,
        span.end,
      );
    }
    if (t !== "number" && t !== "text" && t !== "boolean") {
      return this.fail("INVALID_OPTION", `fieldTypes["${name}"] must be "number", "text" or "boolean"`, span.start, span.end);
    }
    return t;
  }

  fieldRef(name: string): string {
    const alias = this.options.tableAlias ?? this.options.table;
    return alias ? `${quoteIdent(alias)}.${quoteIdent(name)}` : quoteIdent(name);
  }

  /** A column of the row inside a columnQuery() subquery. */
  innerColumn(name: string): string {
    return `${INNER}.${quoteIdent(name)}`;
  }

  /** `(SELECT agg FROM table AS "__fc_r")` — agg receives the inner column expression. */
  columnQuery(name: string, span: Span, select: (col: string, type: FieldType) => string, where?: (col: string, type: FieldType) => string): string {
    const table = this.options.table;
    if (!table) {
      return this.fail("INVALID_OPTION", `Whole-column ranges need the SQL table name: pass the table option`, span.start, span.end);
    }
    const type = this.fieldType(name, span);
    const col = this.innerColumn(name);
    const w = where ? ` WHERE ${where(col, type)}` : "";
    return `(SELECT ${select(col, type)} FROM ${quoteIdent(table)} AS ${INNER}${w})`;
  }

  // ---- kinds & coercion
  kinds(x: SqlVal): KindArm[] {
    const blankWhen = (e: string, extra?: string) => (extra ? `(${e} IS NULL OR ${extra})` : `${e} IS NULL`);
    if (x.t === "blank") return [{ k: "blank", when: null, e: "NULL" }];
    if (x.t === "any") {
      const empty = this.sem.emptyTextIsBlank ? `${x.v} = '""'::jsonb` : undefined;
      return [
        { k: "blank", when: blankWhen(x.v, empty), e: "NULL" },
        { k: "number", when: `jsonb_typeof(${x.v}) = 'number'`, e: `(${x.v})::float8` },
        { k: "text", when: `jsonb_typeof(${x.v}) = 'string'`, e: `(${x.v} #>> '{}')` },
        { k: "boolean", when: null, e: `(${x.v})::boolean` },
      ];
    }
    const arm: KindArm = { k: x.t, when: null, e: x.v };
    if (x.lit !== undefined) arm.lit = x.lit;
    if (x.t === "text" && this.sem.emptyTextIsBlank) {
      if (x.lit === "") return [{ k: "blank", when: null, e: "NULL" }];
      if (x.lit === undefined) return [{ k: "blank", when: blankWhen(x.v, `${x.v} = ''`), e: "NULL" }, arm];
      return [arm];
    }
    return x.nullable ? [{ k: "blank", when: blankWhen(x.v), e: "NULL" }, arm] : [arm];
  }

  dispatch(x: SqlVal, f: (a: KindArm) => Part): Part {
    const arms = this.kinds(x).map((a) => ({ when: a.when, part: f(a) }));
    const v = caseOf(arms.map((a) => ({ when: a.when, then: a.part.v })));
    const anyErr = arms.some((a) => a.part.err !== null);
    const err = anyErr ? caseOf(arms.map((a) => ({ when: a.when, then: a.part.err ?? "NULL" }))) : null;
    return { v, err };
  }

  dispatch2(a: SqlVal, b: SqlVal, f: (x: KindArm, y: KindArm) => Part): Part {
    const outer = this.kinds(a).map((ka) => ({ when: ka.when, part: this.dispatch(b, (kb) => f(ka, kb)) }));
    const v = caseOf(outer.map((o) => ({ when: o.when, then: o.part.v })));
    const anyErr = outer.some((o) => o.part.err !== null);
    const err = anyErr ? caseOf(outer.map((o) => ({ when: o.when, then: o.part.err ?? "NULL" }))) : null;
    return { v, err };
  }

  toNumber(x: SqlVal): SqlVal {
    if (x.t === "number" && !x.nullable) return x;
    if (x.t === "number") return this.make("number", `COALESCE(${x.v}, 0::float8)`, [x.err]);
    const p = this.dispatch(x, (a) => this.sem.toNumber(a));
    return this.make("number", p.v, [x.err, p.err]);
  }
  toText(x: SqlVal): SqlVal {
    if (x.t === "text" && !x.nullable) return x;
    if (x.t === "text") return this.make("text", `COALESCE(${x.v}, '')`, [x.err]);
    const p = this.dispatch(x, (a) => this.sem.toText(a));
    return this.make("text", p.v, [x.err, p.err]);
  }
  toBool(x: SqlVal): SqlVal {
    if (x.t === "boolean" && !x.nullable) return x;
    const p = this.dispatch(x, (a) => this.sem.toBool(a));
    return this.make("boolean", p.v, [x.err, p.err]);
  }
  /** Truncated integer clamped to [lo, hi], as an SQL int expression (x must be a number). */
  int(x: SqlVal, lo = -1000000000, hi = 1000000000): string {
    return `LEAST(GREATEST(trunc(${x.v}), ${lo}), ${hi})::int`;
  }

  compare(op: BinaryOperator, a: SqlVal, b: SqlVal): SqlVal {
    const defaults: Record<Exclude<Kind, "blank">, KindArm> = {
      number: { k: "number", when: null, e: "0::float8", lit: 0 },
      text: { k: "text", when: null, e: "''", lit: "" },
      boolean: { k: "boolean", when: null, e: "FALSE", lit: false },
    };
    if (a.t === b.t && a.t !== "any" && a.t !== "blank") {
      // Same static type: blank becomes that type's empty value on either side.
      const fill = (x: SqlVal): KindArm => {
        const arm: KindArm = { k: a.t as Kind, when: null, e: x.nullable ? `COALESCE(${x.v}, ${defaults[a.t as Exclude<Kind, "blank">].e})` : x.v };
        if (x.lit !== undefined) arm.lit = x.lit;
        return arm;
      };
      return this.make("boolean", this.sem.compareSame(op, fill(a), fill(b)), [a.err, b.err]);
    }
    const p = this.dispatch2(a, b, (x, y) => {
      if (x.k === "blank" && y.k === "blank") return { v: opResult(op, 0), err: null };
      if (x.k === "blank") x = defaults[y.k as Exclude<Kind, "blank">];
      if (y.k === "blank") y = defaults[x.k as Exclude<Kind, "blank">];
      return { v: x.k === y.k ? this.sem.compareSame(op, x, y) : this.sem.compareMixed(op, x, y), err: null };
    });
    return this.make("boolean", p.v, [a.err, b.err, p.err]);
  }

  /** Convert a value so it can sit in a branch of type t. */
  cast(x: SqlVal, t: SqlType): string {
    if (x.t === t) return x.v;
    if (x.t === "blank") return t === "blank" ? "NULL" : `NULL::${SQL_TYPE_NAMES[t as Exclude<SqlType, "blank">]}`;
    if (t === "any") return x.t === "any" ? x.v : `to_jsonb((${x.v})::${SQL_TYPE_NAMES[x.t]})`;
    throw new Error(`internal: cannot cast ${x.t} to ${t}`);
  }

  joinType(vals: SqlVal[]): SqlType {
    const ts = new Set(vals.map((v) => v.t).filter((t) => t !== "blank"));
    if (ts.size === 0) return "blank";
    if (ts.size === 1) return [...ts][0]!;
    return "any";
  }

  /** CASE WHEN cond1 THEN r1 ... ELSE otherwise, with errors from conditions and the chosen branch. */
  chain(arms: { cond: SqlVal; then: SqlVal }[], otherwise: SqlVal): SqlVal {
    const t = this.joinType([...arms.map((a) => a.then), otherwise]);
    const v = caseOf([
      ...arms.map((a) => ({ when: a.cond.v, then: this.cast(a.then, t) })),
      { when: null, then: this.cast(otherwise, t) },
    ]);
    const hasErr = otherwise.err !== null || arms.some((a) => a.cond.err !== null || a.then.err !== null);
    let err: string | null = null;
    if (hasErr) {
      const errArms: { when: string | null; then: string }[] = [];
      for (const a of arms) {
        if (a.cond.err !== null) errArms.push({ when: `${a.cond.err} IS NOT NULL`, then: a.cond.err });
        errArms.push({ when: a.cond.v, then: a.then.err ?? "NULL" });
      }
      errArms.push({ when: null, then: otherwise.err ?? "NULL" });
      err = caseOf(errArms);
    }
    const nullable = t === "blank" || arms.some((a) => a.then.nullable) || otherwise.nullable;
    return { v, t, err, nullable };
  }

  // ---- expressions
  expr(n: BoundNode): SqlVal {
    switch (n.kind) {
      case "number": return this.number(n.value);
      case "string": return this.text(n.value);
      case "boolean": return this.boolean(n.value);
      case "error": return this.error(n.code);
      case "field": {
        const t = this.fieldType(n.name, n);
        const ref = this.fieldRef(n.name);
        if (this.dialect === "airtable") {
          // Airtable: an empty text field is "", an unchecked checkbox is blank.
          if (t === "text") return { v: `COALESCE(${ref}, '')`, t, err: null, nullable: false };
          if (t === "boolean") return { v: `NULLIF(${ref}, FALSE)`, t, err: null, nullable: true };
        }
        return { v: ref, t, err: null, nullable: true };
      }
      case "column":
        return this.fail("INVALID_ARGUMENT", "Whole-column range used outside an aggregate function", n.start, n.end);
      case "unary": {
        const x = this.expr(n.operand);
        if (n.operator === "+") return x;
        const num = this.toNumber(x);
        return this.make("number", `(- ${num.v})`, [num.err]);
      }
      case "percent": {
        const num = this.toNumber(this.expr(n.operand));
        return this.make("number", `(${num.v} / 100)`, [num.err]);
      }
      case "binary": return this.binary(n.operator, this.expr(n.left), this.expr(n.right));
      case "call": {
        const found = registry.lookup(this.dialect, n.name);
        if (found.status !== "ok") throw new Error(`internal: unresolved function ${n.name}`);
        return found.spec.sql(n as BoundCall, this);
      }
    }
  }

  /** Operand of * or /: Airtable rejects any text there, even empty text. */
  mulDivNumber(x: SqlVal): SqlVal {
    if (!this.sem.strictMulDiv) return this.toNumber(x);
    if (x.t === "text") return this.make("number", "NULL::float8", [x.err, quoteText("#ERROR!")]);
    const n = this.toNumber(x);
    if (x.t !== "any") return n;
    return this.make("number", n.v, [x.err, errorIf(`jsonb_typeof(${x.v}) = 'string'`, "#ERROR!"), n.err]);
  }

  binary(op: BinaryOperator, a: SqlVal, b: SqlVal): SqlVal {
    switch (op) {
      case "&": {
        const x = this.toText(a);
        const y = this.toText(b);
        return this.make("text", `(${x.v} || ${y.v})`, [x.err, y.err]);
      }
      case "+":
      case "-": {
        const x = this.toNumber(a);
        const y = this.toNumber(b);
        return this.make("number", `(${x.v} ${op} ${y.v})`, [x.err, y.err]);
      }
      case "*": {
        const x = this.mulDivNumber(a);
        const y = this.mulDivNumber(b);
        return this.make("number", `(${x.v} * ${y.v})`, [x.err, y.err]);
      }
      case "/": {
        const x = this.mulDivNumber(a);
        const y = this.mulDivNumber(b);
        if (this.sem.divZero === "ieee") {
          const zero = `CASE WHEN ${x.v} = 'NaN'::float8 OR ${x.v} = 0 THEN 'NaN'::float8 WHEN ${x.v} > 0 THEN 'Infinity'::float8 ELSE '-Infinity'::float8 END`;
          return this.make("number", `CASE WHEN ${y.v} = 0 THEN ${zero} ELSE ${x.v} / ${y.v} END`, [x.err, y.err]);
        }
        return this.make("number", `(${x.v} / NULLIF(${y.v}, 0))`, [x.err, y.err, errorIf(`${y.v} = 0`, this.sem.divZero)]);
      }
      case "^": {
        const x = this.toNumber(a);
        const y = this.toNumber(b);
        const zeroZero = this.dialect === "excel" ? ` WHEN ${x.v} = 0 AND ${y.v} = 0 THEN '#NUM!'` : "";
        const zeroNeg = this.dialect === "sheets" ? "'#NUM!'" : "'#DIV/0!'";
        const err = `CASE WHEN ${x.v} = 0 AND ${y.v} < 0 THEN ${zeroNeg}${zeroZero} WHEN ${x.v} < 0 AND ${y.v} <> trunc(${y.v}) THEN '#NUM!' END`;
        const v = `CASE WHEN (${x.v} = 0 AND ${y.v} < 0) OR (${x.v} < 0 AND ${y.v} <> trunc(${y.v})) THEN NULL ELSE power(${x.v}, ${y.v}) END`;
        return this.make("number", v, [x.err, y.err, err]);
      }
      default:
        return this.compare(op, a, b);
    }
  }

  /** Final SELECT-able expressions. */
  finish(x: SqlVal): { value: string; error: string; type: SqlType } {
    if (this.dialect === "excel" && x.nullable) {
      // Excel shows an empty referenced cell as 0 when it is the formula result.
      if (x.t === "number" || x.t === "blank") x = { ...x, v: `COALESCE(${x.v}, 0::float8)`, t: "number", nullable: false };
      else x = { ...x, v: `COALESCE(${this.cast(x, "any")}, to_jsonb(0))`, t: "any", nullable: false };
    }
    const value = x.err === null ? x.v : `CASE WHEN ${x.err} IS NULL THEN ${x.v} END`;
    return { value, error: x.err ?? "NULL::text", type: x.t };
  }
}

export function defaultSql(call: BoundCall, g: SqlGen): never {
  return g.fail("UNSUPPORTED_IN_SQL", `${call.name} cannot be compiled to SQL yet`, call.start, call.end, call.name);
}

export type { FieldType };
