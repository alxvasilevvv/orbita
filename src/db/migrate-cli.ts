import { migrate, openDb } from "./db";
import { ensureReferenceData } from "./seed";

const db = await openDb();
const applied = await migrate(db);
await ensureReferenceData(db);
console.log(applied.length ? `Применены миграции: ${applied.join(", ")}` : "Схема актуальна");
await db.close();
