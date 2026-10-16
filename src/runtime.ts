import type { Db } from "./db/db";
import { DbSecretStore } from "./services/secrets";
import { storageFromEnv, type Storage } from "./services/storage";
import { mailerFromEnv, type Mailer } from "./services/notify";
import { scannerFromEnv, type MalwareScanner } from "./services/media";
import { aiProviderFromEnv, agentProviderFromEnv } from "./ai/providers";
import { imageProviderFromEnv, type ImageProvider } from "./integrations/images";
import { telegramFromEnv, type TelegramClient } from "./integrations/telegram";
import { autopilotTick } from "./agents/autopilot";
import { xAdapterFromEnv, type XSocialAdapter } from "./integrations/x/adapter";
import { billingTick, paymentsFromEnv, type PaymentProvider } from "./services/billing";
import { draftOutreach } from "./services/outreach";
import type { AiProvider } from "./ai/guard";
import { DemoLinkedInAdapter, LinkedInHttpAdapter, type SocialAdapter } from "./integrations/linkedin/adapter";
import type { WorkerContext } from "./worker/tick";
import { dailyRetention } from "./services/lifecycle";
import { weeklyAnalysisAll } from "./services/insights";
import { b2bTick } from "./agents/orchestrator";

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
  agentAi: AiProvider;
  images: ImageProvider;
  telegram: TelegramClient;
  payments: PaymentProvider;
  xAdapter: XSocialAdapter;
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
    agentAi: agentProviderFromEnv(env),
    images: imageProviderFromEnv(env),
    telegram: telegramFromEnv(env),
    payments: paymentsFromEnv(env),
    xAdapter: xAdapterFromEnv(env),
  };
}

export function workerContext(rt: Runtime, workerId: string, env = process.env): WorkerContext {
  return {
    db: rt.db, adapter: rt.adapter, secrets: rt.secrets, storage: rt.storage, mailer: rt.mailer, workerId,
    memberDailyLimit: Number(env.MEMBER_DAILY_REQUEST_BUDGET ?? 100), apiVersion: env.LINKEDIN_API_VERSION,
    extraTasks: [
      (now) => dailyRetention(rt.db, rt.storage, now),
      (now) => weeklyAnalysisAll(rt.db, now),
      // Агенты B2B: истечение, исполнение одобренных действий через API, планирование миссий, директор, отчётчик.
      (now) => b2bTick({ db: rt.db, adapter: rt.adapter, secrets: rt.secrets, ai: rt.ai, apiVersion: env.LINKEDIN_API_VERSION }, now),
      // Автопилот сотрудников: план недели, новости компании, черновики, окно отмены, публикация, портреты, Telegram.
      (now) => autopilotTick({ db: rt.db, ai: rt.ai, agentAi: rt.agentAi, images: rt.images, telegram: rt.telegram, storage: rt.storage,
        appUrl: env.APP_URL, callbackSecret: env.TELEGRAM_CALLBACK_SECRET, disabled: env.AUTOPILOT_DISABLED === "1",
        xAdapter: rt.xAdapter, secrets: rt.secrets }, now),
      (now) => billingTick(rt.db, now),
      (now) => draftOutreach(rt.db, now),
    ],
  };
}
