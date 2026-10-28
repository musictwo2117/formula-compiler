import type { ParserConfig } from "../../core/parser";
import { lexAirtable } from "./lexer";

/**
 * Precedence (high → low): unary -, * /, + -, &, comparisons.
 * Airtable does not document its precedence table; see docs/behavior-notes.md.
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
    "&": { bp: 2, assoc: "left", operator: "&" },
    "+": { bp: 3, assoc: "left", operator: "+" },
    "-": { bp: 3, assoc: "left", operator: "-" },
    "*": { bp: 4, assoc: "left", operator: "*" },
    "/": { bp: 4, assoc: "left", operator: "/" },
  },
  prefix: { "-": { bp: 6 } },
  constants: {},
  bareIdentifierHint: "Wrap field names in braces, e.g. {Name}; use TRUE() / FALSE() for booleans",
  operatorHints: {
    "<>": "Airtable uses != for not-equal",
    "^": "Airtable has no ^ operator (POWER() is not supported yet)",
    "%": "Airtable has no % operator; divide by 100",
  },
  allowsOmittedArguments: false,
};
