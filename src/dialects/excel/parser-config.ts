import type { ParserConfig } from "../../core/parser";
import type { LocaleOptions } from "../../core/types";
import { spreadsheetParserConfig } from "../spreadsheet-parser-config";
import { excelLexer } from "./lexer";

export const excelParserConfig = (locale?: LocaleOptions): ParserConfig => spreadsheetParserConfig("excel", excelLexer(locale));
