/**
 * Spreadsheet dates are serial numbers: days since 1899-12-30, with the time
 * of day as the fraction (Sheets and Excel share this epoch for dates from
 * 1900-03-01 on). Dates are wall-clock values: a field "2024-01-15T10:30" is
 * 10:30 whatever the time zone, matching PostgreSQL's `timestamp`.
 */

const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(1899, 11, 30);

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** Wall-clock milliseconds (as if UTC) of a field value, or undefined if it is not a date. */
export function wallClockMs(raw: unknown): number | undefined {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw.getTime();
  if (typeof raw !== "string") return undefined;
  const m = DATE_TEXT.exec(raw.trim());
  if (!m) return undefined;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "0"] = m;
  const ms = Number(`0.${frac}`) * 1000;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
}

/** Serial number of wall-clock milliseconds. Seconds first, so JS and SQL divide the same doubles. */
export function msToSerial(ms: number): number {
  return (ms - EPOCH_MS) / 1000 / 86400;
}

/** UTC calendar parts of a whole-day serial. */
export function serialParts(serial: number): { y: number; m: number; d: number; dow: number } {
  const date = new Date(EPOCH_MS + Math.floor(serial) * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), dow: date.getUTCDay() };
}

/** Whole-day serial of a (possibly overflowing) year/month/day, like Date.UTC. */
export function ymdToSerial(y: number, m: number, d: number): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  date.setUTCHours(0, 0, 0, 0);
  return Math.round((date.getTime() - EPOCH_MS) / DAY_MS);
}

/** Wall-clock milliseconds of an instant in an IANA time zone. */
export function wallClockIn(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"), instant.getUTCMilliseconds());
}

/** NOW() as a serial in a time zone; `now` defaults to the current time. */
export function nowSerial(timeZone: string, now?: Date | string): number {
  const instant = now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
  return msToSerial(wallClockIn(instant, timeZone));
}

/** ISO date text a spreadsheet reads as a date ("2024-01-15", "2024-01-15 10:30", "2024-01-15T10:30:15"). */
export const ISO_DATE_TEXT = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*$/;
export const ISO_DATE_TEXT_SQL = "^\\s*\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2}(:\\d{2})?)?\\s*$";

/** Serial of ISO date text, or undefined if it is not a real date/time (2024-02-30, 25:00). */
export function isoDateSerial(text: string): number | undefined {
  const m = ISO_DATE_TEXT.exec(text);
  if (!m) return undefined;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1).map((x) => (x === undefined ? undefined : Number(x))) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || h! > 23 || mi! > 59 || s! > 59) return undefined;
  const day = ymdToSerial(y!, mo!, d!);
  if (serialParts(day).d !== d) return undefined;
  return day + (h! * 3600 + mi! * 60 + s!) / 86400;
}

// ---------------------------------------------------------------- Excel's 1900 calendar

/**
 * Sheets serials follow the real calendar from 1899-12-30. Excel keeps Lotus 1-2-3's bug: it has a
 * 1900-02-29 (serial 60), so serials 1-59 are one day less than the real calendar, and serial 0 is
 * "1900-01-00". From 1900-03-01 (serial 61) on, both agree. Checked in Excel for the web.
 */
export type DateSystem = "sheets" | "excel";

/** Serial of a real calendar date given as days since 1899-12-30. */
export function fromRealSerial(real: number, system: DateSystem): number {
  return system === "excel" && real < 61 ? real - 1 : real;
}

/** Year / month / day of a serial in the program's calendar. */
export function calendarParts(serial: number, system: DateSystem): { y: number; m: number; d: number } {
  const s = Math.floor(serial);
  if (system === "excel" && s < 61) {
    if (s === 0) return { y: 1900, m: 1, d: 0 };
    if (s === 60) return { y: 1900, m: 2, d: 29 };
    return serialParts(s + 1);
  }
  return serialParts(s);
}

/** DATE(y, m, d): the month's first day in the program's calendar, plus d - 1 days (months may overflow). */
export function calendarDate(y: number, m: number, d: number, system: DateSystem): number {
  return fromRealSerial(ymdToSerial(y, m, 1), system) + d - 1;
}

/** Day of the week (0 = Sunday) follows the serial number in both programs. */
export function serialWeekday(serial: number): number {
  return (((Math.floor(serial) + 6) % 7) + 7) % 7;
}
