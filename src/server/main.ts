import { migrate, openDb } from "../db/db";
import { seedDemo, ensureReferenceData } from "../db/seed";
import { buildApp } from "./app";
import { runDueJobs } from "../services/publishing";
import { DbSecretStore } from "../services/secrets";
import { DemoLinkedInAdapter, LinkedInHttpAdapter } from "../integrations/linkedin/adapter";

const prod = process.env.NODE_ENV === "production";
const authMode = (process.env.AUTH_MODE ?? (prod ? "header" : "dev")) as "dev" | "header";
if (prod && authMode === "dev") throw new Error("AUTH_MODE=dev запрещён в production");

const db = await openDb();
await migrate(db);
if (process.env.SEED_DEMO === "1" || (!prod && process.env.SEED_DEMO !== "0")) await seedDemo(db); else await ensureReferenceData(db);

const secrets = new DbSecretStore(db);
const app = buildApp({ db, secrets, authMode });

// В dev worker запускается в том же процессе (PGlite однопроцессный). В production — отдельный процесс src/worker/main.ts.
if (!prod && process.env.INLINE_WORKER !== "0") {
  const adapter = process.env.LINKEDIN_ADAPTER === "http" ? new LinkedInHttpAdapter() : new DemoLinkedInAdapter();
  setInterval(() => runDueJobs({ db, adapter, secrets, workerId: "inline-dev" }).then((r) => r.length && app.log.info({ jobs: r }, "worker pass")).catch((e) => app.log.error(e)), 10_000);
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
