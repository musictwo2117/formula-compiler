# Changelog

All notable changes to this project are listed here. Versions follow [semver](https://semver.org/);
while the version is 0.x, a minor release can change behaviour to match the source program more closely.

## 0.2.0 — 2026-10-28

### Added

- **Date functions (Google Sheets, Excel):** `TODAY`, `NOW`, `DATE`, `TIME`, `YEAR`, `MONTH`, `DAY`, `HOUR`,
  `MINUTE`, `SECOND`, `WEEKDAY`, `EDATE`, `EOMONTH`, `DAYS` and `DATEDIF` (`"D"`, `"M"`, `"Y"`, `"YM"`), in JS and SQL.
  Dates are serial numbers (days since 1899-12-30, with the time as the fraction).
- **Excel's 1900 calendar:** serial 60 is 1900-02-29 and serial 0 is 1900-01-00, as in Excel. `DATE` counts
  through the fake day; `EDATE`/`EOMONTH` use the real calendar and return `#NUM!` for results before serial 1.
- **`date` field type:** ISO text or a `Date` in JS, a `timestamp` column in SQL. ISO date text is also read as a
  date in arithmetic (`"2024-01-15" + 1`).
- **`timeZone` and `now` options** for `TODAY()` and `NOW()` (`ctx.now` in JS).
- **Lookups (Google Sheets, Excel):** `VLOOKUP`, `XLOOKUP`, `MATCH` and `INDEX` over whole columns, including
  multi-column ranges such as `D:F`. SQL needs the new `orderBy` option for the row order.

### Notes

- Every date and lookup test case was checked in Google Sheets and Excel for the web on 2026-10-28.
- Airtable date functions are not supported yet ([#2](https://github.com/musictwo2117/formula-compiler/issues/2)).
- The npm package now includes only `docs/behavior-notes.md` from `docs/`.

## 0.1.0 — 2026-10-28

First release: compiles Airtable, Google Sheets and Excel formulas to JavaScript, PostgreSQL SQL or an AST, with a
CLI. Behaviour was checked against the real programs; see `docs/behavior-notes.md`.
