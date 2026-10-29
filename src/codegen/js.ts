/**
 * JavaScript code generation. The output is the source of a function
 * `(record, rt, ctx) => value`, where `rt` is the dialect runtime from
 * src/runtime. Fields are always read as record["name"] with the name as a
 * JSON-escaped string literal, so field names can never inject code.
 */
import type { BoundCall, BoundNode } from "../core/ast";
import { registry } from "../core/registry";
import type { CompileOptions, Dialect, FieldType } from "../core/types";
import { matchFieldName } from "../runtime/common";

export function jsString(s: string): string {
  // U+2028/U+2029 are valid in JSON but were line terminators in older JS.
  return JSON.stringify(s).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

const BINARY: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "div", "^": "pow", "&": "concat" };

export class JsGen {
  readonly fieldTypes: Record<string, FieldType>;
  readonly timeZone: string;

  constructor(
    readonly dialect: Dialect,
    readonly options: Pick<CompileOptions, "fieldTypes" | "timeZone" | "headerRow"> = {},
  ) {
    this.fieldTypes = options.fieldTypes ?? {};
    this.timeZone = options.timeZone ?? "UTC";
  }

  expr(n: BoundNode): string {
    switch (n.kind) {
      case "number":
        if (!Number.isFinite(n.value)) throw new Error(`internal: non-finite literal ${n.value}`);
        return String(n.value);
      case "string":
        return jsString(n.value);
      case "boolean":
        return n.value ? "true" : "false";
      case "error":
        return `rt.err(${jsString(n.code)})`;
      case "field": {
        if (this.dialect === "airtable") {
          // Airtable field names are case-insensitive: resolve against fieldTypes, then the record's keys.
          const name = matchFieldName(n.name, Object.keys(this.fieldTypes));
          const key = `record[rt.key(record, ${jsString(name)})]`;
          const type = this.fieldTypes[name];
          return type ? `rt.f(${key}, ${jsString(name)}, ${jsString(type)})` : `rt.v(${key}, ${jsString(name)})`;
        }
        if (this.fieldTypes[n.name] === "date") return `rt.date(record[${jsString(n.name)}], ${jsString(n.name)})`;
        return `rt.v(record[${jsString(n.name)}], ${jsString(n.name)})`;
      }
      case "table": {
        const types = n.names.map((name) => (this.fieldTypes[name] ? jsString(this.fieldTypes[name]!) : "undefined"));
        const rows = n.rows ? `, ${n.rows.first}, ${n.rows.count}` : "";
        return `rt.table(ctx, [${n.names.map(jsString).join(", ")}], [${types.join(", ")}]${rows})`;
      }
      case "column": {
        const type = this.fieldTypes[n.name] === "date" ? `"date"` : "undefined";
        if (n.rows) return `rt.col(ctx, ${jsString(n.name)}, ${type}, ${n.rows.first}, ${n.rows.count})`;
        return type === "undefined" ? `rt.col(ctx, ${jsString(n.name)})` : `rt.col(ctx, ${jsString(n.name)}, ${type})`;
      }
      case "unary":
        return `rt.${n.operator === "-" ? "neg" : "pos"}(${this.expr(n.operand)})`;
      case "percent":
        return `rt.percent(${this.expr(n.operand)})`;
      case "binary": {
        const fn = BINARY[n.operator];
        if (fn) return `rt.${fn}(${this.expr(n.left)}, ${this.expr(n.right)})`;
        return `rt.cmp(${jsString(n.operator)}, ${this.expr(n.left)}, ${this.expr(n.right)})`;
      }
      case "call": {
        const found = registry.lookup(this.dialect, n.name);
        if (found.status !== "ok") throw new Error(`internal: unresolved function ${n.name}`);
        return found.spec.js(n as BoundCall, this);
      }
    }
  }

  /** A thunk, for arguments that must only be evaluated when needed (IF branches). */
  lazy(n: BoundNode): string {
    return `() => ${this.expr(n)}`;
  }

  /** Argument of an aggregate: references keep "reference" semantics (text ignored...). */
  refArg(n: BoundNode): string {
    if (n.kind === "field") return `rt.ref(${this.expr(n)})`;
    return this.expr(n);
  }

  call(name: string, args: string[]): string {
    return `rt.${name}(${args.join(", ")})`;
  }
}

/** Default JS for a function: rt.NAME(arg1, arg2, ...). */
export function eagerJs(call: BoundCall, g: JsGen): string {
  return g.call(call.name, call.args.map((a) => g.expr(a)));
}

export function generateJs(root: BoundNode, dialect: Dialect, options: Pick<CompileOptions, "fieldTypes" | "timeZone" | "headerRow"> = {}): string {
  let body = new JsGen(dialect, options).expr(root);
  if (isTopLevelSearch(root, dialect)) body = `rt.searchResult(${body})`;
  return `(record, rt, ctx) => rt.result(${body})`;
}

/** Airtable shows a not-found SEARCH as empty when it is the whole formula. */
export function isTopLevelSearch(root: BoundNode, dialect: Dialect): boolean {
  return dialect === "airtable" && root.kind === "call" && root.name === "SEARCH";
}
