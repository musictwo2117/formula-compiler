import type { LocaleOptions } from "../../core/types";
import { createSpreadsheetLexer } from "../spreadsheet-lexer";

/** Excel: A1 references, 'Sheet name'!A1, A:A, Table1[col], [@col]; "" escapes inside strings. */
export const excelLexer = (locale?: LocaleOptions) => createSpreadsheetLexer({ structuredRefs: true, ...(locale ? { locale } : {}) });
