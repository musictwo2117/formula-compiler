/**
 * Date and time functions for Google Sheets and Excel. Dates are serial
 * numbers (days since 1899-12-30), so they are ordinary numbers everywhere
 * else. JS helpers live in src/runtime/spreadsheet-dates.ts.
 */
import type { BoundCall } from "../core/ast";
import type { Fail } from "../core/errors";
import { jsString } from "../codegen/js";
import { errorIf, quoteText, sqlNumber, sqlTimestampSerial, type SqlGen, type SqlVal } from "../codegen/sql";
import { isError, type Value } from "../runtime/common";
import { MAX_SERIAL, MONTH_LIMIT, nowSerial } from "../runtime/dates";
import { createSpreadsheetRuntime, type SpreadsheetVariant } from "../runtime/spreadsheet";
import { definer, sqlArgs } from "./shared";

const D0 = "DATE '1899-12-30'";

/** Serial of an SQL date expression in the real calendar. */
const serialOf = (d: string) => `((${d}) - ${D0})::float8`;
/**
 * First day of a month counted from January of year 0, as an SQL date in the real calendar. The
 * count is clamped like monthStartSerial() in src/runtime/dates.ts, so the date stays within
 * PostgreSQL's range (it would otherwise fail the whole query) and agrees with JS.
 */
const monthStart = (months: string) => `(DATE '2000-01-01' + make_interval(months => (LEAST(GREATEST(trunc(${months}), -1), ${MONTH_LIMIT}) - 24000)::int))::date`;

function nowSql(g: SqlGen): string {
  const tz = g.options.timeZone ?? "UTC";
  if (g.options.now !== undefined) return sqlNumber(nowSerial(tz, g.options.now));
  return sqlTimestampSerial(`now() AT TIME ZONE ${quoteText(tz)}`);
}

/** WEEKDAY start day (ISO: Monday = 1 … Sunday = 7) for each return_type; 3 is type 2 minus one. */
const WEEKDAY_START: Record<number, number> = { 1: 7, 2: 1, 3: 1, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 7 };

type DateSql = (args: SqlVal[], g: SqlGen, c: BoundCall) => SqlVal;

/** Compile-time folding of literal date calls; the test harness turns it off to check the SQL itself. */
export const dateFolding = { enabled: true };

/*
 * Every value a function uses more than once goes through g.bind(), so nesting date functions
 * (EDATE(EDATE(A2, 1), 1)) adds to the SQL instead of multiplying it. The error expression is
 * built the same way; it may repeat the value once (range checks), never more.
 */
export function registerSpreadsheetDates(variant: SpreadsheetVariant): void {
  const def = definer(variant);
  const excel = variant === "excel";
  const max = MAX_SERIAL[variant];
  const rt = createSpreadsheetRuntime(variant) as unknown as Record<string, (...args: Value[]) => Value>;
  /** Whole days of a serial, clamped to the valid range, as an int. */
  const wholeDays = (s: string) => `LEAST(GREATEST(floor(${s}), 0), ${max})::int`;
  const outOfRange = (g: SqlGen, s: string, min = 0) => g.bind([s], (x) => errorIf(`${x} < ${min} OR ${x} > ${max}`, "#NUM!"));
  /** Real-calendar serial → the program's serial (Excel is one day less before 1900-03-01). See dates.ts. */
  const fromReal = (g: SqlGen, t: string) => (excel ? g.bind([t], (x) => `CASE WHEN ${x} < 61 THEN ${x} - 1 ELSE ${x} END`) : t);
  /** YEAR / MONTH / DAY of a serial in the program's calendar (Excel: serial 0 is 1900-01-00, 60 is 1900-02-29). */
  const part = (g: SqlGen, field: "YEAR" | "MONTH" | "DAY", s: string): string => {
    if (!excel) return `EXTRACT(${field} FROM ${D0} + ${wholeDays(s)})::float8`;
    const fixed = { YEAR: [1900, 1900], MONTH: [1, 2], DAY: [0, 29] }[field];
    return g.bind([wholeDays(s)], (n) =>
      `CASE ${n} WHEN 0 THEN ${fixed[0]}::float8 WHEN 60 THEN ${fixed[1]}::float8 ELSE EXTRACT(${field} FROM ${D0} + CASE WHEN ${n} < 61 THEN ${n} + 1 ELSE ${n} END)::float8 END`);
  };
  /** Months since January of year 0 for the month of serial s (a bound reference) plus k months. */
  const monthsOf = (g: SqlGen, s: string, k: string) => `(${part(g, "YEAR", s)} * 12 + ${part(g, "MONTH", s)} - 1 + trunc(${k}))`;
  /**
   * EDATE / EOMONTH: `real(x)` is the real-calendar serial computed from the start serial x. The
   * start's range check and the result's (Excel rejects anything before serial 1) share one binding.
   */
  const realResult = (g: SqlGen, s: SqlVal, k: SqlVal, real: (x: string) => string): SqlVal => {
    const v = g.bind([s.v], (x) => fromReal(g, real(x)));
    const err = g.bind([s.v], (x) => `COALESCE(${errorIf(`${x} < 0 OR ${x} > ${max}`, "#NUM!")}, ${outOfRange(g, fromReal(g, real(x)), excel ? 1 : 0)})`);
    return g.make("number", v, [s.err, k.err, err]);
  };
  const jsCall = (name: string) => (c: BoundCall, g: import("../codegen/js").JsGen) => g.call(name, c.args.map((a) => g.expr(a)));
  /**
   * SQL for a date function. When every argument is a literal the result is computed now with the
   * JS runtime (which the case files hold to the same answers), so DATE(2024,1,31) is one number.
   */
  const dateSql = (name: string, build: DateSql) => (c: BoundCall, g: SqlGen): SqlVal => {
    const args = sqlArgs(c, g);
    if (dateFolding.enabled && args.every((a) => a.lit !== undefined && a.err === null)) {
      const r = rt[name]!(...args.map((a) => a.lit as Value));
      if (isError(r)) return g.error(r.code);
      if (typeof r === "number" && Number.isFinite(r)) return g.number(r);
    }
    return build(args, g, c);
  };
  const nums = (args: SqlVal[], g: SqlGen) => args.map((a) => g.toNumber(a));

  def({
    name: "TODAY",
    minArgs: 0,
    maxArgs: 0,
    summary: "TODAY() — today's serial number in the timeZone option (default UTC)",
    js: (_, g) => `rt.TODAY(ctx, ${jsString(g.timeZone)})`,
    sql: (_, g) => g.make("number", `floor(${nowSql(g)})`, []),
  });
  def({
    name: "NOW",
    minArgs: 0,
    maxArgs: 0,
    summary: "NOW() — current date and time as a serial number",
    js: (_, g) => `rt.NOW(ctx, ${jsString(g.timeZone)})`,
    sql: (_, g) => g.make("number", nowSql(g), []),
  });

  def({
    name: "DATE",
    minArgs: 3,
    maxArgs: 3,
    summary: "DATE(year, month, day) — months and days may overflow; years 0-1899 get 1900 added",
    js: jsCall("DATE"),
    sql: dateSql("DATE", (args, g) => {
      const [y, m, d] = nums(args, g) as [SqlVal, SqlVal, SqlVal];
      const serial = g.bind([`trunc(${y.v})`, `trunc(${m.v})`, `trunc(${d.v})`], (yv, mv, dv) => {
        const year = `CASE WHEN ${yv} < 1900 THEN ${yv} + 1900 ELSE ${yv} END`;
        // Excel keeps month and day in 16 bits; see DATE in src/runtime/spreadsheet-dates.ts.
        const day = excel ? `CASE WHEN ${dv} < -32768 OR ${dv} > 32767 THEN 32767 ELSE ${dv} END` : dv;
        // The month's first day in the program's calendar, then count days (Excel passes its 1900-02-29).
        return `(${fromReal(g, serialOf(monthStart(`${year} * 12 + ${mv} - 1`)))} + ${day} - 1)`;
      });
      return g.make("number", serial, [
        y.err, m.err, d.err,
        g.bind([`trunc(${y.v})`], (yv) => errorIf(`${yv} < 0 OR ${yv} >= 10000`, "#NUM!")),
        excel ? g.bind([`trunc(${m.v})`], (mv) => errorIf(`${mv} < -32767 OR ${mv} > 32766`, "#NUM!")) : null,
        outOfRange(g, serial),
      ]);
    }),
  });

  def({
    name: "TIME",
    minArgs: 3,
    maxArgs: 3,
    summary: "TIME(hour, minute, second) — fraction of a day",
    js: jsCall("TIME"),
    sql: dateSql("TIME", (args, g) => {
      const [h, m, s] = nums(args, g) as [SqlVal, SqlVal, SqlVal];
      const total = `(trunc(${h.v}) * 3600 + trunc(${m.v}) * 60 + trunc(${s.v}))`;
      return g.make("number", g.bind([total], (t) => `((${t} - 86400 * floor(${t} / 86400)) / 86400)`), [
        h.err, m.err, s.err, g.bind([total], (t) => errorIf(`${t} < 0`, "#NUM!")),
      ]);
    }),
  });

  for (const field of ["YEAR", "MONTH", "DAY"] as const) {
    def({
      name: field,
      minArgs: 1,
      maxArgs: 1,
      summary: `${field}(date)`,
      js: jsCall(field),
      sql: dateSql(field, (args, g) => {
        const [s] = nums(args, g) as [SqlVal];
        return g.make("number", part(g, field, s.v), [s.err, outOfRange(g, s.v)]);
      }),
    });
  }

  for (const [name, f] of [
    ["HOUR", (secs: string) => `(floor(${secs} / 3600) - 24 * floor(${secs} / 86400))`],
    ["MINUTE", (secs: string) => `(floor(${secs} / 60) - 60 * floor(${secs} / 3600))`],
    ["SECOND", (secs: string) => `(${secs} - 60 * floor(${secs} / 60))`],
  ] as const) {
    def({
      name,
      minArgs: 1,
      maxArgs: 1,
      summary: `${name}(time) — rounded to the nearest second`,
      js: jsCall(name),
      sql: dateSql(name, (args, g) => {
        const [s] = nums(args, g) as [SqlVal];
        // Seconds of the time of day, rounded to the nearest second.
        const secs = g.bind([s.v], (x) => `floor((${x} - floor(${x})) * 86400 + 0.5)`);
        return g.make("number", g.bind([secs], f), [s.err, outOfRange(g, s.v)]);
      }),
    });
  }

  def({
    name: "WEEKDAY",
    minArgs: 1,
    maxArgs: 2,
    summary: "WEEKDAY(date, [type]) — type 1 (Sunday = 1), 2 (Monday = 1), 3 (Monday = 0), 11-17",
    js: jsCall("WEEKDAY"),
    sql: dateSql("WEEKDAY", (args, g) => {
      const [s, t] = nums(args, g) as [SqlVal, SqlVal | undefined];
      const type = t ?? g.number(1);
      // The weekday follows the serial number (Excel's serial 1 is a Sunday); ISO Monday = 1 … Sunday = 7.
      const iso = g.bind([`((${wholeDays(s.v)} + 6) % 7)`], (d0) => `CASE WHEN ${d0} = 0 THEN 7 ELSE ${d0} END::float8`);
      const v = g.bind([`trunc(${type.v})::int`, iso], (k, dow) => {
        const arms = Object.entries(WEEKDAY_START).map(([n, start]) => `WHEN ${n} THEN ((${dow} - ${start} + 7)::numeric % 7)::float8 + ${n === "3" ? 0 : 1}`);
        return `CASE ${k} ${arms.join(" ")} END`;
      });
      return g.make("number", v, [
        s.err, type.err, outOfRange(g, s.v),
        g.bind([`trunc(${type.v})::int`], (k) => errorIf(`${k} NOT IN (${Object.keys(WEEKDAY_START).join(", ")})`, "#NUM!")),
      ]);
    }),
  });

  def({
    name: "EDATE",
    minArgs: 2,
    maxArgs: 2,
    summary: "EDATE(start, months) — same day n months later (clamped to the month's end)",
    js: jsCall("EDATE"),
    sql: dateSql("EDATE", (args, g) => {
      const [s, k] = nums(args, g) as [SqlVal, SqlVal];
      // Day d of month m + k in the real calendar, clamped to that month's length.
      return realResult(g, s, k, (x) =>
        g.bind([monthsOf(g, x, k.v), part(g, "DAY", x)], (t, day) => {
          const first = serialOf(monthStart(t));
          return `(${first} + LEAST(${day}, ${serialOf(monthStart(`${t} + 1`))} - ${first}) - 1)`;
        }));
    }),
  });
  def({
    name: "EOMONTH",
    minArgs: 2,
    maxArgs: 2,
    summary: "EOMONTH(start, months) — last day of the month n months later",
    js: jsCall("EOMONTH"),
    sql: dateSql("EOMONTH", (args, g) => {
      const [s, k] = nums(args, g) as [SqlVal, SqlVal];
      return realResult(g, s, k, (x) => `(${serialOf(monthStart(`${monthsOf(g, x, k.v)} + 1`))} - 1)`);
    }),
  });

  def({
    name: "DAYS",
    minArgs: 2,
    maxArgs: 2,
    summary: "DAYS(end, start) — whole days between two dates",
    js: jsCall("DAYS"),
    sql: dateSql("DAYS", (args, g) => {
      const [e, s] = nums(args, g) as [SqlVal, SqlVal];
      return g.make("number", `(trunc(${e.v}) - trunc(${s.v}))`, [e.err, s.err]);
    }),
  });

  def({
    name: "DATEDIF",
    minArgs: 3,
    maxArgs: 3,
    summary: 'DATEDIF(start, end, unit) — unit "D", "M", "Y" or "YM"',
    validate: (c, fail: Fail) => {
      const u = c.args[2];
      if (u?.kind === "string" && ["MD", "YD"].includes(u.value.toUpperCase())) {
        fail("UNSUPPORTED_FEATURE", `DATEDIF unit "${u.value}" is not supported yet; use "D", "M", "Y" or "YM"`, u.start, u.end, "DATEDIF");
      }
    },
    js: jsCall("DATEDIF"),
    sql: dateSql("DATEDIF", ([sv, ev, uv], g) => {
      const [s, e] = [g.toNumber(sv!), g.toNumber(ev!)];
      const u = g.toText(uv!);
      const v = g.bind([s.v, e.v, `upper(${u.v})`], (sx, ex, unit) => {
        const months = `(${part(g, "YEAR", ex)} - ${part(g, "YEAR", sx)}) * 12 + ${part(g, "MONTH", ex)} - ${part(g, "MONTH", sx)} - CASE WHEN ${part(g, "DAY", ex)} < ${part(g, "DAY", sx)} THEN 1 ELSE 0 END`;
        return g.bind([months], (mo) =>
          `CASE ${unit} WHEN 'D' THEN floor(${ex}) - floor(${sx}) WHEN 'M' THEN ${mo} WHEN 'Y' THEN floor(${mo} / 12) WHEN 'YM' THEN ${mo} - 12 * floor(${mo} / 12) END`);
      });
      return g.make("number", v, [
        s.err, e.err, u.err, outOfRange(g, s.v), outOfRange(g, e.v),
        g.bind([s.v, e.v, `upper(${u.v})`], (sx, ex, unit) => errorIf(`${sx} > ${ex} OR ${unit} NOT IN ('D', 'M', 'Y', 'YM')`, "#NUM!")),
      ]);
    }),
  });
}
