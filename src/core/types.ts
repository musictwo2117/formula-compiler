export type Dialect = "airtable" | "sheets" | "excel";
export type Target = "js" | "sql" | "ast";
export type FieldType = "number" | "text" | "boolean";

export const DIALECTS: readonly Dialect[] = ["airtable", "sheets", "excel"];

export const DIALECT_NAMES: Record<Dialect, string> = {
  airtable: "Airtable",
  sheets: "Google Sheets",
  excel: "Excel",
};

export interface LocaleOptions {
  /** Separator between function arguments. Default ",". */
  argumentSeparator?: "," | ";";
  /** Decimal separator in number literals. Default ".". Requires argumentSeparator ";" when ",". */
  decimalSeparator?: "." | ",";
}

export interface CompileOptions {
  from: Dialect;
  to: Target;
  /** Sheets/Excel: map column letters to field names, e.g. { B: "income" }. */
  columnMap?: Record<string, string>;
  /** Sheets/Excel: header row number (default 1). The formula row defaults to headerRow + 1. */
  headerRow?: number;
  /** Sheets/Excel: the row the formula lives in. References must point at this row. */
  currentRow?: number;
  /** Sheets/Excel: name of the sheet the formula lives in. Needed to accept Sheet1!B2 style references. */
  sheetName?: string;
  /** Excel: name of the table for structured references (Table1[col]). Optional. */
  tableName?: string;
  /** Sheets/Excel: argument and decimal separators. */
  locale?: LocaleOptions;
  /** SQL: type of every referenced field. */
  fieldTypes?: Record<string, FieldType>;
  /** SQL: table that whole-column ranges (A:A) aggregate over. */
  table?: string;
  /** SQL: alias of the outer row in your query, used to qualify field references. Defaults to `table`. */
  tableAlias?: string;
}
