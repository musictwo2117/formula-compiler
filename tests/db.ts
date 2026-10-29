/**
 * The database the SQL tests run on: PGlite (PostgreSQL 17 in-process) by default, or a real PostgreSQL
 * server when FC_TEST_DATABASE_URL is set (CI runs the tests against several versions). Each connection
 * works in its own schema, so test files running in parallel never see each other's tables.
 */
import { PGlite } from "@electric-sql/pglite";

export interface TestDb {
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

export async function openDb(): Promise<TestDb> {
  const url = process.env.FC_TEST_DATABASE_URL;
  if (!url) {
    const db = new PGlite();
    await db.waitReady;
    return {
      exec: async (sql) => {
        await db.exec(sql);
      },
      query: (sql, params) => db.query(sql, params),
      close: () => db.close(),
    };
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const schema = `fc_test_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
  return {
    exec: async (sql) => {
      await client.query(sql);
    },
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as T[] }),
    close: async () => {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    },
  };
}
