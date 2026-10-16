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
  // B2B-демо: руководитель Northwind, бриф компании, реальные сотрудники с подтверждённым трудоустройством, пост страницы.
  const leader = await mk("cto@northwind.example", "Кира Орлова (CTO Northwind)", 0, ["en"]);
  await m(leader, "client_admin", c1);
  (u as any).leader = leader;
  await db.query(`INSERT INTO company_briefs(client_id, version, status, industry, positioning, topics, forbidden_topics, disclosure_mode, disclosure_text, intensity, email_domains, created_by, approved_by, approved_at)
    VALUES ($1, 1, 'approved', 'general', 'Международная инженерная компания: предиктивное обслуживание оборудования, сильная команда разработчиков и инженеров данных.', $2, '{слияние,M&A,финансовые показатели}', 'profile', '#employee', 'low', '{northwind.example}', $3, $4, now())`,
    [c1, JSON.stringify([
      { tag: "kubernetes", weight: 1, keywords: ["k8s", "кластер", "платформ"] },
      { tag: "ml", weight: 1.5, keywords: ["модел", "предиктив", "machine learning"] },
      { tag: "data", weight: 1, keywords: ["данн", "telemetry", "телеметр"] },
      { tag: "security", weight: 1, keywords: ["безопасн", "security"] },
      { tag: "hiring", weight: 1, keywords: ["ваканси", "нанима", "hiring", "открыта позиция"] },
    ]), leader, u.manager]);
  const employees: [string, string, string[], string][] = [
    ["anna.k@northwind.example", "Anna Kovacs (ML Lead)", ["ml", "data"], "Europe/Budapest"],
    ["raj.p@northwind.example", "Raj Patel (Data Engineer)", ["data", "kubernetes"], "Asia/Kolkata"],
    ["lena.m@northwind.example", "Lena Müller (Platform Engineer)", ["kubernetes", "security"], "Europe/Berlin"],
    ["tom.w@northwind.example", "Tom Walsh (Security Engineer)", ["security"], "Europe/Dublin"],
    ["mei.l@northwind.example", "Mei Lin (ML Engineer)", ["ml"], "Asia/Singapore"],
    ["omar.h@northwind.example", "Omar Haddad (Head of Talent)", ["hiring"], "Asia/Dubai"],
  ];
  const empAcc: Record<string, { acc: string; uid: string; name: string; tz: string }> = {};
  for (const [email, name, tags, tz] of employees) {
    const uid = await mk(email, name, 0, ["en"]);
    const acc_ = (await db.query("INSERT INTO managed_accounts(client_id, kind, display_name, primary_language, timezone, manager_id, status) VALUES ($1,'employee',$2,'en',$3,$4,'active') RETURNING id", [c1, name, tz, u.manager])).rows[0].id;
    await m(uid, "client", null, acc_);
    empAcc[email.split(".")[0]] = { acc: acc_, uid, name, tz };
    await db.query("INSERT INTO employee_profiles(account_id, client_id, expertise_tags, frequency, self_reported_activity, employment_verified_at, verification_method) VALUES ($1,$2,$3,'weekly','weekly', now(), 'email_domain')", [acc_, c1, tags]);
    await db.query("INSERT INTO account_safety(account_id, client_id, ramp_started_at) VALUES ($1,$2, now() - interval '30 days')", [acc_, c1]);
    await writeCapabilities(db, acc_, c1, "employee", "none", [], "seed");
    for (const scope of ["react", "comment", "ai_processing", "publish_post"]) {
      await db.query("INSERT INTO consents(client_id, account_id, action_scope, granted_by_name, evidence_ref, granted_by_user_id) VALUES ($1,$2,$3,$4,'Согласие в платформе (демо)',$5)", [c1, acc_, scope, name, uid]);
    }
    if (email.startsWith("anna")) {
      (u as any).employee = uid;
      const src = (await db.query("INSERT INTO knowledge_sources(client_id, account_id, title, kind, body, created_by) VALUES ($1,$2,'Интервью Anna, октябрь','interview','Перенос инференса на отдельный кластер, телеметрия пачками.',$3) RETURNING id", [c1, acc_, uid])).rows[0].id;
      await db.query("INSERT INTO verified_claims(client_id, account_id, statement, source_id, confirmed_by, valid_as_of) VALUES ($1,$2,'Инференс моделей вынесли в отдельный кластер, потому что телеметрия оборудования приходит пачками.',$3,'Anna Kovacs','2026-10-01')", [c1, acc_, src]);
    }
  }
  // Опубликованный пост страницы компании: цель для первой миссии.
  const pageItem = await item(c1, a2, "Как мы снизили простои на 18% с предиктивными моделями", "draft", "Наша ML-команда перевела три завода на предиктивное обслуживание: модели на телеметрии оборудования, кластер Kubernetes для инференса, отдельный контур безопасности данных. Делимся архитектурой и тем, что не сработало.", u.author);
  await db.query("UPDATE content_items SET state = 'published' WHERE id = $1", [pageItem]);
  await db.query("INSERT INTO external_publications(client_id, account_id, content_item_id, external_id, url, evidence_type, published_at) VALUES ($1,$2,$3,'urn:li:activity:7300000000000000042','https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000042/','manual_mark', now() - interval '3 hours')", [c1, a2, pageItem]);
  await seedAutopilot(db, c1, empAcc);
  await db.query("INSERT INTO metric_snapshots(client_id, account_id, metric_key, value, observed_at, source, availability_status) VALUES ($1,$2,'followers',1840, now() - interval '31 days','manual_entry','available'),($1,$2,'followers',2115, now() - interval '1 day','manual_entry','available')", [c1, a2]);
  return { agency_id: ag, seeded: true, users: u };
}

/** Демо автопилота: пять сотрудников Northwind прошли онбординг, паспорта подтверждены, профили подключены. */
async function seedAutopilot(db: Db, clientId: string, emp: Record<string, { acc: string; uid: string; name: string; tz: string }>) {
  const { buildPassport, passportHash, roleByKey, claimsFromInterview, AUTOPILOT_TERMS_TEXT } = await seedDeps();
  const { DbSecretStore } = await import("../services/secrets");
  const { contentHash } = await import("../core/contentStateMachine");
  const secrets = new DbSecretStore(db);
  await db.query("UPDATE company_briefs SET autopilot_review = 'company' WHERE client_id = $1 AND status = 'approved'", [clientId]);
  const people: [string, string, Record<string, string>, string[]][] = [
    ["anna", "data_ml", { now: "I lead the ML team that builds predictive maintenance models for factory equipment.", win: "We moved model inference to a separate Kubernetes cluster because equipment telemetry arrives in bursts. Downtime alerts now arrive before the failure, not after it.", lesson: "Our first model was trained on clean lab data and failed on noisy sensors. Since then every model is validated on raw telemetry from a real line.", stack: "Python, PyTorch, feature stores and streaming telemetry pipelines are my daily tools." }, ["ml", "data"]],
    ["raj", "backend", { now: "I build the data platform that collects telemetry from three plants into one lake.", win: "I redesigned ingestion so that a plant outage no longer blocks data from the other two plants.", lesson: "We tried exactly-once delivery everywhere and paid for it in latency. Idempotent writes turned out to be simpler and cheaper.", stack: "Kafka, Postgres, dbt and a lot of careful schema evolution." }, ["data", "kubernetes"]],
    ["lena", "platform", { now: "I run the internal platform on Kubernetes for all engineering teams.", win: "We cut the time to get a new service into production from two weeks to one day with golden paths.", lesson: "A platform nobody asked for gets ignored. We now start every platform feature with three internal users.", stack: "Kubernetes, Terraform, Argo CD and policy as code." }, ["kubernetes", "security"]],
    ["tom", "security", { now: "I am responsible for application and cloud security at the company.", win: "We moved secret scanning into every pull request and closed the long tail of leaked keys in one quarter.", lesson: "Security reviews at the end of a project create enemies. Short design reviews at the start create allies.", stack: "Threat modeling, cloud IAM, SAST and incident response drills." }, ["security"]],
    ["mei", "data_ml", { now: "I am an ML engineer working on anomaly detection for vibration sensors.", win: "My anomaly detector found a bearing fault three weeks before the scheduled inspection.", lesson: "I spent a month tuning a deep model before trying a simple baseline that was almost as good.", stack: "Signal processing, PyTorch, MLflow and careful experiment tracking." }, ["ml"]],
  ];
  const now = Date.now();
  for (const [key, roleKey, answers, topics] of people) {
    const e = emp[key];
    if (!e) continue;
    const role = roleByKey(roleKey)!;
    const passport = buildPassport(role, e.name, answers, { topics, length: "medium", register: "conversational", humor: false, language: "en", phrases: [], never_topics: ["salary", "customers by name"] });
    const hash = passportHash(passport);
    const src = (await db.query("INSERT INTO knowledge_sources(client_id, account_id, title, kind, body, usage_rights, created_by) VALUES ($1,$2,'Интервью личного агента','interview',$3,'internal_and_ai',$4) RETURNING id", [clientId, e.acc, JSON.stringify(answers), e.uid])).rows[0].id;
    for (const c of claimsFromInterview(answers)) await db.query("INSERT INTO verified_claims(client_id, account_id, statement, source_id, confirmed_by, valid_as_of) VALUES ($1,$2,$3,$4,$5,current_date)", [clientId, e.acc, c, src, e.name]);
    await db.query(`INSERT INTO personal_agents(account_id, client_id, user_id, role_key, onboarding_step, interview, interview_source_id, passport, passport_version, passport_hash, passport_confirmed_at, autopilot, veto_hours, spent_month, spent_usd)
        VALUES ($1,$2,$3,$4,'done',$5,$6,$7,1,$8,now() - interval '20 days','on',24,$9,$10)`, [e.acc, clientId, e.uid, roleKey, JSON.stringify(answers), src, JSON.stringify(passport), hash, new Date().toISOString().slice(0, 7), 1.8]);
    await db.query("INSERT INTO consents(client_id, account_id, action_scope, granted_by_name, evidence_ref, granted_by_user_id, terms) VALUES ($1,$2,'autopilot_posts',$3,'Автопилот: согласие в платформе (демо)',$4,$5)",
      [clientId, e.acc, e.name, e.uid, JSON.stringify({ veto_hours: 24, passport_hash: hash, passport_version: 1, review_by_company: true, text: AUTOPILOT_TERMS_TEXT })]);
    const urn = `urn:li:person:demo${key}`;
    const ref = `linkedin/${e.acc}/seed`;
    await secrets.set(ref, `demo-token-${key}`);
    await db.query("UPDATE managed_accounts SET linkedin_urn = $2, profile_url = $3 WHERE id = $1", [e.acc, urn, `https://www.linkedin.com/in/demo-${key}`]);
    await db.query("INSERT INTO oauth_connections(client_id, account_id, external_subject, granted_scopes, secret_ref, expires_at, status) VALUES ($1,$2,$3,'{openid,profile,w_member_social}',$4, now() + interval '50 days','active')", [clientId, e.acc, urn, ref]);
    await db.query(`INSERT INTO capability_snapshots(client_id, account_id, operation, mode, permission, access_basis, api_version, unavailable_reason, alternative, source, checked_at)
        VALUES ($1,$2,'publish_post_member','api','w_member_social','Share on LinkedIn (демо-подключение)','202608',NULL,'Публикация через человека','seed', now() + interval '1 second')`, [clientId, e.acc]);
  }
  // Подписка $200/мес: пятеро оплачены компанией, у Omar пока нет. Промокод на месяц бесплатно для демо.
  for (const key of ["anna", "raj", "lena", "tom", "mei"]) {
    const e = emp[key];
    await db.query("INSERT INTO subscriptions(account_id, client_id, status, period_end, provider) VALUES ($1,$2,'active', now() + interval '20 days','demo')", [e.acc, clientId]);
  }
  const agency = (await db.query("SELECT agency_id FROM clients WHERE id = $1", [clientId])).rows[0].agency_id;
  await db.query("INSERT INTO promo_codes(agency_id, code, free_months, max_redemptions) VALUES ($1,'FIRSTMONTH',1,500)", [agency]);
  await db.query("UPDATE clients SET autopilot_strategy = 'growth' WHERE id = $1", [clientId]);
  await db.query("UPDATE personal_agents SET strategy = 'steady' WHERE account_id = $1", [emp.tom.acc]);
  for (const [n, t, c, u] of [["Daniel Brooks", "Head of Maintenance", "Atlas Steel", "https://www.linkedin.com/in/demo-daniel-brooks"], ["Sofia Rossi", "VP Operations", "Nordic Paper", "https://www.linkedin.com/in/demo-sofia-rossi"], ["Kenji Watanabe", "Plant Reliability Lead", "Kobe Motors", "https://www.linkedin.com/in/demo-kenji-watanabe"]]) {
    await db.query("INSERT INTO outreach_items(client_id, account_id, kind, lead_name, lead_title, lead_company, lead_url, source) VALUES ($1,$2,'invite',$3,$4,$5,$6,'sales_navigator_export')", [clientId, emp.anna.acc, n, t, c, u]);
  }
  // Посты: опубликованный, готовый к выходу (проверен компанией), ожидающий проверки компании.
  const mk = async (key: string, status: string, hoursFromNow: number, tag: string, body: string, reviewed: boolean) => {
    const e = emp[key];
    const at = new Date(now + hoursFromNow * 36e5);
    const it = (await db.query("INSERT INTO content_items(client_id, account_id, title, objective, pillar, state, approved_version_id) VALUES ($1,$2,$3,'autopilot',$4,$5,NULL) RETURNING id", [clientId, e.acc, `Автопилот: ${tag}`, tag, status === "published" ? "published" : "draft"])).rows[0].id;
    const h = await contentHash({ body, media_ids: [], target_account_id: e.acc });
    const v = (await db.query("INSERT INTO content_versions(client_id, content_item_id, version, body, target_account_id, content_hash, origin) VALUES ($1,$2,1,$3,$4,$5,'ai_draft') RETURNING id", [clientId, it, body, e.acc, h])).rows[0].id;
    await db.query("UPDATE content_items SET current_version_id = $2::uuid, approved_version_id = CASE WHEN state = 'published' THEN $2::uuid ELSE NULL END WHERE id = $1", [it, v]);
    let url: string | null = null;
    if (status === "published") {
      url = `https://www.linkedin.com/feed/update/urn:li:share:73000000000000${Math.floor(Math.random() * 9000 + 1000)}/`;
      await db.query("INSERT INTO external_publications(client_id, account_id, content_item_id, external_id, url, evidence_type, published_at) VALUES ($1,$2,$3,$4,$5,'api_confirmed',$6)", [clientId, e.acc, it, url.split("update/")[1].replace("/", ""), url, at.toISOString()]);
    }
    const consent = (await db.query("SELECT id FROM consents WHERE account_id = $1 AND action_scope = 'autopilot_posts' AND revoked_at IS NULL", [e.acc])).rows[0].id;
    const { createHash } = await import("node:crypto");
    await db.query(`INSERT INTO autopilot_posts(client_id, account_id, kind, slot_key, topic_tag, topic_title, publish_at, status, content_item_id, body, body_sha256, review_required, reviewed_by, reviewed_at, consent_id, external_url)
        VALUES ($1,$2,'post',$3,$4,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$13)`,
      [clientId, e.acc, `seed:${status}:${key}`, tag, at.toISOString(), status, it, body, createHash("sha256").update(body).digest("hex"), reviewed ? (await db.query("SELECT user_id FROM memberships WHERE role = 'client_admin' AND scope_client_id = $1 LIMIT 1", [clientId])).rows[0]?.user_id ?? null : null, reviewed ? new Date(now - 36e5).toISOString() : null, consent, url]);
  };
  await mk("anna", "published", -72, "ml", "One thing I learned this year.\n\nWe moved model inference to a separate Kubernetes cluster because equipment telemetry arrives in bursts.\n\nWhat worked: every model is validated on raw telemetry from a real line.\n\nHow does your team handle this?\n\n#ml", true);
  await mk("lena", "veto_window", 20, "kubernetes", "A short breakdown from our practice.\n\nWe cut the time to get a new service into production from two weeks to one day with golden paths.\n\nWhat I would do differently: start every platform feature with three internal users.\n\nCurious how others approach it.\n\n#kubernetes", true);
  await mk("raj", "review", 40, "data", "Sharing an experience that may help other teams.\n\nI redesigned ingestion so that a plant outage no longer blocks data from the other two plants.\n\nWhat worked: idempotent writes turned out to be simpler and cheaper than exactly-once delivery everywhere.\n\nWhat pitfalls have you seen?\n\n#data", false);
}

async function seedDeps() {
  const a = await import("../core/autopilot");
  const { AUTOPILOT_TERMS } = await import("../services/agent");
  return { ...a, AUTOPILOT_TERMS_TEXT: AUTOPILOT_TERMS };
}
