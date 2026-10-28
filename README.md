# formula-compiler

Compile **Airtable**, **Google Sheets** and **Excel** formulas into **JavaScript** and **PostgreSQL**,
with the source program's own rules for blanks, type coercion, rounding and errors.

```ts
import { compile } from "@formula-compiler/core";

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
npm install @formula-compiler/core
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
| `fieldTypes` | SQL target | `{ income: "number", name: "text", ok: "boolean" }` — required for every referenced field. |
| `table` / `tableAlias` | SQL target | Table that whole-column ranges (`A:A`) aggregate over, and the alias of the outer row. |

### JavaScript

```ts
const r = compile("=IFERROR(B2/C2, \"-\")", { from: "excel", to: "js", columnMap: { B: "sales", C: "visits" } });
r.evaluate({ sales: 10, visits: 0 }); // "-"
r.evaluate({ sales: 10, visits: 4 }); // 2.5
```

Errors come back as `FormulaError` values (`isError(v)`, `v.code === "#DIV/0!"`). Whole-column ranges read
`ctx.rows`: `evaluate(row, { rows })`. To run the generated `code` yourself, pass `runtimeFor(dialect)`
(also exported from `@formula-compiler/core/runtime`) as `rt`.

Generated code for the Airtable example:

```js
(record, rt, ctx) => rt.result(rt.IF(rt.AND(rt.cmp(">", rt.v(record["รายได้"], "รายได้"), 30000), rt.cmp("<", rt.v(record["อายุ"], "อายุ"), 60)), () => "ผ่าน", () => "ไม่ผ่าน"))
```

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

Blank is `NULL`. Numbers are `double precision`. When the branches of `IF`/`SWITCH`/`IFERROR` have different
types (`IF(x, "yes", 0)`), the result is `jsonb`. Whole-column aggregates become subqueries:
`=SUM(B:B)` → `(SELECT COALESCE(SUM("__fc_r"."x"), 0::float8) FROM "people" AS "__fc_r")`.

### Examples by program

**Airtable** — `{Field name}` (Thai, spaces and `\}` allowed) or a bare `FieldName`, `"..."` or `'...'` strings, `!=`, `&`:

```ts
compile("IF({Unit Price} * {Qty} > 100, 'big', BLANK())", { from: "airtable", to: "js" });
```

**Google Sheets** — `=` optional, `<>`, `^`, `50%`, `$A$1`, `'Sheet name'!A1`, `A:A` in aggregates, `;` locale:

```ts
compile("=IF(B2>1; \"a\"; \"b\")", { from: "sheets", to: "js", columnMap: { B: "x" }, locale: { argumentSeparator: ";" } });
compile("=B2/SUM(B:B)", { from: "sheets", to: "sql", columnMap: { B: "x" }, fieldTypes: { x: "number" }, table: "sales" });
```

**Excel** — everything Sheets has, plus structured references:

```ts
compile("=IF([@รายได้] > 30000, \"ผ่าน\", \"ไม่ผ่าน\")", { from: "excel", to: "js" });
compile("=[@amount] / SUM(Table1[amount])", { from: "excel", to: "sql", fieldTypes: { amount: "number" }, table: "orders" });
```

### Errors

```ts
try {
  compile("=1 + VLOOKUP(B2, C:D, 2)", { from: "excel", to: "js" });
} catch (e) {
  e.code;          // "UNSUPPORTED_FUNCTION"  (vs "UNKNOWN_FUNCTION" for names that are not functions)
  e.functionName;  // "VLOOKUP"
  e.dialect;       // "excel"
  e.start, e.end;  // 5, 12
  e.message;       // "[Excel] Function VLOOKUP is not supported yet (lookup and reference functions are planned) (at position 6-12)"
  e.pointer();     // "=1 + VLOOKUP(B2, C:D, 2)\n     ^^^^^^^"
}
```

Codes: `SYNTAX`, `UNKNOWN_FUNCTION`, `UNSUPPORTED_FUNCTION`, `ARITY`, `INVALID_ARGUMENT`, `UNSUPPORTED_REFERENCE`,
`UNSUPPORTED_FEATURE`, `UNKNOWN_NAME`, `UNKNOWN_COLUMN`, `UNSUPPORTED_IN_SQL`, `MISSING_FIELD_TYPE`, `INVALID_OPTION`.

## CLI

Installed, the command is `formula-compiler`; without installing, use `npx @formula-compiler/core`.

```bash
npx @formula-compiler/core "=IF(B2>30000, \"ok\", \"no\")" --from excel --to sql --columns B=income:number
npx @formula-compiler/core "IF({Age} < 60, 'yes')" --from airtable --to js --eval '{"Age": 30}'
```

`--columns B=income,C=age` maps columns; add `:number` / `:text` / `:boolean` (or `--types income=number`)
for the SQL target, which needs field types. Other flags: `--table`, `--sheet`, `--header-row`, `--current-row`,
`--separator ";"`, `--decimal ","`, `--json`. Run `--help` for details.

## Supported functions

✅ supported · ⏳ exists in the program but not supported yet (reported as such) · — not a function of that program

| Function | Airtable | Google Sheets | Excel |
| --- | :-: | :-: | :-: |
| `ABS` | ✅ | ✅ | ✅ |
| `AND` | ✅ | ✅ | ✅ |
| `AVERAGE` | ✅ | ✅ | ✅ |
| `BLANK` | ✅ | — | — |
| `CONCATENATE` | ✅ | ✅ | ✅ |
| `COUNT` | ⏳ | ✅ | ✅ |
| `COUNTA` | ⏳ | ✅ | ✅ |
| `COUNTIF` | — | ✅ | ✅ |
| `ERROR` | ✅ | — | — |
| `FALSE` | ✅ | ✅ | ✅ |
| `FIND` | ✅ | ✅ | ✅ |
| `IF` | ✅ | ✅ | ✅ |
| `IFERROR` | — | ✅ | ✅ |
| `IFNA` | — | ✅ | ✅ |
| `IFS` | — | ✅ | ✅ |
| `INT` | ✅ | ✅ | ✅ |
| `ISBLANK` | — | ✅ | ✅ |
| `ISERROR` | ✅ | ⏳ | ⏳ |
| `ISNUMBER` | — | ✅ | ✅ |
| `ISTEXT` | — | ✅ | ✅ |
| `LEFT` | ✅ | ✅ | ✅ |
| `LEN` | ✅ | ✅ | ✅ |
| `LOWER` | ✅ | ✅ | ✅ |
| `MAX` | ✅ | ✅ | ✅ |
| `MID` | ✅ | ✅ | ✅ |
| `MIN` | ✅ | ✅ | ✅ |
| `MOD` | ✅ | ✅ | ✅ |
| `NOT` | ✅ | ✅ | ✅ |
| `OR` | ✅ | ✅ | ✅ |
| `REPLACE` | ✅ | ✅ | ✅ |
| `RIGHT` | ✅ | ✅ | ✅ |
| `ROUND` | ✅ | ✅ | ✅ |
| `ROUNDDOWN` | ✅ | ✅ | ✅ |
| `ROUNDUP` | ✅ | ✅ | ✅ |
| `SEARCH` | ✅ | ✅ | ✅ |
| `SUBSTITUTE` | ✅ | ✅ | ✅ |
| `SUM` | ✅ | ✅ | ✅ |
| `SUMIF` | — | ✅ | ✅ |
| `SWITCH` | ✅ | ✅ | ✅ |
| `T` | ✅ | ⏳ | ⏳ |
| `TEXTJOIN` | — | ✅ | ✅ |
| `TRIM` | ✅ | ✅ | ✅ |
| `TRUE` | ✅ | ✅ | ✅ |
| `UPPER` | ✅ | ✅ | ✅ |
| `VALUE` | ✅ | ✅ | ✅ |

Per-program differences (for example `IF` without a third argument is blank in Airtable but `FALSE` in
Sheets/Excel, and `ROUND` digits are optional only in Sheets) are documented in
[docs/behavior-notes.md](docs/behavior-notes.md).

## Limitations

- **Every rule was checked against the real programs** (Airtable, Google Sheets and Excel for the web,
  2026-10-28). See [docs/behavior-notes.md](docs/behavior-notes.md).
- Airtable: the JS target needs `fieldTypes` to tell an empty text field from an empty number field.
- References: only cells in the formula's own row, and whole columns (`A:A`, `Table1[col]`) inside `SUM`,
  `AVERAGE`, `COUNT`, `COUNTA`, `MIN`, `MAX`, `COUNTIF`, `SUMIF`. Bounded ranges (`A2:A10`), other rows,
  other sheets, whole rows and multi-column ranges are rejected with `UNSUPPORTED_REFERENCE`.
- Not yet: date/time functions, `VLOOKUP`/`XLOOKUP`/`INDEX`/`MATCH`, `ARRAYFORMULA`, `LAMBDA`, array literals,
  named ranges, omitted arguments (`IF(A1,,1)`), Airtable lookup/rollup (array) fields.
- SQL: literal `COUNTIF`/`SUMIF` criteria (`">5"`, `"a*"`) compile to plain SQL; computed ones (`">"&C2`)
  are parsed per row by PostgreSQL, which gives a much longer expression. Very large numbers can overflow `double precision` and raise a PostgreSQL error. The SQL repeats
  sub-expressions, so it grows quickly with deep nesting of error-producing expressions.
- Strings are handled as code points; Sheets counts UTF-16 units, so `LEN` of an emoji matches Sheets but
  `LEFT`/`MID` on emoji can differ.

## Contributing

```bash
npm install
npm test          # Vitest: every case runs in JS and in PGlite (PostgreSQL 17)
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
  (does not run), and add it to `docs/behavior-notes.md`. Please do not guess.
- Confirmations of unverified behaviour (screenshots or docs links) are very welcome.

## License

[MIT](LICENSE)
