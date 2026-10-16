/**
 * Проверка полноты перевода: собирает русские строки интерфейса и строки сервера,
 * которые интерфейс показывает через t(), и сообщает, каких нет в словаре.
 * Запуск: npx tsx scripts/i18n-check.ts [--json]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EN } from "../src/ui/en";

const CYR = /[А-Яа-яЁё]/;
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f) && !f.endsWith("en.ts") && !f.endsWith("i18n.ts")) files.push(p); } };
walk("src/ui");
// Строки, приходящие с сервера и переводимые в интерфейсе.
const serverFiles = ["src/agents/officer.ts", "src/agents/orchestrator.ts", "src/services/company.ts", "src/services/missions.ts", "src/services/notify.ts", "src/services/workflows.ts", "src/services/onboarding.ts", "src/services/engagement.ts", "src/ai/guard.ts"];

const found = new Set<string>();
const add = (s: string) => { if (CYR.test(s)) found.add(s.replace(/\\"/g, '"')); };
for (const f of files) {
  const src = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  for (const m of src.matchAll(/t\("((?:[^"\\]|\\.)*)"\)/g)) add(m[1]);
  // словари и массивы подписей (…_RU, TABS, nav)
  for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"/g)) if (/^[А-ЯЁ]/.test(m[1]) || /_RU|TABS|nav|\["\//.test(src.slice(Math.max(0, m.index! - 200), m.index))) add(m[1]);
}
for (const f of serverFiles) {
  const src = readFileSync(f, "utf8");
  const pick = (re: RegExp) => { for (const m of src.matchAll(re)) add(m[1]); };
  pick(/label: "([^"]+)"/g);
  pick(/note: "([^"]+)"/g);
  pick(/s\("[a-z_]+", "([^"]+)"/g);
  pick(/"[a-z_.]+": "([^"]+)"/g);
  pick(/[a-z_]+: "([А-ЯЁ][^"]+)"/g);
  if (f.endsWith("guard.ts")) pick(/"((?:Соответствие|Полезность|Конкретность|Достоверность|Оригинальность|Ясность|Риски)[^"]*)"/g);
}
const missing = [...found].filter((s) => !(s in EN)).sort();
if (process.argv.includes("--json")) console.log(JSON.stringify(missing, null, 0));
else {
  console.log(`Строк: ${found.size}, переведено: ${found.size - missing.length}, нет перевода: ${missing.length}`);
  for (const m of missing.slice(0, 50)) console.log(" -", m);
}
process.exit(missing.length ? 1 : 0);
