import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, APPROVED } from "./helpers";
import { actorCtx, loadActor } from "../src/services/context";
import * as company from "../src/services/company";
import * as missions from "../src/services/missions";
import * as acc from "../src/services/accounts";
import { b2bTick, directorTick, executeApproved, expireOverdue, planMission, recordSignal } from "../src/agents/orchestrator";
import { checkText, jaccard, limitsFor, maxParticipants, pickSlot, regulatedReasons, relevance, riskScore, shingles, disclosureMissing, type SafetyState } from "../src/core/safety";
import { buildApp } from "../src/server/app";

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { env = await setup(); process.env.LINKEDIN_APPROVED_PRODUCTS = ""; });
afterEach(async () => { await env.db.close(); });

const ctxOf = async (userId: string) => actorCtx(env.db, (await loadActor(env.db, userId))!);
const userByEmail = async (email: string) => (await env.db.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as string;
const northwind = async () => (await env.acct("John Smith (CEO)")).client_id;
const pagePost = async () => (await env.db.query("SELECT ci.id FROM content_items ci JOIN managed_accounts a ON a.id = ci.account_id WHERE a.kind = 'company_page' AND ci.state = 'published'")).rows[0].id as string;
const DAY = 864e5;
const state = (o: Partial<SafetyState> = {}): SafetyState => ({ rampStartedAt: new Date(Date.now() - 30 * DAY), cooldownUntil: null, halfUntil: null, excluded: false, warningsAt: [], connectionError: false, selfReportedActivity: "weekly", ...o });

async function amplify(now = new Date()) {
  const leader = await env.ctx("leader");
  return missions.createMission(leader, { systemDb: env.db }, await northwind(), { type: "amplify_post", title: "Поддержать разбор ML-архитектуры", target_content_item_id: await pagePost(), window_hours: 48 }, now);
}

describe("движок безопасности: чистые функции", () => {
  it("лимиты: разгон, охлаждение, половинный режим, пауза сотрудника", () => {
    const now = new Date();
    expect(limitsFor(state({ rampStartedAt: new Date(now.getTime() - 2 * DAY) }), "comment", now)).toMatchObject({ day: 1, mode: "ramp" });
    expect(limitsFor(state(), "comment", now)).toMatchObject({ day: 2, hour: 1, week: 6, mode: "normal" });
    expect(limitsFor(state({ cooldownUntil: new Date(now.getTime() + 36e5) }), "react", now).mode).toBe("blocked");
    expect(limitsFor(state({ halfUntil: new Date(now.getTime() + DAY) }), "comment", now)).toMatchObject({ day: 1, mode: "half" });
    expect(limitsFor(state({ frequency: "paused" }), "react", now).day).toBe(0);
  });
  it("риск: запреты отдельно от баллов, затухание сигналов, неизвестность не ниже среднего", () => {
    const now = new Date();
    const r1 = riskScore({ state: state({ warningsAt: [new Date(now.getTime() - 2 * DAY)], selfReportedActivity: "daily" }), now, usedRatio: 0.5 });
    expect(r1.score).toBeCloseTo(35 * Math.exp(-0.2) + 12.5, 0);
    expect(r1.level).toBe("medium");
    expect(riskScore({ state: state({ cooldownUntil: new Date(now.getTime() + DAY) }), now, usedRatio: 0 })).toMatchObject({ blocked: true, score: null, level: "blocked" });
    const r3 = riskScore({ state: state({ selfReportedActivity: null }), now, usedRatio: 0 });
    expect(r3.score).toBe(10);
    expect(r3.level).toBe("medium");
    expect(riskScore({ state: state({ warningsAt: [1, 2, 3].map((d) => new Date(now.getTime() - d * DAY)) }), now, usedRatio: 0 }).reasons).toContain("warnings_30d");
  });
  it("тексты: шаблоны, длина, похожесть по символьным шинглам, ссылки", () => {
    expect(checkText("Great post!!", "comment", []).block).toEqual(expect.arrayContaining(["too_short", "template_phrase"]));
    // Морфология: символьные шинглы ловят «запуск/запуска» хотя бы на уровне предупреждения; короткие тексты блокируются длиной.
    expect(jaccard(shingles("Отличный запуск, команда!"), shingles("Отличного запуска команде"))).toBeGreaterThanOrEqual(0.25);
    expect(checkText("Отличного запуска команде", "comment", ["Отличный запуск, команда!"]).block).toContain("too_short");
    const a = "Мы в команде платформы тоже переводили инференс на Kubernetes и упёрлись в холодный старт GPU-подов";
    expect(checkText(a + " и это заняло месяц", "comment", [a]).block).toContain("similar_text");
    expect(checkText("Полезный разбор, особенно часть про контур безопасности данных и отдельный кластер, смотрите https://x.y", "comment", []).block).toContain("link_in_comment");
  });
  it("релевантность только по словарю компании; комментарий при rel ≥ 0,5 и совпадении основного тега", () => {
    expect(relevance([{ tag: "kubernetes", weight: 1 }, { tag: "security", weight: 0.5 }], ["security"])).toMatchObject({ rel: 0.333, canComment: false });
    expect(relevance([{ tag: "ml", weight: 1.5 }, { tag: "data", weight: 1 }], ["ml"])).toMatchObject({ canComment: true });
  });
  it("участников на пост: 25% с округлением вверх, не больше 5, при меньше 4 подключённых никто", () => {
    expect(maxParticipants(3)).toBe(0);
    expect(maxParticipants(6)).toBe(2);
    expect(maxParticipants(40)).toBe(5);
  });
  it("время: тихий первый час, рабочие часы, разнос 45 минут", () => {
    const now = new Date("2026-10-14T06:00:00Z");
    const t = pickSlot({ windowStart: now, windowEnd: new Date(now.getTime() + 2 * DAY), publishedAt: now, tz: "Europe/Berlin", taken: [], seed: "x", now })!;
    expect(t.getTime()).toBeGreaterThanOrEqual(now.getTime() + 36e5);
    const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(t));
    expect(h).toBeGreaterThanOrEqual(8); expect(h).toBeLessThan(21);
    const t2 = pickSlot({ windowStart: now, windowEnd: new Date(now.getTime() + 2 * DAY), publishedAt: now, tz: "Europe/Berlin", taken: [t], seed: "x", now })!;
    expect(Math.abs(t2.getTime() - t.getTime())).toBeGreaterThanOrEqual(45 * 6e4);
  });
  it("регулируемые отрасли: обещания доходности, FOMO, депозит, раскрытие связи", () => {
    expect(regulatedReasons("Guaranteed 20% monthly profit, don't miss it", "crypto", false)).toEqual(expect.arrayContaining(["return_promise", "fomo", "needs_compliance"]));
    expect(regulatedReasons("Guaranteed 20% monthly", "general", false)).toEqual([]);
    expect(disclosureMissing("Отличная архитектура матчинга", "profile", "#employee", "crypto")).toBe(true);
    expect(disclosureMissing("Работаю в компании: отличная архитектура", "profile", "#employee", "crypto")).toBe(false);
  });
});

describe("роль руководителя компании", () => {
  it("внешняя роль: внутренние разделы закрыты, кабинет компании открыт, персональные данные сотрудников скрыты", async () => {
    const app = buildApp({ db: env.db, secrets: env.secrets, authMode: "dev" });
    const H = { "x-user-id": env.u.leader };
    for (const url of ["/api/tasks", "/api/accounts", "/api/approvals", "/api/users", "/api/engagement", "/api/companies/portfolio"]) {
      expect((await app.inject({ method: "GET", url, headers: H })).statusCode, url).toBe(403);
    }
    const cid = await northwind();
    const r = await app.inject({ method: "GET", url: `/api/companies/${cid}`, headers: H });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.accounts).toBeNull();
    expect(body.team.connected).toBe(7); // 6 инженеров и CEO с личным аккаунтом
    expect(body.team.verified).toBe(6);
    expect(body.seen_from_outside.followers_delta_30d).toBe(275);
    const other = (await env.acct("Елена Петрова")).client_id;
    expect((await app.inject({ method: "GET", url: `/api/companies/${other}`, headers: H })).statusCode).toBe(404);
  });

  it("RLS: руководитель не видит действия, согласия и сигналы конкретных сотрудников", async () => {
    await amplify();
    const leader = await env.ctx("leader");
    for (const t of ["mission_actions", "consents", "safety_events", "account_safety", "employee_profiles", "agent_runs", "employee_invites", "tasks"]) {
      expect((await leader.db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, t).toBe(0);
    }
    expect((await leader.db.query("SELECT count(*)::int n FROM agent_missions")).rows[0].n).toBe(1);
  });

  it("не одобряет действие и не даёт согласие за сотрудника", async () => {
    const { mission } = await amplify();
    const a = (await env.db.query("SELECT id, account_id FROM mission_actions WHERE mission_id = $1 LIMIT 1", [mission.id])).rows[0];
    await expect(missions.decideAction(await env.ctx("leader"), env.db, a.id, { decision: "approve", text: "x" })).rejects.toThrow(/не найдено|владелец/);
    await expect(acc.grantConsent(await env.ctx("leader"), a.account_id, { action_scope: "comment", granted_by_name: "CTO", evidence_ref: "x" })).rejects.toThrow();
  });
});

describe("миссии и агенты", () => {
  it("планировщик: участники по экспертизе, комментарий только по теме, черновик к посту компании, разнос по времени", async () => {
    const { mission, plan } = await amplify();
    expect(mission.status).toBe("active");
    expect(plan!.planned).toBe(2);
    const rows = (await env.db.query("SELECT ma.kind, ma.scheduled_at, ma.ai_drafted, a.display_name FROM mission_actions ma JOIN managed_accounts a ON a.id = ma.account_id WHERE mission_id = $1 ORDER BY scheduled_at", [mission.id])).rows;
    const anna = rows.find((r: any) => r.display_name.startsWith("Anna"));
    expect(anna.kind).toBe("comment");
    expect(anna.ai_drafted).toBe(true);
    expect(rows.filter((r: any) => r.kind === "comment").length).toBe(1);
    expect(Math.abs(new Date(rows[1].scheduled_at).getTime() - new Date(rows[0].scheduled_at).getTime())).toBeGreaterThanOrEqual(45 * 6e4);
    const runs = (await env.db.query("SELECT agent, status FROM agent_runs WHERE mission_id = $1", [mission.id])).rows;
    expect(runs).toEqual([{ agent: "planner", status: "ok" }]);
  });

  it("повторное и параллельное планирование не создаёт дублей", async () => {
    const { mission } = await amplify();
    await env.db.query("UPDATE agent_missions SET status = 'planned' WHERE id = $1", [mission.id]);
    const [a, b] = await Promise.all([planMission(env.db, mission.id), planMission(env.db, mission.id)]);
    expect([a, b].filter(Boolean).length).toBe(0); // ключ plan:<id> уже занят первым запуском
    expect((await env.db.query("SELECT count(*)::int n FROM mission_actions WHERE mission_id = $1", [mission.id])).rows[0].n).toBe(2);
  });

  it("сотрудник: черновик AI нельзя одобрить без правки, свой текст проходит, пропуск без последствий", async () => {
    const { mission } = await amplify();
    const annaUser = await userByEmail("anna.k@northwind.example");
    const anna = await ctxOf(annaUser);
    const mine = await missions.myActions(anna);
    expect(mine.length).toBe(1);
    await expect(missions.decideAction(anna, env.db, mine[0].id, { decision: "approve" })).rejects.toThrow(/служебные пометки|Офицер/);
    const text = "Хорошо видно, почему мы вынесли инференс моделей в отдельный кластер: телеметрия оборудования идёт пачками, и без этого задержки росли в разы.";
    const r: any = await missions.decideAction(anna, env.db, mine[0].id, { decision: "approve", text });
    expect(r.status).toBe("approved");
    const done: any = await missions.markActionDone(anna, mine[0].id, {});
    expect(done.evidence).toBe("manual_mark");
    const other = (await env.db.query("SELECT ma.id, m.user_id FROM mission_actions ma JOIN memberships m ON m.scope_account_id = ma.account_id AND m.role = 'client' WHERE ma.mission_id = $1 AND ma.status = 'awaiting_owner'", [mission.id])).rows[0];
    expect((await missions.decideAction(await ctxOf(other.user_id), env.db, other.id, { decision: "skip" })).status).toBe("skipped");
    const detail: any = await missions.missionDetail(await env.ctx("leader"), env.db, mission.id);
    expect(detail.actions).toBeNull();
    expect(detail.agents).toBeNull();
    expect(detail.output).toBeNull(); // меньше 5 участников: счётчики руководителю не показываются
    const agency: any = await missions.missionDetail(await env.ctx("manager"), env.db, mission.id);
    expect(agency.output).toMatchObject({ total: 2, done: 1 });
    expect(detail.outcome.status).toBe("not_computable");
  });

  it("частота: сотрудник получает не больше одного запроса в неделю", async () => {
    const first = await amplify();
    const firstAccounts = (await env.db.query("SELECT account_id FROM mission_actions WHERE mission_id = $1", [first.mission.id])).rows.map((r: any) => r.account_id);
    const leader = await env.ctx("leader");
    const r = await missions.createMission(leader, { systemDb: env.db }, await northwind(), { type: "amplify_post", title: "Ещё один пост", target_url: "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000099/", target_is_company_post: true, topic_tags: ["ml"], window_hours: 48 });
    expect((await env.db.query("SELECT plan_summary FROM agent_missions WHERE id = $1", [r.mission.id])).rows[0].plan_summary.vetoed.frequency).toBe(2);
    expect((r.plan as any).vetoed).toBeUndefined(); // руководителю причины отсева не отдаются
    const second = (await env.db.query("SELECT account_id FROM mission_actions WHERE mission_id = $1", [r.mission.id])).rows.map((x: any) => x.account_id);
    expect(second.some((x: string) => firstAccounts.includes(x))).toBe(false);
  });

  it("гонка лимита: два параллельных одобрения в одном часе, проходит ровно одно", async () => {
    const { mission } = await amplify();
    const anna = (await env.db.query("SELECT ma.*, m.user_id FROM mission_actions ma JOIN memberships m ON m.scope_account_id = ma.account_id AND m.role = 'client' JOIN managed_accounts a ON a.id = ma.account_id WHERE ma.mission_id = $1 AND a.display_name LIKE 'Anna%'", [mission.id])).rows[0];
    const m2 = (await env.db.query("INSERT INTO agent_missions(client_id, created_by, type, title, window_start, window_end, status, idem_key, target_url) SELECT client_id, created_by, 'discussion', 'Обсуждение', window_start, window_end, 'active', 'race', 'https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000077/' FROM agent_missions WHERE id = $1 RETURNING id", [mission.id])).rows[0];
    const b = (await env.db.query("INSERT INTO mission_actions(mission_id, client_id, account_id, kind, window_start, window_end, scheduled_at) VALUES ($1,$2,$3,'comment',$4,$5,$6) RETURNING id", [m2.id, anna.client_id, anna.account_id, anna.window_start, anna.window_end, anna.scheduled_at])).rows[0];
    const ctx = await ctxOf(anna.user_id);
    const t1 = "Хорошо видно, почему мы вынесли инференс моделей в отдельный кластер и как это повлияло на задержки телеметрии.";
    const t2 = "Отдельный вопрос, который мы долго обсуждали внутри: как версионировать признаки, когда меняется прошивка датчиков на заводе.";
    const res = await Promise.allSettled([missions.decideAction(ctx, env.db, anna.id, { decision: "approve", text: t1 }), missions.decideAction(ctx, env.db, b.id, { decision: "approve", text: t2 })]);
    expect(res.filter((x) => x.status === "fulfilled").length).toBe(1);
    expect(String((res.find((x) => x.status === "rejected") as any).reason.details)).toMatch(/лимит/);
  });

  it("сигнал LinkedIn: охлаждение, снятие предложений, исключение после трёх, восстановление только агентством", async () => {
    await amplify();
    const annaUser = await userByEmail("anna.k@northwind.example");
    const anna = await ctxOf(annaUser);
    const accId = (await env.db.query("SELECT scope_account_id FROM memberships WHERE user_id = $1", [annaUser])).rows[0].scope_account_id;
    const r: any = await company.reportSignal(anna, env.db, accId, { kind: "warning", note: "Предупреждение о необычной активности" });
    expect(r.stopped).toBe(1);
    const p: any = await company.myParticipation(anna);
    expect(p.accounts[0].risk.level).toBe("blocked");
    const t0 = Date.now();
    await recordSignal(env.db, { accountId: accId, kind: "captcha", source: "owner", dedupe: "c1" }, new Date(t0 + 1000));
    const third: any = await recordSignal(env.db, { accountId: accId, kind: "restriction", source: "owner", dedupe: "c2" }, new Date(t0 + 2000));
    expect(third.excluded).toBe(true);
    await expect(company.restoreAccount(anna, env.db, accId)).rejects.toThrow();
    await company.restoreAccount(await env.ctx("manager"), env.db, accId);
    const s = (await env.db.query("SELECT excluded, half_until > now() AS half FROM account_safety WHERE account_id = $1", [accId])).rows[0];
    expect(s).toEqual({ excluded: false, half: true });
  });

  it("аварийная остановка: руководитель ставит, снять может только агентство", async () => {
    await amplify();
    const cid = await northwind();
    const r: any = await company.pauseCompany(await env.ctx("leader"), env.db, cid, { paused: true, reason: "Проверяем формулировки после релиза" });
    expect(r.stopped).toBe(2);
    await expect(company.pauseCompany(await env.ctx("leader"), env.db, cid, { paused: false })).rejects.toThrow(/агентства/);
    await expect(missions.createMission(await env.ctx("leader"), { systemDb: env.db }, cid, { type: "amplify_post", title: "x2x", target_url: "https://www.linkedin.com/feed/update/urn:li:activity:1/" })).rejects.toThrow(/остановлена/);
    await company.pauseCompany(await env.ctx("manager"), env.db, cid, { paused: false });
  });

  it("политика AI: к чужому посту черновик комментария не готовится", async () => {
    const leader = await env.ctx("leader");
    const r = await missions.createMission(leader, { systemDb: env.db }, await northwind(), { type: "discussion", title: "Обсуждение отраслевой статьи", target_url: "https://www.linkedin.com/feed/update/urn:li:activity:7311111111111111111/", target_excerpt: "Predictive maintenance models and telemetry data", topic_tags: ["ml", "data"], window_hours: 48 });
    const rows = (await env.db.query("SELECT proposed_text, warnings FROM mission_actions WHERE mission_id = $1", [r.mission.id])).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const x of rows) { expect(x.proposed_text).toBeNull(); expect(x.warnings).toContain("ai_not_allowed_external_post"); }
  });

  it("регулируемая отрасль без compliance: новости компании не планируются, текст с обещанием дохода отклоняется", async () => {
    const cid = await northwind();
    const mgr = await env.ctx("manager");
    const b: any = await company.proposeBrief(await env.ctx("leader"), cid, { industry: "crypto", positioning: "Криптобиржа с инженерной командой мирового уровня", topics: [{ tag: "ml", weight: 1.5, keywords: ["модел"] }, { tag: "data", weight: 1, keywords: ["данн"] }] });
    expect(b.disclosure_mode).toBe("inline");
    await company.approveBrief(mgr, b.id, {});
    const r = await missions.createMission(await env.ctx("leader"), { systemDb: env.db }, cid, { type: "company_news", title: "Новость", target_content_item_id: await pagePost() });
    expect(r.mission.status).toBe("blocked");
    expect(r.mission.blocked_reasons.join(" ")).toMatch(/compliance/);
  });

  it("исполнение через API: только одобренное владельцем, повторная проверка, 429 включает охлаждение", async () => {
    process.env.LINKEDIN_APPROVED_PRODUCTS = APPROVED + ",Community Management API";
    const annaUser = await userByEmail("anna.k@northwind.example");
    const accId = (await env.db.query("SELECT scope_account_id FROM memberships WHERE user_id = $1", [annaUser])).rows[0].scope_account_id;
    env.secrets.set("tok:anna", "t");
    await env.db.query("UPDATE managed_accounts SET linkedin_urn = 'urn:li:person:anna' WHERE id = $1", [accId]);
    await env.db.query("INSERT INTO oauth_connections(client_id, account_id, external_subject, granted_scopes, secret_ref, status) SELECT client_id, id, 'urn:li:person:anna', '{w_member_social_feed}', 'tok:anna', 'active' FROM managed_accounts WHERE id = $1", [accId]);
    await acc.refreshCapabilities(await env.ctx("manager"), accId);
    const { mission } = await amplify();
    const a = (await env.db.query("SELECT * FROM mission_actions WHERE mission_id = $1 AND account_id = $2", [mission.id, accId])).rows[0];
    expect(a.exec_mode).toBe("api");
    const text = "Хорошо видно, почему мы вынесли инференс моделей в отдельный кластер: телеметрия оборудования идёт пачками, иначе задержки росли.";
    await missions.decideAction(await ctxOf(annaUser), env.db, a.id, { decision: "approve", text });
    const at = new Date(new Date(a.scheduled_at).getTime() + 60_000);
    const r = await executeApproved({ db: env.db, adapter: env.adapter, secrets: env.secrets }, at);
    expect(r).toEqual([{ id: a.id, outcome: "done" }]);
    expect(env.adapter.social).toEqual([{ kind: "comment", actor: "urn:li:person:anna", target: "urn:li:activity:7300000000000000042", text }]);
    // Правка текста после одобрения аннулирует одобрение.
    const b = (await env.db.query("INSERT INTO mission_actions(mission_id, client_id, account_id, kind, window_start, window_end, scheduled_at, status, exec_mode, final_text, approved_text_sha256) SELECT mission_id, client_id, account_id, 'react', window_start, window_end, scheduled_at + interval '3 hours', 'approved', 'api', NULL, NULL FROM mission_actions WHERE id = $1 RETURNING id, scheduled_at", [a.id])).rows[0];
    env.adapter.failures.set("urn:li:person:anna", "quota");
    const r2 = await executeApproved({ db: env.db, adapter: env.adapter, secrets: env.secrets }, new Date(new Date(b.scheduled_at).getTime() + 60_000));
    expect(r2[0].outcome).toBe("error:throttled");
    expect((await env.db.query("SELECT cooldown_until > now() AS c FROM account_safety WHERE account_id = $1", [accId])).rows[0].c).toBe(true);
  });

  it("простой: просроченные предложения истекают, без залпа действий после восстановления", async () => {
    const { mission } = await amplify();
    const later = new Date(Date.now() + 5 * DAY);
    const r = await expireOverdue(env.db, later);
    expect(r).toEqual({ actions_expired: 2, missions_completed: 1 });
    const t = await b2bTick({ db: env.db, adapter: env.adapter, secrets: env.secrets }, later);
    expect(t.executed).toBe(0);
    expect((await env.db.query("SELECT status FROM agent_missions WHERE id = $1", [mission.id])).rows[0].status).toBe("completed");
  });

  it("директор: один бриф в сутки по поясу компании", async () => {
    const at = new Date("2026-10-15T13:00:00Z"); // 09:00 в Нью-Йорке
    await env.db.query("UPDATE managed_accounts SET timezone = 'America/New_York' WHERE kind = 'company_page'");
    expect((await directorTick(env.db, at)).briefs).toBe(1);
    expect((await directorTick(env.db, new Date(at.getTime() + 36e5))).briefs).toBe(0);
    expect((await directorTick(env.db, new Date("2026-10-15T20:00:00Z"))).briefs).toBe(0);
  });
});

describe("приглашение сотрудника", () => {
  it("одноразовый токен, предпросмотр прав, согласия от самого сотрудника, подтверждение по домену почты", async () => {
    const cid = await northwind();
    const leader = await env.ctx("leader");
    const sent: any[] = [];
    const mailer = { name: "test", send: async (m: any) => { sent.push(m); } };
    const prod: any = await company.createInvite(leader, env.db, cid, { email: "no.link@northwind.example", display_name: "Без ссылки" }, { mailer });
    expect(prod.invite_link).toBeUndefined(); // создатель ссылку не видит, она уходит письмом
    expect(sent[0]).toMatchObject({ to: "no.link@northwind.example" });
    expect(sent[0].link).toMatch(/^#\/invite\//);
    await expect(company.acceptInvite(env.db, { token: sent[0].link.split("/").pop(), expertise_tags: ["ml"], self_reported_activity: "weekly", consents: { react: true, comment: true, ai_processing: true } }, null, true)).rejects.toThrow(/Войдите/);
    const inv: any = await company.createInvite(leader, env.db, cid, { email: "sara.n@northwind.example", display_name: "Sara Nilsson (Backend Engineer)", timezone: "Europe/Stockholm" }, { exposeLink: true });
    const token = inv.invite_link.split("/").pop();
    expect((await env.db.query("SELECT count(*)::int n FROM employee_invites WHERE token_hash = $1", [token])).rows[0].n).toBe(0);
    const prev: any = await company.invitePreview(env.db, token);
    expect(prev.leader_does_not_see).toContain("ваши пропуски и отказы");
    const r: any = await company.acceptInvite(env.db, { token, expertise_tags: ["Kubernetes", "data"], self_reported_activity: "weekly", consents: { react: true, comment: true, ai_processing: false } });
    expect(r.employment_verified).toBe(true);
    const consents = (await env.db.query("SELECT action_scope, granted_by_user_id FROM consents WHERE account_id = $1 ORDER BY action_scope", [r.account_id])).rows;
    expect(consents).toEqual([{ action_scope: "comment", granted_by_user_id: r.user_id }, { action_scope: "react", granted_by_user_id: r.user_id }]);
    await expect(company.acceptInvite(env.db, { token, expertise_tags: ["x1"], self_reported_activity: "weekly", consents: { react: true, comment: true, ai_processing: true } })).rejects.toThrow(/недействительно/);
    const list: any[] = await company.listInvites(leader, env.db, cid);
    expect(list[0]).not.toHaveProperty("token_hash");
    expect(list.find((x: any) => x.email === "sara.n@northwind.example").status).toBe("accepted");
    const other: any = await company.createInvite(leader, env.db, cid, { email: "guest@gmail.com", display_name: "Подрядчик" }, { exposeLink: true });
    const t2 = other.invite_link.split("/").pop();
    const r2: any = await company.acceptInvite(env.db, { token: t2, expertise_tags: ["ml"], self_reported_activity: "rare", consents: { react: true, comment: false, ai_processing: false } });
    expect(r2.employment_verified).toBe(false);
  });
});

describe("исправления итогового аудита кода", () => {
  it("руководитель не открывает черновики и материалы личных аккаунтов сотрудников, только страницу компании", async () => {
    const { contentDetail } = await import("../src/services/content");
    const anna = (await env.db.query("SELECT id, client_id FROM managed_accounts WHERE display_name LIKE 'Anna%'")).rows[0];
    const it = (await env.db.query("INSERT INTO content_items(client_id, account_id, title, state) VALUES ($1,$2,'Черновик Anna','draft') RETURNING id", [anna.client_id, anna.id])).rows[0];
    await expect(contentDetail(await env.ctx("leader"), it.id)).rejects.toThrow(/не найден/);
    expect((await contentDetail(await env.ctx("leader"), await pagePost())).item.id).toBeTruthy();
  });

  it("согласие сотрудника не может дать ни агентство, ни работодатель", async () => {
    const anna = (await env.db.query("SELECT id FROM managed_accounts WHERE display_name LIKE 'Anna%'")).rows[0];
    await expect(acc.grantConsent(await env.ctx("manager"), anna.id, { action_scope: "comment", granted_by_name: "Менеджер", evidence_ref: "x" })).rejects.toThrow(/владелец/);
  });

  it("признак «пост компании» не принимается на слово: AI не готовит черновик к чужой ссылке", async () => {
    const r = await missions.createMission(await env.ctx("leader"), { systemDb: env.db }, await northwind(), { type: "amplify_post", title: "Чужой пост под видом своего", target_url: "https://www.linkedin.com/feed/update/urn:li:activity:7399999999999999999/", target_is_company_post: true, target_excerpt: "ml models telemetry data", topic_tags: ["ml"] });
    expect((await env.db.query("SELECT target_is_company_post FROM agent_missions WHERE id = $1", [r.mission.id])).rows[0].target_is_company_post).toBe(false);
  });

  it("после восстановления агентством прежние сигналы не исключают аккаунт снова", async () => {
    const anna = (await env.db.query("SELECT id FROM managed_accounts WHERE display_name LIKE 'Anna%'")).rows[0].id;
    const t0 = Date.now() - 5000;
    for (const [i, k] of ["warning", "captcha", "restriction"].entries()) await recordSignal(env.db, { accountId: anna, kind: k, source: "agency", dedupe: `r${i}` }, new Date(t0 + i * 1000));
    await company.restoreAccount(await env.ctx("manager"), env.db, anna);
    const r: any = await recordSignal(env.db, { accountId: anna, kind: "warning", source: "agency", dedupe: "after" });
    expect(r.excluded).toBe(false);
  });

  it("решение по предложению после остановки компании не проходит", async () => {
    const { mission } = await amplify();
    const row = (await env.db.query("SELECT ma.id, m.user_id FROM mission_actions ma JOIN memberships m ON m.scope_account_id = ma.account_id AND m.role = 'client' WHERE ma.mission_id = $1 AND ma.kind = 'react'", [mission.id])).rows[0];
    await company.pauseCompany(await env.ctx("leader"), env.db, await northwind(), { paused: true, reason: "Проверка формулировок" });
    await expect(missions.decideAction(await ctxOf(row.user_id), env.db, row.id, { decision: "approve" })).rejects.toThrow(/обработано|остановлено/);
  });

  it("скользящее окно: 23:50 и 00:05 считаются в одних сутках", async () => {
    const { maxInWindow } = await import("../src/agents/officer");
    const t = Date.parse("2026-10-15T00:05:00Z");
    expect(maxInWindow([Date.parse("2026-10-14T23:50:00Z"), Date.parse("2026-10-14T23:55:00Z")], t, 864e5)).toBe(2);
    expect(maxInWindow([Date.parse("2026-10-13T00:00:00Z")], t, 864e5)).toBe(0);
  });
});

