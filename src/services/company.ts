import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/db";
import { assertAccountOwner, audit, ConflictError, isInternal, NotFoundError, requireOp, ValidationError, type Ctx } from "./context";
import { ForbiddenError } from "../core/permissions";
import { isValidTimeZone } from "../core/time";
import { limitsFor, riskScore, LIMITS, type ActionKind } from "../core/safety";
import { loadSafety, usageAround } from "../agents/officer";
import { companyHealth, recordSignal } from "../agents/orchestrator";
import { writeCapabilities } from "./accounts";
import type { Mailer } from "./notify";

/**
 * Компания клиента: бриф, сводка для руководителя, приглашения сотрудников, аварийная остановка,
 * профиль участия сотрудника и сигналы LinkedIn. Руководитель видит агрегаты; персональные данные
 * участия видит только сам сотрудник и команда агентства.
 */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const K = 5;
/** Ячейки меньше K объединяются в «меньше 5». */
function suppress(levels: Record<string, number>) {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(levels)) out[k] = v >= K ? v : "<5";
  return out;
}

async function clientOf(ctx: Ctx, clientId: string) {
  const c = (await ctx.db.query("SELECT id, name, status, engagement_paused_at, engagement_paused_reason FROM clients WHERE id = $1 AND agency_id = $2", [clientId, ctx.actor.agency_id])).rows[0];
  if (!c) throw new NotFoundError("Компания не найдена");
  requireOp(ctx, "view_company", { clientId });
  return c;
}

/** Компании, доступные пользователю: руководителю его компания, агентству все. */
export async function listCompanies(ctx: Ctx) {
  return (await ctx.db.query("SELECT id, name, status FROM clients WHERE agency_id = $1 ORDER BY name", [ctx.actor.agency_id])).rows
    .filter((c: any) => ctx.actor.memberships.some((m) => !m.revoked_at && (m.role === "client_admin" ? m.scope_client_id === c.id : m.role !== "client" && m.role !== "auditor" && (!m.scope_client_id || m.scope_client_id === c.id) && !m.scope_account_id)));
}

/** Первый экран руководителя: «как нас видят», команда (агрегаты), решения, риски, миссии. */
export async function companyOverview(ctx: Ctx, systemDb: Db, clientId: string) {
  const c = await clientOf(ctx, clientId);
  const internal = isInternal(ctx, { clientId });
  const health = await companyHealth(systemDb, clientId);
  const page = (await systemDb.query(`
    SELECT a.id, a.display_name, a.profile_url,
      (SELECT value::float FROM metric_snapshots s WHERE s.account_id = a.id AND s.metric_key = 'followers' AND s.value IS NOT NULL ORDER BY observed_at DESC LIMIT 1) AS followers,
      (SELECT value::float FROM metric_snapshots s WHERE s.account_id = a.id AND s.metric_key = 'followers' AND s.value IS NOT NULL AND observed_at <= now() - interval '30 days' ORDER BY observed_at DESC LIMIT 1) AS followers_30d_ago,
      (SELECT count(*)::int FROM external_publications ep WHERE ep.account_id = a.id AND ep.published_at > now() - interval '30 days') AS posts_30d,
      (SELECT extract(day FROM now() - max(ep.published_at))::int FROM external_publications ep WHERE ep.account_id = a.id) AS days_since_post
      FROM managed_accounts a WHERE a.client_id = $1 AND a.kind = 'company_page' LIMIT 1`, [clientId])).rows[0] ?? null;
  const hiring = (await systemDb.query("SELECT count(*)::int n FROM agent_missions WHERE client_id = $1 AND type = 'hiring' AND status IN ('planned','active')", [clientId])).rows[0].n;
  const briefs = (await systemDb.query("SELECT id, version, status, industry, positioning, topics, forbidden_topics, disclosure_mode, disclosure_text, compliance_approved_at, intensity, email_domains, created_at, approved_at FROM company_briefs WHERE client_id = $1 ORDER BY version DESC LIMIT 5", [clientId])).rows;
  const decisions: { kind: string; title: string; link?: string }[] = [];
  const pageApprovals = (await systemDb.query(`SELECT ci.id, ci.title FROM approval_requests r JOIN content_items ci ON ci.id = r.content_item_id JOIN managed_accounts a ON a.id = ci.account_id
     WHERE a.client_id = $1 AND a.kind = 'company_page' AND r.stage = 'client' AND r.status = 'pending' ORDER BY r.created_at LIMIT 3`, [clientId])).rows;
  for (const p of pageApprovals) decisions.push({ kind: "approve_page_post", title: `Согласовать пост страницы: ${p.title}`, link: `#/content/${p.id}` });
  if (briefs[0]?.status === "draft") decisions.push({ kind: "brief", title: internal ? "Утвердить новую версию брифа компании" : "Новая версия брифа ждёт утверждения агентства" });
  if (!briefs.some((b: any) => b.status === "approved")) decisions.push({ kind: "brief_missing", title: "Заполнить бриф компании: без него агенты не работают" });
  // Распределение риска только агрегатом и только при группе от 5 человек.
  const accounts = (await systemDb.query(`SELECT a.id, a.display_name, a.timezone, p.expertise_tags, p.employment_verified_at, p.frequency FROM managed_accounts a LEFT JOIN employee_profiles p ON p.account_id = a.id
     WHERE a.client_id = $1 AND a.kind <> 'company_page' AND a.status = 'active' ORDER BY a.display_name`, [clientId])).rows;
  const now = new Date();
  const perAccount = [];
  for (const a of accounts) {
    const s = await loadSafety(systemDb, a.id);
    const used = await usageAround(systemDb, a.id, "comment", now);
    const lim = limitsFor(s, "comment", now);
    const risk = riskScore({ state: s, now, usedRatio: lim.day ? used.day / lim.day : 1 });
    perAccount.push({ account_id: a.id, display_name: a.display_name, level: risk.level, score: risk.score, reasons: risk.reasons, mode: lim.mode, verified: !!a.employment_verified_at, expertise: a.expertise_tags ?? [], frequency: a.frequency ?? null });
  }
  const levels = perAccount.reduce((acc: Record<string, number>, x) => ({ ...acc, [x.level]: (acc[x.level] ?? 0) + 1 }), {});
  const missions = (await systemDb.query(`
    SELECT m.id, m.type, m.title, m.status, m.window_start, m.window_end, m.blocked_reasons, m.created_at,
           count(ma.*) FILTER (WHERE ma.status = 'done')::int AS done, count(ma.*)::int AS total
      FROM agent_missions m LEFT JOIN mission_actions ma ON ma.mission_id = m.id
     WHERE m.client_id = $1 GROUP BY m.id ORDER BY m.created_at DESC LIMIT 30`, [clientId])).rows;
  const missionsOut = internal ? missions : missions.map((m: any) => ({ ...m, done: m.total >= K ? m.done : null, total: m.total >= K ? m.total : null }));
  return {
    company: c, internal,
    seen_from_outside: page ? { page_name: page.display_name, page_url: page.profile_url, followers: page.followers, followers_delta_30d: page.followers != null && page.followers_30d_ago != null ? page.followers - page.followers_30d_ago : null, posts_30d: page.posts_30d, days_since_post: page.days_since_post, open_roles: hiring } : null,
    team: { connected: health.connected, verified: health.verified, invites_pending: health.invites_pending, active_30d: health.active_30d, hidden_below: K },
    // Руководителю: без ячеек меньше 5 и без точных счётчиков сигналов, по которым вычисляется конкретный человек.
    risk: internal
      ? { distribution: levels, signals_7d: health.signals_7d, accounts_paused: health.accounts_paused }
      : { distribution: accounts.length >= K ? suppress(levels) : null, signals_7d: null, accounts_paused: null, status: health.signals_7d || health.accounts_paused ? "attention" : "ok" },
    decisions: decisions.slice(0, 3),
    briefs, missions: missionsOut,
    // Персональная таблица только команде агентства.
    accounts: internal ? perAccount : null,
  };
}

const TopicSchema = z.object({ tag: z.string().min(2).max(40), weight: z.number().min(0.1).max(3).default(1), keywords: z.array(z.string().min(2).max(40)).max(20).default([]) });
const BriefInput = z.object({
  industry: z.enum(["general", "crypto", "fin", "health"]).default("general"),
  positioning: z.string().min(10).max(2000),
  topics: z.array(TopicSchema).min(1).max(30),
  forbidden_topics: z.array(z.string().min(2).max(80)).max(50).default([]),
  disclosure_mode: z.enum(["profile", "inline"]).default("profile"),
  disclosure_text: z.string().min(2).max(60).default("#employee"),
  disclaimers: z.record(z.string(), z.string().max(500)).default({}),
  licenses: z.array(z.object({ regulator: z.string(), number: z.string(), jurisdiction: z.string() })).default([]),
  target_countries: z.array(z.string().length(2)).default([]),
  compliance_owner: z.string().max(200).optional(),
  compliance_ref: z.string().max(500).optional(),
  intensity: z.enum(["low", "normal"]).default("low"),
  email_domains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)).max(10).default([]),
  autopilot_review: z.enum(["auto", "company"]).default("auto"),
});

/** Новая версия брифа. Правку руководителя утверждает агентство; бриф для регулируемой отрасли требует compliance. */
export async function proposeBrief(ctx: Ctx, clientId: string, input: unknown) {
  await clientOf(ctx, clientId);
  requireOp(ctx, "direct_agents", { clientId });
  const d = BriefInput.parse(input);
  if ((d.industry === "crypto" || d.industry === "fin") && d.disclosure_mode !== "inline") d.disclosure_mode = "inline";
  // Регулируемая отрасль: посты автопилота всегда проверяет компания.
  if (d.industry === "crypto" || d.industry === "fin") d.autopilot_review = "company";
  return ctx.db.tx(async (q) => {
    const v = (await q.query("SELECT coalesce(max(version), 0) + 1 AS v FROM company_briefs WHERE client_id = $1", [clientId])).rows[0].v;
    await q.query("UPDATE company_briefs SET status = 'superseded' WHERE client_id = $1 AND status = 'draft'", [clientId]);
    const b = (await q.query(
      `INSERT INTO company_briefs(client_id, version, industry, positioning, topics, forbidden_topics, disclosure_mode, disclosure_text, disclaimers, licenses, target_countries, compliance_owner, compliance_ref, intensity, email_domains, created_by, autopilot_review)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [clientId, v, d.industry, d.positioning, JSON.stringify(d.topics), d.forbidden_topics, d.disclosure_mode, d.disclosure_text, JSON.stringify(d.disclaimers), JSON.stringify(d.licenses), d.target_countries, d.compliance_owner ?? null, d.compliance_ref ?? null, d.intensity, d.email_domains.map((x) => x.toLowerCase()), ctx.actor.id, d.autopilot_review])).rows[0];
    await audit(q, ctx, { action: "brief.proposed", entity_type: "company_brief", entity_id: b.id, client_id: clientId, details: { version: v, industry: d.industry } });
    return b;
  });
}

/** Утверждение брифа агентством. compliance отмечается отдельно, со ссылкой на документ клиента. */
export async function approveBrief(ctx: Ctx, briefId: string, input: unknown) {
  const d = z.object({ compliance_approved: z.boolean().default(false), compliance_ref: z.string().max(500).optional() }).parse(input ?? {});
  const b = (await ctx.db.query("SELECT * FROM company_briefs WHERE id = $1", [briefId])).rows[0];
  if (!b) throw new NotFoundError("Бриф не найден");
  if (!isInternal(ctx, { clientId: b.client_id })) throw new ForbiddenError("approve_brief", "Бриф утверждает команда агентства");
  requireOp(ctx, "edit_strategy", { clientId: b.client_id });
  if (b.status !== "draft") throw new ConflictError("Утвердить можно только черновик брифа");
  if (d.compliance_approved && !d.compliance_ref && !b.compliance_ref) throw new ValidationError("Укажите документ compliance клиента");
  return ctx.db.tx(async (q) => {
    await q.query("UPDATE company_briefs SET status = 'superseded' WHERE client_id = $1 AND status = 'approved'", [b.client_id]);
    const r = (await q.query(`UPDATE company_briefs SET status = 'approved', approved_by = $2, approved_at = now(),
        compliance_approved_at = CASE WHEN $3::boolean THEN now() ELSE compliance_approved_at END, compliance_ref = coalesce($4, compliance_ref) WHERE id = $1 RETURNING *`,
      [briefId, ctx.actor.id, d.compliance_approved, d.compliance_ref ?? null])).rows[0];
    await audit(q, ctx, { action: "brief.approved", entity_type: "company_brief", entity_id: briefId, client_id: b.client_id, details: { version: b.version, compliance: d.compliance_approved } });
    return r;
  });
}

/** Аварийная остановка компании: ставят руководитель и агентство, снимает только агентство. */
export async function pauseCompany(ctx: Ctx, systemDb: Db, clientId: string, input: unknown) {
  const d = z.object({ paused: z.boolean(), reason: z.string().min(3).max(500).optional() }).parse(input);
  await clientOf(ctx, clientId);
  requireOp(ctx, "direct_agents", { clientId });
  if (!d.paused && !isInternal(ctx, { clientId })) throw new ForbiddenError("resume", "Снять остановку может только команда агентства после разбора причины");
  if (d.paused && !d.reason) throw new ValidationError("Укажите причину остановки");
  const r = await systemDb.tx(async (q) => {
    if (d.paused) {
      await q.query("UPDATE clients SET engagement_paused_at = now(), engagement_paused_by = $2, engagement_paused_reason = $3 WHERE id = $1", [clientId, ctx.actor.id, d.reason]);
      const stopped = await q.query("UPDATE mission_actions SET status = 'blocked', veto_codes = array_append(veto_codes, 'company_paused') WHERE client_id = $1 AND status IN ('awaiting_owner','approved') RETURNING id", [clientId]);
      return { stopped: stopped.rows.length };
    }
    await q.query("UPDATE clients SET engagement_paused_at = NULL, engagement_paused_by = NULL, engagement_paused_reason = NULL WHERE id = $1", [clientId]);
    return { stopped: 0 };
  });
  await audit(systemDb, ctx, { action: d.paused ? "company.engagement_paused" : "company.engagement_resumed", entity_type: "client", entity_id: clientId, client_id: clientId, details: { stopped: r.stopped, has_reason: !!d.reason } });
  return { paused: d.paused, ...r };
}

/* ---------- Приглашения сотрудников ---------- */
const InviteInput = z.object({ email: z.string().email().max(200), display_name: z.string().min(2).max(120), title: z.string().max(120).optional(), timezone: z.string().optional() });

/**
 * Приглашение реального сотрудника. Аккаунт LinkedIn сотрудник подключает сам; платформа не создаёт профили.
 * Токен: 32 байта, хранится только хешем, одноразовый, 72 часа.
 */
export async function createInvite(ctx: Ctx, systemDb: Db, clientId: string, input: unknown, opts: { mailer?: Mailer; exposeLink?: boolean; appUrl?: string } = {}) {
  await clientOf(ctx, clientId);
  requireOp(ctx, "manage_company_team", { clientId });
  const d = InviteInput.parse(input);
  const tz = d.timezone && isValidTimeZone(d.timezone) ? d.timezone : "UTC";
  const recent = (await systemDb.query("SELECT count(*)::int n FROM employee_invites WHERE client_id = $1 AND created_at > now() - interval '1 hour'", [clientId])).rows[0].n;
  if (recent >= 50) throw Object.assign(new Error("Слишком много приглашений за час"), { status: 429 });
  const token = randomBytes(32).toString("base64url");
  const r = await systemDb.tx(async (q) => {
    const exists = (await q.query("SELECT u.id FROM users u WHERE lower(u.email) = lower($1)", [d.email])).rows[0];
    // Нейтральный ответ: по нему нельзя перебором узнать, есть ли адрес в системе.
    if (exists) throw new ConflictError("Не удалось создать приглашение для этого адреса: обратитесь к менеджеру агентства");
    const u = (await q.query("INSERT INTO users(agency_id, email, display_name, is_active, languages) VALUES ($1,$2,$3,false,'{}') RETURNING id", [ctx.actor.agency_id, d.email.toLowerCase(), d.display_name])).rows[0];
    const manager = (await q.query("SELECT manager_id FROM managed_accounts WHERE client_id = $1 AND manager_id IS NOT NULL LIMIT 1", [clientId])).rows[0]?.manager_id ?? null;
    const a = (await q.query("INSERT INTO managed_accounts(client_id, kind, display_name, primary_language, timezone, manager_id, status) VALUES ($1,'employee',$2,'en',$3,$4,'onboarding') RETURNING id", [clientId, d.display_name, tz, manager])).rows[0];
    await q.query("INSERT INTO memberships(user_id, agency_id, role, scope_account_id) VALUES ($1,$2,'client',$3)", [u.id, ctx.actor.agency_id, a.id]);
    await q.query("INSERT INTO employee_profiles(account_id, client_id) VALUES ($1,$2)", [a.id, clientId]);
    await q.query("INSERT INTO account_safety(account_id, client_id) VALUES ($1,$2)", [a.id, clientId]);
    await writeCapabilities(q, a.id, clientId, "employee", "none", [], "invite");
    const inv = (await q.query(
      "INSERT INTO employee_invites(agency_id, client_id, email, display_name, title, token_hash, expires_at, created_by, user_id, account_id) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '72 hours', $7,$8,$9) RETURNING id, expires_at",
      [ctx.actor.agency_id, clientId, d.email.toLowerCase(), d.display_name, d.title ?? null, sha(token), ctx.actor.id, u.id, a.id])).rows[0];
    return inv;
  });
  await audit(systemDb, ctx, { action: "invite.created", entity_type: "employee_invite", entity_id: r.id, client_id: clientId, details: {} });
  // Ссылка уходит сотруднику письмом. Создателю она не показывается: иначе руководитель мог бы принять приглашение и дать согласия за сотрудника.
  const link = `#/invite/${token}`;
  if (opts.mailer) await opts.mailer.send({ to: d.email.toLowerCase(), subject: "Приглашение в команду компании в LinkedIn OS", text: `${d.display_name}, вас пригласили подключить свой аккаунт LinkedIn. Ссылка действует 72 часа.`, link }).catch(() => {});
  return { invite_id: r.id, expires_at: r.expires_at, sent_to: d.email.toLowerCase(), ...(opts.exposeLink ? { invite_link: link, dev_note: "Ссылка показана только в демо-режиме" } : {}) };
}

export async function listInvites(ctx: Ctx, systemDb: Db, clientId: string) {
  await clientOf(ctx, clientId);
  requireOp(ctx, "manage_company_team", { clientId });
  return (await systemDb.query(`SELECT id, email, display_name, title, created_at, expires_at, used_at, revoked_at,
      CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN used_at IS NOT NULL THEN 'accepted' WHEN expires_at < now() THEN 'expired' ELSE 'pending' END AS status
      FROM employee_invites WHERE client_id = $1 ORDER BY created_at DESC LIMIT 200`, [clientId])).rows;
}

export async function revokeInvite(ctx: Ctx, systemDb: Db, inviteId: string) {
  const inv = (await systemDb.query("SELECT * FROM employee_invites WHERE id = $1 AND agency_id = $2", [inviteId, ctx.actor.agency_id])).rows[0];
  if (!inv) throw new NotFoundError("Приглашение не найдено");
  await clientOf(ctx, inv.client_id);
  requireOp(ctx, "manage_company_team", { clientId: inv.client_id });
  await systemDb.query("UPDATE employee_invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL", [inviteId]);
  await audit(systemDb, ctx, { action: "invite.revoked", entity_type: "employee_invite", entity_id: inviteId, client_id: inv.client_id });
  return { ok: true };
}

/** Что увидит сотрудник до принятия: компания и что видит руководитель. Без токена в ответе. */
export async function invitePreview(systemDb: Db, token: string) {
  const inv = (await systemDb.query(`SELECT i.display_name, i.title, i.expires_at, i.used_at, i.revoked_at, c.name AS company FROM employee_invites i JOIN clients c ON c.id = i.client_id WHERE i.token_hash = $1`, [sha(token)])).rows[0];
  if (!inv || inv.revoked_at || inv.used_at || new Date(inv.expires_at) < new Date()) throw new NotFoundError("Приглашение недействительно или истекло");
  return { company: inv.company, display_name: inv.display_name, title: inv.title, expires_at: inv.expires_at, leader_sees: ["подключён ли аккаунт", "общие цифры участия команды (от 5 человек)"], leader_does_not_see: ["ваши пропуски и отказы", "ваш уровень риска", "черновики до публикации", "сообщения о предупреждениях LinkedIn"] };
}

const AcceptInput = z.object({
  token: z.string().min(20).max(100),
  expertise_tags: z.array(z.string().min(2).max(40)).min(1).max(5),
  frequency: z.enum(["weekly", "biweekly"]).default("weekly"),
  self_reported_activity: z.enum(["rare", "weekly", "daily"]),
  consents: z.object({ react: z.boolean(), comment: z.boolean(), ai_processing: z.boolean() }),
  linkedin_profile_url: z.string().url().refine((u) => /^https:\/\/([a-z]+\.)?linkedin\.com\/in\//i.test(u), "Нужна ссылка на ваш профиль linkedin.com/in/…").optional(),
});

/** Принятие приглашения: атомарно, один раз. Согласия даёт сам сотрудник; подтверждение трудоустройства по домену почты или HR. */
export async function acceptInvite(systemDb: Db, input: unknown, authenticatedUserId?: string | null, requireAuth = false) {
  const d = AcceptInput.parse(input);
  if (requireAuth && !authenticatedUserId) throw Object.assign(new Error("Войдите под рабочей почтой, на которую пришло приглашение"), { status: 401 });
  return systemDb.tx(async (q) => {
    const inv = (await q.query("UPDATE employee_invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING *", [sha(d.token)])).rows[0];
    if (!inv) throw new NotFoundError("Приглашение недействительно или истекло");
    if (authenticatedUserId && authenticatedUserId !== inv.user_id) throw new ForbiddenError("invite", "Приглашение выдано другому пользователю");
    await q.query("UPDATE users SET is_active = true WHERE id = $1", [inv.user_id]);
    const brief = (await q.query("SELECT email_domains FROM company_briefs WHERE client_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1", [inv.client_id])).rows[0];
    const domain = inv.email.split("@")[1];
    const byDomain = !!brief?.email_domains?.includes(domain);
    await q.query(`UPDATE employee_profiles SET expertise_tags = $2, frequency = $3, self_reported_activity = $4,
        employment_verified_at = CASE WHEN $5::boolean THEN now() ELSE NULL END, verification_method = CASE WHEN $5::boolean THEN 'email_domain' ELSE NULL END, updated_at = now() WHERE account_id = $1`,
      [inv.account_id, d.expertise_tags.map((t) => t.toLowerCase()), d.frequency, d.self_reported_activity, byDomain]);
    await q.query("UPDATE managed_accounts SET status = 'active', profile_url = coalesce($2, profile_url) WHERE id = $1", [inv.account_id, d.linkedin_profile_url ?? null]);
    await q.query("UPDATE account_safety SET ramp_started_at = now() WHERE account_id = $1", [inv.account_id]);
    for (const [scope, on] of Object.entries(d.consents)) {
      if (on) await q.query("INSERT INTO consents(client_id, account_id, action_scope, granted_by_name, evidence_ref, granted_by_user_id) VALUES ($1,$2,$3,$4,$5,$6)", [inv.client_id, inv.account_id, scope, inv.display_name, `Приглашение ${inv.id}: согласие в платформе`, inv.user_id]);
    }
    await q.query("INSERT INTO audit_events(agency_id, client_id, account_id, actor_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,'invite.accepted','employee_invite',$5,$6)",
      [inv.agency_id, inv.client_id, inv.account_id, inv.user_id, inv.id, JSON.stringify({ verified_by_domain: byDomain, consents: Object.keys(d.consents).filter((k) => (d.consents as any)[k]) })]);
    return { user_id: inv.user_id, account_id: inv.account_id, employment_verified: byDomain };
  });
}

/** Подтверждение трудоустройства руководителем (HR) или агентством. */
export async function confirmEmployment(ctx: Ctx, systemDb: Db, accountId: string) {
  const a = (await systemDb.query("SELECT a.id, a.client_id FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = $1 AND c.agency_id = $2", [accountId, ctx.actor.agency_id])).rows[0];
  if (!a) throw new NotFoundError("Аккаунт не найден");
  requireOp(ctx, "manage_company_team", { clientId: a.client_id });
  const kind = (await systemDb.query("SELECT kind FROM managed_accounts WHERE id = $1", [accountId])).rows[0]?.kind;
  if (kind !== "employee") throw new ValidationError("Подтверждение трудоустройства относится к аккаунтам сотрудников");
  const u = await systemDb.query("UPDATE employee_profiles SET employment_verified_at = now(), employment_verified_by = $2, verification_method = 'hr_confirmation', updated_at = now() WHERE account_id = $1 RETURNING account_id", [accountId, ctx.actor.id]);
  if (!u.rows.length) throw new NotFoundError("Профиль участия не найден");
  await audit(systemDb, ctx, { action: "employee.employment_confirmed", entity_type: "managed_account", entity_id: accountId, client_id: a.client_id, account_id: accountId });
  return { ok: true };
}

/* ---------- Сотрудник: свой профиль участия ---------- */
export async function myParticipation(ctx: Ctx) {
  const ids = ctx.actor.memberships.filter((m) => m.role === "client" && m.scope_account_id && !m.revoked_at).map((m) => m.scope_account_id as string);
  if (!ids.length) return { accounts: [] };
  const now = new Date();
  const out = [];
  for (const id of ids) {
    const a = (await ctx.db.query("SELECT a.id, a.display_name, a.kind, a.timezone, c.name AS company FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = $1", [id])).rows[0];
    if (!a || a.kind === "company_page") continue;
    const p = (await ctx.db.query("SELECT expertise_tags, frequency, paused_until, self_reported_activity, employment_verified_at, verification_method FROM employee_profiles WHERE account_id = $1", [id])).rows[0] ?? null;
    const s = await loadSafety(ctx.db, id);
    const limits: Record<string, unknown> = {};
    let maxRatio = 0;
    for (const k of Object.keys(LIMITS) as ActionKind[]) {
      const lim = limitsFor(s, k, now);
      const used = await usageAround(ctx.db, id, k, now);
      if (lim.day) maxRatio = Math.max(maxRatio, used.day / lim.day);
      limits[k] = { ...lim, used };
    }
    const risk = riskScore({ state: s, now, usedRatio: maxRatio });
    const consents = (await ctx.db.query("SELECT action_scope, granted_at, revoked_at FROM consents WHERE account_id = $1 ORDER BY granted_at DESC", [id])).rows;
    out.push({ account: a, profile: p, risk, limits, cooldown_until: s.cooldownUntil, half_until: s.halfUntil, excluded: s.excluded, consents });
  }
  return { accounts: out };
}

const ProfileInput = z.object({
  expertise_tags: z.array(z.string().min(2).max(40)).min(1).max(5).optional(),
  frequency: z.enum(["weekly", "biweekly", "paused"]).optional(),
  pause_days: z.number().int().min(1).max(90).optional(),
  self_reported_activity: z.enum(["rare", "weekly", "daily"]).optional(),
});
export async function updateMyProfile(ctx: Ctx, accountId: string, input: unknown) {
  assertAccountOwner(ctx, accountId);
  const d = ProfileInput.parse(input);
  const r = await ctx.db.query(`UPDATE employee_profiles SET expertise_tags = coalesce($2, expertise_tags), frequency = coalesce($3, frequency),
      paused_until = CASE WHEN $4::int IS NULL THEN paused_until ELSE now() + make_interval(days => $4::int) END,
      self_reported_activity = coalesce($5, self_reported_activity), expertise_confirmed_at = CASE WHEN $2::text[] IS NULL THEN expertise_confirmed_at ELSE NULL END, updated_at = now()
     WHERE account_id = $1 RETURNING account_id`, [accountId, d.expertise_tags?.map((t) => t.toLowerCase()) ?? null, d.frequency ?? null, d.pause_days ?? null, d.self_reported_activity ?? null]);
  if (!r.rows.length) throw new NotFoundError("Профиль участия не найден");
  if (d.pause_days || d.frequency === "paused") await ctx.db.query("UPDATE mission_actions SET status = 'skipped' WHERE account_id = $1 AND status = 'awaiting_owner'", [accountId]);
  return { ok: true };
}

const SignalInput = z.object({ kind: z.enum(["warning", "captcha", "restriction", "identity_check", "comment_hidden", "token_revoked"]), note: z.string().max(500).optional() });
/** «LinkedIn предупредил»: одна кнопка для сотрудника или менеджера. Мгновенная остановка аккаунта. */
export async function reportSignal(ctx: Ctx, systemDb: Db, accountId: string, input: unknown) {
  const d = SignalInput.parse(input);
  const a = (await systemDb.query("SELECT a.id, a.client_id FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = $1 AND c.agency_id = $2", [accountId, ctx.actor.agency_id])).rows[0];
  if (!a) throw new NotFoundError("Аккаунт не найден");
  const owner = ctx.actor.memberships.some((m) => m.role === "client" && m.scope_account_id === accountId && !m.revoked_at);
  if (!owner && !isInternal(ctx, { clientId: a.client_id, accountId })) throw new ForbiddenError("signal", "Сообщить о сигнале может владелец аккаунта или команда агентства");
  const r = await recordSignal(systemDb, { accountId, kind: d.kind, source: owner ? "owner" : "agency", note: d.note, userId: ctx.actor.id, dedupe: `${d.kind}:${accountId}:${new Date().toISOString().slice(0, 16)}` });
  await audit(systemDb, ctx, { action: "safety.signal_reported", entity_type: "managed_account", entity_id: accountId, client_id: a.client_id, account_id: accountId, details: { kind: d.kind } });
  const managers = (await systemDb.query("SELECT manager_id FROM managed_accounts WHERE id = $1 AND manager_id IS NOT NULL", [accountId])).rows.map((x: any) => x.manager_id);
  const { notify } = await import("./notify");
  await notify(systemDb, { agency_id: ctx.actor.agency_id, client_id: a.client_id, user_ids: managers, kind: "safety.signal", title: "Сигнал LinkedIn по аккаунту сотрудника: действия остановлены", link: `#/accounts/${accountId}`, dedupe: `signal:${(r as any).event_id ?? accountId}` });
  return r;
}

/** Снятие исключения после разбора: только агентство. */
export async function restoreAccount(ctx: Ctx, systemDb: Db, accountId: string) {
  const a = (await systemDb.query("SELECT a.id, a.client_id FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = $1 AND c.agency_id = $2", [accountId, ctx.actor.agency_id])).rows[0];
  if (!a || !isInternal(ctx, { clientId: a.client_id, accountId })) throw new NotFoundError("Аккаунт не найден");
  requireOp(ctx, "manage_connection", { clientId: a.client_id, accountId });
  // Возврат на половинные лимиты на 7 дней, а не сразу на штатные.
  await systemDb.query("UPDATE account_safety SET excluded = false, excluded_reason = NULL, cooldown_until = NULL, half_until = now() + interval '7 days', updated_at = now() WHERE account_id = $1", [accountId]);
  await systemDb.query("INSERT INTO safety_events(client_id, account_id, kind, source, reported_by) VALUES ($1,$2,'restored','agency',$3)", [a.client_id, accountId, ctx.actor.id]);
  await audit(systemDb, ctx, { action: "safety.restored", entity_type: "managed_account", entity_id: accountId, client_id: a.client_id, account_id: accountId });
  return { ok: true };
}

/** Портфель агентства: компании, день онбординга, подключение, риски, просроченные решения. */
export async function portfolio(ctx: Ctx, systemDb: Db) {
  if (!isInternal(ctx)) throw new ForbiddenError("view", "Портфель доступен команде агентства");
  const visible = new Set((await ctx.db.query("SELECT id FROM clients WHERE agency_id = $1", [ctx.actor.agency_id])).rows.map((r: any) => r.id));
  const rows = (await systemDb.query(`SELECT c.id, c.name, c.status, c.engagement_paused_at,
      (SELECT min(created_at) FROM company_briefs b WHERE b.client_id = c.id) AS onboarding_started,
      (SELECT status FROM company_briefs b WHERE b.client_id = c.id ORDER BY version DESC LIMIT 1) AS brief_status
      FROM clients c WHERE c.agency_id = $1 ORDER BY c.name`, [ctx.actor.agency_id])).rows.filter((r: any) => visible.has(r.id));
  const out = [];
  for (const r of rows) {
    const h = await companyHealth(systemDb, r.id);
    const day = r.onboarding_started ? Math.min(14, Math.floor((Date.now() - new Date(r.onboarding_started).getTime()) / 864e5) + 1) : 0;
    out.push({ ...r, onboarding_day: day, ...h });
  }
  return out;
}
