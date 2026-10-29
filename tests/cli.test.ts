import { describe, expect, it } from "vitest";
import { run } from "../src/cli";

function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("cli", () => {
  it("compiles Excel to SQL with typed columns", () => {
    const r = cli('=IF(AND(B2>30000, C2<60), "ผ่าน", "ไม่ผ่าน")', "--from", "excel", "--to", "sql", "--columns", "B=income:number,C=age:number");
    expect(r.code).toBe(0);
    expect(r.out).toContain('COALESCE("income", 0::float8) > 30000::float8');
  });

  it("explains missing SQL types instead of guessing", () => {
    const r = cli("=B2+1", "--from", "excel", "--to", "sql", "--columns", "B=income");
    expect(r.code).toBe(1);
    expect(r.err).toContain("needs the type");
    expect(r.err).toContain("--types");
  });

  it("evaluates JS against a record", () => {
    const r = cli("IF({Age} < 60, 'yes')", "--from", "airtable", "--eval", '{"Age": 70}');
    expect(r).toMatchObject({ code: 0, out: "null" });
  });

  it("prints errors with a pointer", () => {
    const r = cli("=SUM(1;2)", "--from", "sheets");
    expect(r.code).toBe(1);
    expect(r.err).toContain("^");
  });

  it("passes the table, row order and time zone to SQL", () => {
    const r = cli("=SUM(B2:B10)", "--from", "sheets", "--to", "sql", "--columns", "B=sales:number", "--table", "orders", "--order-by", "id");
    expect(r.code).toBe(0);
    expect(r.out).toContain('FROM "orders" AS "__fc_r" WHERE "__fc_r"."id" <=');
    const t = cli("=TODAY()", "--from", "excel", "--to", "sql", "--time-zone", "Asia/Bangkok", "--now", "2026-10-29T00:00:00Z");
    expect(t.out).toContain("46324");
    expect(cli("=TODAY()", "--from", "excel", "--time-zone", "Asia/Bangkok", "--now", "2026-10-29T00:00:00Z", "--eval", "{}").out).toBe("46324");
  });

  it("supports the ; locale", () => {
    const r = cli("=ROUND(2,5;0)", "--from", "excel", "--separator", ";", "--decimal", ",", "--eval", "{}");
    expect(r.out).toBe("3");
  });

  it("rejects bad usage", () => {
    expect(cli("=1").code).toBe(2);
    expect(cli("=1", "--from", "excel", "--types", "x=datetime").code).toBe(2);
  });
});
