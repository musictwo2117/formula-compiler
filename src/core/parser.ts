import type { BinaryOperator, ErrorCode, Node } from "./ast";
import type { Fail } from "./errors";
import type { Dialect } from "./types";
import {
  describeToken,
  type CellTokenValue,
  type Lexer,
  type RangeTokenValue,
  type StructuredTokenValue,
  type Token,
} from "./lexer-utils";

export interface BinaryOpConfig {
  /** Binding power: higher binds tighter. */
  bp: number;
  assoc: "left" | "right";
  operator: BinaryOperator;
}

/** Everything the single Pratt parser needs to know about a dialect. */
export interface ParserConfig {
  dialect: Dialect;
  lexer: Lexer;
  /** Keyed by operator token text, e.g. "!=" → "<>" for Airtable. */
  binary: Record<string, BinaryOpConfig>;
  /** Prefix operators ("-", "+") and the binding power of their operand. */
  prefix: Record<string, { bp: number }>;
  /** Postfix percent operator, if the dialect has one. */
  percent?: { bp: number };
  /** Bare identifiers that are constants, e.g. TRUE/FALSE in spreadsheets (upper-case keys). */
  constants: Record<string, boolean>;
  /** Extra hint for bare identifiers that are not constants. */
  bareIdentifierHint: string;
  /** Hints for operators that exist in other dialects but not this one, e.g. "<>" in Airtable. */
  operatorHints?: Record<string, string>;
  /** Whether omitted arguments like IF(A1,,1) are valid syntax in the source program. */
  allowsOmittedArguments: boolean;
  /** Called when a function name is read, before its arguments (to report unknown functions first). */
  onCall?: (name: string, start: number, end: number) => void;
}

export function parse(formula: string, config: ParserConfig, fail: Fail): Node {
  const tokens = config.lexer(formula, fail);
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;

  const unexpected = (t: Token, expected?: string): never => {
    const hint = t.kind === "op" ? config.operatorHints?.[t.text] : undefined;
    const msg = hint
      ? `Unexpected operator "${t.text}": ${hint}`
      : t.kind === "eof"
        ? `Unexpected end of formula${expected ? `, expected ${expected}` : ""}`
        : `Unexpected ${describeToken(t)}${expected ? `, expected ${expected}` : ""}`;
    return fail("SYNTAX", msg, t.start, Math.max(t.end, t.start + 1));
  };

  function parseExpression(minBp: number): Node {
    let left = parsePrefix();
    for (;;) {
      const t = peek();
      if (t.kind !== "op") break;
      if (t.text === "%" && config.percent) {
        if (config.percent.bp < minBp) break;
        next();
        left = { type: "Percent", operand: left, start: left.start, end: t.end };
        continue;
      }
      const op = config.binary[t.text];
      if (!op) return unexpected(t);
      if (op.bp < minBp) break;
      next();
      const right = parseExpression(op.assoc === "left" ? op.bp + 1 : op.bp);
      left = { type: "Binary", operator: op.operator, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  function parsePrefix(): Node {
    const t = next();
    switch (t.kind) {
      case "number":
        return { type: "Number", value: t.value as number, raw: t.text, start: t.start, end: t.end };
      case "string":
        return { type: "String", value: t.value as string, start: t.start, end: t.end };
      case "error":
        return { type: "Error", code: t.value as ErrorCode, start: t.start, end: t.end };
      case "field":
        return { type: "Field", name: t.value as string, start: t.start, end: t.end };
      case "cell": {
        const v = t.value as CellTokenValue;
        return { type: "Cell", ...v, start: t.start, end: t.end };
      }
      case "range": {
        const v = t.value as RangeTokenValue;
        return { type: "Range", ...v, start: t.start, end: t.end };
      }
      case "structured": {
        const v = t.value as StructuredTokenValue;
        return { type: "StructuredRef", ...v, start: t.start, end: t.end };
      }
      case "lparen": {
        const inner = parseExpression(0);
        const close = next();
        if (close.kind !== "rparen") return unexpected(close, '")"');
        return inner;
      }
      case "op": {
        const pre = config.prefix[t.text];
        if (!pre) return unexpected(t);
        const operand = parseExpression(pre.bp);
        return { type: "Unary", operator: t.text as "-" | "+", operand, start: t.start, end: operand.end };
      }
      case "ident": {
        const name = t.value as string;
        if (peek().kind === "lparen") return parseCall(t, name);
        if (name in config.constants) {
          return { type: "Boolean", value: config.constants[name]!, start: t.start, end: t.end };
        }
        return fail(
          "UNKNOWN_NAME",
          `Unknown name "${t.text}". ${config.bareIdentifierHint}`,
          t.start,
          t.end,
        );
      }
      default:
        return unexpected(t);
    }
  }

  function parseCall(nameTok: Token, name: string): Node {
    config.onCall?.(name, nameTok.start, nameTok.end);
    next(); // (
    const args: Node[] = [];
    if (peek().kind === "rparen") {
      const close = next();
      return { type: "Call", name, nameStart: nameTok.start, nameEnd: nameTok.end, args, start: nameTok.start, end: close.end };
    }
    for (;;) {
      const t = peek();
      if (t.kind === "sep" || t.kind === "rparen") {
        if (config.allowsOmittedArguments) {
          fail("UNSUPPORTED_FEATURE", `Omitted arguments in ${name}() are not supported yet; write the value explicitly`, t.start, t.end, name);
        }
        unexpected(t, "an argument");
      }
      args.push(parseExpression(0));
      const after = next();
      if (after.kind === "rparen") {
        return { type: "Call", name, nameStart: nameTok.start, nameEnd: nameTok.end, args, start: nameTok.start, end: after.end };
      }
      if (after.kind !== "sep") return unexpected(after, `an argument separator or ")" to close ${name}(`);
    }
  }

  const root = parseExpression(0);
  const rest = peek();
  if (rest.kind !== "eof") {
    if (rest.kind === "sep") {
      fail("SYNTAX", `Unexpected argument separator "${rest.text}" outside a function call`, rest.start, rest.end);
    }
    if (rest.kind === "rparen") fail("SYNTAX", 'Unmatched ")"', rest.start, rest.end);
    unexpected(rest, "end of formula");
  }
  return root;
}
