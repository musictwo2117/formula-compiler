# formula-compiler

Compile **Airtable**, **Google Sheets** and **Excel** formulas into **JavaScript** and **PostgreSQL**,
with the source program's own rules for blanks, type coercion, rounding and errors.

```ts
import { compile } from "@musictwo2117/formula-compiler";

const { evaluate } = compile('IF(AND({รายได้}>30000, {อายุ}<60), "ผ่าน", "ไม่ผ่าน")', { from: "airtable", to: "js" });
evaluate({ "รายได้": 40000, "อายุ": 30 }); // "ผ่าน"
```

- One hand-written Pratt parser and one shared AST for all three programs (no parser libraries).
- JS output reads fields only through `record["name"]`; SQL output quotes every identifier and literal.
- Errors such as `#DIV/0!` and `#VALUE!` are values on both targets, so `IFERROR` / `ISERROR` work in SQL too.
- A formula that is invalid, or uses something not supported yet, fails at compile time with a clear
  error: code, position, function name and source program. Nothing is guessed or silently mistranslated.
- Every test case runs through both the JS output and the SQL output (on PGlite) and must give the same result.

## Install

```bash
npm install @musictwo2117/formula-compiler
```

Node 18+. ESM and CommonJS builds, TypeScript types included.

## Usage

```ts
compile(formula, { from: "airtable" | "sheets" | "excel", to: "js" | "sql" | "ast", ...options })
```

| `to` | Result |
| --- | --- |
| `"js"` | `{ code, evaluate(record, ctx?) }` — `code` is the source of `(record, rt, ctx) => value`; `evaluate` is ready to call. |
| `"sql"` | `{ sql, errorSql, type, sqlType }` — a value expression and an error-code expression to put in a `SELECT`. |
| `"ast"` | `{ ast }` — the shared syntax tree; every node has `start` / `end` offsets. |

### Options

| Option | Programs | Meaning |
| --- | --- | --- |
| `columnMap` | Sheets, Excel | Column letter → field name, e.g. `{ B: "income", C: "age" }`. |
| `headerRow` / `currentRow` | Sheets, Excel | Row of the formula. Default `headerRow` 1 and `currentRow = headerRow + 1`. References must point at this row. |
| `sheetName` | Sheets, Excel | Name of the formula's sheet, so `Sheet1!B2` / `'ชีต ไทย'!B2` are accepted. |
| `tableName` | Excel | Optional check for `Table1[...]` references. |
| `locale` | Sheets, Excel | `{ argumentSeparator: ";", decimalSeparator: "," }` for `=ROUND(1,5;0)`. |
| `fieldTypes` | SQL target | `{ income: "number", name: "text", ok: "boolean", due: "date" }` — required for every referenced field. Sheets/Excel `date` fields (`"2024-01-15"`, `"2024-01-15T10:30"` or a `Date`; a `timestamp` column in SQL) become serial numbers. |
| `table` / `tableAlias` | SQL target | Table that ranges (`A:A`, `A2:A10`) read, and the alias of the outer row. |
| `orderBy` | SQL target | Field that gives the row order (row 1, row 2, …) for bounded ranges (`A2:A10`) and for `VLOOKUP`, `XLOOKUP`, `MATCH` and `INDEX`; it must be unique and not null. JS uses the order of `ctx.rows`. |
| `timeZone` / `now` | Sheets, Excel | Time zone for `TODAY()` / `NOW()` (IANA name, default `"UTC"`), and a fixed "now" for SQL (JS reads `ctx.now`). |

### JavaScript

```ts
const r = compile("=IFERROR(B2/C2, \"-\")", { from: "excel", to: "js", columnMap: { B: "sales", C: "visits" } });
r.evaluate({ sales: 10, visits: 0 }); // "-"
r.evaluate({ sales: 10, visits: 4 }); // 2.5
```

Errors come back as `FormulaError` values (`isError(v)`, `v.code === "#DIV/0!"`). Ranges (`A:A`, `A2:A10`)
read `ctx.rows`: `evaluate(row, { rows })`, with `rows[0]` as the row after the header. To run the generated `code` yourself, pass `runtimeFor(dialect)`
(also exported from `@musictwo2117/formula-compiler/runtime`) as `rt`.

Generated code for the Airtable example:

```js
(record, rt, ctx) => rt.result(rt.IF(rt.AND(rt.cmp(">", rt.v(record[rt.key(record, "รายได้")], "รายได้"), 30000), rt.cmp("<", rt.v(record[rt.key(record, "อายุ")], "อายุ"), 60)), () => "ผ่าน", () => "ไม่ผ่าน"))
```

`rt.key` matches the field name without regard to case, as Airtable does.

### SQL (PostgreSQL)

```ts
const r = compile('=IF(AND(B2>30000, C2<60), "ผ่าน", "ไม่ผ่าน")', {
  from: "excel", to: "sql",
  columnMap: { B: "income", C: "age" },
  fieldTypes: { income: "number", age: "number" },
});
// SELECT ${r.sql} AS result, ${r.errorSql} AS error FROM people
```

```sql
-- value (text)
CASE WHEN ((COALESCE("income", 0::float8) > 30000::float8) AND (COALESCE("age", 0::float8) < 60::float8)) THEN 'ผ่าน' ELSE 'ไม่ผ่าน' END
-- error code (NULL when no error)
NULL::text
```

The SQL needs PostgreSQL 15 or later; CI runs every case on PostgreSQL 15, 16, 17 and 18. Blank is `NULL`.
Numbers are `double precision`. When the branches of `IF`/`SWITCH`/`IFERROR` have different
types (`IF(x, "yes", 0)`), the result is `jsonb`. Whole-column aggregates become subqueries:
`=SUM(B:B)` → `((SELECT COALESCE(SUM("__fc_r"."x"), 0::float8) FROM "people" AS "__fc_r"))`.

### Examples by program

**Airtable** — `{Field name}` (Thai, spaces and `\}` allowed) or a bare `FieldName`, `"..."` or `'...'` strings, `!=`, `&`:

```ts
compile("IF({Unit Price} * {Qty} > 100, 'big', BLANK())", { from: "airtable", to: "js" });
```

**Google Sheets** — `=` optional, `<>`, `^`, `50%`, `$A$1`, `'Sheet name'!A1`, `A:A` and `A2:A10` in aggregates and lookups, `;` locale:

```ts
compile("=IF(B2>1; \"a\"; \"b\")", { from: "sheets", to: "js", columnMap: { B: "x" }, locale: { argumentSeparator: ";" } });
compile("=B2/SUM(B:B)", { from: "sheets", to: "sql", columnMap: { B: "x" }, fieldTypes: { x: "number" }, table: "sales" });
```

**Excel** — everything Sheets has, plus structured references:

```ts
compile("=IF([@รายได้] > 30000, \"ผ่าน\", \"ไม่ผ่าน\")", { from: "excel", to: "js" });
compile("=[@amount] / SUM(Table1[amount])", { from: "excel", to: "sql", fieldTypes: { amount: "number" }, table: "orders" });
```

### Dates and lookups (Sheets, Excel)

Dates are serial numbers, as in the spreadsheet (days since 1899-12-30, the time of day as the fraction).
Give date fields the `date` type: ISO text or a `Date` (read in local time) in JS, a `timestamp` column in SQL.

```ts
const due = compile("=EDATE(B2, 1)", { from: "excel", to: "js", columnMap: { B: "start" }, fieldTypes: { start: "date" } });
due.evaluate({ start: "2024-01-31" }); // 45351 (2024-02-29)

const age = compile('=DATEDIF(B2, TODAY(), "Y")', {
  from: "sheets", to: "js", columnMap: { B: "born" }, fieldTypes: { born: "date" }, timeZone: "Asia/Bangkok",
});
age.evaluate({ born: "1990-05-20" }, { now: "2026-10-28T09:00:00Z" }); // 36
```

Excel's 1900 calendar is followed too (it has a 1900-02-29, so `DATE(1900,1,1)` is 1 in Excel and 2 in Sheets).

`VLOOKUP`, `XLOOKUP`, `MATCH` and `INDEX` work over whole columns and bounded ranges (`A2:B10`). In JS they read
`ctx.rows`; in SQL they read `table`, in the order of the `orderBy` field:

```ts
const rows = [{ sku: "A1", price: 10 }, { sku: "B2", price: 25 }];
const price = compile('=VLOOKUP("b2", A:B, 2, FALSE)', { from: "excel", to: "js", columnMap: { A: "sku", B: "price" } });
price.evaluate(rows[0], { rows }); // 25

compile('=VLOOKUP("b2", A:B, 2, FALSE)', {
  from: "excel", to: "sql", columnMap: { A: "sku", B: "price" },
  fieldTypes: { sku: "text", price: "number" }, table: "products", orderBy: "id",
});
```

### Errors

```ts
try {
  compile("=1 + OFFSET(B2, C:D, 2)", { from: "excel", to: "js" });
} catch (e) {
  e.code;          // "UNSUPPORTED_FUNCTION"  (vs "UNKNOWN_FUNCTION" for names that are not functions)
  e.functionName;  // "OFFSET"
  e.dialect;       // "excel"
  e.start, e.end;  // 5, 11
  e.message;       // "[Excel] Function OFFSET is not supported yet (supported lookup functions: VLOOKUP, XLOOKUP, MATCH, INDEX) (at position 6-11)"
  e.pointer();     // "=1 + OFFSET(B2, C:D, 2)\n     ^^^^^^"
}
```

Codes: `SYNTAX`, `UNKNOWN_FUNCTION`, `UNSUPPORTED_FUNCTION`, `ARITY`, `INVALID_ARGUMENT`, `UNSUPPORTED_REFERENCE`,
`UNSUPPORTED_FEATURE`, `UNKNOWN_NAME`, `UNKNOWN_COLUMN`, `UNSUPPORTED_IN_SQL`, `MISSING_FIELD_TYPE`, `INVALID_OPTION`.

## CLI

Installed, the command is `formula-compiler`; without installing, use `npx @musictwo2117/formula-compiler`.

```bash
npx @musictwo2117/formula-compiler "=IF(B2>30000, \"ok\", \"no\")" --from excel --to sql --columns B=income:number
npx @musictwo2117/formula-compiler "IF({Age} < 60, 'yes')" --from airtable --to js --eval '{"Age": 30}'
```

`--columns B=income,C=age` maps columns; add `:number` / `:text` / `:boolean` / `:date` (or `--types income=number`)
for the SQL target, which needs field types. Other flags: `--table`, `--sheet`, `--header-row`, `--current-row`,
`--order-by`, `--table-alias`, `--time-zone`, `--now`, `--separator ";"`, `--decimal ","`, `--json`. Run `--help`
for details.

## Supported functions

✅ supported · ⏳ exists in the program but not supported yet (reported as such) · — not a function of that program

| Function | Airtable | Google Sheets | Excel |
| --- | :-: | :-: | :-: |
| `ABS` | ✅ | ✅ | ✅ |
| `AND` | ✅ | ✅ | ✅ |
| `AVERAGE` | ✅ | ✅ | ✅ |
| `BLANK` | ✅ | — | — |
| `CONCATENATE` | ✅ | ✅ | ✅ |
| `COUNT` | ✅ | ✅ | ✅ |
| `COUNTA` | ✅ | ✅ | ✅ |
| `COUNTALL` | ✅ | — | — |
| `COUNTIF` | — | ✅ | ✅ |
| `DATE` | ⏳ | ✅ | ✅ |
| `DATEDIF` | ⏳ | ✅ | ✅ |
| `DAY` | ⏳ | ✅ | ✅ |
| `DAYS` | ⏳ | ✅ | ✅ |
| `EDATE` | ⏳ | ✅ | ✅ |
| `EOMONTH` | ⏳ | ✅ | ✅ |
| `ERROR` | ✅ | — | — |
| `FALSE` | ✅ | ✅ | ✅ |
| `FIND` | ✅ | ✅ | ✅ |
| `HOUR` | ⏳ | ✅ | ✅ |
| `IF` | ✅ | ✅ | ✅ |
| `IFERROR` | — | ✅ | ✅ |
| `IFNA` | — | ✅ | ✅ |
| `IFS` | — | ✅ | ✅ |
| `INDEX` | — | ✅ | ✅ |
| `INT` | ✅ | ✅ | ✅ |
| `ISBLANK` | — | ✅ | ✅ |
| `ISERROR` | ✅ | ⏳ | ⏳ |
| `ISNUMBER` | — | ✅ | ✅ |
| `ISTEXT` | — | ✅ | ✅ |
| `LEFT` | ✅ | ✅ | ✅ |
| `LEN` | ✅ | ✅ | ✅ |
| `LOWER` | ✅ | ✅ | ✅ |
| `MATCH` | — | ✅ | ✅ |
| `MAX` | ✅ | ✅ | ✅ |
| `MID` | ✅ | ✅ | ✅ |
| `MIN` | ✅ | ✅ | ✅ |
| `MINUTE` | ⏳ | ✅ | ✅ |
| `MOD` | ✅ | ✅ | ✅ |
| `MONTH` | ⏳ | ✅ | ✅ |
| `NOT` | ✅ | ✅ | ✅ |
| `NOW` | ⏳ | ✅ | ✅ |
| `OR` | ✅ | ✅ | ✅ |
| `REPLACE` | ✅ | ✅ | ✅ |
| `RIGHT` | ✅ | ✅ | ✅ |
| `ROUND` | ✅ | ✅ | ✅ |
| `ROUNDDOWN` | ✅ | ✅ | ✅ |
| `ROUNDUP` | ✅ | ✅ | ✅ |
| `SEARCH` | ✅ | ✅ | ✅ |
| `SECOND` | ⏳ | ✅ | ✅ |
| `SUBSTITUTE` | ✅ | ✅ | ✅ |
| `SUM` | ✅ | ✅ | ✅ |
| `SUMIF` | — | ✅ | ✅ |
| `SWITCH` | ✅ | ✅ | ✅ |
| `T` | ✅ | ⏳ | ⏳ |
| `TEXTJOIN` | — | ✅ | ✅ |
| `TIME` | ⏳ | ✅ | ✅ |
| `TODAY` | ⏳ | ✅ | ✅ |
| `TRIM` | ✅ | ✅ | ✅ |
| `TRUE` | ✅ | ✅ | ✅ |
| `UPPER` | ✅ | ✅ | ✅ |
| `VALUE` | ✅ | ✅ | ✅ |
| `VLOOKUP` | — | ✅ | ✅ |
| `WEEKDAY` | ⏳ | ✅ | ✅ |
| `XLOOKUP` | — | ✅ | ✅ |
| `YEAR` | ⏳ | ✅ | ✅ |

Per-program differences (for example `IF` without a third argument is blank in Airtable but `FALSE` in
Sheets/Excel, and `ROUND` digits are optional only in Sheets) are documented in
[docs/behavior-notes.md](docs/behavior-notes.md).

## Limitations

- **Every rule was checked against the real programs** (Airtable, Google Sheets and Excel for the web,
  2026-10-28 and 2026-10-29). See [docs/behavior-notes.md](docs/behavior-notes.md).
- Airtable: the JS target needs `fieldTypes` to tell an empty text field from an empty number field, and an
  unchecked checkbox sent as `null` needs the type `boolean` (otherwise it reads as an empty number field; `false`
  needs no type).
- Airtable cases that still differ (todo): `MID(BLANK(), 1, 1)` is `"1"` in Airtable, `LEFT("abc", BLANK())` is
  `"abc"`, and `COUNTA(ERROR())` is 1 where formula-compiler gives `#ERROR!`.
- `TODAY()` / `NOW()` use the `timeZone` option, UTC by default: pass the spreadsheet's time zone (Sheets) or the
  browser's (Excel for the web), or the result is hours off. Excel was checked in Asia/Bangkok only.
- References: only cells in the formula's own row, plus whole columns (`A:A`, `Table1[col]`) and bounded ranges
  (`A2:A10`) inside aggregates and lookups (multi-column `D:F` / `D2:F10` only as the `VLOOKUP` / `INDEX`
  table). Other rows, other sheets, whole rows and ranges that include the header row (`A1:A10`) are rejected with
  `UNSUPPORTED_REFERENCE`; open-ended ranges (`A2:A`) are a `SYNTAX` error. Whole columns hold the data rows only: the header row
  reads as empty (`INDEX(B:B, 1)` is blank, not the header text). `SUMIF` / `XLOOKUP` ranges must cover the same
  rows.
- Dates: Sheets/Excel serial dates and 15 date functions; Airtable dates, `NETWORKDAYS`/`WORKDAY`, `WEEKNUM`,
  `DATEVALUE`, `TEXT` and `DATEDIF` units `"MD"`/`"YD"` are not supported yet.
- Text outside ASCII: case-insensitive comparisons lower-case both sides, so a few letters (`σ`/`ς`, `İ`) differ
  from Google Sheets and between JS and SQL. See [docs/behavior-notes.md](docs/behavior-notes.md).
- Not yet: `HLOOKUP`/`LOOKUP`/`XMATCH`/`OFFSET`, `ARRAYFORMULA`, `LAMBDA`, array literals, named ranges,
  omitted arguments (`IF(A1,,1)`), Airtable lookup/rollup (array) fields (`COUNT` / `COUNTA` / `COUNTALL` work on
  plain values).
- SQL lookups need the `orderBy` option, and their match mode, column index and search mode must be literals.
  An index on the lookup column makes `VLOOKUP` / `XLOOKUP` fast; `MATCH` and `INDEX` positions cost time in
  proportion to the row number. Bounded ranges read the rows between two `orderBy` keys, so an index on the
  `orderBy` field keeps small ranges of a big table fast.
- Google Sheets dates after 99999-12-31 are `#NUM!` here; Sheets still gives a number.
- SQL: literal `COUNTIF`/`SUMIF` criteria (`">5"`, `"a*"`) compile to plain SQL; computed ones (`">"&C2`)
  are parsed per row by PostgreSQL, which gives a much longer expression. Very large numbers can overflow `double precision` and raise a PostgreSQL error. The SQL repeats
  sub-expressions, so it grows quickly with deep nesting of error-producing expressions (date functions compute
  repeated values once, so they are not affected).
- Strings are handled as code points; Sheets counts UTF-16 units, so `LEN` of an emoji matches Sheets but
  `LEFT`/`MID` on emoji can differ.

## Contributing

Development needs Node 22.12 or later (Vitest 5); the published package still runs on Node 18+, which CI checks.

```bash
npm install
npm test          # Vitest: every case runs in JS and in PGlite (PostgreSQL 17)
FC_TEST_DATABASE_URL=postgres://user@localhost/db npm test   # the SQL on a real server instead
npm run typecheck
npm run build
```

- Code map: `src/core` (AST, Pratt parser, registry, reference resolver), `src/dialects/<program>`
  (lexer, parser config, function table), `src/codegen` (JS and SQL generators), `src/runtime` (JS helpers).
- **Adding a function**: register it in the program's `functions.ts` (shared Sheets/Excel functions live in
  `src/dialects/spreadsheet-functions.ts`) with its arity, JS (usually a runtime helper in `src/runtime/`)
  and SQL. Remove it from the `markUnsupported` list. Then add cases to `tests/cases/<program>.json` and run
  `npm run docs:functions` to refresh the table above.
- **Test cases** are `{ formula, record | rows, columnMap?, types?, options?, expected | error }`. Mark behaviour you
  could not confirm in the real program with `"unverified": "why"` (still runs, adds a todo) or `"todo": "why"`
  (does not run), and add it to `docs/behavior-notes.md`. Please do not guess. A difference we accept on purpose
  keeps the real value in `expected` and says why in `"limitation"`; `"ours"` is what JS and SQL must give
  (without it the case is skipped).
- Confirmations of unverified behaviour (screenshots or docs links) are very welcome.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
