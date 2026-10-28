/**
 * JS side of the Sheets/Excel date functions (src/dialects/spreadsheet-dates.ts
 * has the SQL). Dates are serial numbers; see src/runtime/dates.ts.
 */
import { FormulaError, isError, type EvalContext, type Value } from "./common";
import { calendarDate, calendarParts, fromRealSerial, nowSerial, serialParts, serialWeekday, ymdToSerial, type DateSystem } from "./dates";

const MAX_SERIAL = 2958465;
const num = (msg: string) => new FormulaError(msg);

type ToNumber = (x: Value) => number | FormulaError;
type ToText = (x: Value) => string | FormulaError;

const WEEKDAY_START: Record<number, number> = { 1: 7, 2: 1, 3: 1, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 7 };

export function spreadsheetDateFunctions(N: ToNumber, X: ToText, system: DateSystem) {
  const parts = (s: number) => calendarParts(s, system);
  /** A date computed in the real calendar (EDATE, EOMONTH), as a serial; Excel rejects anything before serial 1. */
  const realResult = (y: number, m: number, d: number): Value => {
    const s = fromRealSerial(ymdToSerial(y, m, d), system);
    return system === "excel" && s < 1 ? num("#NUM!") : s;
  };
  /** Numbers for all arguments, or the first error. */
  const nums = (...xs: Value[]): number[] | FormulaError => {
    const out: number[] = [];
    for (const x of xs) {
      const n = N(x);
      if (isError(n)) return n;
      out.push(n);
    }
    return out;
  };
  /** Serial in the first argument (checked for range), extra numeric arguments after it. */
  const serial = (x: Value, f: (s: number, ...rest: number[]) => Value, ...more: Value[]): Value => {
    const n = nums(x, ...more);
    if (isError(n)) return n;
    const [s, ...rest] = n as [number, ...number[]];
    return s < 0 || s > MAX_SERIAL ? num("#NUM!") : f(s, ...rest);
  };
  const seconds = (s: number) => Math.floor((s - Math.floor(s)) * 86400 + 0.5);
  const months = (s: number, e: number) => {
    const [a, b] = [parts(s), parts(e)];
    return (b.y - a.y) * 12 + b.m - a.m - (b.d < a.d ? 1 : 0);
  };

  return {
    TODAY: (ctx: EvalContext | undefined, timeZone: string): Value => Math.floor(nowSerial(timeZone, ctx?.now)),
    NOW: (ctx: EvalContext | undefined, timeZone: string): Value => nowSerial(timeZone, ctx?.now),
    DATE(y: Value, m: Value, d: Value): Value {
      const n = nums(y, m, d);
      if (isError(n)) return n;
      let year = Math.trunc(n[0]!);
      if (year < 0 || year >= 10000) return num("#NUM!");
      if (year < 1900) year += 1900;
      const s = calendarDate(year, Math.trunc(n[1]!), Math.trunc(n[2]!), system);
      return s < 0 ? num("#NUM!") : s;
    },
    TIME(h: Value, m: Value, s: Value): Value {
      const n = nums(h, m, s);
      if (isError(n)) return n;
      const total = Math.trunc(n[0]!) * 3600 + Math.trunc(n[1]!) * 60 + Math.trunc(n[2]!);
      return total < 0 ? num("#NUM!") : (total - 86400 * Math.floor(total / 86400)) / 86400;
    },
    YEAR: (x: Value): Value => serial(x, (s) => parts(s).y),
    MONTH: (x: Value): Value => serial(x, (s) => parts(s).m),
    DAY: (x: Value): Value => serial(x, (s) => parts(s).d),
    HOUR: (x: Value): Value => serial(x, (s) => { const t = seconds(s); return Math.floor(t / 3600) - 24 * Math.floor(t / 86400); }),
    MINUTE: (x: Value): Value => serial(x, (s) => { const t = seconds(s); return Math.floor(t / 60) - 60 * Math.floor(t / 3600); }),
    SECOND: (x: Value): Value => serial(x, (s) => { const t = seconds(s); return t - 60 * Math.floor(t / 60); }),
    WEEKDAY(x: Value, type: Value = 1): Value {
      return serial(x, (s, t) => {
        const k = Math.trunc(t!);
        const start = WEEKDAY_START[k];
        if (start === undefined) return num("#NUM!");
        const iso = ((serialWeekday(s) + 6) % 7) + 1;
        return ((iso - start + 7) % 7) + (k === 3 ? 0 : 1);
      }, type);
    },
    EDATE(x: Value, k: Value): Value {
      return serial(x, (s, n) => {
        const { y, m, d } = parts(s);
        const target = m + Math.trunc(n!);
        const last = serialParts(ymdToSerial(y, target + 1, 0)).d;
        return realResult(y, target, Math.min(d, last));
      }, k);
    },
    EOMONTH(x: Value, k: Value): Value {
      return serial(x, (s, n) => {
        const { y, m } = parts(s);
        return realResult(y, m + Math.trunc(n!) + 1, 0);
      }, k);
    },
    DAYS(e: Value, s: Value): Value {
      const n = nums(e, s);
      return isError(n) ? n : Math.trunc(n[0]!) - Math.trunc(n[1]!);
    },
    DATEDIF(start: Value, end: Value, unit: Value): Value {
      const n = nums(start, end);
      if (isError(n)) return n;
      const u = X(unit);
      if (isError(u)) return u;
      const [s, e] = n as [number, number];
      if (s < 0 || s > MAX_SERIAL || e < 0 || e > MAX_SERIAL || s > e) return num("#NUM!");
      switch (u.toUpperCase()) {
        case "D": return Math.floor(e) - Math.floor(s);
        case "M": return months(s, e);
        case "Y": return Math.floor(months(s, e) / 12);
        case "YM": { const mo = months(s, e); return mo - 12 * Math.floor(mo / 12); }
        default: return num("#NUM!");
      }
    },
  };
}
