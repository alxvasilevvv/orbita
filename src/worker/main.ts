/**
 * Отдельный процесс исполнителя (production, PostgreSQL). Несколько экземпляров безопасны:
 * захват задания — атомарный UPDATE ... WHERE status = 'queued'.
 */
import { hostname } from "node:os";
import { openDb } from "../db/db";
import { runDueJobs } from "../services/publishing";
import { DbSecretStore } from "../services/secrets";
import { DemoLinkedInAdapter, LinkedInHttpAdapter } from "../integrations/linkedin/adapter";

const db = await openDb();
const adapter = process.env.LINKEDIN_ADAPTER === "http" ? new LinkedInHttpAdapter() : new DemoLinkedInAdapter();
// Тот же интерфейс SecretStore можно заменить адаптером Vault / AWS Secrets Manager.
const secrets = new DbSecretStore(db);
const workerId = `${hostname()}:${process.pid}`;
const interval = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });

while (!stopping) {
  try {
    const r = await runDueJobs({ db, adapter, secrets, workerId, memberDailyLimit: Number(process.env.MEMBER_DAILY_REQUEST_BUDGET ?? 100), apiVersion: process.env.LINKEDIN_API_VERSION });
    if (r.length) console.log(JSON.stringify({ msg: "worker pass", results: r }));
  } catch (e: any) {
    console.error(JSON.stringify({ msg: "worker error", error: e.message }));
  }
  await new Promise((res) => setTimeout(res, interval));
}
await db.close();
