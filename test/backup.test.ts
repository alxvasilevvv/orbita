import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteDb, migrate } from "../src/db/db";
import { seedDemo } from "../src/db/seed";
import { actorCtx, loadActor } from "../src/services/context";
import * as acc from "../src/services/accounts";

/**
 * Учения по восстановлению: снимок базы → восстановление в новый экземпляр →
 * проверка данных, политик изоляции и работы приложения. В production то же делает scripts/restore-drill.sh для PostgreSQL.
 */
describe("резервная копия и восстановление", () => {
  it("снимок восстанавливается полностью, изоляция и сценарии работают", async () => {
    const src = new PGlite();
    const db = await createPgliteDbFrom(src);
    await migrate(db);
    const seed: any = await seedDemo(db);
    const counts = async (q: { query: any }) => Object.fromEntries(await Promise.all(["clients", "managed_accounts", "content_items", "content_versions", "audit_events", "workflow_definitions", "memberships"].map(async (t) => [t, (await q.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n])));
    const before = await counts(db);
    const dump = await src.dumpDataDir("none");

    const restoredPg = new PGlite({ loadDataDir: dump });
    const restored = await createPgliteDbFrom(restoredPg);
    expect(await counts(restored)).toEqual(before);
    // Миграции идемпотентны после восстановления
    expect(await migrate(restored)).toEqual([]);
    // RLS работает в восстановленной базе
    const other = actorCtx(restored, (await loadActor(restored, seed.users.author2))!);
    const visible = (await other.db.query("SELECT name FROM clients")).rows.map((r: any) => r.name);
    expect(visible).toEqual(["Elena Petrova Consulting"]);
    // Приложение работает
    const mgr = actorCtx(restored, (await loadActor(restored, seed.users.manager))!);
    expect((await acc.listAccounts(mgr)).length).toBe(3);
    await db.close(); await restored.close();
  }, 120000);
});

async function createPgliteDbFrom(pg: PGlite) {
  // Обёртка того же вида, что createPgliteDb, но над готовым экземпляром.
  await pg.waitReady;
  await pg.exec("SET TIME ZONE 'UTC'");
  let chain: Promise<unknown> = Promise.resolve();
  return {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params as any[]) as any,
    tx: <T>(fn: (q: any) => Promise<T>) => { const run = chain.then(() => pg.transaction((t) => fn({ query: (s: string, p?: unknown[]) => t.query(s, p as any[]) }))); chain = run.catch(() => undefined); return run as Promise<T>; },
    close: () => pg.close(),
  };
}
void createPgliteDb;
