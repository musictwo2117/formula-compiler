# formula-compiler

Turn **Airtable**, **Google Sheets** and **Excel** formulas into **JavaScript** functions or **PostgreSQL**
expressions that give the same answers as the original program.

```ts
import { compile } from "@musictwo2117/formula-compiler";

const { evaluate } = compile('IF(AND({รายได้}>30000, {อายุ}<60), "ผ่าน", "ไม่ผ่าน")', { from: "airtable", to: "js" });
evaluate({ "รายได้": 40000, "อายุ": 30 }); // "ผ่าน"
```

**Why use it**

- **Same results as the real program.** Each program has its own rules for blanks, text in arithmetic, rounding
  and errors. Every rule here was checked in a real Airtable base, Google Sheet and Excel for the web, and is
  recorded as a test case ([docs/behavior-notes.md](docs/behavior-notes.md)).
- **No guessing.** A formula that is wrong, or uses something not supported yet, fails when you compile it, with
  an error code and the position in the formula. Nothing is silently translated into something else.
- **JS and SQL agree.** Every test case runs through both outputs and must give the same value. Errors such as
  `#DIV/0!` are values in both, so `IFERROR` / `ISERROR` work in SQL too.
- **Safe output.** The JS reads fields only through `record["name"]`; the SQL quotes every name and value.

## Contents

- [Install](#install)
- [Quick start](#quick-start): [JavaScript](#javascript), [SQL](#sql-postgresql)
- [Options](#options)
- [Formulas by program](#formulas-by-program)
- [Dates](#dates-sheets-excel) · [Ranges and lookups](#ranges-and-lookups-sheets-excel) · [Errors](#errors)
- [Command line](#command-line)
- [Supported functions](#supported-functions)
- [Limitations](#limitations)
- [Contributing](#contributing)

## Install

```bash
npm install @musictwo2117/formula-compiler
```

Runs on Node 18 or later. ESM and CommonJS builds; TypeScript types included.

## Quick start

```ts
compile(formula, { from, to, ...options })
```

- `from`: `"airtable"`, `"sheets"` or `"excel"`
- `to`: what you get back:

| `to` | You get |
| --- | --- |
| `"js"` | `{ evaluate(record, ctx?), code }`: call `evaluate` with a row; `code` is the generated function's source. |
| `"sql"` | `{ sql, errorSql, type, sqlType }`: two expressions to put in a `SELECT`, the value and the error code. |
| `"ast"` | `{ ast }`: the parsed formula; every node has `start` / `end` positions. |

### JavaScript

Spreadsheet formulas refer to columns, so tell the compiler which field each column letter is (`columnMap`):

```ts
const r = compile('=IFERROR(B2/C2, "-")', { from: "excel", to: "js", columnMap: { B: "sales", C: "visits" } });
r.evaluate({ sales: 10, visits: 4 }); // 2.5
r.evaluate({ sales: 10, visits: 0 }); // "-"
```

- A blank is `null`. (Like Excel, an Excel formula whose whole result is an empty cell gives 0.)
- An error comes back as a `FormulaError` value, not an exception: check it with `isError(v)` and read `v.code`
  (for example `"#DIV/0!"`).
- Formulas that read other rows (ranges, lookups) need all the rows: `evaluate(row, { rows })`, where `rows[0]`
  is the first row under the header.
- `TODAY()` / `NOW()` read the time from `ctx.now` if you pass it: `evaluate(row, { now: "2026-10-29T09:00:00Z" })`.

To run the generated `code` yourself, pass `runtimeFor(dialect)` (also exported from
`@musictwo2117/formula-compiler/runtime`) as its `rt` argument.

### SQL (PostgreSQL)

The SQL target needs the type of every field the formula uses (`fieldTypes`):

```ts
const r = compile('=IF(AND(B2>30000, C2<60), "ผ่าน", "ไม่ผ่าน")', {
  from: "excel", to: "sql",
  columnMap: { B: "income", C: "age" },
  fieldTypes: { income: "number", age: "number" },
});
// SELECT ${r.sql} AS result, ${r.errorSql} AS error FROM people
```

```sql
-- r.sql: the value
CASE WHEN ((COALESCE("income", 0::float8) > 30000::float8) AND (COALESCE("age", 0::float8) < 60::float8)) THEN 'ผ่าน' ELSE 'ไม่ผ่าน' END
-- r.errorSql: the error code, NULL when there is none
NULL::text
```

- Needs PostgreSQL 15 or later (CI runs every case on 15, 16, 17 and 18).
- A blank is `NULL`; numbers are `double precision`.
- When the branches of `IF` / `SWITCH` / `IFERROR` have different types (`IF(x, "yes", 0)`), the result is `jsonb`.
- Formulas over whole columns become subqueries, so pass the table name (`table`):
  `=SUM(B:B)` → `((SELECT COALESCE(SUM("__fc_r"."x"), 0::float8) FROM "people" AS "__fc_r"))`.

## Options

**For every program**

| Option | Meaning |
| --- | --- |
| `fieldTypes` | Type of each field: `{ income: "number", name: "text", ok: "boolean", due: "date" }`. **Required for SQL.** In JS, Airtable needs it to tell an empty text field from an empty number field (see [Limitations](#limitations)). |

**Google Sheets and Excel**

| Option | Meaning |
| --- | --- |
| `columnMap` | Column letter → field name: `{ B: "income", C: "age" }`. |
| `headerRow` / `currentRow` | Which row is the header (default 1) and which row the formula is in (default the row after the header). Cell references must point at the formula's row. |
| `sheetName` | The formula's own sheet, so `Sheet1!B2` or `'ชีต ไทย'!B2` is accepted. |
| `tableName` | Excel only: checks the table name in `Table1[...]` references. |
| `locale` | `{ argumentSeparator: ";", decimalSeparator: "," }` for formulas written like `=ROUND(1,5;0)`. |
| `timeZone` | Time zone for `TODAY()` / `NOW()`, as an IANA name such as `"Asia/Bangkok"`. Default `"UTC"`. |
| `now` | A fixed "now" for `TODAY()` / `NOW()` in SQL (in JS, pass `ctx.now` instead). |

**SQL target**

| Option | Meaning |
| --- | --- |
| `table` | The table that ranges and lookups read (`A:A`, `A2:A10`, `VLOOKUP`). |
| `tableAlias` | The alias of the current row's table in your query, if it has one. |
| `orderBy` | A field that gives the row order (row 1, row 2, …). Needed for bounded ranges (`A2:A10`) and lookups. It must be unique and never null. |

## Formulas by program

**Airtable**: fields as `{Field name}` (Thai, spaces and `\}` allowed) or a bare `FieldName`; strings in `"..."` or
`'...'`; `!=` for "not equal"; `&` joins text.

```ts
compile("IF({Unit Price} * {Qty} > 100, 'big', BLANK())", { from: "airtable", to: "js" });
```

Airtable matches field names without regard to case (`{price}` finds the field `Price`), and so does the compiler.

**Google Sheets**: the leading `=` is optional; `<>`, `^`, `50%`, `$A$1`, `'Sheet name'!A1`; `A:A` and `A2:A10`
inside aggregates and lookups; `;` as the separator with `locale`.

```ts
compile('=IF(B2>1; "a"; "b")', { from: "sheets", to: "js", columnMap: { B: "x" }, locale: { argumentSeparator: ";" } });
compile("=B2/SUM(B:B)", { from: "sheets", to: "sql", columnMap: { B: "x" }, fieldTypes: { x: "number" }, table: "sales" });
```

**Excel**: everything Sheets has, plus table references (`[@column]`, `Table1[column]`):

```ts
compile('=IF([@รายได้] > 30000, "ผ่าน", "ไม่ผ่าน")', { from: "excel", to: "js" });
compile("=[@amount] / SUM(Table1[amount])", { from: "excel", to: "sql", fieldTypes: { amount: "number" }, table: "orders" });
```

Where the programs differ (for example, `IF` without a third argument is blank in Airtable but `FALSE` in Sheets
and Excel), each follows its own rules. [docs/behavior-notes.md](docs/behavior-notes.md) lists them.

## Dates (Sheets, Excel)

Dates are serial numbers, as in the spreadsheet: days since 1899-12-30, with the time of day as the fraction.
Give date fields the type `date`. In JS a date field can be ISO text (`"2024-01-15"`, `"2024-01-15T10:30"`) or a
`Date` (read in local time); in SQL it is a `timestamp` column.

```ts
const due = compile("=EDATE(B2, 1)", { from: "excel", to: "js", columnMap: { B: "start" }, fieldTypes: { start: "date" } });
due.evaluate({ start: "2024-01-31" }); // 45351 (2024-02-29)

const age = compile('=DATEDIF(B2, TODAY(), "Y")', {
  from: "sheets", to: "js", columnMap: { B: "born" }, fieldTypes: { born: "date" }, timeZone: "Asia/Bangkok",
});
age.evaluate({ born: "1990-05-20" }, { now: "2026-10-28T09:00:00Z" }); // 36
```

- **Set `timeZone`.** `TODAY()` and `NOW()` use UTC unless you pass `timeZone`. Use the spreadsheet's time zone
  for Sheets (File → Settings) and the computer's for Excel; otherwise the result can be hours, or a day, off.
- Excel's calendar has a 1900-02-29 that never existed, so `DATE(1900,1,1)` is 1 in Excel and 2 in Sheets. The
  compiler follows this.

## Ranges and lookups (Sheets, Excel)

Aggregates (`SUM`, `COUNTIF`, `SUMIF`, …) and lookups (`VLOOKUP`, `XLOOKUP`, `MATCH`, `INDEX`) can read a whole
column (`A:A`, `Table1[col]`) or a bounded range (`A2:A10`).

- In JS, pass all the rows: `evaluate(row, { rows })`.
- In SQL, pass `table` and `orderBy` (the field that puts the rows in order).

```ts
const rows = [{ sku: "A1", price: 10 }, { sku: "B2", price: 25 }];
const price = compile('=VLOOKUP("b2", A:B, 2, FALSE)', { from: "excel", to: "js", columnMap: { A: "sku", B: "price" } });
price.evaluate(rows[0], { rows }); // 25

compile('=VLOOKUP("b2", A:B, 2, FALSE)', {
  from: "excel", to: "sql", columnMap: { A: "sku", B: "price" },
  fieldTypes: { sku: "text", price: "number" }, table: "products", orderBy: "id",
});
```

## Errors

Problems are reported when you compile, as a `FormulaCompileError`:

```ts
try {
  compile("=1 + OFFSET(B2, C:D, 2)", { from: "excel", to: "js" });
} catch (e) {
  e.code;          // "UNSUPPORTED_FUNCTION"
  e.functionName;  // "OFFSET"
  e.dialect;       // "excel"
  e.start, e.end;  // 5, 11
  e.message;       // "[Excel] Function OFFSET is not supported yet (supported lookup functions: VLOOKUP, XLOOKUP, MATCH, INDEX) (at position 6-11)"
  e.pointer();     // "=1 + OFFSET(B2, C:D, 2)\n     ^^^^^^"
}
```

| Code | Meaning |
| --- | --- |
| `SYNTAX` | The formula cannot be read (a missing bracket, an unexpected character, …). |
| `UNKNOWN_FUNCTION` | The program has no function with this name. |
| `UNSUPPORTED_FUNCTION` | The program has this function, but the compiler does not support it yet. |
| `ARITY` | Too few or too many arguments. |
| `INVALID_ARGUMENT` | An argument the function cannot take. |
| `UNSUPPORTED_REFERENCE` | A reference the compiler does not support (another row, another sheet, `A2:A`, …). |
| `UNSUPPORTED_FEATURE` | Syntax the compiler does not support yet (array literals, omitted arguments, …). |
| `UNKNOWN_NAME` | A name that is not a function, field or reference. |
| `UNKNOWN_COLUMN` | A column letter missing from `columnMap`. |
| `UNSUPPORTED_IN_SQL` | Works in JS, but cannot be compiled to SQL. |
| `MISSING_FIELD_TYPE` | The SQL target needs a `fieldTypes` entry for this field. |
| `INVALID_OPTION` | A bad option value (an unknown time zone, an invalid `now`, …). |

## Command line

Once installed, the command is `formula-compiler`; without installing, use `npx @musictwo2117/formula-compiler`.

```bash
npx @musictwo2117/formula-compiler "=IF(B2>30000, \"ok\", \"no\")" --from excel --to sql --columns B=income:number
npx @musictwo2117/formula-compiler "IF({Age} < 60, 'yes')" --from airtable --to js --eval '{"Age": 30}'
```

- `--columns B=income,C=age` maps columns. Add a type for SQL: `B=income:number` (`number`, `text`, `boolean`,
  `date`), or use `--types income=number`.
- Other flags: `--table`, `--sheet`, `--header-row`, `--current-row`, `--order-by`, `--table-alias`, `--time-zone`,
  `--now`, `--separator ";"`, `--decimal ","`, `--json`. Run `--help` for details.

## Supported functions

✅ supported · ⏳ exists in the program but not supported yet (you get `UNSUPPORTED_FUNCTION`) · — not a function of that program

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

## Limitations

Every rule was checked against the real programs on 2026-10-28 and 2026-10-29. The details, and the few cases
that still differ, are in [docs/behavior-notes.md](docs/behavior-notes.md).

### Things you need to pass in

- **Airtable in JS: `fieldTypes`.** Without it the compiler cannot tell an empty text field from an empty number
  field, and Airtable treats them differently (`{t} * 2` is `#ERROR!` for empty text, 0 for an empty number). An
  unchecked checkbox sent as `null` needs the type `boolean`; one sent as `false` needs no type.
- **`timeZone` for `TODAY()` / `NOW()`.** The default is UTC. Excel for the web was checked in one time zone
  (Asia/Bangkok) only.
- **SQL ranges and lookups: `table` and `orderBy`.** Lookups also need their match mode, column number and search
  mode written as plain values (`2`, `FALSE`), not computed.

### Not supported yet

- **References**: only cells in the formula's own row, plus whole columns (`A:A`, `Table1[col]`) and bounded
  ranges (`A2:A10`) inside aggregates and lookups. A range of several columns (`D:F`, `D2:F10`) works only as the
  table of `VLOOKUP` / `INDEX`. Other rows, other sheets, whole rows (`2:2`), open-ended ranges (`A2:A`, `A:A10`)
  and ranges that include the header row (`A1:A10`) give `UNSUPPORTED_REFERENCE`. `SUMIF` / `XLOOKUP` ranges must
  cover the same rows.
- **Functions**: `HLOOKUP`, `LOOKUP`, `XMATCH`, `OFFSET`, `ARRAYFORMULA`, `LAMBDA`; Airtable date functions;
  `NETWORKDAYS`, `WORKDAY`, `WEEKNUM`, `DATEVALUE`, `TEXT`; `DATEDIF` units `"MD"` and `"YD"`.
- **Syntax**: array literals (`{1,2}`), named ranges, and empty arguments (`IF(A1,,1)`).
- **Airtable lookup and rollup fields** (lists of values). `COUNT`, `COUNTA` and `COUNTALL` work on plain values.

### Known differences

- **Airtable, on purpose.** `MID` of a real blank returns its count in Airtable (`MID(BLANK(), 1, 3)` is 3); the
  compiler gives `""`. `COUNTA(ERROR())` is 1 in Airtable; the compiler gives `#ERROR!`.
- **Whole columns hold only the data rows.** The header row reads as empty, so `INDEX(B:B, 1)` is blank, not the
  header text.
- **Letters outside ASCII.** Case-insensitive comparisons lower-case both sides, so a few letters (`σ`/`ς`, `İ`)
  compare differently from Google Sheets, and differently in JS and SQL.
- **Emoji.** Text is handled as characters (code points). Sheets counts UTF-16 units, so `LEN` of an emoji
  matches Sheets but `LEFT` / `MID` across an emoji can differ.
- **Far-future dates.** Google Sheets dates after 99999-12-31 are `#NUM!` here; Sheets still gives a number.
- **SQL size and range.** Literal `COUNTIF` / `SUMIF` criteria (`">5"`, `"a*"`) become plain SQL, but computed
  ones (`">"&C2`) are parsed row by row and make a much longer expression. The SQL repeats sub-expressions, so it
  grows quickly when error-producing expressions are nested deeply (date functions are not affected). Very large
  numbers can overflow `double precision` and make PostgreSQL raise an error.
- **SQL speed.** An index on the lookup column makes `VLOOKUP` / `XLOOKUP` fast, and an index on the `orderBy`
  field keeps small ranges of a big table fast. `MATCH` and `INDEX` take longer the further down the row is.

## Contributing

Development needs Node 22.12 or later (for Vitest 5); the published package still runs on Node 18+, which CI checks.

```bash
npm install
npm test          # every case runs in JS and on PGlite (PostgreSQL 17)
FC_TEST_DATABASE_URL=postgres://user@localhost/db npm test   # run the SQL on a real server instead
npm run typecheck
npm run build
```

**Where things are**

- `src/core`: the syntax tree, parser, function registry and reference checks
- `src/dialects/<program>`: each program's lexer, parser settings and function table
- `src/codegen`: the JS and SQL generators
- `src/runtime`: the helpers the generated JS calls

**Adding a function**

1. Register it in the program's `functions.ts` (functions shared by Sheets and Excel live in
   `src/dialects/spreadsheet-functions.ts`) with its number of arguments, JS (usually a helper in `src/runtime/`)
   and SQL, and remove it from the `markUnsupported` list.
2. Add test cases to `tests/cases/<program>.json`.
3. Run `npm run docs:functions` and paste its output over the table above.

**Test cases** look like `{ formula, record | rows, columnMap?, types?, options?, expected | error }`.

- **Please do not guess.** Check each behaviour in the real program and put the date in the case name, e.g.
  "(checked in Airtable 2026-10-29)". Write it up in `docs/behavior-notes.md` too.
- If you could not check a behaviour, mark the case `"unverified": "why"` (it still runs, and is listed as todo)
  or `"todo": "why"` (it does not run).
- For a difference we accept on purpose, keep the real program's value in `expected`, say why in
  `"limitation"`, and put what JS and SQL must give in `"ours"` (without `"ours"` the case is skipped).

Confirmations of unverified behaviour (a screenshot or a docs link) are very welcome.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
