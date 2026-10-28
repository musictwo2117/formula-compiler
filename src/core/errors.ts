import { DIALECT_NAMES, type Dialect } from "./types";

export type CompileErrorCode =
  /** The formula is not valid syntax for the source program. */
  | "SYNTAX"
  /** The name is not a function of the source program (as far as formula-compiler knows). */
  | "UNKNOWN_FUNCTION"
  /** The function exists in the source program but formula-compiler does not support it yet. */
  | "UNSUPPORTED_FUNCTION"
  /** Wrong number of arguments. */
  | "ARITY"
  /** An argument has a shape the function cannot accept (e.g. a range where a value is needed). */
  | "INVALID_ARGUMENT"
  /** A valid reference that this version cannot translate (cross-row, other sheet, bounded range...). */
  | "UNSUPPORTED_REFERENCE"
  /** A valid feature that this version cannot translate (omitted arguments, array literals...). */
  | "UNSUPPORTED_FEATURE"
  /** A bare identifier that is not a function or a known constant (named range?). */
  | "UNKNOWN_NAME"
  /** A cell reference whose column is not in columnMap. */
  | "UNKNOWN_COLUMN"
  /** The formula is fine but cannot be expressed in SQL by this version. */
  | "UNSUPPORTED_IN_SQL"
  /** SQL target needs the type of a field. */
  | "MISSING_FIELD_TYPE"
  /** Bad compile options. */
  | "INVALID_OPTION";

export interface CompileErrorInit {
  code: CompileErrorCode;
  dialect: Dialect;
  formula: string;
  start: number;
  end: number;
  message: string;
  functionName?: string;
}

/**
 * Thrown for every problem found while compiling. Positions are 0-based
 * offsets into the original formula string (end is exclusive).
 */
export class FormulaCompileError extends Error {
  readonly code: CompileErrorCode;
  readonly dialect: Dialect;
  readonly dialectName: string;
  readonly formula: string;
  readonly start: number;
  readonly end: number;
  readonly functionName: string | undefined;
  /** The message without the "[Excel] ... at position" decoration. */
  readonly reason: string;

  constructor(init: CompileErrorInit) {
    const name = DIALECT_NAMES[init.dialect];
    const pos = init.end - init.start > 1 ? `${init.start + 1}-${init.end}` : `${init.start + 1}`;
    super(`[${name}] ${init.message} (at position ${pos})`);
    this.name = "FormulaCompileError";
    this.code = init.code;
    this.dialect = init.dialect;
    this.dialectName = name;
    this.formula = init.formula;
    this.start = init.start;
    this.end = init.end;
    this.functionName = init.functionName;
    this.reason = init.message;
  }

  /** The formula with a caret line under the offending part. */
  pointer(): string {
    const width = Math.max(1, this.end - this.start);
    return `${this.formula}\n${" ".repeat(this.start)}${"^".repeat(width)}`;
  }

  toJSON() {
    return {
      code: this.code,
      dialect: this.dialect,
      message: this.message,
      start: this.start,
      end: this.end,
      functionName: this.functionName,
    };
  }
}

export type Fail = (
  code: CompileErrorCode,
  message: string,
  start: number,
  end: number,
  functionName?: string,
) => never;

export function makeFail(dialect: Dialect, formula: string): Fail {
  return (code, message, start, end, functionName) => {
    const init: CompileErrorInit = { code, dialect, formula, start, end, message };
    if (functionName !== undefined) init.functionName = functionName;
    throw new FormulaCompileError(init);
  };
}
