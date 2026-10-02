/**
 * Отдельный процесс исполнителя (production, PostgreSQL). Несколько экземпляров безопасны:
 * захват задания — атомарный UPDATE ... WHERE status = 'queued', события помечаются обработанными.
 */
import { hostname } from "node:os";
import { openDb } from "../db/db";
import { createRuntime, workerContext } from "../runtime";
import { workerTick } from "./tick";

const db = await openDb();
const rt = createRuntime(db);
const ctx = workerContext(rt, `${hostname()}:${process.pid}`);
const interval = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

while (!stopping) {
  const report = await workerTick(ctx);
  if (Object.values(report).some((v) => v && (typeof v !== "number" || v > 0) && !(Array.isArray(v) && !v.length))) console.log(JSON.stringify({ msg: "worker tick", report }));
  await new Promise((res) => setTimeout(res, interval));
}
await db.close();
