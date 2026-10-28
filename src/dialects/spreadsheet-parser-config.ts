import type { Lexer } from "../core/lexer-utils";
import type { ParserConfig } from "../core/parser";
import type { Dialect } from "../core/types";

/**
 * Sheets/Excel precedence (high → low): unary minus, %, ^, * /, + -, &,
 * comparisons. Unary minus binds tighter than ^, so -2^2 = 4.
 */
export function spreadsheetParserConfig(dialect: Dialect, lexer: Lexer): ParserConfig {
  return {
    dialect,
    lexer,
    binary: {
      "=": { bp: 1, assoc: "left", operator: "=" },
      "<>": { bp: 1, assoc: "left", operator: "<>" },
      "<": { bp: 1, assoc: "left", operator: "<" },
      ">": { bp: 1, assoc: "left", operator: ">" },
      "<=": { bp: 1, assoc: "left", operator: "<=" },
      ">=": { bp: 1, assoc: "left", operator: ">=" },
      "&": { bp: 2, assoc: "left", operator: "&" },
      "+": { bp: 3, assoc: "left", operator: "+" },
      "-": { bp: 3, assoc: "left", operator: "-" },
      "*": { bp: 4, assoc: "left", operator: "*" },
      "/": { bp: 4, assoc: "left", operator: "/" },
      "^": { bp: 5, assoc: "left", operator: "^" },
    },
    prefix: { "-": { bp: 7 }, "+": { bp: 7 } },
    percent: { bp: 6 },
    constants: { TRUE: true, FALSE: false },
    bareIdentifierHint: "Named ranges and other names are not supported; use cell references such as B2",
    operatorHints: {
      "!=": "use <> for not-equal",
      "==": "use = for comparison",
    },
    allowsOmittedArguments: true,
  };
}
