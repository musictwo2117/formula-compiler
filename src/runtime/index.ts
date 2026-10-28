import type { Dialect } from "../core/types";
import { airtableRuntime } from "./airtable";
import { createSpreadsheetRuntime } from "./spreadsheet";

export * from "./common";
export { airtableRuntime } from "./airtable";
export { createSpreadsheetRuntime, parseCriterion, matchesCriterion } from "./spreadsheet";

const runtimes: Partial<Record<Dialect, object>> = {
  airtable: airtableRuntime,
  excel: createSpreadsheetRuntime("excel"),
  sheets: createSpreadsheetRuntime("sheets"),
};

export function registerRuntime(dialect: Dialect, rt: object): void {
  runtimes[dialect] = rt;
}

/** The `rt` object generated JS expects for a dialect. */
export function runtimeFor(dialect: Dialect): object {
  const rt = runtimes[dialect];
  if (!rt) throw new TypeError(`No runtime for ${dialect}`);
  return rt;
}
