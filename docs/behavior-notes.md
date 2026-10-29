# Behavior notes

How formula-compiler reproduces each program. Every rule here was checked on 2026-10-28 (blanks by field type, `COUNT` and `TODAY()`/`NOW()` time zones on
2026-10-29) by running the
formulas in the real program and reading the computed values: a real **Airtable** base, a real
**Google Sheet**, and **Excel for the web**. The cases named "(checked in … 2026-10-28)" in
`tests/cases/*.json` are those probes; there are no unverified cases left.

JS and SQL always agree with each other — the test-suite checks every runnable case on both. Please send
a PR (with the program and date) if a program's behaviour changes.

## Shared model

- Values are number, text, boolean, blank or error. Blank is `null` in JS and `NULL` in SQL.
- Errors are values (`FormulaError` in JS; in SQL a second expression, `errorSql`, holds the code such as
  `'#DIV/0!'`), so `IFERROR` / `ISERROR` work without SQL exceptions.
- Numbers are IEEE doubles on both sides (`double precision` in SQL).
- Text ordering is by code point (`COLLATE "C"`); spreadsheets lower-case first. The real programs use
  locale-aware ordering for punctuation and accented letters.
- Case-insensitive text comparisons (`=`, lookups, `COUNTIF`, `SEARCH`) lower-case both sides: `toLowerCase()`
  in JS, `lower()` in SQL. This matches the real programs for ASCII and most accented letters (`"É"="é"`,
  `"ß"="ẞ"`). **Not matched** (Google Sheets, checked 2026-10-29; the cases are todo): Sheets folds case, so
  `"σ"="ς"` is TRUE where both JS and SQL say FALSE; a final `Σ` lower-cases to `ς` in JS but `σ` in SQL; and
  SQL lower-cases `İ` to `i` (`"İ"="i"` is TRUE, `LEN(LOWER("İ"))` is 1) where Sheets and JS give `i̇`. SQL also
  follows the database's character type (`LC_CTYPE`), so other databases may differ further.
- A `Date` in a date field is read in the machine's local time: `new Date(2024, 0, 15)` is 2024-01-15 in any time
  zone, as node-postgres builds `timestamp` values.
- Not handled: results that overflow a double. PostgreSQL raises "value out of range" where JS gives
  Infinity.

## Airtable (checked in a real base)

Airtable behaves much like JavaScript.

**Syntax**
- Field names are case-insensitive: `{NUM5}` and `NUM5` find the field `num5` (the exact spelling wins
  when both exist). formula-compiler matches against `fieldTypes` at compile time and the record's keys at
  run time.
- `{Field name}` with `\}` and `\\` escapes; a bare word such as `num5` is also a field name (so `TRUE`
  without `()` is the field "TRUE" — Airtable says "Unknown field names: true").
- Strings `"…"` or `'…'` with backslash escapes. Not-equal is `!=`; `<>` is an invalid formula.
- Precedence: unary minus, then `* /`, then **`+ - &` on one level, left to right** (`"x" & 1 + 2` is
  `NaN`, `2 + 3 & "x"` is `"5x"`), then comparisons.

**Blanks and booleans**
- An empty field, `""` and `BLANK()` are equal: `{x} = ""`, `{n} = 0`, `BLANK() = 0` and `BLANK() = FALSE()` are
  all true. But a blank is not always the same as `""` (checked by field type on 2026-10-29):
  - An empty **number or currency** field, `BLANK()` and `IF` without its third argument are a *real* blank.
    An empty **text, long text or single select** field and an **unchecked checkbox** are empty text `""`.
  - `!=` is not the opposite of `=`: a real blank is only "not different" from another real blank. `{n} != ""`,
    `{n} != 0` and `BLANK() != ""` are true; `{t} != ""` and `{t} != 0` (empty text) are false.
  - Against text, `<` `>` `<=` `>=` read a real blank as the number 0 and the text with `Number()`:
    `{n} < "a"` and `BLANK() <= "a"` are false, `BLANK() < "1"` is true; empty text sorts first (`{t} < "a"`).
  - `*` and `/` are `#ERROR!` for empty text (`{t} * 2`, unchecked `{chk} * 2`) but 0 for a real blank.
  - Text functions reject a real blank: `LEN`, `UPPER`, `LOWER`, `TRIM`, `LEFT`, `REPLACE` and `VALUE` of
    `BLANK()` or an empty number field, `SEARCH` in it and `SUBSTITUTE` with it as the replacement are
    `#ERROR!`. `RIGHT(BLANK(), 1)` and `SUBSTITUTE(BLANK(), "a", "b")` are `""`; `&` and `CONCATENATE` give `""`.
    `LEN` of empty text is 0.
  - `IF`, `NOT`, `SUM`, `AVERAGE` treat both the same (false, 0, skipped).
- A checked checkbox is `TRUE`: `{chk} * 2` = 2, `{chk} = 1` is true, `LEN({chk})` is `#ERROR!`.
- `TRUE()` is 1 in arithmetic; booleans become `"TRUE"` / `"FALSE"` as text.
- `IF(cond, value)` without a third argument is blank; `IF` treats 0, `""`, blank and NaN as false.

**Arithmetic**
- `+` and `-` read text with JavaScript's `Number()`: `"3" + 1` = 4, `"a" + 1` = NaN, `" " + 1` = 1,
  `"1e3" + 0` = 1000. An empty text field is 0.
- `*` and `/` reject text — any text, even an empty text field: `"3" * 2` is `#ERROR!`.
- Division by zero is **not an error value**: `1/0` is `Infinity`, `-1/0` is `-Infinity`, `0/0` is `NaN`.
  They keep flowing through arithmetic (`(1/0) * 0` is NaN) and comparisons (`1/0 > 5` is true), become
  `"Infinity"` as text, and the API shows them as `{ "specialValue": "Infinity" }`.
- `ISERROR(x)` returns the **number** 1 or 0, and is 1 for errors and for Infinity / NaN.
- Comparisons between text and a number/boolean are numeric, JavaScript-style: `10 < "9"` is false,
  `1 = "1"` is true, `TRUE() = "TRUE"` is false, anything compared with NaN is false (except `!=`).
  Text against text is case-sensitive (`"a" = "A"` is false; `"a" < "B"` is false).
- Number → text is JavaScript's `String(n)`: `0.30000000000000004`, `0.00001`, `1e+21`, `1e-7`.

**Functions**
- `ROUND(v, p)` is `Math.round(v × 10^p) / 10^p` on doubles — ties toward +infinity, no decimal
  snapping: `ROUND(2.675, 2)` = 2.68 but `ROUND(1.005, 2)` = 1; a fractional `p` is not truncated.
  `ROUNDUP` / `ROUNDDOWN` work the same way with ceil / floor away from / toward zero
  (`ROUNDUP(0.1 + 0.2, 1)` = 0.4).
- `MOD(a, b)` is `|a| mod |b|` with the sign of the divisor: `MOD(-7, 3)` = 1, `MOD(7, -3)` = -1.
- `SUM` counts blanks as 0 and numeric text as numbers (`SUM("2", 1)` = 3), skipping other text.
  `AVERAGE`, `MIN`, `MAX` skip blanks, text and booleans (`AVERAGE(2, 4, blank)` = 3, `AVERAGE(TRUE(), 2)` = 2,
  `AVERAGE(blank)` = NaN); `MIN` / `MAX` with no numbers are 0.
- `COUNT` counts numbers (NaN and Infinity too, not numeric text or booleans), `COUNTA` counts everything but
  blanks and empty text (`FALSE()` and 0 count, an unchecked checkbox does not), `COUNTALL` counts every
  argument. An error argument is the result (`COUNT(ERROR())` is `#ERROR!`). Only plain arguments are
  supported; rollup and lookup (array) fields are not.
- `VALUE(text)` keeps only digits and `.`; any `-` makes it negative and `%` divides by 100:
  `VALUE("$1,000")` = 1000, `VALUE("a1b2")` = 12, `VALUE("1.5e3")` = 1.53, `VALUE("5-3")` = -53,
  `VALUE("abc")` = 0, `VALUE("1.2.3")` = NaN.
- Numeric functions read text with `Number()`: `ABS("-3")` = 3, `ROUND("2.5", 0)` = 3.
- Text functions (`LEN`, `UPPER`, `LOWER`, `TRIM`, `LEFT`, `RIGHT`, `MID`, `FIND`, `SEARCH`, `SUBSTITUTE`,
  `REPLACE`) reject a number or boolean as their text argument: `LEN(123.5)` is `#ERROR!`. `&` and
  `CONCATENATE` do convert, and so does `FIND` for the text to find (below).
- `LEN` counts code points (an emoji is 1).
- `MID(s, start, n)` is 1-based — **the official docs example `MID("quick brown fox", 6, 5) => "brown"` is
  wrong; Airtable returns `" brow"`.** A start below 1 gives `""`.
- `RIGHT("abc", 4)` is `""` (a count longer than the text gives nothing); `RIGHT("abc", 2.7)` is `"abc"`.
- `LEFT` with a negative count is `""`.
- `REPLACE` works like `s.substring(0, start - 1) + replacement + s.substring(start - 1 + count)`.
- `SUBSTITUTE` with an index of 0 or less, or past the last occurrence, changes nothing.
- `FIND` / `SEARCH`: case-sensitive (both), `startFromPosition` is 1-based (0 behaves like 1), 0 when not
  found. A not-found `SEARCH` that is the whole formula shows as empty. They differ with blanks and
  non-text (checked 2026-10-29):
  - `FIND` in a blank or empty text is blank, not 0 (`FIND("a", "")`, `FIND("a", {t})`, `FIND("", BLANK())`);
    `FIND` of a number reads it as text (`FIND(5, "a5")` = 2); `FIND` of a boolean or real blank is 0
    (`FIND(TRUE(), "aTRUE")`, `FIND(BLANK(), "abc")`); `FIND("", "abc")` is 1; searching in a number or
    boolean is `#ERROR!`.
  - `SEARCH` takes text only: a number, boolean or real blank in either argument is `#ERROR!`
    (`SEARCH(5, "a5")`, `SEARCH(BLANK(), "abc")`); `SEARCH("a", "")` is 0.
- `SWITCH` without a match or default is blank. `T()` of anything but text is `""` (shown as empty; `LEN(T(5))`
  is 0).
- `TRIM` strips whitespace at both ends (including newlines) and keeps inner runs of spaces.

**Known gaps**
- Blanks in two text functions (todo cases, checked 2026-10-29): `MID(BLANK(), 1, 1)` is `"1"` and `LEFT("abc",
  BLANK())` is `"abc"`; formula-compiler gives `""` and `""`. `COUNTA(ERROR())` is 1 (the `ERROR()`
  argument is counted, though an error from `{t} * 2` makes `COUNTA` an error); formula-compiler gives `#ERROR!`.
- In JS, pass `fieldTypes` so an empty text field is `""` (needed for the `*` / `/` rule); without it an
  empty field is treated as an empty number.
- `Number()` hex/binary forms (`"0x10"`) are not supported.
- PostgreSQL orders NaN above every number; the generated SQL guards comparisons, but `MIN`/`MAX` over a
  NaN argument may differ.

## Google Sheets (checked in a real sheet)

- Leading `=` optional; text is `"…"` with `""` for a quote; not-equal is `<>`; `%` is postfix.
- `-3^2` is 9 (unary minus binds tighter than `^`); `2^3^2` is 64; `0^0` is 1; `0^-1` is `#NUM!`.
- An empty cell equals both `""` and `0`; blank is 0 in arithmetic and `""` with `&`. An empty referenced
  cell as the whole result stays empty.
- `IF(cond, value)` without a third argument is `FALSE`; `IF("true", 1, 2)` is 1.
- Text comparison is case-insensitive; different types never compare equal (`1 = "1"` is false);
  `TRUE > "zzz"`.
- Text in arithmetic: `""` is 0; `"$1,000"`, `"1,234.5"`, `"50%"`, `"(5)"`, `"-$5"`, `" 3 "` are read as
  numbers; `" "`, `"abc"`, `"1,00"` and `"1e3"` are `#VALUE!`. `VALUE()` follows the same rules
  (`VALUE("") = 0`).
- Number → text: 15 significant digits (`1/3 & ""` = `0.333333333333333`, `2/3` → `…667`); written out in
  full between 1E-10 and 1E+21, otherwise `1E+21`, `1.18059162071741E+21`, `1E-11`.
- Typed numbers keep 15 significant digits: `=1234567890123456` is 1234567890123450.
- `ROUND` ties away from zero with 15-digit snapping (`ROUND(2.675, 2)` = 2.68, `ROUND(1.005, 2)` = 1.01);
  places are optional.
- `SUM(B2, 1)` ignores text in references; `SUM(1, "2", TRUE)` coerces typed values;
  `COUNT(1, "2", "x", TRUE, 1/0)` = 3; `AND(text reference)` is `#VALUE!`; `AND("TRUE")` is TRUE.
- `MOD` takes the divisor's sign; `INT` rounds down.
- `FIND` is case-sensitive, `SEARCH` is not; **both Sheets and Excel `SEARCH` support `*`, `?`, `~`**.
  Out-of-range start or no match is `#VALUE!`; `FIND("", "")` is `#VALUE!`.
- `TRIM` strips spaces, tabs and newlines at the ends, collapses inner runs of spaces, and keeps inner tabs
  and non-breaking spaces.
- `LEN` counts UTF-16 units (an emoji is 2). `LEFT`/`MID`/`RIGHT` also work in UTF-16 units in Sheets and
  can split an emoji; formula-compiler uses code points there (PostgreSQL cannot hold half a character).
- `SWITCH` is case-insensitive; `TEXTJOIN` keeps or drops empties as asked; `SUBSTITUTE` past the last
  occurrence and `REPLACE` past the end behave like Excel.
- `COUNTIF`: `"5"` and `5` also match cells holding the **text** `"5"`, but `">4"` and `"<>5"` only look at
  numbers; `""` matches empty cells; an empty criterion **cell** matches nothing; wildcards and case
  rules as in `SEARCH`.

### Dates and lookups (Google Sheets)

- Dates are serial numbers: days since 1899-12-30, time of day as the fraction (`DATE(2024,1,15)` = 45306).
- `DATE` lets months and days overflow (`DATE(2024,14,1)` = 2025-02-01, `DATE(2024,3,0)` = Feb 29) and adds
  1900 to years 0-1899 (`DATE(99,1,1)` = 1999, `DATE(1899,12,31)` = 3799-12-31); years below 0 or from
  10000 are `#NUM!`. `DATE(1900,1,1)` = 2; serial 0 is 1899-12-30.
- Date text in ISO form is a date (`YEAR("2024-01-15")` = 2024); impossible dates (`"2024-02-30"`) are not.
- Sheets has no 9999-12-31 limit: `DATE(9999,12,32)` = 10000-01-01 and `YEAR` of it is 10000. Results below
  serial 0 are `#NUM!` (`EDATE(0,-1)`, `EOMONTH(0,-2)`, `DATE(2024,1,-1E9)`). **Not matched:** formula-compiler
  stops at 99999-12-31 and gives `#NUM!` after it, while Sheets still gives a number (`DATE(2024,1,1E9)` =
  1000045291; months beyond 2^31 seem to be capped, `DATE(2024,1E10,1)` = 65362736589). These cases are todo.
- `EDATE` / `EOMONTH` clamp to the month's end; `WEEKDAY` types 1, 2, 3 and 11-17; `HOUR` / `MINUTE` /
  `SECOND` round to the nearest second; `DATEDIF` with `"D"`, `"M"`, `"Y"`, `"YM"`.
- `TODAY()` / `NOW()` use the `timeZone` option (default UTC): give it the spreadsheet's time zone (File →
  Settings). Checked 2026-10-29 by reading `NOW()` at a known UTC moment in a sheet set to `Etc/GMT`,
  `Asia/Bangkok` and `America/Los_Angeles`: the serial is the local wall-clock time (00:23:06.007Z is
  46324.307708414 in Bangkok; 00:23:20.228Z is 46323.724539676 in Los Angeles, where `TODAY()` is still
  46323). `tests/core.test.ts` checks the `timeZone` and `now` options give the same serials in JS and SQL.
- `VLOOKUP` exact match (`FALSE`) ignores case and takes `*` `?` `~` wildcards; the first matching row wins.
  Approximate match (the default) returns the last of the largest keys <= the search key. Numbers never match
  text (`VLOOKUP("10", …)` finds nothing). A column past the table is `#REF!`; nothing found is `#N/A`.
- `XLOOKUP` match mode 0 is exact **without** wildcards, 2 is wildcards, -1 / 1 are exact-or-next-smaller /
  larger; search mode -1 searches from the last row. `if_not_found` replaces `#N/A`.
- `MATCH` positions count from row 1 of the sheet (with the header in row 1, the first data row is 2);
  types 0, 1 (largest <=, last of equals) and -1. `INDEX` beyond the data is blank.

## Excel (checked in Excel for the web)

- Same as Sheets except where listed here.
- `ROUND`, `ROUNDUP`, `ROUNDDOWN` require `num_digits`.
- `0^0` is `#NUM!`; `0^-1` is `#DIV/0!`; `-3^2` is 9.
- An empty referenced cell as the whole result shows `0` (`=B2` with B2 empty → 0); in SQL that makes a
  nullable text result `jsonb`.
- Text in arithmetic and `VALUE()`: `"$1,000"`, `"1,234.5"`, `"50%"`, `"(5)"`, `"-$5"`, `"$-5"`, `"+5"`,
  `".5"`, `"5."`, `" 3 "` and — unlike Sheets — exponents (`"1e3"`, `"$1e3"`, `"1.5E+3%"` = 15) are numbers.
  `""` (unlike Sheets), `" "`, `"(-5)"`, `"5%%"` and `"1,00"` are `#VALUE!`.
- Number → text: 15 significant digits, written out in full while that takes at most 20 characters
  (`1E+19` → 20 digits, `1.5E-15` → `0.0000000000000015`), otherwise scientific: `1E+20`, `-1E+20`, `1E-19`,
  `3.33333333333333E-13`, `1.18059162071741E+21`.
- Typed numbers keep 15 significant digits.
- `FIND("", "abc", 4)` is 4 and `FIND("", "")` is 1 (a start one past the end is allowed);
  `SEARCH("", "abc", 4)` and `FIND("", "abc", 5)` are `#VALUE!`.
- `TRIM` removes only spaces (tabs stay). `LEN` of an emoji is 1.
- `SWITCH` is case-insensitive.
- `COUNTIF`: `"5"` and `5` also match cells holding the text `"5"`, while `"<>5"` and `">4"` only look at
  numbers (as in Sheets). **An empty criterion cell means 0** (it counts zeros, not empty cells).
- Structured references: `[@col]`, `[@[col with spaces]]`, `Table1[@col]`, `Table1[[#This Row],[col]]`, and
  `Table1[col]` / `[col]` as whole columns inside aggregates. `'` escapes `[ ] # '` inside names.

### Dates and lookups (Excel)

- Same as Sheets except **Excel's 1900 calendar**: Excel keeps Lotus 1-2-3's bug and has a 1900-02-29
  (serial 60), so `DATE(1900,1,1)` = 1, `DATE(1900,2,29)` = 60, `DATE(1900,3,1)` = 61, and serial 0 is
  "1900-01-00" (`DAY(0)` = 0, `MONTH(0)` = 1, `YEAR(0)` = 1900). Date fields and date text before
  1900-03-01 get the same offset (`"1900-01-15"+0` = 15). `WEEKDAY` follows the serial (`WEEKDAY(1)` = 1).
- `DATE` counts through the fake day (`DATE(1900,3,0)` = 60, `DATE(1900,2,30)` = 61), but `EDATE` / `EOMONTH`
  use the real calendar (`EDATE(DATE(1900,1,31),1)` = 59, `EDATE(60,12)` = 1901-02-28) and give `#NUM!`
  for results before serial 1.
- Excel stops at 9999-12-31 (serial 2958465): `DATE(9999,12,32)`, `EDATE(DATE(9999,12,1),1)` and
  `YEAR(2958466)` are `#NUM!`.
- `DATE` keeps month and day in 16 bits: a month outside -32767 to 32766 is `#NUM!` (`DATE(2024,32766,1)` =
  1042555 but `DATE(2024,32767,1)` is `#NUM!`), and a day outside -32768 to 32767 counts as 32767
  (`DATE(2024,1,1E9)` = `DATE(2024,1,-1E9)` = `DATE(2024,1,32767)` = 78058). `EDATE` has no such limit
  (`EDATE(45000,90000)` = 2784318).
- Lookups behave like Sheets (all 25 lookup probes gave the same answers).

### Lookups in SQL

- Rows are ordered by the `orderBy` field, which must be unique and not null (ties would make "the first
  match" and `INDEX` rows depend on PostgreSQL's plan). JS uses the order of `ctx.rows`.
- `VLOOKUP` / `XLOOKUP` / exact `MATCH` on a number or boolean column can use a PostgreSQL index on that column
  (text keys compare `lower(col) COLLATE "C"`, so they need an index on that expression).
- `MATCH` positions and `INDEX` rows count the rows before the match (`count(*)` / `OFFSET`), so they cost time
  in proportion to the row number; on large tables prefer `XLOOKUP` / `VLOOKUP`.

