import { createPgliteDb, migrate, type Db } from "../src/db/db";
import { seedDemo } from "../src/db/seed";
import { loadActor, type Ctx } from "../src/services/context";
import { MemorySecretStore } from "../src/services/publishing";
import { DemoLinkedInAdapter } from "../src/integrations/linkedin/adapter";

export async function setup() {
  const db: Db = await createPgliteDb();
  await migrate(db);
  const seed: any = await seedDemo(db);
  const u = seed.users as Record<string, string>;
  const ctx = async (key: string): Promise<Ctx> => ({ db, actor: (await loadActor(db, u[key]))! });
  const acct = async (name: string) => (await db.query("SELECT id, client_id FROM managed_accounts WHERE display_name = $1", [name])).rows[0] as { id: string; client_id: string };
  const secrets = new MemorySecretStore();
  const adapter = new DemoLinkedInAdapter();
  return { db, u, ctx, acct, secrets, adapter };
}

export const APPROVED = "Share on LinkedIn,Sign In with LinkedIn using OpenID Connect";
