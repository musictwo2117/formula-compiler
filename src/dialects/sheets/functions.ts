/**
 * Google Sheets function table: the shared spreadsheet functions with the
 * Sheets variant rules (optional ROUND places, SEARCH without wildcards,
 * 0^0 = 1, an empty referenced cell stays empty as a result).
 */
import { registerSpreadsheetFunctions } from "../spreadsheet-functions";

registerSpreadsheetFunctions("sheets");
