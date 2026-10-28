/**
 * Runs a JSON case file through both targets: the compiled JS function and
 * the compiled SQL on PGlite. Every runnable case must give the expected
 * value in JS and exactly the same value in SQL.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile, FormulaCompileError, isError, type CompileOptions, type Dialect, type FieldType } from "../src/index";
import { quoteIdent } from "../src/codegen/sql";

export interface TestCase {
  name?: string;
  formula: string;
  record?: Record<string, unknown>;
  /** All rows of the table (for A:A ranges); the current record is rows[row ?? 0]. */
  rows?: Record<string, unknown>[];
  row?: number;
  columnMap?: Record<string, string>;
  types?: Record<string, FieldType>;
  options?: Partial<CompileOptions>;
  /** Fixed "now" for TODAY()/NOW(), given to both JS (ctx.now) and SQL (options.now). */
  now?: string;
  expected?: unknown;
  error?: { code: string; functionName?: string; start?: number; end?: number };
  /** Behaviour we could not confirm against the real program: not run. */
  todo?: string;
  /** Runs (checks our behaviour and JS/SQL parity) but needs confirming against the real program. */
  unverified?: string;
  /** The case is valid but the SQL target refuses it (with UNSUPPORTED_IN_SQL). */
  sqlUnsupported?: string;
}

const pgType: Record<FieldType, string> = { number: "double precision", text: "text", boolean: "boolean", date: "timestamp" };

function inferTypes(rows: Record<string, unknown>[], explicit: Record<string, FieldType> = {}): Record<string, FieldType> {
  const out: Record<string, FieldType> = { ...explicit };
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (out[k] || v === null || v === undefined) continue;
      out[k] = typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "text";
    }
  }
  for (const row of rows) for (const k of Object.keys(row)) if (!out[k]) throw new Error(`field "${k}" is always null: add it to "types"`);
  return out;
}

/** Errors as { error }, Infinity / NaN as { specialValue } (the Airtable API's shape). */
function normalize(v: unknown): unknown {
  if (isError(v)) return { error: v.code };
  if (typeof v === "number" && !Number.isFinite(v)) return { specialValue: String(v) };
  return v;
}

function caseName(c: TestCase, i: number): string {
  return `#${i + 1} ${c.name ? `${c.name}: ` : ""}${c.formula}`;
}

export function runCases(dialect: Dialect, cases: TestCase[]): void {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterAll(async () => {
    await db?.close();
  });

  describe(`${dialect} cases`, () => {
    it("has at least 40 cases", () => {
      expect(cases.length).toBeGreaterThanOrEqual(40);
    });

    cases.forEach((c, i) => {
      const name = caseName(c, i);
      if (c.todo) {
        it.todo(`${name} — ${c.todo}`);
        return;
      }
      if (c.unverified) it.todo(`verify against ${dialect}: ${c.formula} — ${c.unverified}`);

      const rows = c.rows ?? [c.record ?? {}];
      const current = rows[c.row ?? 0]!;
      const fieldTypes = inferTypes(rows, c.types);
      const table = `ตาราง ทดสอบ ${i}`;
      const base: Omit<CompileOptions, "to"> = { from: dialect, fieldTypes, table, ...c.options };
      if (c.columnMap) base.columnMap = c.columnMap;
      if (c.now) base.now = c.now;

      if (c.error) {
        const want = c.error;
        it(`${name} → ${want.code}`, () => {
          for (const to of ["js", "sql", "ast"] as const) {
            let thrown: unknown;
            try {
              compile(c.formula, { ...base, to });
            } catch (e) {
              thrown = e;
            }
            expect(thrown, `target ${to}`).toBeInstanceOf(FormulaCompileError);
            const err = thrown as FormulaCompileError;
            expect(err.code).toBe(want.code);
            expect(err.dialect).toBe(dialect);
            if (want.functionName !== undefined) expect(err.functionName).toBe(want.functionName);
            if (want.start !== undefined) expect(err.start).toBe(want.start);
            if (want.end !== undefined) expect(err.end).toBe(want.end);
          }
        });
        return;
      }

      it(`${c.unverified ? "[unverified] " : ""}${name}`, async () => {
        const js = compile(c.formula, { ...base, to: "js" });
        const jsValue = normalize(js.evaluate(current, c.now ? { rows, now: c.now } : { rows }));
        expect(jsValue, "JS result").toEqual(c.expected);

        if (c.sqlUnsupported) {
          expect(() => compile(c.formula, { ...base, to: "sql" })).toThrow(FormulaCompileError);
          try {
            compile(c.formula, { ...base, to: "sql" });
          } catch (e) {
            expect((e as FormulaCompileError).code).toBe("UNSUPPORTED_IN_SQL");
          }
          return;
        }

        const sql = compile(c.formula, { ...base, to: "sql" });
        const cols = Object.entries(fieldTypes);
        const t = quoteIdent(table);
        await db.exec(`CREATE TABLE ${t} ("__id" int${cols.map(([k, ty]) => `, ${quoteIdent(k)} ${pgType[ty]}`).join("")})`);
        try {
          for (const [idx, row] of rows.entries()) {
            const names = ["__id", ...cols.map(([k]) => k)];
            const params = [idx, ...cols.map(([k]) => row[k] ?? null)];
            await db.query(`INSERT INTO ${t} (${names.map(quoteIdent).join(", ")}) VALUES (${params.map((_, j) => `$${j + 1}`).join(", ")})`, params);
          }
          const res = await db.query<{ value: unknown; error: string | null }>(
            `SELECT ${sql.sql} AS value, ${sql.errorSql} AS error FROM ${t} WHERE "__id" = ${c.row ?? 0}`,
          );
          const r = res.rows[0]!;
          const sqlValue = r.error !== null ? { error: r.error } : normalize(r.value);
          expect(sqlValue, `SQL result\n${sql.sql}\nerror: ${sql.errorSql}`).toEqual(jsValue);
        } finally {
          await db.exec(`DROP TABLE ${t}`);
        }
      });
    });
  });
}
