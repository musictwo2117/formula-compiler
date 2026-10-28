# Behavior notes

Sources checked: [Airtable formula field reference](https://support.airtable.com/docs/formula-field-reference),
[Google Sheets SEARCH](https://support.google.com/docs/answer/3094154),
[Excel SWITCH](https://support.microsoft.com/en-us/office/switch-function-47ab33c0-28ce-4530-8a45-d532ec4aa25e).
The Airtable examples from that page are test cases in `tests/cases/airtable.json`.

How formula-compiler reproduces each program, and **what has not been confirmed
against the real program yet**. Every item marked _unverified_ has a matching
`it.todo("verify against …")` in the test run (cases flagged `unverified` in
`tests/cases/*.json`), and items marked _todo_ are not implemented as tests at all
(cases flagged `todo`). Please send a PR with a screenshot or a link to the official
docs if you can confirm or correct one.

JS and SQL always agree with each other — the test-suite checks every runnable case
on both. The notes below are about agreeing with **the source program**.

## Shared model

- Values are number, text, boolean, blank or error. Blank is `null` in JS and `NULL` in SQL.
- Errors are values (`FormulaError` in JS; in SQL a second expression, `errorSql`,
  holds the code such as `'#DIV/0!'`). This is what lets `IFERROR`/`ISERROR` catch them
  without SQL exceptions.
- Numbers are IEEE doubles on both sides (`double precision` in SQL).
- `ROUND`/`ROUNDUP`/`ROUNDDOWN` first snap the double to 15 significant digits (like
  Excel, and like PostgreSQL's `float8 → numeric` cast), so `ROUND(2.675, 2)` is `2.68`.
- Strings are measured in Unicode code points (PostgreSQL `length()`), so `LEN` of an
  emoji is 1. Excel counts UTF-16 units (2 for most emoji). Thai text is the same in all.
- Text ordering is by code point after lower-casing (spreadsheets) — `COLLATE "C"` in SQL.
  The real programs use locale-aware ordering, so punctuation and accented letters can
  sort differently. ASCII letters, digits and Thai consonants sort the same.
- `UPPER`/`LOWER` use JavaScript / PostgreSQL case mapping; special cases such as the
  Turkish dotted I may differ from the programs.
- Not handled: numbers so large that the result overflows a double. JS returns
  `#NUM!`/`#ERROR!`; PostgreSQL raises an "out of range" exception.

## Airtable

Matches Airtable's documentation or well-known behavior (not machine-checked against Airtable):

- `IF(cond, value)` without a third argument returns blank.
- An empty field, `""` and `BLANK()` are the same: `{x} = ""` is true when empty, and `IF({x}, …)` tests "is not empty".
- Blank is 0 in arithmetic and `""` with `&`.
- `TRUE()` is 1 in arithmetic.
- `ROUND` breaks ties toward +infinity (`ROUND(-2.5, 0) = -2`); `ROUNDUP` rounds away from zero, `ROUNDDOWN` toward zero.
- `FIND` returns 0 when not found; `SEARCH` returns blank when not found.
- `TRIM` only strips leading and trailing whitespace.

_Unverified_ (implemented as described, flagged in `tests/cases/airtable.json`):

- Blank compared with a number counts as 0 (`{n} = 0` is true for an empty number field).
- Division by zero is an error (documented: `ISERROR(2/0)` is true); the code shown, `#ERROR!`, is not documented.
- `=` on text is case-sensitive (`"a" = "A"` is false).
- Text in arithmetic (`{t} * 2` with `"3"`) gives `#ERROR!` rather than coercing.
- `VALUE("abc")` gives `#ERROR!`. A leading `$` is dropped (documented: `VALUE("$1000")` = 1000); thousands
  separators (`"1,000"`) and the `-`/`%` cases the docs warn about are not handled.
- Number → text with `&` uses JavaScript's `String(n)`: `0.1 + 0.2 & ""` is `"0.30000000000000004"`. Booleans become `"1"` / `"0"`.
- `MOD` takes the sign of the dividend (`MOD(-7, 3) = -1`).
- `AVERAGE`, `MIN` and `MAX` count a blank argument as 0.
- `SEARCH` is case-sensitive like `FIND`.
- `SWITCH` with no match and no default returns blank.
- Operator precedence (Airtable does not document it): unary minus, then `* /`, then `+ -`, then `&`, then comparisons.

_Todo_ (not tested; current behavior may be wrong):

- **`MID` start position — the docs contradict themselves.** The official example is
  `MID("quick brown fox", 6, 5) => "brown"`, which is only true if `whereToStart` is 0-based, while
  `REPLACE("database", 2, 5, "o") => "dose"` is 1-based. Implemented as 1-based (like spreadsheets) until
  someone checks in a real base.

- `FIND`/`SEARCH` `startFromPosition`: implemented as a 0-based offset ("0 by default" in the docs).
- `T()` of a blank or of a checkbox.
- Strings: only `\"`, `\'`, `\\`, `\n`, `\t` escapes are recognised.
- Bare names without braces (`Name` instead of `{Name}`) are rejected; Airtable may accept single-word names.
- Lookup, rollup and linked-record fields (arrays), dates, attachments.

## Google Sheets and Excel (shared)

Matches the documented behavior (not machine-checked against the programs):

- Leading `=` is optional; text is `"…"` with `""` for a quote; not-equal is `<>`.
- Unary minus binds tighter than `^` in Excel: `-2^2 = 4`. `^` is left-associative: `2^3^2 = 64`.
- `%` is postfix: `50% = 0.5`.
- An empty cell equals both `""` and `0`; blank is 0 in arithmetic and `""` with `&`.
- `IF(cond, value)` without a third argument returns `FALSE`.
- Text comparison is case-insensitive. Values of different types never compare equal; numbers < text < booleans.
- `""` is text, not blank: `""+1` is `#VALUE!` in Excel; `ISBLANK("")` is `FALSE`.
- Numeric text is coerced in arithmetic (`" 3 " * 2 = 6`); other text gives `#VALUE!`.
- `#DIV/0!`, `#VALUE!`, `#N/A`, `#NUM!` are produced where the programs produce them; `IFERROR` catches all, `IFNA` only `#N/A`.
- `SUM`/`AVERAGE`/`MIN`/`MAX`/`COUNT`: numbers typed into the arguments are coerced (`SUM(1,"2",TRUE) = 4`) but text, booleans and blanks inside references are ignored (`SUM(B2)` with B2 = `"5"` is 0). `AVERAGE` of nothing is `#DIV/0!`; `MIN`/`MAX` of nothing is 0.
- `AND`/`OR` ignore text and blank references and return `#VALUE!` if nothing is left.
- `MOD` takes the sign of the divisor; `INT` rounds down; `ROUND` ties go away from zero.
- `FIND` is case-sensitive, `SEARCH` is not; both return `#VALUE!` when not found or when start is out of range.
- `TRIM` also collapses runs of inner spaces (space character only).
- Number → text uses up to 15 significant digits: `1/3 & ""` is `"0.333333333333333"`, `(0.1+0.2) & ""` is `"0.3"`.
- `COUNTIF`/`SUMIF` criteria: `">5"`, `"<>x"`, `"="`, `""`, wildcards `*` `?` `~`, case-insensitive; also
  computed criteria such as `">"&C2` or a cell holding the value.
- `SWITCH` with no match and no default is `#N/A` (documented for Excel).

_Unverified_:

- `SWITCH` compares text case-insensitively, like `=`.
- Very large or very small numbers turned into text are written out in full (`"1000000000000000000000"`);
  the programs switch to scientific notation (`1E+21`).

_Todo_:

- `COUNTIF(range, "5")` against **text** cells containing `"5"` (implemented: no match).
- `COUNTIF` with a blank criterion cell (implemented: matches empty cells).
- `VALUE("")`, `VALUE("50%")`, `VALUE("$1,000")`, dates in `VALUE` (implemented: only plain numbers).
- `AND("TRUE")` with text typed in directly (implemented: `"TRUE"`/`"FALSE"` accepted, other text `#VALUE!`).
- `FIND("", "")` (implemented: `#VALUE!` because start 1 is past the end).

## Excel only

- `ROUND`, `ROUNDUP`, `ROUNDDOWN` require `num_digits`.
- `SEARCH` supports `*`, `?` and `~` wildcards.
- `0^0` is `#NUM!`.
- An empty referenced cell as the whole result shows `0` (`=B2` with B2 empty → `0`). In SQL that makes a
  nullable text result `jsonb`.
- Structured references: `[@col]`, `[@[col with spaces]]`, `Table1[@col]`, `Table1[[#This Row],[col]]`, and
  `Table1[col]` / `[col]` as whole columns inside aggregates. `'` escapes `[ ] # '` inside names.

## Google Sheets only

- `ROUND`, `ROUNDUP`, `ROUNDDOWN` places are optional (default 0).
- No structured references.
- An empty referenced cell as the whole result stays empty.

_Unverified_:

- `0^0` is 1.
- `-3^2` is 9 (unary minus binds tighter than `^`, as in Excel).
- `SEARCH` treats `*` and `?` literally (no wildcards).
- `""+1` is `#VALUE!` (Sheets may treat `""` as 0).
- `TRIM` removes only the space character (Sheets may also remove other whitespace).
