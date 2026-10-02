import type { Db } from "./db";
import { DEFAULT_METRIC_DEFINITIONS } from "../core/metrics";

export async function ensureReferenceData(db: Db) {
  for (const m of DEFAULT_METRIC_DEFINITIONS) {
    await db.query("INSERT INTO metric_definitions(key, name, unit, nature, definition) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING", [m.key, m.name, m.unit, m.nature, m.definition]);
  }
  await db.query("INSERT INTO metric_definitions(key, name, unit, nature, definition, is_platform_defined) VALUES ('interaction_rate_by_impressions','Interaction rate (платформа)','percent','periodic','(reactions + comments + reposts) / impressions × 100%. Определение платформы, не LinkedIn.', true) ON CONFLICT DO NOTHING");
  const policies = [
    ["oauth_tokens", "LinkedIn OAuth", "Исполнение согласованных действий", "Только worker публикации", null, "Удаление секрета при отзыве подключения или окончании договора"],
    ["linkedin_api_data", "LinkedIn API", "Отчётность клиенту в рамках разрешённых целей", "Команда аккаунта, клиент", 365, "Удаление из БД, кэша, индексов; резервные копии истекают по циклу ротации"],
    ["client_content", "Клиент и команда", "Подготовка и публикация", "Команда аккаунта, клиент, AI-провайдер при согласии ai_processing", 730, "Удаление по запросу или после завершения обслуживания"],
    ["manual_metrics", "Ручной ввод", "Отчётность", "Команда аккаунта, клиент", 730, "Как client_content"],
    ["audit_events", "Платформа", "Безопасность и расследования", "Аудитор, владелец", 1095, "Без исходного контента; удаляется по сроку"],
    ["ai_executions", "AI-адаптер", "Контроль качества и стоимости", "Владелец, редактор", 180, "Вывод AI удаляется вместе с контентом клиента"],
  ];
  for (const p of policies) await db.query("INSERT INTO retention_policies VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", p);
  const { seedBuiltinWorkflows } = await import("../services/workflows");
  for (const a of (await db.query("SELECT id FROM agencies")).rows) await seedBuiltinWorkflows(db, a.id, null);
}

/** Демо-данные. Не содержат метрик LinkedIn: показатели появляются только из ручного ввода с источником. */
export async function seedDemo(db: Db) {
  await ensureReferenceData(db);
  const exists = (await db.query("SELECT id FROM agencies LIMIT 1")).rows[0];
  if (exists) return { agency_id: exists.id, seeded: false };
  const ag = (await db.query("INSERT INTO agencies(name) VALUES ('Demo Agency') RETURNING id")).rows[0].id;
  const team = (await db.query("INSERT INTO teams(agency_id, name) VALUES ($1,'Team Alpha') RETURNING id", [ag])).rows[0].id;
  const mk = async (email: string, name: string, rate = 30, langs = ["ru", "en"]) =>
    (await db.query("INSERT INTO users(agency_id, email, display_name, internal_hourly_rate, languages, mfa_enrolled) VALUES ($1,$2,$3,$4,$5,true) RETURNING id", [ag, email, name, rate, langs])).rows[0].id;
  const u = {
    owner: await mk("owner@demo.agency", "Ольга (владелец)", 80),
    ops: await mk("ops@demo.agency", "Игорь (опер. директор)", 60),
    strategist: await mk("strategist@demo.agency", "Мария (стратег)", 50),
    manager: await mk("am@demo.agency", "Денис (аккаунт-менеджер)", 40),
    author: await mk("author@demo.agency", "Анна (автор)", 30),
    author2: await mk("author2@demo.agency", "Павел (автор другого клиента)", 30),
    editor: await mk("editor@demo.agency", "Екатерина (редактор)", 35),
    analyst: await mk("analyst@demo.agency", "Сергей (аналитик)", 35),
    client: await mk("ceo@northwind.example", "Джон Смит (клиент Northwind)", 0, ["en"]),
    auditor: await mk("audit@demo.agency", "Аудитор", 0),
  };
  const c1 = (await db.query("INSERT INTO clients(agency_id, name, contract_ref, service_package, monthly_fee, team_id, status) VALUES ($1,'Northwind Robotics','NW-2026-01','Executive + Company',6000,$2,'active') RETURNING id", [ag, team])).rows[0].id;
  const c2 = (await db.query("INSERT INTO clients(agency_id, name, contract_ref, service_package, monthly_fee, team_id, status) VALUES ($1,'Elena Petrova Consulting','EP-2026-03','Expert',1500,$2,'active') RETURNING id", [ag, team])).rows[0].id;
  const acc = async (client: string, kind: string, name: string, tz: string, lang: string, url: string, conf = false) =>
    (await db.query("INSERT INTO managed_accounts(client_id, kind, display_name, profile_url, primary_language, timezone, manager_id, status, confidential_job_search, audience_geo) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9) RETURNING id", [client, kind, name, url, lang, tz, u.manager, conf, ["US", "EU"]])).rows[0].id;
  const a1 = await acc(c1, "executive", "John Smith (CEO)", "America/New_York", "en", "https://www.linkedin.com/in/example-john-smith");
  const a2 = await acc(c1, "company_page", "Northwind Robotics (страница)", "America/New_York", "en", "https://www.linkedin.com/company/example-northwind");
  const a3 = await acc(c2, "expert", "Елена Петрова", "Europe/Berlin", "ru", "https://www.linkedin.com/in/example-elena");
  const m = async (user: string, role: string, client: string | null = null, account: string | null = null) => db.query("INSERT INTO memberships(user_id, agency_id, role, scope_client_id, scope_account_id) VALUES ($1,$2,$3,$4,$5)", [user, ag, role, client, account]);
  await m(u.owner, "owner"); await m(u.ops, "ops_director"); await m(u.strategist, "strategist"); await m(u.manager, "account_manager");
  await m(u.author, "author", c1); await m(u.author2, "author", c2); await m(u.editor, "editor"); await m(u.analyst, "analyst");
  await m(u.client, "client", null, a1); await m(u.auditor, "auditor");

  const { writeCapabilities } = await import("../services/accounts");
  for (const [id, client, kind] of [[a1, c1, "executive"], [a2, c1, "company_page"], [a3, c2, "expert"]] as const) {
    await writeCapabilities(db, id, client, kind, "none", [], "seed");
    for (const scope of ["publish_post", "ai_processing", "analytics_read"]) {
      await db.query("INSERT INTO consents(client_id, account_id, action_scope, granted_by_name, evidence_ref) VALUES ($1,$2,$3,$4,$5)", [client, id, scope, kind === "company_page" ? "Marketing Director, Northwind" : "Владелец профиля", "Договор, приложение 2 (демо)"]);
    }
  }
  const strat = async (account: string, client: string, template: string, goal: string, pillars: string[], ppw: number, forbidden: string[] = []) =>
    db.query("INSERT INTO strategy_versions(client_id, account_id, version, template, playbook, brand_voice, restrictions, status, created_by, approved_by, change_reason) VALUES ($1,$2,1,$3,$4,$5,$6,'approved',$7,$7,'Первичная стратегия')",
      [client, account, template, JSON.stringify({ goal, horizon_weeks: 12, audience: "Руководители производственных компаний", pillars, posts_per_week: ppw, formats: ["text", "image"], primary_kpi: "qualified_inquiries", secondary_kpis: ["impressions", "comments"], review_period_weeks: 4, time_budget_hours_month: 12, posting_windows: ["Вт 09:00", "Чт 09:00"] }),
       JSON.stringify({ style: "спокойный, конкретный", formality: "деловой", humor: "редко", avoid: ["революционный", "game-changer"] }),
       JSON.stringify({ forbidden_topics: forbidden, needs_personal_approval: ["увольнения"], allow_self_approval: false, skip_client_review: false }), u.strategist]);
  await strat(a1, c1, "executive", "Профессиональный авторитет", ["Управленческие решения", "Отраслевые наблюдения", "Кейсы"], 2, ["слияние", "M&A"]);
  await strat(a3, c2, "expert", "Конверсия в консультации", ["Разборы", "Методология"], 3);
  const ks = (await db.query("INSERT INTO knowledge_sources(client_id, account_id, title, kind, body, created_by) VALUES ($1,$2,'Интервью CEO, сентябрь','interview','Расшифровка интервью о переходе на предиктивное обслуживание.', $3) RETURNING id", [c1, a1, u.strategist])).rows[0].id;
  await db.query("INSERT INTO verified_claims(client_id, account_id, statement, source_id, confirmed_by, valid_as_of) VALUES ($1,$2,'Northwind перевела 3 завода на предиктивное обслуживание в 2026 году.',$3,'John Smith','2026-09-15'),($1,$2,'Решение принималось после 6 месяцев пилота на одном заводе.',$3,'John Smith','2026-09-15')", [c1, a1, ks]);
  await db.query("INSERT INTO knowledge_sources(client_id, account_id, title, kind, body, created_by) VALUES ($1,$2,'Методология Елены','brief','Конфиденциальные заметки другого клиента.',$3)", [c2, a3, u.strategist]);

  const { contentHash } = await import("../core/contentStateMachine");
  const item = async (client: string, account: string, title: string, state: string, body: string, author: string) => {
    const it = (await db.query("INSERT INTO content_items(client_id, account_id, title, pillar, state, author_id) VALUES ($1,$2,$3,'Управленческие решения',$4,$5) RETURNING id", [client, account, title, state, author])).rows[0].id;
    const h = await contentHash({ body, media_ids: [], target_account_id: account });
    const v = (await db.query("INSERT INTO content_versions(client_id, content_item_id, version, body, target_account_id, content_hash, created_by) VALUES ($1,$2,1,$3,$4,$5,$6) RETURNING id", [client, it, body, account, h, author])).rows[0].id;
    await db.query("UPDATE content_items SET current_version_id = $2 WHERE id = $1", [it, v]);
    if (state === "editorial_review" || state === "client_review") await db.query("INSERT INTO approval_requests(client_id, content_item_id, content_version_id, content_hash, stage, requested_by) VALUES ($1,$2,$3,$4,$5,$6)", [client, it, v, h, state === "editorial_review" ? "editorial" : "client", author]);
    return it;
  };
  await item(c1, a1, "Почему мы полгода пилотировали один завод", "editorial_review", "Мы перевели три завода на предиктивное обслуживание. Но сначала шесть месяцев пилотировали один.\n\nГлавный урок: ...", u.author);
  await item(c1, a1, "Что я понял о данных с оборудования", "draft", "Черновик. [НУЖНО ОТ КЛИЕНТА: пример с цифрами по простоям]", u.author);
  await item(c2, a3, "Разбор: как не потерять клиента на онбординге", "client_review", "Разбор типичной ошибки онбординга B2B-клиента...", u.author2);
  await db.query("INSERT INTO tasks(client_id, account_id, type, title, assignee_id, due_at, estimate_minutes) VALUES ($1,$2,'profile_audit','Аудит профиля: заголовок и About',$3, now() - interval '1 day', 90), ($1,$2,'interview','Интервью CEO по теме Q4',$4, now() + interval '2 days', 60)", [c1, a1, u.manager, u.strategist]);
  const { seedBuiltinWorkflows } = await import("../services/workflows");
  await seedBuiltinWorkflows(db, ag, u.ops);
  await db.query("INSERT INTO time_entries(client_id, account_id, user_id, minutes, work_date) VALUES ($1,$2,$3,240,current_date - 3),($1,$2,$4,180,current_date - 2)", [c1, a1, u.author, u.manager]);
  return { agency_id: ag, seeded: true, users: u };
}
