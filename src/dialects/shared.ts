/** Helpers shared by the dialect function tables. */
import type { BoundCall } from "../core/ast";
import { registry, type FunctionSpec } from "../core/registry";
import type { Dialect } from "../core/types";
import { eagerJs, type JsGen } from "../codegen/js";
import type { SqlGen, SqlVal } from "../codegen/sql";
import type { RoundMode } from "../runtime/common";

export type SpecInput = Omit<FunctionSpec, "js"> & { js?: FunctionSpec["js"] };

export function definer(dialect: Dialect) {
  return (spec: SpecInput): void => registry.register(dialect, { js: eagerJs, ...spec });
}

/** Evaluated arguments as SqlVals. */
export function sqlArgs(call: BoundCall, g: SqlGen): SqlVal[] {
  return call.args.map((a) => g.expr(a));
}

export function lazyArgsJs(call: BoundCall, g: JsGen, eager: number[]): string {
  return g.call(
    call.name,
    call.args.map((a, i) => (eager.includes(i) ? g.expr(a) : g.lazy(a))),
  );
}

/** Numeric function of numeric arguments: f receives the coerced SQL expressions. */
export function numericSql(g: SqlGen, args: SqlVal[], f: (...xs: string[]) => string, extraErr: (...xs: string[]) => string | null = () => null): SqlVal {
  const nums = args.map((a) => g.toNumber(a));
  const vs = nums.map((n) => n.v);
  return g.make("number", f(...vs), [...nums.map((n) => n.err), extraErr(...vs)]);
}

export function textSql(g: SqlGen, args: SqlVal[], f: (...xs: string[]) => string): SqlVal {
  const ts = args.map((a) => g.toText(a));
  return g.make("text", f(...ts.map((t) => t.v)), ts.map((t) => t.err));
}

/**
 * Decimal rounding in SQL. x is cast to numeric (15 significant digits, the
 * same snapping roundDecimal() does in JS), then rounded.
 */
export function roundSql(mode: RoundMode, x: string, digits: string): string {
  const n = `(${x})::numeric`;
  const scale = `power(10::numeric, ${digits})`;
  switch (mode) {
    case "halfAwayFromZero":
      return `round(${n}, ${digits})::float8`;
    case "down":
      return `trunc(${n}, ${digits})::float8`;
    case "up":
      return `(sign(${n}) * ceil(abs(${n}) * ${scale}) / ${scale})::float8`;
    case "halfUp":
      return `(floor(${n} * ${scale} + 0.5) / ${scale})::float8`;
  }
}

export function roundDigits(g: SqlGen, d: SqlVal): string {
  return g.int(d, -400, 400);
}

/** SUBSTITUTE(text, old, new, instance) for one instance, via string_to_array. */
export function substituteNthSql(t: string, o: string, n: string, i: string): string {
  const arr = `string_to_array(${t}, ${o})`;
  return `CASE WHEN ${o} = '' OR COALESCE(array_length(${arr}, 1), 0) <= ${i} THEN ${t} ELSE array_to_string((${arr})[1:${i}], ${o}) || ${n} || array_to_string((${arr})[${i} + 1:], ${o}) END`;
}

export const ASCII_TRIM_SQL = "'^[ \\t\\n\\r\\f\\v]+|[ \\t\\n\\r\\f\\v]+$'";

export const DATE_FUNCTIONS = [
  "TODAY", "NOW", "DATE", "TIME", "YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "WEEKDAY", "WEEKNUM",
  "DATEVALUE", "TIMEVALUE", "EDATE", "EOMONTH", "NETWORKDAYS", "WORKDAY", "DATEDIF", "DAYS", "TEXT",
];
