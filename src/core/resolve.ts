import { isCellAddress, type BoundNode, type CellAddress, type Node, type RowSpan, type Span } from "./ast";
import type { Fail } from "./errors";
import { describeArity, isColumnArg, registry, unknownFunctionMessage, type FunctionSpec } from "./registry";
import type { CompileOptions, Dialect } from "./types";

export interface ResolveContext {
  dialect: Dialect;
  formula: string;
  options: CompileOptions;
  fail: Fail;
}

const AGGREGATE_HINT = "ranges are only supported as arguments of aggregate and lookup functions such as SUM, AVERAGE, COUNT, MIN, MAX, COUNTIF, SUMIF and VLOOKUP";

/**
 * Turns the parse tree into the bound tree: cell and structured references
 * become field names, functions are checked against the registry.
 */
export function resolve(root: Node, ctx: ResolveContext): BoundNode {
  const { dialect, options, fail } = ctx;
  const headerRow = options.headerRow ?? 1;
  const currentRow = options.currentRow ?? headerRow + 1;
  const columnMap = normalizeColumnMap(options.columnMap);

  function sheetCheck(sheet: string | undefined, span: Span): void {
    if (sheet === undefined) return;
    if (options.sheetName === undefined) {
      fail(
        "UNSUPPORTED_REFERENCE",
        `Reference to sheet "${sheet}": pass the sheetName option if this is the sheet the formula lives in; references to other sheets are not supported yet`,
        span.start,
        span.end,
      );
    }
    if (sheet.toLowerCase() !== options.sheetName!.toLowerCase()) {
      fail(
        "UNSUPPORTED_REFERENCE",
        `Reference to another sheet "${sheet}" (formula sheet is "${options.sheetName}") is not supported yet`,
        span.start,
        span.end,
      );
    }
  }

  function columnField(col: string, span: Span, display: string): string {
    if (!columnMap) {
      return fail("UNKNOWN_COLUMN", `Cell reference ${display} needs a columnMap entry for column ${col}, e.g. columnMap: { ${col}: "fieldName" }`, span.start, span.end);
    }
    const field = columnMap.get(col);
    if (field === undefined) {
      return fail("UNKNOWN_COLUMN", `Column ${col} (in ${display}) is not in columnMap`, span.start, span.end);
    }
    return field;
  }

  function cellToField(sheet: string | undefined, a: CellAddress, span: Span, display: string): BoundNode {
    sheetCheck(sheet, span);
    if (a.row !== currentRow) {
      fail(
        "UNSUPPORTED_REFERENCE",
        `Cross-row reference ${display}: only references to the formula's own row (${currentRow}) are supported in this version; set currentRow if the formula is in another row`,
        span.start,
        span.end,
      );
    }
    return { kind: "field", name: columnField(a.col, span, display), start: span.start, end: span.end };
  }

  function visit(node: Node, columnAllowed: boolean, tableAllowed = false): BoundNode {
    const span = { start: node.start, end: node.end };
    switch (node.type) {
      case "Number":
        return { kind: "number", value: node.value, ...span };
      case "String":
        return { kind: "string", value: node.value, ...span };
      case "Boolean":
        return { kind: "boolean", value: node.value, ...span };
      case "Error":
        return { kind: "error", code: node.code, ...span };
      case "Field":
        return { kind: "field", name: node.name, ...span };
      case "Cell":
        return cellToField(node.sheet, node.address, span, formulaText(node));
      case "Range": {
        const text = formulaText(node);
        sheetCheck(node.sheet, span);
        let rows: RowSpan | undefined;
        if (isCellAddress(node.from) || isCellAddress(node.to)) {
          if (!isCellAddress(node.from) || !isCellAddress(node.to)) {
            return fail("UNSUPPORTED_REFERENCE", `Range ${text}: open-ended ranges are not supported yet; use whole columns (A:A) or both rows (A2:A10)`, node.start, node.end);
          }
          const [top, bottom] = [node.from.row, node.to.row].sort((x, y) => x - y) as [number, number];
          if (top <= headerRow) {
            return fail(
              "UNSUPPORTED_REFERENCE",
              `Range ${text} includes the header row (${headerRow}); start it at row ${headerRow + 1}, or set headerRow`,
              node.start,
              node.end,
            );
          }
          rows = { first: top - headerRow - 1, count: bottom - top + 1 };
        }
        if (node.from.col !== node.to.col) {
          if (!tableAllowed) {
            return fail("UNSUPPORTED_REFERENCE", `Range ${text} spans several columns; multi-column ranges are only supported as the table of VLOOKUP / INDEX`, node.start, node.end);
          }
          const [a, b] = [colNumber(node.from.col), colNumber(node.to.col)].sort((x, y) => x - y) as [number, number];
          const names: string[] = [];
          for (let c = a; c <= b; c++) names.push(columnField(colLetters(c), span, text));
          return rows ? { kind: "table", names, rows, ...span } : { kind: "table", names, ...span };
        }
        if (!columnAllowed) return fail("UNSUPPORTED_REFERENCE", `Range ${text}: ${AGGREGATE_HINT}`, node.start, node.end);
        const name = columnField(node.from.col, span, text);
        return rows ? { kind: "column", name, rows, ...span } : { kind: "column", name, ...span };
      }
      case "StructuredRef": {
        const text = formulaText(node);
        if (node.table !== undefined && options.tableName !== undefined && node.table.toLowerCase() !== options.tableName.toLowerCase()) {
          return fail("UNSUPPORTED_REFERENCE", `Reference to table "${node.table}" (formula table is "${options.tableName}") is not supported`, node.start, node.end);
        }
        if (node.thisRow) return { kind: "field", name: node.column, ...span };
        if (!columnAllowed) return fail("UNSUPPORTED_REFERENCE", `Structured reference ${text} means the whole column; ${AGGREGATE_HINT}. Use [@${node.column}] for the current row`, node.start, node.end);
        return { kind: "column", name: node.column, ...span };
      }
      case "Unary":
        return { kind: "unary", operator: node.operator, operand: visit(node.operand, false), ...span };
      case "Percent":
        return { kind: "percent", operand: visit(node.operand, false), ...span };
      case "Binary":
        return { kind: "binary", operator: node.operator, left: visit(node.left, false), right: visit(node.right, false), ...span };
      case "Call": {
        const spec = lookupFunction(dialect, node.name, node.nameStart, node.nameEnd, fail);
        const n = node.args.length;
        if (n < spec.minArgs || n > spec.maxArgs) {
          return fail("ARITY", `${node.name} expects ${describeArity(spec)} but got ${n}`, node.start, node.end, node.name);
        }
        const args = node.args.map((a, i) => visit(a, isColumnArg(spec, i), spec.tableArgs?.includes(i) ?? false));
        for (const i of spec.requiredColumnArgs ?? []) {
          const a = args[i];
          if (a && a.kind !== "column" && a.kind !== "table") {
            fail("INVALID_ARGUMENT", `Argument ${i + 1} of ${node.name} must be a range (e.g. A:A or A2:A10) in this version`, a.start, a.end, node.name);
          }
        }
        const call = { kind: "call" as const, name: node.name, args, ...span };
        spec.validate?.(call, fail);
        return call;
      }
    }
  }

  function formulaText(node: Span): string {
    return ctx.formula.slice(node.start, node.end);
  }

  return visit(root, false);
}

/** The registry entry for a function, or a clear "unknown" / "not supported yet" error. */
export function lookupFunction(dialect: Dialect, name: string, start: number, end: number, fail: Fail): FunctionSpec {
  const found = registry.lookup(dialect, name);
  if (found.status === "unknown") return fail("UNKNOWN_FUNCTION", unknownFunctionMessage(dialect, name, found.availableIn), start, end, name);
  if (found.status === "unsupported") return fail("UNSUPPORTED_FUNCTION", `Function ${name} is not supported yet (${found.reason})`, start, end, name);
  return found.spec;
}

function normalizeColumnMap(map: Record<string, string> | undefined): Map<string, string> | undefined {
  if (!map) return undefined;
  const out = new Map<string, string>();
  for (const [col, field] of Object.entries(map)) out.set(col.replace(/\$/g, "").toUpperCase(), field);
  return out;
}

function colNumber(col: string): number {
  let n = 0;
  for (const c of col) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

function colLetters(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
