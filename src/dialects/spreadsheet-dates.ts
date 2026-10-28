/**
 * Date and time functions for Google Sheets and Excel. Dates are serial
 * numbers (days since 1899-12-30), so they are ordinary numbers everywhere
 * else. JS helpers live in src/runtime/spreadsheet-dates.ts.
 */
import type { BoundCall } from "../core/ast";
import type { Fail } from "../core/errors";
import { jsString } from "../codegen/js";
import { errorIf, quoteText, sqlNumber, sqlTimestampSerial, type SqlGen, type SqlVal } from "../codegen/sql";
import { nowSerial } from "../runtime/dates";
import type { SpreadsheetVariant } from "../runtime/spreadsheet";
import { definer, sqlArgs } from "./shared";

const D0 = "DATE '1899-12-30'";
/** Largest serial Excel accepts (9999-12-31). */
const MAX_SERIAL = 2958465;

/** Whole days of a serial, clamped to the valid range, as an int. */
const wholeDays = (s: string) => `LEAST(GREATEST(floor(${s}), 0), ${MAX_SERIAL})::int`;
/** Serial of an SQL date expression in the real calendar. */
const serialOf = (d: string) => `((${d}) - ${D0})::float8`;
const badSerial = (s: string) => errorIf(`${s} < 0 OR ${s} > ${MAX_SERIAL}`, "#NUM!");
/** Seconds of the time of day, rounded to the nearest second. */
const secondsOf = (s: string) => `floor((${s} - floor(${s})) * 86400 + 0.5)`;
const clampInt = (x: string, lim: number) => `LEAST(GREATEST(trunc(${x}), ${-lim}), ${lim})::int`;

function nowSql(g: SqlGen): string {
  const tz = g.options.timeZone ?? "UTC";
  if (g.options.now !== undefined) return sqlNumber(nowSerial(tz, g.options.now));
  return sqlTimestampSerial(`now() AT TIME ZONE ${quoteText(tz)}`);
}

const nums = (c: BoundCall, g: SqlGen): SqlVal[] => sqlArgs(c, g).map((a) => g.toNumber(a));

/** WEEKDAY start day (ISO: Monday = 1 … Sunday = 7) for each return_type; 3 is type 2 minus one. */
const WEEKDAY_START: Record<number, number> = { 1: 7, 2: 1, 3: 1, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 7 };

export function registerSpreadsheetDates(variant: SpreadsheetVariant): void {
  const def = definer(variant);
  const excel = variant === "excel";
  /** Real-calendar serial → the program's serial (Excel is one day less before 1900-03-01). See dates.ts. */
  const fromReal = (t: string) => (excel ? `CASE WHEN ${t} < 61 THEN ${t} - 1 ELSE ${t} END` : t);
  /** YEAR / MONTH / DAY of a serial in the program's calendar (Excel: serial 0 is 1900-01-00, 60 is 1900-02-29). */
  const part = (field: "YEAR" | "MONTH" | "DAY", s: string): string => {
    const n = wholeDays(s);
    if (!excel) return `EXTRACT(${field} FROM ${D0} + ${n})::float8`;
    const fixed = { YEAR: [1900, 1900], MONTH: [1, 2], DAY: [0, 29] }[field];
    return `CASE ${n} WHEN 0 THEN ${fixed[0]}::float8 WHEN 60 THEN ${fixed[1]}::float8 ELSE EXTRACT(${field} FROM ${D0} + CASE WHEN ${n} < 61 THEN ${n} + 1 ELSE ${n} END)::float8 END`;
  };
  /** First day of month (m + k) of year y, as an SQL date in the real calendar. */
  const monthStart = (y: string, monthsFromJan: string) => `(make_date(LEAST(GREATEST(${y}, 1), 9999)::int, 1, 1) + make_interval(months => ${clampInt(monthsFromJan, 1_000_000)}))::date`;
  /** EDATE / EOMONTH results: real-calendar dates; Excel rejects anything before serial 1. */
  const realResult = (date: string, errs: (string | null)[]): SqlVal => {
    const s = fromReal(serialOf(date));
    const errors = [...errs, excel ? errorIf(`${s} < 1`, "#NUM!") : null].filter((e): e is string => e !== null);
    return { v: s, t: "number", nullable: false, err: errors.length ? `COALESCE(${errors.join(", ")})` : null };
  };
  const jsCall = (name: string) => (c: BoundCall, g: import("../codegen/js").JsGen) => g.call(name, c.args.map((a) => g.expr(a)));

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
    sql: (c, g) => {
      const [y, m, d] = nums(c, g) as [SqlVal, SqlVal, SqlVal];
      const year = `CASE WHEN trunc(${y.v}) < 1900 THEN trunc(${y.v}) + 1900 ELSE trunc(${y.v}) END`;
      // The month's first day in the program's calendar, then count days (Excel passes its 1900-02-29).
      const serial = `(${fromReal(serialOf(monthStart(year, `${m.v} - 1`)))} + ${clampInt(`${d.v} - 1`, 10_000_000)})`;
      return g.make("number", serial, [y.err, m.err, d.err, errorIf(`trunc(${y.v}) < 0 OR trunc(${y.v}) >= 10000`, "#NUM!"), errorIf(`${serial} < 0`, "#NUM!")]);
    },
  });

  def({
    name: "TIME",
    minArgs: 3,
    maxArgs: 3,
    summary: "TIME(hour, minute, second) — fraction of a day",
    js: jsCall("TIME"),
    sql: (c, g) => {
      const [h, m, s] = nums(c, g) as [SqlVal, SqlVal, SqlVal];
      const total = `(trunc(${h.v}) * 3600 + trunc(${m.v}) * 60 + trunc(${s.v}))`;
      return g.make("number", `((${total} - 86400 * floor(${total} / 86400)) / 86400)`, [h.err, m.err, s.err, errorIf(`${total} < 0`, "#NUM!")]);
    },
  });

  for (const [name, field] of [["YEAR", "YEAR"], ["MONTH", "MONTH"], ["DAY", "DAY"]] as const) {
    def({
      name,
      minArgs: 1,
      maxArgs: 1,
      summary: `${name}(date)`,
      js: jsCall(name),
      sql: (c, g) => {
        const [s] = nums(c, g) as [SqlVal];
        return g.make("number", part(field, s.v), [s.err, badSerial(s.v)]);
      },
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
      sql: (c, g) => {
        const [s] = nums(c, g) as [SqlVal];
        return g.make("number", f(secondsOf(s.v)), [s.err, badSerial(s.v)]);
      },
    });
  }

  def({
    name: "WEEKDAY",
    minArgs: 1,
    maxArgs: 2,
    summary: "WEEKDAY(date, [type]) — type 1 (Sunday = 1), 2 (Monday = 1), 3 (Monday = 0), 11-17",
    js: jsCall("WEEKDAY"),
    sql: (c, g) => {
      const [s, t] = nums(c, g) as [SqlVal, SqlVal | undefined];
      const type = t ?? g.number(1);
      // The weekday follows the serial number (Excel's serial 1 is a Sunday).
      const dow0 = `((${wholeDays(s.v)} + 6) % 7)`;
      const dow = `CASE WHEN ${dow0} = 0 THEN 7 ELSE ${dow0} END::float8`;
      const arms = Object.entries(WEEKDAY_START).map(
        ([k, start]) => `WHEN ${k} THEN ((${dow} - ${start} + 7)::numeric % 7)::float8 + ${k === "3" ? 0 : 1}`,
      );
      return g.make("number", `CASE trunc(${type.v})::int ${arms.join(" ")} END`, [
        s.err, type.err, badSerial(s.v), errorIf(`trunc(${type.v})::int NOT IN (${Object.keys(WEEKDAY_START).join(", ")})`, "#NUM!"),
      ]);
    },
  });

  def({
    name: "EDATE",
    minArgs: 2,
    maxArgs: 2,
    summary: "EDATE(start, months) — same day n months later (clamped to the month's end)",
    js: jsCall("EDATE"),
    sql: (c, g) => {
      const [s, k] = nums(c, g) as [SqlVal, SqlVal];
      // Day d of month m + k in the real calendar, clamped to that month's length.
      const first = monthStart(part("YEAR", s.v), `${part("MONTH", s.v)} - 1 + ${k.v}`);
      const length = `EXTRACT(DAY FROM (${first} + interval '1 month' - interval '1 day'))`;
      const date = `(${first} + (LEAST(${part("DAY", s.v)}, ${length}) - 1)::int)`;
      return realResult(date, [s.err, k.err, badSerial(s.v)]);
    },
  });
  def({
    name: "EOMONTH",
    minArgs: 2,
    maxArgs: 2,
    summary: "EOMONTH(start, months) — last day of the month n months later",
    js: jsCall("EOMONTH"),
    sql: (c, g) => {
      const [s, k] = nums(c, g) as [SqlVal, SqlVal];
      const date = `(${monthStart(part("YEAR", s.v), `${part("MONTH", s.v)} + ${k.v}`)} - 1)`;
      return realResult(date, [s.err, k.err, badSerial(s.v)]);
    },
  });

  def({
    name: "DAYS",
    minArgs: 2,
    maxArgs: 2,
    summary: "DAYS(end, start) — whole days between two dates",
    js: jsCall("DAYS"),
    sql: (c, g) => {
      const [e, s] = nums(c, g) as [SqlVal, SqlVal];
      return g.make("number", `(trunc(${e.v}) - trunc(${s.v}))`, [e.err, s.err]);
    },
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
    sql: (c, g) => {
      const [sv, ev, uv] = sqlArgs(c, g) as [SqlVal, SqlVal, SqlVal];
      const [s, e] = [g.toNumber(sv), g.toNumber(ev)];
      const u = g.toText(uv);
      const months = `((${part("YEAR", e.v)} - ${part("YEAR", s.v)}) * 12 + ${part("MONTH", e.v)} - ${part("MONTH", s.v)} - CASE WHEN ${part("DAY", e.v)} < ${part("DAY", s.v)} THEN 1 ELSE 0 END)`;
      const v = `CASE upper(${u.v}) WHEN 'D' THEN floor(${e.v}) - floor(${s.v}) WHEN 'M' THEN ${months} WHEN 'Y' THEN floor(${months} / 12) WHEN 'YM' THEN ${months} - 12 * floor(${months} / 12) END`;
      return g.make("number", v, [
        s.err, e.err, u.err, badSerial(s.v), badSerial(e.v),
        errorIf(`${s.v} > ${e.v} OR upper(${u.v}) NOT IN ('D', 'M', 'Y', 'YM')`, "#NUM!"),
      ]);
    },
  });
}
