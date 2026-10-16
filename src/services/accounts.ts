import { z } from "zod";
import { accountScope, assertAccountOwner, audit, isAccountOwner, ConflictError, emit, requireOp, ValidationError, visibleAccountsFilter, type Ctx } from "./context";
import { appAccessFromEnv, CAPABILITY_CATALOG, resolveCapabilities, type AccountKind } from "../core/capabilities";
import { isValidTimeZone } from "../core/time";
import { cancelPendingJobs } from "./jobs";
import { STRATEGY_TEMPLATES } from "../core/templates";

export async function listAccounts(ctx: Ctx, filter: { q?: string; attention?: boolean; limit?: number; offset?: number } = {}) {
  const vis = visibleAccountsFilter(ctx, "a", 2);
  const params: unknown[] = [ctx.actor.agency_id, ...vis.params];
  let where = `c.agency_id = $1 AND ${vis.sql}`;
  if (filter.q) { params.push(`%${filter.q}%`); where += ` AND (a.display_name ILIKE $${params.length} OR c.name ILIKE $${params.length})`; }
  params.push(Math.min(filter.limit ?? 100, 500), filter.offset ?? 0);
  const rows = (await ctx.db.query(`
    SELECT a.id, a.display_name, a.kind, a.timezone, a.status, a.publishing_paused, c.id AS client_id, c.name AS client_name,
           u.display_name AS manager_name,
           (SELECT s.playbook->>'goal' FROM strategy_versions s WHERE s.account_id = a.id AND s.status = 'approved' ORDER BY version DESC LIMIT 1) AS goal,
           coalesce((SELECT o.status FROM oauth_connections o WHERE o.account_id = a.id ORDER BY updated_at DESC LIMIT 1), 'none') AS connection_status,
           (SELECT count(*)::int FROM approval_requests r JOIN content_items ci ON ci.id = r.content_item_id WHERE ci.account_id = a.id AND r.status = 'pending') AS pending_approvals,
           (SELECT min(ci.scheduled_at) FROM content_items ci WHERE ci.account_id = a.id AND ci.state = 'scheduled') AS next_publication,
           (SELECT count(*)::int FROM content_items ci WHERE ci.account_id = a.id AND ci.state IN ('failed','publication_unknown')) AS publish_problems,
           (SELECT count(*)::int FROM tasks t WHERE t.account_id = a.id AND t.status IN ('open','in_progress','blocked') AND t.due_at < now()) AS overdue_tasks,
           (SELECT count(*)::int FROM content_items ci WHERE ci.account_id = a.id AND ci.state = 'published' AND ci.updated_at > now() - interval '30 days') AS published_30d,
           (SELECT (s.playbook->>'posts_per_week')::numeric FROM strategy_versions s WHERE s.account_id = a.id AND s.status = 'approved' ORDER BY version DESC LIMIT 1) AS posts_per_week
      FROM managed_accounts a JOIN clients c ON c.id = a.client_id LEFT JOIN users u ON u.id = a.manager_id
     WHERE ${where}
     ORDER BY c.name, a.display_name
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
  // Аккаунт сотрудника ведётся по брифу компании и миссиям агентов, а не по собственной стратегии и контент-плану.
  for (const r of rows) if (r.kind === "employee" && !r.goal) r.goal = "Участник команды компании";
  const out = rows.map((r: any) => ({ ...r, attention_reasons: attentionReasons(r), plan_progress: planProgress(r) }));
  return filter.attention ? out.filter((r) => r.attention_reasons.length) : out;
}

function planProgress(r: any): string {
  if (r.kind === "employee" && r.posts_per_week == null) return "по миссиям компании";
  if (r.posts_per_week == null) return "план не утверждён";
  const planned = Math.round(Number(r.posts_per_week) * 30 / 7);
  return `${r.published_30d} из ${planned} за 30 дней`;
}

export function attentionReasons(r: any): string[] {
  const out: string[] = [];
  if (r.publish_problems) out.push(`Ошибки или неопределённость публикации: ${r.publish_problems}`);
  if (["expired", "revoked", "error"].includes(r.connection_status)) out.push(`Подключение LinkedIn: ${r.connection_status}, нужно переподключение`);
  if (r.connection_status === "expiring") out.push("Подключение скоро истечёт");
  if (r.pending_approvals) out.push(`${r.pending_approvals} материал(а) ожидают согласования`);
  if (r.overdue_tasks) out.push(`Просроченных задач: ${r.overdue_tasks}`);
  if (!r.goal) out.push("Нет утверждённой стратегии");
  if (r.publishing_paused) out.push("Публикация приостановлена");
  return out;
}

const ClientInput = z.object({ name: z.string().min(1), contract_ref: z.string().optional(), service_package: z.string().optional(), monthly_fee: z.number().nonnegative().optional() });
export async function createClient(ctx: Ctx, input: unknown) {
  requireOp(ctx, "manage_clients", {});
  const d = ClientInput.parse(input);
  return ctx.db.tx(async (q) => {
    const c = (await q.query("INSERT INTO clients(agency_id, name, contract_ref, service_package, monthly_fee, status) VALUES ($1,$2,$3,$4,$5,'onboarding') RETURNING *", [ctx.actor.agency_id, d.name, d.contract_ref ?? null, d.service_package ?? null, d.monthly_fee ?? null])).rows[0];
    await audit(q, ctx, { action: "client.created", entity_type: "client", entity_id: c.id, client_id: c.id });
    return c;
  });
}

const AccountInput = z.object({
  client_id: z.string().uuid(),
  kind: z.enum(["executive", "founder", "expert", "employee", "job_seeker", "company_page"]),
  display_name: z.string().min(1),
  profile_url: z.string().url().optional(),
  primary_language: z.string().default("en"),
  timezone: z.string(),
  manager_id: z.string().uuid().optional(),
  confidential_job_search: z.boolean().default(false),
});
export async function createAccount(ctx: Ctx, input: unknown) {
  const d = AccountInput.parse(input);
  requireOp(ctx, "manage_clients", { clientId: d.client_id });
  if (!isValidTimeZone(d.timezone)) throw new ValidationError(`Неизвестный часовой пояс ${d.timezone}`);
  return ctx.db.tx(async (q) => {
    const own = (await q.query("SELECT 1 FROM clients WHERE id = $1 AND agency_id = $2", [d.client_id, ctx.actor.agency_id])).rows[0];
    if (!own) throw new ValidationError("Клиент не найден");
    const a = (await q.query(
      `INSERT INTO managed_accounts(client_id, kind, display_name, profile_url, primary_language, timezone, manager_id, confidential_job_search)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [d.client_id, d.kind, d.display_name, d.profile_url ?? null, d.primary_language, d.timezone, d.manager_id ?? null, d.confidential_job_search])).rows[0];
    await writeCapabilities(q, a.id, a.client_id, a.kind, "none", [], "account_created");
    await audit(q, ctx, { action: "account.created", entity_type: "managed_account", entity_id: a.id, client_id: a.client_id, account_id: a.id });
    return a;
  });
}

export async function writeCapabilities(q: { query: Ctx["db"]["query"] }, accountId: string, clientId: string, kind: AccountKind, status: any, scopes: string[], source: string) {
  const caps = resolveCapabilities({ kind, connectionStatus: status, grantedScopes: scopes }, appAccessFromEnv());
  for (const c of caps) {
    await q.query(
      `INSERT INTO capability_snapshots(client_id, account_id, operation, mode, permission, access_basis, api_version, unavailable_reason, alternative, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [clientId, accountId, c.operation, c.mode, c.permission, c.access_basis, c.api_version, c.unavailable_reason, c.alternative, source]);
  }
  return caps;
}

/** Возможности X-аккаунта: публикация твитов через API при активном подключении, иначе через человека. */
export async function writeXCapability(q: { query: Ctx["db"]["query"] }, accountId: string, clientId: string, connected: boolean) {
  await q.query(`INSERT INTO capability_snapshots(client_id, account_id, operation, mode, permission, access_basis, api_version, unavailable_reason, alternative, source, checked_at)
      VALUES ($1,$2,'publish_post_x',$3,'tweet.write', $4,'2', $5,'Публикация сотрудником вручную','x_oauth', now())`,
    [clientId, accountId, connected ? 'api' : 'assisted', connected ? 'X API v2; scopes: tweet.write users.read offline.access' : null, connected ? null : 'Аккаунт X не подключён через OAuth']);
}

export async function currentCapabilities(q: { query: Ctx["db"]["query"] }, accountId: string) {
  return (await q.query(
    `SELECT DISTINCT ON (operation) operation, mode, permission, access_basis, api_version, checked_at, unavailable_reason, alternative, source
       FROM capability_snapshots WHERE account_id = $1 ORDER BY operation, checked_at DESC, id`, [accountId])).rows;
}

/** Повторная проверка возможностей (при подключении, изменении прав, перед действием). */
export async function refreshCapabilities(ctx: Ctx, accountId: string, source = "manual_refresh") {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "view", { clientId: a.client_id, accountId });
  const conn = (await ctx.db.query("SELECT status, granted_scopes FROM oauth_connections WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 1", [accountId])).rows[0];
  return ctx.db.tx((q) => writeCapabilities(q, accountId, a.client_id, a.kind as AccountKind, conn?.status ?? "none", conn?.granted_scopes ?? [], source));
}

const ConsentInput = z.object({
  action_scope: z.enum(["publish_post", "comment", "react", "analytics_read", "profile_edit_tasks", "ai_processing"]),
  // autopilot_posts и likeness_processing выдаются только через кабинет сотрудника с условиями (services/agent.ts).
  granted_by_name: z.string().min(1),
  evidence_ref: z.string().min(1),
});
export async function grantConsent(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "manage_consent", { clientId: a.client_id, accountId });
  // Согласие за сотрудника не даёт ни работодатель, ни агентство: только владелец аккаунта в платформе.
  if (a.kind === "employee") assertAccountOwner(ctx, accountId);
  const d = ConsentInput.parse(input);
  return ctx.db.tx(async (q) => {
    const c = (await q.query("INSERT INTO consents(client_id, account_id, action_scope, granted_by_name, evidence_ref, granted_by_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [a.client_id, accountId, d.action_scope, d.granted_by_name, d.evidence_ref, ctx.actor.id])).rows[0];
    await audit(q, ctx, { action: "consent.granted", entity_type: "consent", entity_id: c.id, client_id: a.client_id, account_id: accountId, details: { scope: d.action_scope } });
    return c;
  });
}

/** Отзыв согласия: отменяет все ещё не отправленные внешние задания аккаунта. */
export async function revokeConsent(ctx: Ctx, accountId: string, scope: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "manage_consent", { clientId: a.client_id, accountId });
  return ctx.db.tx(async (q) => {
    await q.query("UPDATE consents SET revoked_at = now() WHERE account_id = $1 AND action_scope = $2 AND revoked_at IS NULL", [accountId, scope]);
    let cancelled = 0;
    if (scope === "publish_post") {
      cancelled = (await cancelPendingJobs(q, { accountId }, "consent_revoked", { resetScheduled: true })).length;
    }
    if (scope === "publish_post" || scope === "autopilot_posts") {
      // Автопилот: открытые посты отменяются, агент выключается до нового согласия владельца.
      const { cancelOpenPosts } = await import("./agent");
      cancelled += await cancelOpenPosts(q, accountId, "consent_revoked");
      await q.query("UPDATE personal_agents SET autopilot = 'off', updated_at = now() WHERE account_id = $1", [accountId]);
    }
    await audit(q, ctx, { action: "consent.revoked", entity_type: "consent", client_id: a.client_id, account_id: accountId, details: { scope, cancelled_jobs: cancelled } });
    await emit(q, "consent.revoked", a.client_id, { account_id: accountId, scope });
    return { cancelled_jobs: cancelled };
  });
}

export async function hasConsent(q: { query: Ctx["db"]["query"] }, accountId: string, scope: string) {
  return !!(await q.query("SELECT 1 FROM consents WHERE account_id = $1 AND action_scope = $2 AND revoked_at IS NULL AND paused_at IS NULL", [accountId, scope])).rows[0];
}

/** Подключение OAuth. Токен уже сохранён в менеджере секретов; здесь только ссылка. */
export async function recordOAuthConnection(ctx: Ctx, accountId: string, input: { external_subject: string; granted_scopes: string[]; secret_ref: string; expires_at?: string; organization_urns?: string[] }) {
  const a = await accountScope(ctx.db, ctx, accountId);
  // Сотрудник подключает свой личный профиль сам; страницу компании и чужие аккаунты подключает агентство.
  if (!(a.kind !== "company_page" && isAccountOwner(ctx, accountId))) requireOp(ctx, "manage_connection", { clientId: a.client_id, accountId });
  return ctx.db.tx(async (q) => {
    // Идентичность: личный профиль публикует от имени человека, страница компании только от имени организации,
    // которую подключивший пользователь администрирует (organizationAcls). Чужой профиль не принимается.
    if (!/^urn:li:person:.+/.test(input.external_subject)) throw new ValidationError("Ожидается идентификатор участника LinkedIn (urn:li:person)");
    const expected = (await q.query("SELECT linkedin_urn FROM managed_accounts WHERE id = $1", [accountId])).rows[0]?.linkedin_urn as string | null;
    let identity: string;
    if (a.kind === "company_page") {
      const orgs = (input.organization_urns ?? []).filter((o) => /^urn:li:organization:\d+$/.test(o));
      const org = expected ? (orgs.includes(expected) ? expected : null) : orgs.length === 1 ? orgs[0] : null;
      if (!org) throw new ConflictError(expected
        ? "Подключивший пользователь не является администратором этой страницы компании в LinkedIn"
        : orgs.length > 1 ? "Пользователь администрирует несколько страниц: укажите URN организации в карточке аккаунта и подключите снова" : "Пользователь не администрирует ни одной страницы компании в LinkedIn");
      identity = org;
    } else {
      if (expected && expected !== input.external_subject) throw new ConflictError("Подключён другой профиль LinkedIn: войдите под учётной записью владельца аккаунта");
      identity = input.external_subject;
    }
    await q.query("UPDATE managed_accounts SET linkedin_urn = $2 WHERE id = $1", [accountId, identity]);
    await q.query("UPDATE oauth_connections SET status = 'revoked', updated_at = now() WHERE account_id = $1 AND status IN ('active','expiring')", [accountId]);
    const c = (await q.query(
      "INSERT INTO oauth_connections(client_id, account_id, external_subject, granted_scopes, secret_ref, expires_at, status, connected_by) VALUES ($1,$2,$3,$4,$5,$6,'active',$7) RETURNING id, status, granted_scopes, expires_at",
      [a.client_id, accountId, input.external_subject, input.granted_scopes, input.secret_ref, input.expires_at ?? null, ctx.actor.id])).rows[0];
    const caps = await writeCapabilities(q, accountId, a.client_id, a.kind as AccountKind, "active", input.granted_scopes, "oauth_connected");
    await audit(q, ctx, { action: "connection.created", entity_type: "oauth_connection", entity_id: c.id, client_id: a.client_id, account_id: accountId, details: { scopes: input.granted_scopes, identity } });
    return { connection: c, capabilities: caps, identity };
  });
}

/** Ожидаемая идентичность LinkedIn: URN организации для страницы компании или участника для личного профиля. */
export async function setLinkedInIdentity(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "manage_connection", { clientId: a.client_id, accountId });
  const re = a.kind === "company_page" ? /^urn:li:organization:\d+$/ : /^urn:li:person:[A-Za-z0-9_-]+$/;
  const d = z.object({ linkedin_urn: z.string().regex(re, a.kind === "company_page" ? "Ожидается urn:li:organization:<число>" : "Ожидается urn:li:person:<id>").nullable() }).parse(input);
  return ctx.db.tx(async (q) => {
    await q.query("UPDATE managed_accounts SET linkedin_urn = $2 WHERE id = $1", [accountId, d.linkedin_urn]);
    await audit(q, ctx, { action: "account.identity_set", entity_type: "managed_account", entity_id: accountId, client_id: a.client_id, account_id: accountId, details: { linkedin_urn: d.linkedin_urn } });
    return { linkedin_urn: d.linkedin_urn };
  });
}

export async function markConnectionRevoked(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "manage_connection", { clientId: a.client_id, accountId });
  return ctx.db.tx(async (q) => {
    await q.query("UPDATE oauth_connections SET status = 'revoked', updated_at = now() WHERE account_id = $1 AND status <> 'revoked'", [accountId]);
    await writeCapabilities(q, accountId, a.client_id, a.kind as AccountKind, "revoked", [], "connection_revoked");
    // Сценарий: подключение отозвано → остановить внешние задания и запросить переподключение.
    const r = await q.query("UPDATE publication_jobs SET status = 'awaiting_human', last_error_code = 'connection_revoked', updated_at = now() WHERE account_id = $1 AND status = 'queued' AND mode = 'api' RETURNING id", [accountId]);
    await q.query(`INSERT INTO tasks(client_id, account_id, type, title, definition_of_done, source_ref, priority, priority_reason)
                   VALUES ($1,$2,'reconnect','Переподключить LinkedIn','Владелец прошёл OAuth, возможности обновлены',$3,0.9,'Внешние задания остановлены')
                   ON CONFLICT DO NOTHING`, [a.client_id, accountId, `reconnect:${accountId}`]);
    await emit(q, "connection.revoked", a.client_id, { account_id: accountId }, `revoked:${accountId}:${Date.now()}`);
    await audit(q, ctx, { action: "connection.revoked", entity_type: "managed_account", entity_id: accountId, client_id: a.client_id, account_id: accountId, details: { paused_jobs: r.rows.length } });
    return { paused_jobs: r.rows.length };
  });
}

const StrategyInput = z.object({
  template: z.enum(Object.keys(STRATEGY_TEMPLATES) as [string, ...string[]]),
  playbook: z.object({
    goal: z.string().min(1),
    horizon_weeks: z.number().int().positive().default(12),
    audience: z.string().min(1),
    success_criteria: z.array(z.string()).default([]),
    pillars: z.array(z.string()).min(1),
    posts_per_week: z.number().positive(),
    formats: z.array(z.string()).default(["text"]),
    primary_kpi: z.string(),
    secondary_kpis: z.array(z.string()).default([]),
    review_period_weeks: z.number().int().positive().default(4),
    time_budget_hours_month: z.number().nonnegative().default(10),
    suspension_conditions: z.array(z.string()).default([]),
    posting_windows: z.array(z.string()).default([]),
  }),
  brand_voice: z.record(z.string(), z.unknown()).default({}),
  restrictions: z.object({
    forbidden_topics: z.array(z.string()).default([]),
    needs_personal_approval: z.array(z.string()).default([]),
    allow_self_approval: z.boolean().default(false),
    skip_client_review: z.boolean().default(false),
  }).default({ forbidden_topics: [], needs_personal_approval: [], allow_self_approval: false, skip_client_review: false }),
  change_reason: z.string().optional(),
});
export async function createStrategyVersion(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "edit_strategy", { clientId: a.client_id, accountId });
  const d = StrategyInput.parse(input);
  return ctx.db.tx(async (q) => {
    const v = (await q.query("SELECT coalesce(max(version),0)+1 AS v FROM strategy_versions WHERE account_id = $1", [accountId])).rows[0].v;
    const s = (await q.query(
      "INSERT INTO strategy_versions(client_id, account_id, version, template, playbook, brand_voice, restrictions, change_reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [a.client_id, accountId, v, d.template, JSON.stringify(d.playbook), JSON.stringify(d.brand_voice), JSON.stringify(d.restrictions), d.change_reason ?? null, ctx.actor.id])).rows[0];
    await audit(q, ctx, { action: "strategy.version_created", entity_type: "strategy_version", entity_id: s.id, client_id: a.client_id, account_id: accountId, details: { version: v } });
    return s;
  });
}

export async function approveStrategy(ctx: Ctx, accountId: string, strategyId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "approve_strategy", { clientId: a.client_id, accountId });
  return ctx.db.tx(async (q) => {
    const s = (await q.query("SELECT * FROM strategy_versions WHERE id = $1 AND account_id = $2", [strategyId, accountId])).rows[0];
    if (!s) throw new ValidationError("Версия стратегии не найдена");
    await q.query("UPDATE strategy_versions SET status = 'superseded' WHERE account_id = $1 AND status = 'approved'", [accountId]);
    await q.query("UPDATE strategy_versions SET status = 'approved', approved_by = $2 WHERE id = $1", [strategyId, ctx.actor.id]);
    await q.query("UPDATE managed_accounts SET status = 'active' WHERE id = $1 AND status = 'onboarding'", [accountId]);
    await audit(q, ctx, { action: "strategy.approved", entity_type: "strategy_version", entity_id: strategyId, client_id: a.client_id, account_id: accountId });
    return { ...s, status: "approved" };
  });
}

export async function activeStrategy(q: { query: Ctx["db"]["query"] }, accountId: string) {
  return (await q.query("SELECT * FROM strategy_versions WHERE account_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1", [accountId])).rows[0] ?? null;
}

export async function addKnowledge(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "edit_strategy", { clientId: a.client_id, accountId });
  const d = z.object({ title: z.string().min(1), kind: z.string().default("brief"), body: z.string().min(1), usage_rights: z.enum(["internal_only", "internal_and_ai"]).default("internal_and_ai"),
    claims: z.array(z.object({ statement: z.string().min(1), confirmed_by: z.string().min(1), valid_as_of: z.string() })).default([]) }).parse(input);
  return ctx.db.tx(async (q) => {
    const s = (await q.query("INSERT INTO knowledge_sources(client_id, account_id, title, kind, body, usage_rights, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, title", [a.client_id, accountId, d.title, d.kind, d.body, d.usage_rights, ctx.actor.id])).rows[0];
    for (const c of d.claims) await q.query("INSERT INTO verified_claims(client_id, account_id, statement, source_id, confirmed_by, valid_as_of) VALUES ($1,$2,$3,$4,$5,$6)", [a.client_id, accountId, c.statement, s.id, c.confirmed_by, c.valid_as_of]);
    await audit(q, ctx, { action: "knowledge.added", entity_type: "knowledge_source", entity_id: s.id, client_id: a.client_id, account_id: accountId, details: { claims: d.claims.length } });
    return s;
  });
}

export async function accountWorkspace(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "view", { clientId: a.client_id, accountId });
  const { hasInternalRole } = await import("./portal");
  if (!hasInternalRole(ctx, { clientId: a.client_id, accountId })) throw Object.assign(new Error("Рабочее пространство доступно команде агентства. Клиенту доступен кабинет клиента"), { status: 403 });
  const q = ctx.db;
  const [account, strategies, capabilities, consents, connection, content, tasks, actions, knowledge, claims, metrics, reports] = await Promise.all([
    q.query("SELECT a.*, c.name AS client_name FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = $1", [accountId]).then((r) => r.rows[0]),
    q.query("SELECT id, version, template, playbook, brand_voice, restrictions, status, change_reason, created_at FROM strategy_versions WHERE account_id = $1 ORDER BY version DESC", [accountId]).then((r) => r.rows),
    currentCapabilities(q, accountId).then((rows) => rows.map((c: any) => ({ ...c, label: CAPABILITY_CATALOG.find((x) => x.operation === c.operation)?.label ?? c.operation }))),
    q.query("SELECT id, action_scope, granted_by_name, evidence_ref, granted_at, paused_at, revoked_at FROM consents WHERE account_id = $1 ORDER BY granted_at DESC", [accountId]).then((r) => r.rows),
    q.query("SELECT id, status, granted_scopes, expires_at, updated_at FROM oauth_connections WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 1", [accountId]).then((r) => r.rows[0] ?? null),
    q.query(`SELECT ci.id, ci.title, ci.state, ci.pillar, ci.scheduled_at, ci.scheduled_tz, ci.updated_at, cv.version, cv.body, cv.created_by AS version_author,
                    ep.url AS external_url, ep.evidence_type
               FROM content_items ci LEFT JOIN content_versions cv ON cv.id = ci.current_version_id LEFT JOIN external_publications ep ON ep.content_item_id = ci.id
              WHERE ci.account_id = $1 ORDER BY coalesce(ci.scheduled_at, ci.updated_at) DESC LIMIT 200`, [accountId]).then((r) => r.rows),
    q.query("SELECT t.*, u.display_name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.account_id = $1 ORDER BY (t.status IN ('done','cancelled')), t.due_at NULLS LAST LIMIT 200", [accountId]).then((r) => r.rows),
    q.query("SELECT ar.*, u.display_name AS actor_name FROM action_records ar LEFT JOIN users u ON u.id = ar.actor WHERE ar.account_id = $1 ORDER BY requested_at DESC LIMIT 200", [accountId]).then((r) => r.rows),
    q.query("SELECT id, title, kind, usage_rights, created_at FROM knowledge_sources WHERE account_id = $1 ORDER BY created_at DESC", [accountId]).then((r) => r.rows),
    q.query("SELECT id, statement, confirmed_by, valid_as_of, source_id FROM verified_claims WHERE account_id = $1 ORDER BY created_at DESC", [accountId]).then((r) => r.rows),
    q.query("SELECT ms.*, md.name, md.unit, md.nature FROM metric_snapshots ms JOIN metric_definitions md ON md.key = ms.metric_key WHERE ms.account_id = $1 ORDER BY observed_at DESC LIMIT 200", [accountId]).then((r) => r.rows),
    q.query("SELECT id, kind, period_start, period_end, status, created_at FROM reports WHERE account_id = $1 ORDER BY created_at DESC", [accountId]).then((r) => r.rows),
  ]);
  return { account, strategies, capabilities, consents, connection, content, tasks, actions, knowledge, claims, metrics, reports,
    permissions: [...(await import("../core/permissions")).allowedOperations(ctx.actor.memberships, { clientId: a.client_id, accountId })] };
}

/** Массовое назначение внутренних задач: показывает состав и результат по каждому аккаунту. */
export async function bulkCreateTasks(ctx: Ctx, input: unknown) {
  const d = z.object({ account_ids: z.array(z.string().uuid()).min(1).max(500), title: z.string().min(1), type: z.string().default("internal"), due_at: z.string().optional(), assignee_id: z.string().uuid().optional(), dry_run: z.boolean().default(false) }).parse(input);
  const results: { account_id: string; status: "created" | "would_create" | "error"; task_id?: string; error?: string }[] = [];
  for (const id of d.account_ids) {
    try {
      const a = await accountScope(ctx.db, ctx, id);
      requireOp(ctx, "bulk_action", { clientId: a.client_id, accountId: id });
      if (d.dry_run) { results.push({ account_id: id, status: "would_create" }); continue; }
      const t = (await ctx.db.query("INSERT INTO tasks(client_id, account_id, type, title, due_at, assignee_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [a.client_id, id, d.type, d.title, d.due_at ?? null, d.assignee_id ?? null])).rows[0];
      results.push({ account_id: id, status: "created", task_id: t.id });
    } catch (e: any) {
      results.push({ account_id: id, status: "error", error: e.message });
    }
  }
  await audit(ctx.db, ctx, { action: d.dry_run ? "bulk.tasks_preview" : "bulk.tasks_created", entity_type: "bulk", details: { total: results.length, errors: results.filter((r) => r.status === "error").length } });
  return { results };
}
