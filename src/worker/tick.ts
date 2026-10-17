import type { Db } from "../db/db";
import type { SocialAdapter } from "../integrations/linkedin/adapter";
import type { SecretStore } from "../services/publishing";
import { runDueJobs, resolveUnknownDue } from "../services/publishing";
import { processOutbox, runScans } from "../services/events";
import { deliverPending, type Mailer } from "../services/notify";
import type { Storage } from "../services/storage";
import { processExports } from "../services/exports";

export interface WorkerContext {
  db: Db;
  adapter: SocialAdapter;
  secrets: SecretStore;
  storage: Storage;
  mailer: Mailer;
  workerId: string;
  memberDailyLimit?: number;
  apiVersion?: string;
  extraTasks?: ((now: Date) => Promise<unknown>)[];
}

let lastScan = 0;

/** Один проход фоновой обработки. Каждая подсистема изолирована: сбой одной не останавливает другие. */
export async function workerTick(w: WorkerContext, now = new Date()) {
  const report: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { report[name] = await fn(); } catch (e: any) { report[name] = { error: e.message }; }
  };
  await step("publishing", () => runDueJobs({ db: w.db, adapter: w.adapter, secrets: w.secrets, storage: w.storage, workerId: w.workerId, memberDailyLimit: w.memberDailyLimit, apiVersion: w.apiVersion, now: () => now }));
  if (now.getTime() - lastScan > 60_000) {
    lastScan = now.getTime();
    await step("scans", () => runScans(w.db, now));
    await step("resolve_unknown", () => resolveUnknownDue({ db: w.db, adapter: w.adapter, secrets: w.secrets }, now));
    for (const [i, t] of (w.extraTasks ?? []).entries()) await step(`task_${i}`, () => t(now));
  }
  await step("exports", () => processExports(w.db, w.storage));
  await step("outbox", () => processOutbox(w.db));
  await step("delivery", () => deliverPending(w.db, w.mailer));
  return report;
}
