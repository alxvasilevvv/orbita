import type { Db } from "./db/db";
import { DbSecretStore } from "./services/secrets";
import { storageFromEnv, type Storage } from "./services/storage";
import { mailerFromEnv, type Mailer } from "./services/notify";
import { scannerFromEnv, type MalwareScanner } from "./services/media";
import { aiProviderFromEnv } from "./ai/providers";
import type { AiProvider } from "./ai/guard";
import { DemoLinkedInAdapter, LinkedInHttpAdapter, type SocialAdapter } from "./integrations/linkedin/adapter";
import type { WorkerContext } from "./worker/tick";
import { dailyRetention } from "./services/lifecycle";
import { weeklyAnalysisAll } from "./services/insights";

export interface SecretStoreFull { get(ref: string): Promise<string | null>; set(ref: string, v: string): Promise<unknown> | unknown; delete(ref: string): Promise<void> }

/** Общие зависимости API и исполнителя, собранные из окружения. */
export interface Runtime {
  db: Db;
  secrets: SecretStoreFull;
  storage: Storage;
  mailer: Mailer;
  scanner: MalwareScanner;
  ai: AiProvider;
  adapter: SocialAdapter;
}

export function createRuntime(db: Db, env = process.env): Runtime {
  return {
    db,
    secrets: new DbSecretStore(db),
    storage: storageFromEnv(env),
    mailer: mailerFromEnv(env),
    scanner: scannerFromEnv(env),
    ai: aiProviderFromEnv(env),
    adapter: env.LINKEDIN_ADAPTER === "http" ? new LinkedInHttpAdapter() : new DemoLinkedInAdapter(),
  };
}

export function workerContext(rt: Runtime, workerId: string, env = process.env): WorkerContext {
  return {
    db: rt.db, adapter: rt.adapter, secrets: rt.secrets, storage: rt.storage, mailer: rt.mailer, workerId,
    memberDailyLimit: Number(env.MEMBER_DAILY_REQUEST_BUDGET ?? 100), apiVersion: env.LINKEDIN_API_VERSION,
    extraTasks: [
      (now) => dailyRetention(rt.db, rt.storage, now),
      (now) => weeklyAnalysisAll(rt.db, now),
    ],
  };
}
