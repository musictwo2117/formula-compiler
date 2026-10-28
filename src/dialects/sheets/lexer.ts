import type { LocaleOptions } from "../../core/types";
import { createSpreadsheetLexer } from "../spreadsheet-lexer";

/** Google Sheets: like Excel but without structured (table) references. */
export const sheetsLexer = (locale?: LocaleOptions) => createSpreadsheetLexer({ structuredRefs: false, ...(locale ? { locale } : {}) });
