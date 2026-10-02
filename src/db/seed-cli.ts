import { migrate, openDb } from "./db";
import { seedDemo } from "./seed";

const db = await openDb();
await migrate(db);
const r = await seedDemo(db);
console.log(r.seeded ? "Демо-данные созданы" : "Данные уже есть, сид пропущен");
await db.close();
