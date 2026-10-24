import { migrate, openDb } from "../db/db";
import { seedDemo, ensureReferenceData } from "../db/seed";
import { buildApp } from "./app";
import { createRuntime, workerContext } from "../runtime";
import { workerTick } from "../worker/tick";

const prod = process.env.NODE_ENV === "production";
const authMode = (process.env.AUTH_MODE ?? (prod ? "session" : "dev")) as "dev" | "header" | "session";
if (prod && authMode === "dev") throw new Error("AUTH_MODE=dev запрещён в production");
if (prod && !process.env.SECRETS_KEY) throw new Error("SECRETS_KEY обязателен в production");

const db = await openDb();
await migrate(db);
if (process.env.SEED_DEMO === "1" || (!prod && process.env.SEED_DEMO !== "0")) await seedDemo(db, { x: true }); else await ensureReferenceData(db);

const rt = createRuntime(db);
const app = buildApp({ ...rt, authMode });

// В dev исполнитель работает в том же процессе. В production его можно включить тем же способом (INLINE_WORKER=1)
// для одноконтейнерного деплоя, либо вынести в отдельный процесс src/worker/main.ts.
if (process.env.INLINE_WORKER === "1" || (!prod && process.env.INLINE_WORKER !== "0")) {
  const wctx = workerContext(rt, "inline-dev");
  setInterval(() => { workerTick(wctx).catch((e) => app.log.error(e)); }, Number(process.env.WORKER_INTERVAL_MS ?? 10_000));
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
