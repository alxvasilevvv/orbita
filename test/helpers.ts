import { createPgliteDb, createPgDb, migrate, type Db } from "../src/db/db";
import { randomBytes } from "node:crypto";
import { seedDemo } from "../src/db/seed";
import { actorCtx, loadActor, type Ctx } from "../src/services/context";
import { MemorySecretStore } from "../src/services/publishing";
import { DemoLinkedInAdapter } from "../src/integrations/linkedin/adapter";
import { DemoXAdapter } from "../src/integrations/x/adapter";

/** По умолчанию PGlite; с TEST_PG_ADMIN_URL каждый тест получает отдельную базу настоящего PostgreSQL. */
async function freshDb(): Promise<Db> {
  const admin = process.env.TEST_PG_ADMIN_URL;
  if (!admin) return createPgliteDb();
  const { default: pg } = await import("pg");
  const name = `t_${randomBytes(6).toString("hex")}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect(); await c.query(`CREATE DATABASE ${name}`); await c.end();
  const url = new URL(admin); url.pathname = `/${name}`;
  const db = await createPgDb(url.toString());
  const close = db.close;
  db.close = async () => {
    await close();
    const d = new pg.Client({ connectionString: admin });
    await d.connect(); await d.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await d.end();
  };
  return db;
}

export async function setup() {
  const db: Db = await freshDb();
  await migrate(db);
  const seed: any = await seedDemo(db);
  const u = seed.users as Record<string, string>;
  const ctx = async (key: string): Promise<Ctx> => actorCtx(db, (await loadActor(db, u[key]))!);
  const acct = async (name: string) => (await db.query("SELECT id, client_id FROM managed_accounts WHERE display_name = $1", [name])).rows[0] as { id: string; client_id: string };
  const secrets = new MemorySecretStore();
  const adapter = new DemoLinkedInAdapter();
  const xAdapter = new DemoXAdapter();
  return { db, u, ctx, acct, secrets, adapter, xAdapter };
}

export const APPROVED = "Share on LinkedIn,Sign In with LinkedIn using OpenID Connect";
