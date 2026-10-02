/**
 * Воспроизводимый нагрузочный тест: N аккаунтов, 50 одновременных пользователей,
 * типовые чтения API. Использование: npx tsx scripts/loadtest.ts 500 [длительность_с]
 * По умолчанию PGlite в памяти (однопоточный, поэтому результат консервативный);
 * с DATABASE_URL=postgres://… — на PostgreSQL.
 */
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { openDb, createPgliteDb, migrate, type Db } from "../src/db/db";
import { seedDemo } from "../src/db/seed";
import { buildApp } from "../src/server/app";
import { MemorySecretStore } from "../src/services/publishing";

const N = Number(process.argv[2] ?? 500);
const DURATION = Number(process.argv[3] ?? 30) * 1000;
const USERS = 50;
/** Пауза пользователя между действиями, мс (0 = стресс-режим без пауз). */
const THINK_MS = Number(process.env.THINK_MS ?? 1000);
// Виртуальные пользователи шлют запросы без пауз, поэтому защитный лимит на пользователя для теста снят.
process.env.API_RATE_LIMIT_PER_MIN = "100000000";

async function seedLoad(db: Db, n: number) {
  const ag = (await db.query("SELECT id FROM agencies LIMIT 1")).rows[0].id;
  const mgr = (await db.query("SELECT id FROM users WHERE email = 'am@demo.agency'")).rows[0].id;
  const author = (await db.query("SELECT id FROM users WHERE email = 'author@demo.agency'")).rows[0].id;
  const clients = Math.ceil(n / 3);
  await db.query(`INSERT INTO clients(agency_id, name, status, monthly_fee) SELECT $1, 'Load client ' || g, 'active', 1500 FROM generate_series(1, $2) g`, [ag, clients]);
  await db.query(`INSERT INTO managed_accounts(client_id, kind, display_name, timezone, manager_id, status)
    SELECT c.id, (ARRAY['executive','founder','expert','company_page'])[1 + (row_number() OVER () % 4)], c.name || ' / acc ' || k, (ARRAY['Europe/Berlin','America/New_York','Asia/Dubai','Asia/Bangkok'])[1 + (k % 4)], $2, 'active'
      FROM clients c CROSS JOIN generate_series(1, 3) k WHERE c.name LIKE 'Load client %' LIMIT $1`, [n, mgr]);
  await db.query(`INSERT INTO strategy_versions(client_id, account_id, version, template, playbook, status, created_by)
    SELECT a.client_id, a.id, 1, 'executive', '{"goal":"Профессиональный авторитет","audience":"x","pillars":["A","B"],"posts_per_week":2,"primary_kpi":"qualified_inquiries","formats":["text"]}', 'approved', $1
      FROM managed_accounts a WHERE a.display_name LIKE 'Load client %'`, [mgr]);
  await db.query(`INSERT INTO content_items(client_id, account_id, title, state, author_id, planned_for)
    SELECT a.client_id, a.id, 'Материал ' || k, (ARRAY['idea','draft','editorial_review','approved','published'])[1 + (k % 5)], $1, now() + (k || ' days')::interval
      FROM managed_accounts a CROSS JOIN generate_series(1, 20) k WHERE a.display_name LIKE 'Load client %'`, [author]);
  await db.query(`INSERT INTO tasks(client_id, account_id, type, title, assignee_id, due_at, estimate_minutes)
    SELECT a.client_id, a.id, 'internal', 'Задача ' || k, $1, now() + ((k - 5) || ' days')::interval, 30
      FROM managed_accounts a CROSS JOIN generate_series(1, 10) k WHERE a.display_name LIKE 'Load client %'`, [mgr]);
  await db.query(`INSERT INTO metric_snapshots(client_id, account_id, metric_key, value, observed_at, source, availability_status)
    SELECT a.client_id, a.id, 'followers', 1000 + k, now() - (k || ' days')::interval, 'manual_entry', 'available'
      FROM managed_accounts a CROSS JOIN generate_series(1, 10) k WHERE a.display_name LIKE 'Load client %'`);
  // 50 сотрудников уровня агентства: у каждого виртуального пользователя своя учётная запись.
  const staff = (await db.query(`INSERT INTO users(agency_id, email, display_name) SELECT $1, 'load' || g || '@demo.agency', 'Load user ' || g FROM generate_series(1, ${USERS}) g RETURNING id`, [ag])).rows.map((r: any) => r.id);
  for (const id of staff) await db.query("INSERT INTO memberships(user_id, agency_id, role) VALUES ($1,$2,'account_manager')", [id, ag]);
  // Аккаунты распределены между менеджерами (~${N / USERS} на человека), как в реальном агентстве.
  await db.query("UPDATE managed_accounts SET manager_id = ($1::uuid[])[1 + (abs(hashtext(id::text)) % $2)] WHERE display_name LIKE 'Load client %'", [staff, staff.length]);
  await db.query("ANALYZE");
  return { manager: mgr, staff };
}

function pct(xs: number[], p: number) { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; }

const db = process.env.DATABASE_URL ? await openDb() : await createPgliteDb();
await migrate(db);
const seed: any = await seedDemo(db);
const t0 = performance.now();
const { staff } = await seedLoad(db, N);
const seedSec = ((performance.now() - t0) / 1000).toFixed(1);
const accounts = (await db.query("SELECT id FROM managed_accounts ORDER BY random() LIMIT 200")).rows.map((r: any) => r.id);
const app = buildApp({ db, secrets: new MemorySecretStore(), authMode: "dev" });
process.env.LOG_LEVEL = "silent";
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
const now = new Date();
const scenarios: [string, () => string][] = [
  ["Реестр (100 строк)", () => "/api/accounts?limit=100"],
  ["Реестр, требующие внимания", () => "/api/accounts?attention=1&limit=100"],
  ["Обзор агентства", () => "/api/overview"],
  ["Рабочее пространство аккаунта", () => `/api/accounts/${accounts[Math.floor(Math.random() * accounts.length)]}`],
  ["Центр согласований", () => "/api/approvals"],
  ["Задачи", () => "/api/tasks"],
  ["Календарь на месяц", () => `/api/calendar?mine=1&from=${now.toISOString().slice(0, 10)}&to=${new Date(now.getTime() + 30 * 864e5).toISOString().slice(0, 10)}`],
];
const lat = new Map<string, number[]>(scenarios.map(([n]) => [n, []]));
let errors = 0;
const end = performance.now() + DURATION;
await Promise.all(Array.from({ length: USERS }, async (_, i) => {
  while (performance.now() < end) {
    const [name, path] = scenarios[(i + Math.floor(Math.random() * scenarios.length)) % scenarios.length];
    const s = performance.now();
    const r = await fetch(base + path(), { headers: { "x-user-id": staff[i] } });
    await r.arrayBuffer();
    if (!r.ok) errors++;
    lat.get(name)!.push(performance.now() - s);
    if (THINK_MS) await new Promise((res) => setTimeout(res, THINK_MS * (0.5 + Math.random())));
  }
}));
await app.close();
const rows = [...lat.entries()].map(([name, xs]) => ({ name, n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: Math.max(...xs) }));
const total = rows.reduce((s, r) => s + r.n, 0);
const engine = process.env.DATABASE_URL ? "PostgreSQL" : "PGlite (in-memory, однопоточный)";
const mode = THINK_MS ? `реалистичный режим, пауза пользователя ≈ ${THINK_MS} мс` : "стресс-режим без пауз";
const md = `## ${N} аккаунтов, ${USERS} одновременных пользователей, ${mode}, ${DURATION / 1000} с, ${engine}

Данные: ${N} аккаунтов, ${N * 20} материалов, ${N * 10} задач, ${N * 10} снимков метрик. Сид за ${seedSec} с. Запросов: ${total}, ошибок: ${errors}, пропускная способность ≈ ${(total / (DURATION / 1000)).toFixed(0)} запр/с.

| Сценарий | Запросов | p50, мс | p95, мс | max, мс |
|---|---|---|---|---|
${rows.map((r) => `| ${r.name} | ${r.n} | ${r.p50.toFixed(0)} | ${r.p95.toFixed(0)} | ${r.max.toFixed(0)} |`).join("\n")}
`;
console.log(md);
if (process.env.LOADTEST_OUT) writeFileSync(process.env.LOADTEST_OUT, md, { flag: "a" });
await db.close();
process.exit(0);
