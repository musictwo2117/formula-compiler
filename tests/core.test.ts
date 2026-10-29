import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile, FormulaCompileError, parseFormula, registry } from "../src/index";
import { quoteIdent, quoteText } from "../src/codegen/sql";

function compileError(fn: () => unknown): FormulaCompileError {
  try {
    fn();
  } catch (e) {
    if (e instanceof FormulaCompileError) return e;
    throw e;
  }
  throw new Error("expected a FormulaCompileError");
}

describe("parser", () => {
  it("builds one shared AST with positions for every dialect", () => {
    const air = parseFormula("IF({a} > 1, 'x')", { from: "airtable" });
    const xl = parseFormula("=IF(B2 > 1, \"x\")", { from: "excel" });
    expect(air.type).toBe("Call");
    expect(xl.type).toBe("Call");
    if (air.type !== "Call" || xl.type !== "Call") return;
    expect(air.args[0]).toMatchObject({ type: "Binary", operator: ">", start: 3, end: 10, left: { type: "Field", name: "a", start: 3, end: 6 } });
    expect(xl.args[0]).toMatchObject({ type: "Binary", operator: ">", start: 4, end: 10, left: { type: "Cell", address: { col: "B", row: 2 } } });
  });

  it("normalises != to <>", () => {
    expect(parseFormula("{a} != 1", { from: "airtable" })).toMatchObject({ type: "Binary", operator: "<>" });
  });

  it("parses references", () => {
    expect(parseFormula("='My Sheet'!$A$1:B$10", { from: "sheets" })).toMatchObject({
      type: "Range",
      sheet: "My Sheet",
      from: { col: "A", row: 1, colAbsolute: true, rowAbsolute: true },
      to: { col: "B", row: 10, colAbsolute: false, rowAbsolute: true },
    });
    expect(parseFormula("=Table1[[#This Row],[Net Pay]]", { from: "excel" })).toMatchObject({ type: "StructuredRef", table: "Table1", column: "Net Pay", thisRow: true });
    expect(parseFormula("=[@[odd']name]]", { from: "excel" })).toMatchObject({ type: "StructuredRef", column: "odd]name", thisRow: true });
  });

  it("does not mistake function names for cell references", () => {
    // LOG10 is a valid column+row (LOG10) but followed by "(" it is a function call.
    const e = compileError(() => parseFormula("=LOG10(1)", { from: "excel" }));
    expect(e).toMatchObject({ code: "UNSUPPORTED_FUNCTION", functionName: "LOG10" });
    expect(parseFormula("=LEN(1)", { from: "excel" })).toMatchObject({ type: "Call", name: "LEN" });
  });

  it("returns the AST from compile(..., to: 'ast')", () => {
    const r = compile("=B2+1", { from: "excel", to: "ast", columnMap: { B: "x" } });
    expect(r.ast).toMatchObject({ type: "Binary", operator: "+" });
  });
});

describe("errors", () => {
  it("carries code, position, function name and program name", () => {
    const e = compileError(() => compile("=1 + OFFSET(B2, C:D, 2)", { from: "excel", to: "js" }));
    expect(e.code).toBe("UNSUPPORTED_FUNCTION");
    expect(e.functionName).toBe("OFFSET");
    expect(e.dialect).toBe("excel");
    expect([e.start, e.end]).toEqual([5, 11]);
    expect(e.message).toMatch(/^\[Excel\] Function OFFSET is not supported yet/);
    expect(e.pointer()).toBe("=1 + OFFSET(B2, C:D, 2)\n     ^^^^^^");
  });

  it("separates 'not supported yet' from 'not a function'", () => {
    expect(compileError(() => compile("=XMATCH(1,2,3)", { from: "sheets", to: "js" })).code).toBe("UNSUPPORTED_FUNCTION");
    const unknown = compileError(() => compile("=ISERRORX(1)", { from: "sheets", to: "js" }));
    expect(unknown.code).toBe("UNKNOWN_FUNCTION");
    expect(unknown.message).toContain("Google Sheets");
  });

  it("points at the other programs that have a function", () => {
    const e = compileError(() => compile("IFERROR(1, 2)", { from: "airtable", to: "js" }));
    expect(e.message).toContain("Google Sheets, Excel");
  });

  it("asks for field types on the SQL target", () => {
    const e = compileError(() => compile("{a} + 1", { from: "airtable", to: "sql" }));
    expect(e.code).toBe("MISSING_FIELD_TYPE");
    expect([e.start, e.end]).toEqual([0, 3]);
  });

  it("asks for the table name for whole-column ranges in SQL", () => {
    const e = compileError(() => compile("=SUM(B:B)", { from: "excel", to: "sql", columnMap: { B: "x" }, fieldTypes: { x: "number" } }));
    expect(e.code).toBe("INVALID_OPTION");
  });

  it("validates options", () => {
    expect(compileError(() => compile("=1", { from: "excel", to: "js", locale: { decimalSeparator: "," } })).code).toBe("INVALID_OPTION");
    expect(() => compile("1", { from: "lotus" as never, to: "js" })).toThrow(/Unknown source program/);
  });

  it("names the supported lookups when a lookup function is not supported", () => {
    const e = compileError(() => compile("=1 + OFFSET(B2, C:D, 2)", { from: "excel", to: "js" }));
    expect(e.code).toBe("UNSUPPORTED_FUNCTION");
    expect(e.message).toBe("[Excel] Function OFFSET is not supported yet (supported lookup functions: VLOOKUP, XLOOKUP, MATCH, INDEX) (at position 6-11)");
  });

  it("reports a bad timeZone or now as INVALID_OPTION, not RangeError", () => {
    for (const to of ["js", "sql"] as const) {
      const e = compileError(() => compile("=TODAY()", { from: "sheets", to, timeZone: "Asia/Bangkokk" }));
      expect(e.code).toBe("INVALID_OPTION");
      expect(e.reason).toMatch(/Asia\/Bangkokk/);
      expect(compileError(() => compile("=NOW()", { from: "excel", to, now: "not a date" })).code).toBe("INVALID_OPTION");
    }
    expect(compile("=TODAY()", { from: "sheets", to: "sql", timeZone: "Asia/Bangkok", now: new Date("2024-01-15T20:00:00Z") }).sql).toBe("floor(45307.125::float8)");
  });
});

describe("Date field values", () => {
  const savedTz = process.env.TZ;
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("reads a Date in local time, like date text", () => {
    const f = compile("=B2", { from: "excel", to: "js", columnMap: { B: "d" }, fieldTypes: { d: "date" } });
    const day = compile("=DAY(B2)", { from: "excel", to: "js", columnMap: { B: "d" }, fieldTypes: { d: "date" } });
    for (const tz of ["Asia/Bangkok", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = tz;
      expect(f.evaluate({ d: new Date(2024, 0, 15, 10, 30) })).toBe(f.evaluate({ d: "2024-01-15T10:30" }));
      expect(day.evaluate({ d: new Date(2024, 0, 15) })).toBe(15);
    }
  });

  it("keeps years before 100 (they were read as 1900-1999)", () => {
    const d = new Date(2024, 0, 15);
    d.setFullYear(50);
    const f = compile("=B2", { from: "sheets", to: "js", columnMap: { B: "d" }, fieldTypes: { d: "date" } });
    const serial = -675682; // 0050-01-15, as PostgreSQL's timestamp gives it
    expect(f.evaluate({ d })).toBe(serial);
    expect(f.evaluate({ d: "0050-01-15" })).toBe(serial);
  });
});

describe("security", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
  });
  afterAll(async () => {
    await db.close();
  });

  const nasty = ['"]); throw new Error("pwned"); (["', "`${process.exit(1)}`", "a b", "x' OR 1=1 --", 'a"b'];

  it("reads fields through record[...] with the name as an escaped string literal", () => {
    for (const name of nasty) {
      const escaped = name.replace(/\\/g, "\\\\").replace(/}/g, "\\}");
      const r = compile(`{${escaped}} & "!"`, { from: "airtable", to: "js" });
      expect(r.code).toContain(`record[rt.key(record, ${JSON.stringify(name).replace(" ", "\\u2028")})]`);
      expect(r.evaluate({ [name]: "ok" })).toBe("ok!");
    }
  });

  it("never emits raw string literals into JS", () => {
    const r = compile('"); globalThis.hacked = true; ("', { from: "airtable", to: "js" });
    r.evaluate({});
    expect((globalThis as Record<string, unknown>).hacked).toBeUndefined();
  });

  it("quotes SQL identifiers and text", async () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteText("it's")).toBe("'it''s'");
    expect(quoteText("back\\slash'")).toBe("E'back\\\\slash'''");
    const field = 'x"; DROP TABLE t; --';
    const r = compile(`{${field}} & ' \\\\ it\\'s'`, { from: "airtable", to: "sql", fieldTypes: { [field]: "text" } });
    await db.exec(`CREATE TABLE t (${quoteIdent(field)} text)`);
    await db.query(`INSERT INTO t VALUES ($1)`, ["v"]);
    const res = await db.query<{ v: string }>(`SELECT ${r.sql} AS v FROM t`);
    expect(res.rows[0]!.v).toBe("v \\ it's");
    const still = await db.query("SELECT count(*)::int AS n FROM t");
    expect(still.rows[0]).toEqual({ n: 1 });
  });
});

describe("registry", () => {
  it("knows which programs implement each function", () => {
    expect(registry.dialectsFor("IFERROR")).toEqual(["sheets", "excel"]);
    expect(registry.dialectsFor("SWITCH")).toEqual(["airtable", "sheets", "excel"]);
    expect(registry.dialectsFor("BLANK")).toEqual(["airtable"]);
  });

  it("has different specs per program", () => {
    const sheets = registry.lookup("sheets", "ROUND");
    const excel = registry.lookup("excel", "ROUND");
    expect(sheets.status === "ok" && sheets.spec.minArgs).toBe(1);
    expect(excel.status === "ok" && excel.spec.minArgs).toBe(2);
  });
});

describe("SQL lookups", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    // Stored out of order: the orderBy field, not the physical order, decides row 1, 2, 3.
    await db.exec(`CREATE TABLE "fruit" ("n" int, "name" text, "price" float8);
      INSERT INTO "fruit" VALUES (3, 'cherry', 30), (1, 'apple', 10), (2, 'Apple', 20);
      CREATE INDEX ON "fruit" ("price"); ANALYZE "fruit"`);
  });
  afterAll(async () => {
    await db?.close();
  });

  const options = {
    from: "excel" as const,
    table: "fruit",
    orderBy: "n",
    columnMap: { A: "n", B: "name", C: "price" },
    fieldTypes: { n: "number", name: "text", price: "number" } as const,
  };
  const rows = [{ n: 1, name: "apple", price: 10 }, { n: 2, name: "Apple", price: 20 }, { n: 3, name: "cherry", price: 30 }];

  it.each([
    ["=VLOOKUP(\"APPLE\",B:C,2,FALSE)", 10],
    ["=XLOOKUP(\"apple\",B:B,C:C,\"none\",0,-1)", 20],
    ["=MATCH(30,C:C,0)", 4],
    ["=INDEX(B:B,3)", "Apple"],
    ["=INDEX(B:B,MATCH(25,C:C,1))", "Apple"],
  ])("%s follows orderBy in SQL and ctx.rows in JS", async (formula, expected) => {
    expect(compile(formula, { ...options, to: "js" }).evaluate(rows[0]!, { rows })).toBe(expected);
    const sql = compile(formula, { ...options, to: "sql" });
    const res = await db.query<{ v: unknown; e: string | null }>(`SELECT ${sql.sql} AS v, ${sql.errorSql} AS e FROM "fruit" WHERE "n" = 1`);
    expect(res.rows[0]).toEqual({ v: expected, e: null });
  });

  it("does not renumber the table for every row", () => {
    // A window per outer row made lookups quadratic; plain comparisons also let PostgreSQL use an index.
    const sql = compile("=VLOOKUP(C2,C:C,1,FALSE)", { ...options, to: "sql" });
    expect(sql.sql + sql.errorSql).not.toMatch(/row_number|OVER \(/);
    expect(sql.sql).toContain(`"__fc_r"."price" = `);
  });

  it("uses an index on the lookup column", async () => {
    const sql = compile("=VLOOKUP(C2,C:C,1,FALSE)", { ...options, to: "sql" });
    await db.exec("SET enable_seqscan = off");
    const plan = await db.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT ${sql.sql} FROM "fruit"`);
    await db.exec("RESET enable_seqscan");
    expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/Index (Only )?Scan using fruit_price_idx/);
  });
});

describe("SQL size of date functions", () => {
  // Nested date functions used to repeat their arguments in every branch: EDATE(EDATE(A2,1),1) was
  // 4.4 million characters for Excel. These limits keep the growth in check.
  const size = (from: "excel" | "sheets", formula: string) => {
    const out = compile(formula, { from, to: "sql", columnMap: { A: "d", B: "e" }, fieldTypes: { d: "number", e: "number" } });
    return out.sql.length + out.errorSql.length;
  };
  const nested = (depth: number) => "=" + Array.from({ length: depth }).reduce<string>((f) => `EDATE(${f},1)`, "A2");

  it.each(["excel", "sheets"] as const)("each %s date function on fields stays under 8,000 characters", (from) => {
    for (const f of ["DATE(A2,B2,1)", "TIME(A2,B2,0)", "YEAR(A2)", "MONTH(A2)", "DAY(A2)", "HOUR(A2)", "MINUTE(A2)", "SECOND(A2)",
      "WEEKDAY(A2,B2)", "EDATE(A2,B2)", "EOMONTH(A2,B2)", "DAYS(A2,B2)", "DATEDIF(A2,B2,\"M\")"]) {
      expect(size(from, "=" + f), f).toBeLessThan(8_000);
    }
  });

  it.each(["excel", "sheets"] as const)("nesting %s date functions does not multiply the SQL", (from) => {
    expect(size(from, nested(2))).toBeLessThan(20_000);
    expect(size(from, nested(8))).toBeLessThan(200_000);
    // Doubling the depth may at most about quadruple the size (the error SQL re-checks each value).
    expect(size(from, nested(8)) / size(from, nested(4))).toBeLessThan(4.5);
    expect(size(from, "=DATEDIF(A2,EDATE(A2,12),\"M\")")).toBeLessThan(20_000);
  });

  it.each(["excel", "sheets"] as const)("runs deeply nested %s date SQL in PostgreSQL", async (from) => {
    // Short SQL is not enough: if PostgreSQL flattened the bindings back, the plan itself would
    // blow up (depth 3 ran out of memory before bindings got OFFSET 0).
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE "t" ("d" float8); INSERT INTO "t" VALUES (45000)`);
      const formula = nested(8);
      const js = compile(formula, { from, to: "js", columnMap: { A: "d" } }).evaluate({ d: 45000 });
      const sql = compile(formula, { from, to: "sql", columnMap: { A: "d", B: "e" }, fieldTypes: { d: "number", e: "number" } });
      const res = await db.query<{ v: number; e: string | null }>(`SELECT ${sql.sql} AS v, ${sql.errorSql} AS e FROM "t"`);
      expect(res.rows[0]).toEqual({ v: js, e: null });
      expect(js).toBe(45245);
    } finally {
      await db.close();
    }
  });

  it("computes date calls with literal arguments at compile time", () => {
    expect(compile("=EDATE(DATE(2024,1,31),1)", { from: "excel", to: "sql" }).sql).toBe("45351::float8");
    expect(compile("=DATE(9999,12,32)", { from: "excel", to: "sql" }).errorSql).toBe("'#NUM!'");
    expect(compile("=DATE(9999,12,32)", { from: "sheets", to: "sql" }).sql).toBe("2958466::float8");
  });
});
