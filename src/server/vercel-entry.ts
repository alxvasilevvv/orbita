// Serverless-обёртка Orbita для Vercel. Один процесс: PGlite в памяти, демо-данные,
// демо-вход. Фоновый воркер не крутится (serverless), витрина читает засеянное состояние.
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// Демо-режим: dev-адаптеры, разрешён dev-вход, база в памяти.
process.env.NODE_ENV = "development";
process.env.AUTH_MODE = "dev";
process.env.DATABASE_URL ||= "pglite:memory";
process.env.ORBITA_MIGRATIONS_DIR ||= join(process.cwd(), "migrations");
process.env.ORBITA_PUBLIC_DIR ||= join(process.cwd(), "public");

import { migrate, openDb } from "../db/db";
import { seedDemo } from "../db/seed";
import { buildApp } from "./app";
import { createRuntime } from "../runtime";

let ready: Promise<ReturnType<typeof buildApp>> | null = null;
function getApp() {
  if (!ready) {
    ready = (async () => {
      const db = await openDb();
      await migrate(db);
      await seedDemo(db, { x: true });
      const rt = createRuntime(db);
      const app = buildApp({ ...rt, authMode: "dev" });
      await app.ready();
      return app;
    })();
  }
  return ready;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  app.server.emit("request", req, res);
}
