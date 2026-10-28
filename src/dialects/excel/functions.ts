/**
 * Excel function table: the shared spreadsheet functions with Excel's
 * variant rules (required ROUND digits, SEARCH wildcards, 0^0 = #NUM!).
 */
import { registerSpreadsheetFunctions } from "../spreadsheet-functions";

registerSpreadsheetFunctions("excel");
