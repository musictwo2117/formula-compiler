# Changelog

All notable changes to this project are listed here. Versions follow [semver](https://semver.org/);
while the version is 0.x, a minor release can change behaviour to match the source program more closely.

## 0.2.1 — 2026-10-28

### Fixed

- **SQL no longer fails the whole query on an out-of-range date.** `DATE(2024,-1E7,1)`, `EDATE(A2,-1E6)` and
  similar raised PostgreSQL's `timestamp out of range`; they are now `#NUM!` for that row.
- **Out-of-range dates agree in JS and SQL.** Huge month or day arguments gave `NaN` in JS and a clamped,
  wrong date in SQL. Both now follow the real programs, checked in Excel for the web and Google Sheets:
  - Excel: results after 9999-12-31 are `#NUM!`; `DATE` months outside -32767 to 32766 are `#NUM!`, and days
    outside -32768 to 32767 count as 32767.
  - Sheets: dates may go past 9999 (`DATE(9999,12,32)` = 10000-01-01, `YEAR` of it is 10000); anything before
    serial 0 is `#NUM!` (`EDATE(0,-1)` was -30). Dates after 99999-12-31 are `#NUM!` here although Sheets still
    gives a number.
- **SQL lookups are much faster.** `VLOOKUP` / `XLOOKUP` / `MATCH` / `INDEX` no longer renumber the whole table
  with a window for every row, and their comparisons can use an index on the lookup column. On 4,000 rows,
  `VLOOKUP` went from 6.8 s to 1.2 s (18 ms with an index); `INDEX`/`MATCH` from 24 s to 11 s.

### Changed

- `orderBy` must be unique and not null (ties already gave an arbitrary row order).

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
