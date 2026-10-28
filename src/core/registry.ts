import type { BoundCall, BoundNode } from "./ast";
import type { Fail } from "./errors";
import { DIALECT_NAMES, DIALECTS, type Dialect } from "./types";
import type { JsGen } from "../codegen/js";
import type { SqlGen, SqlVal } from "../codegen/sql";

/**
 * One function as implemented for one dialect. The same name can have a
 * different spec per dialect — that is where per-program behaviour lives
 * (arity, coercion, blank handling, the generated JS and SQL).
 */
export interface FunctionSpec {
  name: string;
  minArgs: number;
  maxArgs: number;
  /** Argument positions that may be whole-column ranges (A:A, Table1[col]). */
  columnArgs?: "all" | readonly number[];
  /** Argument positions that may be multi-column whole ranges (D:F), e.g. the VLOOKUP table. */
  tableArgs?: readonly number[];
  /** Argument positions that must be whole-column ranges. */
  requiredColumnArgs?: readonly number[];
  /** Extra checks on the bound arguments (e.g. IFS needs pairs). */
  validate?: (call: BoundCall, fail: Fail) => void;
  js: (call: BoundCall, g: JsGen) => string;
  sql: (call: BoundCall, g: SqlGen) => SqlVal;
  /** One line for the README table / docs. */
  summary: string;
  /** Behaviour that differs from the other programs, for docs. */
  notes?: string;
}

export type LookupResult =
  | { status: "ok"; spec: FunctionSpec }
  | { status: "unsupported"; reason: string }
  | { status: "unknown"; availableIn: Dialect[] };

export class FunctionRegistry {
  private readonly specs = new Map<string, Map<Dialect, FunctionSpec>>();
  private readonly unsupported = new Map<string, Map<Dialect, string>>();

  register(dialect: Dialect, spec: FunctionSpec): void {
    let byDialect = this.specs.get(spec.name);
    if (!byDialect) this.specs.set(spec.name, (byDialect = new Map()));
    if (byDialect.has(dialect)) throw new Error(`${spec.name} already registered for ${dialect}`);
    byDialect.set(dialect, spec);
  }

  /**
   * Record functions that exist in the source program but are not
   * implemented, so users get "not supported yet" instead of "invalid formula".
   */
  markUnsupported(dialect: Dialect, names: readonly string[], reason: string): void {
    for (const name of names) {
      let byDialect = this.unsupported.get(name);
      if (!byDialect) this.unsupported.set(name, (byDialect = new Map()));
      byDialect.set(dialect, reason);
    }
  }

  lookup(dialect: Dialect, name: string): LookupResult {
    const spec = this.specs.get(name)?.get(dialect);
    if (spec) return { status: "ok", spec };
    const reason = this.unsupported.get(name)?.get(dialect);
    if (reason !== undefined) return { status: "unsupported", reason };
    return { status: "unknown", availableIn: this.dialectsFor(name) };
  }

  dialectsFor(name: string): Dialect[] {
    const byDialect = this.specs.get(name);
    return byDialect ? DIALECTS.filter((d) => byDialect.has(d)) : [];
  }

  list(dialect: Dialect): FunctionSpec[] {
    const out: FunctionSpec[] = [];
    for (const byDialect of this.specs.values()) {
      const spec = byDialect.get(dialect);
      if (spec) out.push(spec);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  listUnsupported(dialect: Dialect): string[] {
    const out: string[] = [];
    for (const [name, byDialect] of this.unsupported) if (byDialect.has(dialect)) out.push(name);
    return out.sort();
  }

  /** name → dialects that implement it; handy for docs. */
  matrix(): { name: string; dialects: Dialect[] }[] {
    return [...this.specs.keys()].sort().map((name) => ({ name, dialects: this.dialectsFor(name) }));
  }
}

export const registry = new FunctionRegistry();

export function describeArity(spec: FunctionSpec): string {
  if (spec.minArgs === spec.maxArgs) return `${spec.minArgs} argument${spec.minArgs === 1 ? "" : "s"}`;
  if (spec.maxArgs === Infinity) return `at least ${spec.minArgs} argument${spec.minArgs === 1 ? "" : "s"}`;
  return `${spec.minArgs} to ${spec.maxArgs} arguments`;
}

export function unknownFunctionMessage(dialect: Dialect, name: string, availableIn: Dialect[]): string {
  const where = availableIn.length
    ? ` (formula-compiler supports it for ${availableIn.map((d) => DIALECT_NAMES[d]).join(", ")})`
    : "";
  return `Unknown function ${name}: not a ${DIALECT_NAMES[dialect]} function known to formula-compiler${where}`;
}

export function isColumnArg(spec: FunctionSpec, index: number): boolean {
  if (spec.columnArgs === "all") return true;
  return spec.columnArgs?.includes(index) ?? false;
}

export type { BoundNode };
