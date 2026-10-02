import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Транзакция с преамбулой без параметров, отправленной вместе с BEGIN одним обращением к базе. */
  txWith?<T>(prelude: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** PGlite: настоящий PostgreSQL в WASM для разработки и тестов. */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  await pg.exec("SET TIME ZONE 'UTC'");
  // PGlite однопоточен: сериализуем транзакции через очередь.
  let chain: Promise<unknown> = Promise.resolve();
  const db: Db = {
    query: (sql, params) => pg.query(sql, params as any[]) as any,
    tx: (fn) => {
      const run = chain.then(() => pg.transaction((t) => fn({ query: (s, p) => t.query(s, p as any[]) as any })));
      chain = run.catch(() => undefined);
      return run;
    },
    txWith: (prelude, fn) => {
      const run = chain.then(() => pg.transaction(async (t) => { await t.exec(prelude); return fn({ query: (s, p) => t.query(s, p as any[]) as any }); }));
      chain = run.catch(() => undefined);
      return run;
    },
    close: () => pg.close(),
  };
  return db;
}

/** Продакшн: пул node-postgres по DATABASE_URL. */
export async function createPgDb(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 30), options: "-c TimeZone=UTC" });
  return {
    query: (sql, params) => pool.query(sql, params as any[]) as any,
    async txWith(prelude, fn) {
      const c = await pool.connect();
      try {
        await c.query(`BEGIN; ${prelude}`);
        const r = await fn({ query: (s, p) => c.query(s, p as any[]) as any });
        await c.query("COMMIT");
        return r;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const r = await fn({ query: (s, p) => c.query(s, p as any[]) as any });
        await c.query("COMMIT");
        return r;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url && !url.startsWith("pglite:")) return createPgDb(url);
  const dir = url?.slice("pglite:".length) || process.env.PGLITE_DIR || "./data/pglite";
  return createPgliteDb(dir === "memory" ? undefined : dir);
}

const here = dirname(fileURLToPath(import.meta.url));
export async function migrate(db: Db): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const dir = join(here, "../../migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = (await readFile(join(dir, f), "utf8")).replace(/CREATE TABLE schema_migrations[^;]*;/, "");
    await db.tx(async (q) => {
      for (const stmt of splitSql(sql)) await q.query(stmt);
      await q.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
    });
    applied.push(f);
  }
  // Политики RLS пересчитываются после каждой миграции: новые таблицы сразу изолированы.
  const hasRls = (await db.query("SELECT 1 FROM pg_proc WHERE proname = 'apply_rls'")).rows.length;
  if (hasRls) await db.query("SELECT apply_rls()");
  return applied;
}

/** Делит SQL на операторы с учётом $$-блоков, строк и комментариев. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let dollar: string | null = null;
  let quote = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (!dollar && !quote && ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (!quote && ch === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        if (dollar === null) dollar = m[0];
        else if (dollar === m[0]) dollar = null;
        cur += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (!dollar && ch === "'") quote = !quote;
    if (!dollar && !quote && ch === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
