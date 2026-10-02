import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { env = await setup(); });
afterEach(async () => { await env.db.close(); });

describe("изоляция на уровне PostgreSQL (RLS)", () => {
  it("автор другого клиента не видит строки чужого клиента даже прямым SQL", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const other = await env.ctx("author2");
    for (const table of ["content_items", "content_versions", "managed_accounts", "verified_claims", "knowledge_sources", "tasks", "consents"]) {
      const n = (await other.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE client_id = $1`, [a1.client_id])).rows[0].n;
      expect(n, table).toBe(0);
    }
    const clients = (await other.db.query("SELECT name FROM clients")).rows.map((r: any) => r.name);
    expect(clients).toEqual(["Elena Petrova Consulting"]);
  });

  it("запись в чужого клиента отклоняется политикой", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const other = await env.ctx("author2");
    await expect(other.db.query("INSERT INTO tasks(client_id, account_id, type, title) VALUES ($1,$2,'x','x')", [a1.client_id, a1.id])).rejects.toThrow(/row-level security/);
  });

  it("секреты недоступны роли приложения", async () => {
    const owner = await env.ctx("owner");
    await expect(owner.db.query("SELECT * FROM encrypted_secrets")).rejects.toThrow(/permission denied/);
  });

  it("клиент видит только своего клиента", async () => {
    const client = await env.ctx("client");
    const names = (await client.db.query("SELECT name FROM clients")).rows.map((r: any) => r.name);
    expect(names).toEqual(["Northwind Robotics"]);
  });

  it("каждая таблица с client_id покрыта политикой", async () => {
    const rows = (await env.db.query(`
      SELECT c.table_name FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.column_name = 'client_id'
         AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.table_name AND p.policyname = 'tenant_isolation')`)).rows;
    expect(rows).toEqual([]);
  });
});
