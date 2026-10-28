import "./dialects/airtable/functions";
import "./dialects/excel/functions";
import "./dialects/sheets/functions";

import type { BoundNode, Node } from "./core/ast";
import { FormulaCompileError, makeFail } from "./core/errors";
import type { ParserConfig } from "./core/parser";
import { parse } from "./core/parser";
import { lookupFunction, resolve } from "./core/resolve";
import { DIALECTS, type CompileOptions, type Dialect, type LocaleOptions, type Target } from "./core/types";
import { generateJs, isTopLevelSearch } from "./codegen/js";
import { SQL_TYPE_NAMES, SqlGen, type SqlType } from "./codegen/sql";
import { airtableParserConfig } from "./dialects/airtable/parser-config";
import { excelParserConfig } from "./dialects/excel/parser-config";
import { sheetsParserConfig } from "./dialects/sheets/parser-config";
import { runtimeFor } from "./runtime/index";
import type { EvalContext, Value } from "./runtime/common";

export interface AstResult {
  target: "ast";
  dialect: Dialect;
  ast: Node;
}

export interface JsResult {
  target: "js";
  dialect: Dialect;
  /** Source of `(record, rt, ctx) => value`; rt is runtimeFor(dialect). */
  code: string;
  /** Ready-to-use evaluator built from `code`. */
  evaluate: (record: Record<string, unknown>, ctx?: EvalContext) => Value;
}

export interface SqlResult {
  target: "sql";
  dialect: Dialect;
  /** Value expression; NULL when the formula evaluates to an error or blank. */
  sql: string;
  /** Error code expression ('#DIV/0!', ...) or NULL. */
  errorSql: string;
  /** Static result type; "any" means jsonb (branches of different types). */
  type: SqlType;
  /** PostgreSQL type of `sql`, or null when the result is always blank. */
  sqlType: string | null;
}

export type CompileResult = AstResult | JsResult | SqlResult;

type ResultFor<T extends Target> = T extends "ast" ? AstResult : T extends "js" ? JsResult : SqlResult;

const parserConfigs: Partial<Record<Dialect, (locale: LocaleOptions | undefined) => ParserConfig>> = {
  airtable: () => airtableParserConfig,
  excel: excelParserConfig,
  sheets: sheetsParserConfig,
};

export function registerParserConfig(dialect: Dialect, make: (locale: LocaleOptions | undefined) => ParserConfig): void {
  parserConfigs[dialect] = make;
}

function checkOptions(formula: string, options: CompileOptions): void {
  if (typeof formula !== "string") throw new TypeError("formula must be a string");
  if (!DIALECTS.includes(options.from)) throw new TypeError(`Unknown source program "${String(options.from)}"; use one of ${DIALECTS.join(", ")}`);
  if (!["js", "sql", "ast"].includes(options.to)) throw new TypeError(`Unknown target "${String(options.to)}"; use js, sql or ast`);
  const fail = makeFail(options.from, formula);
  const loc = options.locale;
  if (loc) {
    if (options.from === "airtable") fail("INVALID_OPTION", "The locale option only applies to Sheets/Excel", 0, 0);
    if (loc.argumentSeparator !== undefined && loc.argumentSeparator !== "," && loc.argumentSeparator !== ";") {
      fail("INVALID_OPTION", 'locale.argumentSeparator must be "," or ";"', 0, 0);
    }
    if (loc.decimalSeparator !== undefined && loc.decimalSeparator !== "." && loc.decimalSeparator !== ",") {
      fail("INVALID_OPTION", 'locale.decimalSeparator must be "." or ","', 0, 0);
    }
    if (loc.decimalSeparator === "," && (loc.argumentSeparator ?? ",") === ",") {
      fail("INVALID_OPTION", 'decimalSeparator "," requires argumentSeparator ";"', 0, 0);
    }
  }
  for (const k of ["headerRow", "currentRow"] as const) {
    const v = options[k];
    if (v !== undefined && (!Number.isInteger(v) || v < (k === "headerRow" ? 0 : 1))) fail("INVALID_OPTION", `${k} must be a positive integer`, 0, 0);
  }
}

/** Parse only; returns the shared AST. */
export function parseFormula(formula: string, options: Pick<CompileOptions, "from" | "locale">): Node {
  const make = parserConfigs[options.from];
  if (!make) throw new TypeError(`No parser registered for ${options.from}`);
  const fail = makeFail(options.from, formula);
  const config = make(options.locale);
  return parse(formula, { ...config, onCall: (name, start, end) => lookupFunction(options.from, name, start, end, fail) }, fail);
}

function bind(formula: string, options: CompileOptions): { ast: Node; bound: BoundNode } {
  checkOptions(formula, options);
  const ast = parseFormula(formula, options);
  const bound = resolve(ast, { dialect: options.from, formula, options, fail: makeFail(options.from, formula) });
  return { ast, bound };
}

export function compile<T extends Target>(formula: string, options: CompileOptions & { to: T }): ResultFor<T>;
export function compile(formula: string, options: CompileOptions): CompileResult {
  const { ast, bound } = bind(formula, options);
  const dialect = options.from;
  if (options.to === "ast") return { target: "ast", dialect, ast };
  if (options.to === "js") {
    const code = generateJs(bound, dialect, options);
    const fn = new Function(`return ${code}`)() as (r: unknown, rt: unknown, ctx: unknown) => Value;
    const rt = runtimeFor(dialect);
    return { target: "js", dialect, code, evaluate: (record, ctx) => fn(record ?? {}, rt, ctx ?? {}) };
  }
  const g = new SqlGen(dialect, options, makeFail(dialect, formula));
  let value = g.expr(bound);
  if (isTopLevelSearch(bound, dialect)) value = { ...value, v: `NULLIF(${value.v}, 0::float8)`, nullable: true };
  const out = g.finish(value);
  return {
    target: "sql",
    dialect,
    sql: out.value,
    errorSql: out.error,
    type: out.type,
    sqlType: out.type === "blank" ? null : SQL_TYPE_NAMES[out.type],
  };
}

/** Shorthand: compile to JS and return the evaluator. */
export function createEvaluator(formula: string, options: Omit<CompileOptions, "to">) {
  return compile(formula, { ...options, to: "js" }).evaluate;
}

export { FormulaCompileError } from "./core/errors";
export type { CompileErrorCode } from "./core/errors";
export type { CompileOptions, Dialect, FieldType, LocaleOptions, Target } from "./core/types";
export type { Node, BoundNode } from "./core/ast";
export { FormulaError, isError } from "./runtime/common";
export type { Value, EvalContext } from "./runtime/common";
export { runtimeFor } from "./runtime/index";
export { registry } from "./core/registry";
export { FormulaCompileError as CompileError };
