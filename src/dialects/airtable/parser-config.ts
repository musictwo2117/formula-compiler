import type { ParserConfig } from "../../core/parser";
import { lexAirtable } from "./lexer";

/**
 * Precedence (high → low): unary -, * /, then + - & on one level (left to
 * right), then comparisons. Checked against Airtable: "x" & 1 + 2 is NaN,
 * 2 + 3 & "x" is "5x", "x" & 1 * 2 is "x2".
 */
export const airtableParserConfig: ParserConfig = {
  dialect: "airtable",
  lexer: lexAirtable,
  binary: {
    "=": { bp: 1, assoc: "left", operator: "=" },
    "!=": { bp: 1, assoc: "left", operator: "<>" },
    "<": { bp: 1, assoc: "left", operator: "<" },
    ">": { bp: 1, assoc: "left", operator: ">" },
    "<=": { bp: 1, assoc: "left", operator: "<=" },
    ">=": { bp: 1, assoc: "left", operator: ">=" },
    "&": { bp: 3, assoc: "left", operator: "&" },
    "+": { bp: 3, assoc: "left", operator: "+" },
    "-": { bp: 3, assoc: "left", operator: "-" },
    "*": { bp: 4, assoc: "left", operator: "*" },
    "/": { bp: 4, assoc: "left", operator: "/" },
  },
  prefix: { "-": { bp: 6 } },
  constants: {},
  bareIdentifierHint: "",
  bareIdentifiersAreFields: true,
  operatorHints: {
    "<>": "Airtable uses != for not-equal",
    "^": "Airtable has no ^ operator (POWER() is not supported yet)",
    "%": "Airtable has no % operator; divide by 100",
  },
  allowsOmittedArguments: false,
};
