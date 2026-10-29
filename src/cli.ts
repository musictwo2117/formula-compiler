import { parseArgs } from "node:util";
import { compile, FormulaCompileError, isError, type CompileOptions, type Dialect, type FieldType, type Target } from "./index";

const HELP = `Usage: formula-compiler "<formula>" --from <airtable|sheets|excel> --to <js|sql|ast> [options]

Options:
  --from <program>        Source program: airtable, sheets or excel (required)
  --to <target>           js, sql or ast (default: js)
  --columns <map>         Column letters to field names, optionally typed:
                          B=income,C=age  or  B=income:number,C=name:text
  --types <map>           Field types for SQL: income=number,name=text,ok=boolean
  --table <name>          SQL table for ranges (A:A, A2:A10) and lookups
  --order-by <field>      SQL field that gives the row order (unique, not null);
                          needed by bounded ranges (A2:A10) and lookups
  --table-alias <name>    SQL alias of the outer row (default: the table)
  --time-zone <zone>      IANA time zone for TODAY() / NOW() (default UTC)
  --now <iso>             Fixed "now" for TODAY() / NOW() (SQL; JS --eval too)
  --sheet <name>          Name of the sheet the formula is on
  --header-row <n>        Header row (default 1); formula row defaults to n + 1
  --current-row <n>       Row the formula is on
  --separator <, or ;>    Argument separator (Sheets/Excel)
  --decimal <. or ,>      Decimal separator (Sheets/Excel)
  --eval <json>           With --to js: evaluate against this record, e.g. '{"income":40000}'
  --json                  Print the full result as JSON
  -h, --help              Show this help

Examples:
  formula-compiler "=IF(B2>30000, \\"ok\\", \\"no\\")" --from excel --to sql --columns B=income:number
  formula-compiler "IF({Age} < 60, 'yes')" --from airtable --to js --eval '{"Age": 30}'
  formula-compiler "=SUM(B2:B10)" --from sheets --to sql --columns B=sales:number --table orders --order-by id
`;

const FIELD_TYPES: readonly FieldType[] = ["number", "text", "boolean", "date"];

function parsePairs(s: string, flag: string): [string, string][] {
  return s.split(",").filter(Boolean).map((pair) => {
    const i = pair.indexOf("=");
    if (i <= 0) throw new UsageError(`${flag}: expected key=value, got "${pair}"`);
    return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
  });
}

function fieldType(t: string, flag: string): FieldType {
  if (!FIELD_TYPES.includes(t as FieldType)) throw new UsageError(`${flag}: type must be number, text, boolean or date (got "${t}")`);
  return t as FieldType;
}

class UsageError extends Error {}

function positiveInt(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} must be a whole number`);
  return n;
}

export function run(argv: string[], out: (s: string) => void, err: (s: string) => void): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        from: { type: "string" },
        to: { type: "string", default: "js" },
        columns: { type: "string" },
        types: { type: "string" },
        table: { type: "string" },
        "order-by": { type: "string" },
        "table-alias": { type: "string" },
        "time-zone": { type: "string" },
        now: { type: "string" },
        sheet: { type: "string" },
        "header-row": { type: "string" },
        "current-row": { type: "string" },
        separator: { type: "string" },
        decimal: { type: "string" },
        eval: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    err(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    out(HELP);
    return 0;
  }
  try {
    if (positionals.length !== 1) throw new UsageError("Pass exactly one formula (quote it)");
    if (!v.from) throw new UsageError("--from is required");
    const formula = positionals[0]!;
    const options: CompileOptions = { from: v.from as Dialect, to: v.to as Target };
    const fieldTypes: Record<string, FieldType> = {};
    if (v.columns) {
      options.columnMap = {};
      for (const [col, target] of parsePairs(v.columns, "--columns")) {
        const [name, type] = target.split(":") as [string, string | undefined];
        options.columnMap[col] = name;
        if (type) fieldTypes[name] = fieldType(type, "--columns");
      }
    }
    if (v.types) for (const [name, type] of parsePairs(v.types, "--types")) fieldTypes[name] = fieldType(type, "--types");
    if (Object.keys(fieldTypes).length) options.fieldTypes = fieldTypes;
    if (v.table) options.table = v.table;
    if (v["order-by"]) options.orderBy = v["order-by"];
    if (v["table-alias"]) options.tableAlias = v["table-alias"];
    if (v["time-zone"]) options.timeZone = v["time-zone"];
    if (v.now) options.now = v.now;
    if (v.sheet) options.sheetName = v.sheet;
    const headerRow = positiveInt(v["header-row"], "--header-row");
    const currentRow = positiveInt(v["current-row"], "--current-row");
    if (headerRow !== undefined) options.headerRow = headerRow;
    if (currentRow !== undefined) options.currentRow = currentRow;
    if (v.separator || v.decimal) {
      options.locale = {};
      if (v.separator) options.locale.argumentSeparator = v.separator as ";";
      if (v.decimal) options.locale.decimalSeparator = v.decimal as ",";
    }

    const result = compile(formula, options);
    if (result.target === "ast") {
      out(JSON.stringify(result.ast, null, 2));
    } else if (result.target === "js") {
      if (v.eval !== undefined) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(v.eval) as Record<string, unknown>;
        } catch {
          throw new UsageError("--eval must be a JSON object");
        }
        const value = result.evaluate(record, v.now ? { now: v.now } : undefined);
        out(JSON.stringify(isError(value) ? { error: value.code } : value));
      } else {
        out(v.json ? JSON.stringify({ code: result.code }, null, 2) : result.code);
      }
    } else if (v.json) {
      out(JSON.stringify({ sql: result.sql, errorSql: result.errorSql, type: result.type, sqlType: result.sqlType }, null, 2));
    } else {
      out(`-- value (${result.sqlType ?? "always blank"})\n${result.sql}\n-- error code (NULL when no error)\n${result.errorSql}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof FormulaCompileError) {
      err(`${e.message}\n${e.pointer()}`);
      if (e.code === "MISSING_FIELD_TYPE") err("Hint: give types with --types name=number or --columns B=name:number");
      return 1;
    }
    if (e instanceof UsageError || e instanceof TypeError) {
      err(`${e.message}\n\nRun with --help for usage.`);
      return 2;
    }
    throw e;
  }
}

if (typeof require !== "undefined" && require.main === module) {
  process.exitCode = run(process.argv.slice(2), (s) => console.log(s), (s) => console.error(s));
}
