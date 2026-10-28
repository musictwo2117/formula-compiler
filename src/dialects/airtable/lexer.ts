import type { Fail } from "../../core/errors";
import { isDigit, isIdentStart, isSpace, readIdent, readNumber, readOperator, type Token } from "../../core/lexer-utils";

const OPERATORS = ["!=", "<=", ">=", "<>", "=", "<", ">", "+", "-", "*", "/", "&", "^", "%"] as const;

/**
 * Airtable: {Field name} with \} and \\ escapes, "..." or '...' strings with
 * backslash escapes, != for not-equal, & for concatenation.
 */
export function lexAirtable(src: string, fail: Fail): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const start = i;
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === "{") {
      let name = "";
      i++;
      for (;;) {
        if (i >= src.length) fail("SYNTAX", 'Unclosed field reference: missing "}"', start, src.length);
        const c = src[i]!;
        if (c === "\\" && (src[i + 1] === "}" || src[i + 1] === "\\")) {
          name += src[i + 1];
          i += 2;
          continue;
        }
        if (c === "}") break;
        name += c;
        i++;
      }
      i++;
      if (name.trim() === "") fail("SYNTAX", "Empty field name {}", start, i);
      tokens.push({ kind: "field", text: src.slice(start, i), start, end: i, value: name });
      continue;
    }
    if (ch === '"' || ch === "'") {
      let value = "";
      i++;
      for (;;) {
        if (i >= src.length) fail("SYNTAX", `Unclosed string: missing ${ch}`, start, src.length);
        const c = src[i]!;
        if (c === "\\" && i + 1 < src.length) {
          const e = src[i + 1]!;
          value += e === "n" ? "\n" : e === "t" ? "\t" : e;
          i += 2;
          continue;
        }
        if (c === ch) break;
        value += c;
        i++;
      }
      i++;
      tokens.push({ kind: "string", text: src.slice(start, i), start, end: i, value });
      continue;
    }
    if (isDigit(ch) || (ch === "." && isDigit(src[i + 1]))) {
      const num = readNumber(src, i, ".")!;
      i = num.end;
      tokens.push({ kind: "number", text: src.slice(start, i), start, end: i, value: num.value });
      continue;
    }
    if (isIdentStart(ch)) {
      i = readIdent(src, i);
      const text = src.slice(start, i);
      tokens.push({ kind: "ident", text, start, end: i, value: text.toUpperCase() });
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen", text: ch, start, end: ++i });
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", text: ch, start, end: ++i });
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "sep", text: ch, start, end: ++i });
      continue;
    }
    const op = readOperator(src, i, OPERATORS);
    if (op) {
      i += op.length;
      tokens.push({ kind: "op", text: op, start, end: i });
      continue;
    }
    fail("SYNTAX", `Unexpected character "${ch}"`, start, start + 1);
  }
  tokens.push({ kind: "eof", text: "", start: src.length, end: src.length });
  return tokens;
}
