import type { ParserConfig } from "../../core/parser";
import type { LocaleOptions } from "../../core/types";
import { spreadsheetParserConfig } from "../spreadsheet-parser-config";
import { sheetsLexer } from "./lexer";

export const sheetsParserConfig = (locale?: LocaleOptions): ParserConfig => spreadsheetParserConfig("sheets", sheetsLexer(locale));
