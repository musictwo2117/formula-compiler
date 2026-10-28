# Behavior notes

How formula-compiler reproduces each program, and how each rule was established.

- **Airtable** and **Google Sheets** rules were checked on 2026-10-28 by running the formulas in a real
  Airtable base and a real Google Sheet and reading the computed values. The cases named
  "(checked in … 2026-10-28)" in `tests/cases/*.json` are those probes.
- **Excel** could not be run; its rules follow Microsoft's documentation and well-known behaviour.
  Anything not confirmed is flagged `unverified` in `tests/cases/excel.json` (it still runs, and adds an
  `it.todo("verify against excel …")`).

JS and SQL always agree with each other — the test-suite checks every runnable case on both. Please send
a PR (with the program and date) if you can confirm or correct a rule.

## Shared model

- Values are number, text, boolean, blank or error. Blank is `null` in JS and `NULL` in SQL.
- Errors are values (`FormulaError` in JS; in SQL a second expression, `errorSql`, holds the code such as
  `'#DIV/0!'`), so `IFERROR` / `ISERROR` work without SQL exceptions.
- Numbers are IEEE doubles on both sides (`double precision` in SQL).
- Text ordering is by code point (`COLLATE "C"`); spreadsheets lower-case first. The real programs use
  locale-aware ordering for punctuation and accented letters.
- Not handled: results that overflow a double. PostgreSQL raises "value out of range" where JS gives
  Infinity.

## Airtable (checked in a real base)

Airtable behaves much like JavaScript.

**Syntax**
- `{Field name}` with `\}` and `\\` escapes; a bare word such as `num5` is also a field name (so `TRUE`
  without `()` is the field "TRUE" — Airtable says "Unknown field names: true").
- Strings `"…"` or `'…'` with backslash escapes. Not-equal is `!=`; `<>` is an invalid formula.
- Precedence: unary minus, then `* /`, then **`+ - &` on one level, left to right** (`"x" & 1 + 2` is
  `NaN`, `2 + 3 & "x"` is `"5x"`), then comparisons.

**Blanks and booleans**
- An empty field, `""` and `BLANK()` are the same: `{x} = ""`, `{n} = 0` and `BLANK() = 0` are all true.
- An unchecked checkbox is blank. `TRUE()` is 1 in arithmetic; booleans become `"TRUE"` / `"FALSE"` as text.
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
  `AVERAGE`, `MIN`, `MAX` skip blanks and text (`AVERAGE(2, 4, blank)` = 3, `AVERAGE(blank)` = NaN).
- `VALUE(text)` keeps only digits and `.`; any `-` makes it negative and `%` divides by 100:
  `VALUE("$1,000")` = 1000, `VALUE("a1b2")` = 12, `VALUE("1.5e3")` = 1.53, `VALUE("5-3")` = -53,
  `VALUE("abc")` = 0, `VALUE("1.2.3")` = NaN.
- Numeric functions read text with `Number()`: `ABS("-3")` = 3, `ROUND("2.5", 0)` = 3.
- Text functions (`LEN`, `UPPER`, `LOWER`, `TRIM`, `LEFT`, `RIGHT`, `MID`, `FIND`, `SEARCH`, `SUBSTITUTE`,
  `REPLACE`) reject a number or boolean as their text argument: `LEN(123.5)` is `#ERROR!`. `&` and
  `CONCATENATE` do convert.
- `LEN` counts code points (an emoji is 1).
- `MID(s, start, n)` is 1-based — **the official docs example `MID("quick brown fox", 6, 5) => "brown"` is
  wrong; Airtable returns `" brow"`.** A start below 1 gives `""`.
- `RIGHT("abc", 4)` is `""` (a count longer than the text gives nothing); `RIGHT("abc", 2.7)` is `"abc"`.
- `LEFT` with a negative count is `""`.
- `REPLACE` works like `s.substring(0, start - 1) + replacement + s.substring(start - 1 + count)`.
- `SUBSTITUTE` with an index of 0 or less, or past the last occurrence, changes nothing.
- `FIND` / `SEARCH`: case-sensitive (both), `startFromPosition` is 1-based (0 behaves like 1), 0 when not
  found. A not-found `SEARCH` that is the whole formula shows as empty (that is the only difference).
- `SWITCH` without a match or default is blank. `T()` of a checkbox, number or blank is blank.
- `TRIM` strips whitespace at both ends (including newlines) and keeps inner runs of spaces.

**Known gaps**
- Field names are case-insensitive in Airtable (`{NUM5}` finds `num5`); formula-compiler reads
  `record["NUM5"]` exactly as written.
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

## Excel (documentation, not run)

- Same as Sheets except where listed here.
- `ROUND`, `ROUNDUP`, `ROUNDDOWN` require `num_digits`.
- `0^0` is `#NUM!`; `0^-1` is `#DIV/0!`.
- An empty referenced cell as the whole result shows `0` (`=B2` with B2 empty → 0); in SQL that makes a
  nullable text result `jsonb`.
- Text in arithmetic: plain decimals only (`""+1` is `#VALUE!`).
- Number → text: 15 significant digits, written out in full (no `1E+21` switch implemented).
- Typed numbers keep 15 significant digits (documented by Microsoft).
- `TRIM` removes only spaces. `LEN` counts code points.
- Structured references: `[@col]`, `[@[col with spaces]]`, `Table1[@col]`, `Table1[[#This Row],[col]]`, and
  `Table1[col]` / `[col]` as whole columns inside aggregates. `'` escapes `[ ] # '` inside names.

_Unverified_ (in `tests/cases/excel.json`):

- `SWITCH` compares text case-insensitively, like `=` (true in Sheets).

_Not checked (current Excel behaviour in formula-compiler, which differs from Sheets)_: `COUNTIF` with an
empty criterion cell matches empty cells; `COUNTIF(range, "5")` does not match text cells; `VALUE("")`,
`VALUE("50%")` and `VALUE("$1,000")` are `#VALUE!`; numbers are never written in scientific notation;
`TRIM` keeps tabs; `LEN` of an emoji is 1.
