import { z } from "zod";
import { accountScope, audit, ConflictError, isInternal, NotFoundError, requireOp, ValidationError, visibleAccountsFilter, type Ctx } from "./context";
import { aggregate, interactionRateByImpressions, type MetricValue } from "../core/metrics";
import { capacityCheck, taskPriority } from "../core/heuristics";
import { agencyWide, can, ForbiddenError } from "../core/permissions";

export async function agencyOverview(ctx: Ctx) {
  const vis = visibleAccountsFilter(ctx, "a", 2);
  const p = [ctx.actor.agency_id, ...vis.params];
  const base = `FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE c.agency_id = $1 AND ${vis.sql}`;
  const one = async (sql: string) => (await ctx.db.query(sql, p)).rows[0];
  const production = await one(`SELECT
      (SELECT count(*)::int ${base}) AS accounts,
      (SELECT count(*)::int FROM content_items ci WHERE ci.account_id IN (SELECT a.id ${base}) AND ci.state = 'scheduled' AND ci.scheduled_at::date = now()::date) AS publications_today,
      (SELECT count(*)::int FROM tasks t WHERE t.account_id IN (SELECT a.id ${base}) AND t.status IN ('open','in_progress','blocked') AND t.due_at < now()) AS overdue_tasks,
      (SELECT count(*)::int FROM approval_requests r JOIN content_items ci ON ci.id = r.content_item_id WHERE ci.account_id IN (SELECT a.id ${base}) AND r.status = 'pending' AND r.created_at < now() - interval '48 hours') AS stale_approvals,
      (SELECT count(*)::int FROM content_items ci WHERE ci.account_id IN (SELECT a.id ${base}) AND ci.state IN ('failed','publication_unknown')) AS publish_errors,
      (SELECT count(*)::int FROM oauth_connections o WHERE o.account_id IN (SELECT a.id ${base}) AND o.status IN ('expiring','expired','revoked','error')) AS connection_problems,
      (SELECT count(*)::int FROM incidents i WHERE i.agency_id = $1 AND i.status = 'open') AS open_incidents`);
  const showFinance = agencyWide(ctx.actor.memberships) && can(ctx.actor.memberships, "view_finance", {});
  const load = agencyWide(ctx.actor.memberships) ? (await ctx.db.query(`
      SELECT u.id, u.display_name, u.weekly_capacity_hours,
             coalesce(sum(t.estimate_minutes) FILTER (WHERE t.status IN ('open','in_progress')), 0)::int AS assigned_minutes,
             count(t.*) FILTER (WHERE t.status IN ('open','in_progress') AND t.due_at < now())::int AS overdue
        FROM users u LEFT JOIN tasks t ON t.assignee_id = u.id
       WHERE u.agency_id = $1 AND u.is_active AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.role NOT IN ('client','auditor') AND m.revoked_at IS NULL)
       GROUP BY u.id ORDER BY u.display_name`, [ctx.actor.agency_id])).rows.map((r: any) => ({ ...r, ...capacityCheck({ capacity_minutes: Number(r.weekly_capacity_hours) * 60, assigned_minutes: r.assigned_minutes }, 0) })) : [];
  const finance = showFinance ? (await ctx.db.query(`
      SELECT c.id, c.name, c.monthly_fee,
             coalesce((SELECT sum(te.minutes) FROM time_entries te WHERE te.client_id = c.id AND te.work_date > now() - interval '30 days'), 0)::int AS minutes_30d,
             coalesce((SELECT sum(te.minutes * coalesce(u.internal_hourly_rate,0) / 60.0) FROM time_entries te JOIN users u ON u.id = te.user_id WHERE te.client_id = c.id AND te.work_date > now() - interval '30 days'), 0)::numeric(12,2) AS labor_cost_30d,
             coalesce((SELECT sum(cost_usd) FROM ai_executions ae WHERE ae.client_id = c.id AND ae.created_at > now() - interval '30 days'), 0)::numeric(12,4) AS ai_cost_30d
        FROM clients c WHERE c.agency_id = $1 ORDER BY c.name`, [ctx.actor.agency_id])).rows : null;
  return { production, team_load: load, finance, finance_note: finance ? "Себестоимость = трудозатраты × внутренняя ставка + прямые расходы (AI). Накладные расходы распределяются отдельно." : null };
}

export async function listTasks(ctx: Ctx, f: { mine?: boolean; status?: string; limit?: number } = {}) {
  // Внутренние задачи команды клиенту не показываются.
  if (ctx.actor.memberships.every((m) => m.role === "client" || m.role === "auditor")) return [];
  const vis = visibleAccountsFilter(ctx, "a", 2);
  const params: unknown[] = [ctx.actor.agency_id, ...vis.params];
  let where = `c.agency_id = $1 AND (t.account_id IS NULL AND ${agencyWide(ctx.actor.memberships)} OR ${vis.sql})`;
  if (f.mine) { params.push(ctx.actor.id); where += ` AND t.assignee_id = $${params.length}`; }
  if (f.status) { params.push(f.status); where += ` AND t.status = $${params.length}`; } else where += " AND t.status IN ('open','in_progress','blocked')";
  // Сначала задачи с наибольшим приоритетом и ближайшим сроком; список ограничен, подробности по запросу.
  params.push(Math.min(f.limit ?? 200, 500));
  const rows = (await ctx.db.query(`SELECT t.id, t.client_id, t.account_id, t.type, t.title, left(t.details, 2000) AS details, t.assignee_id, t.due_at, t.estimate_minutes, t.priority, t.priority_reason, t.status, t.created_at,
           a.display_name AS account_name, c.name AS client_name, u.display_name AS assignee_name
      FROM tasks t JOIN clients c ON c.id = t.client_id LEFT JOIN managed_accounts a ON a.id = t.account_id LEFT JOIN users u ON u.id = t.assignee_id
     WHERE ${where} ORDER BY t.priority DESC NULLS LAST, t.due_at NULLS LAST LIMIT $${params.length}`, params)).rows;
  return rows.map((t: any) => {
    const p = t.priority != null ? { score: Number(t.priority), reason: t.priority_reason } : taskPriority({ due: t.due_at ? new Date(t.due_at) : null, impact: 0.5, blocker_severity: t.type.includes("unknown") || t.type.includes("reconnect") ? 1 : 0.2, blockers: [] });
    return { ...t, priority_score: p.score, priority_reason: p.reason };
  }).sort((a: any, b: any) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
}

export async function updateTask(ctx: Ctx, taskId: string, input: unknown) {
  const d = z.object({ status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]).optional(), assignee_id: z.string().uuid().nullable().optional(), force_over_capacity: z.boolean().default(false) }).parse(input);
  const t = (await ctx.db.query("SELECT t.* FROM tasks t JOIN clients c ON c.id = t.client_id WHERE t.id = $1 AND c.agency_id = $2", [taskId, ctx.actor.agency_id])).rows[0];
  if (!t) throw new NotFoundError("Задача не найдена");
  if (t.account_id) await accountScope(ctx.db, ctx, t.account_id);
  const isAssignee = t.assignee_id === ctx.actor.id;
  if (!isAssignee) requireOp(ctx, "manage_tasks", { clientId: t.client_id, accountId: t.account_id ?? undefined });
  if (d.assignee_id) {
    const u = (await ctx.db.query(`SELECT u.weekly_capacity_hours, coalesce((SELECT sum(estimate_minutes) FROM tasks WHERE assignee_id = u.id AND status IN ('open','in_progress')),0)::int AS assigned FROM users u WHERE u.id = $1 AND u.agency_id = $2`, [d.assignee_id, ctx.actor.agency_id])).rows[0];
    if (!u) throw new ValidationError("Исполнитель не найден");
    const cap = capacityCheck({ capacity_minutes: Number(u.weekly_capacity_hours) * 60, assigned_minutes: u.assigned }, t.estimate_minutes ?? 0);
    if (!cap.ok && !d.force_over_capacity) throw new ValidationError(`Назначение превысит ёмкость исполнителя на ${cap.overBy} мин. Перераспределите или подтвердите явно.`, cap);
  }
  if (["assisted_publish", "resolve_unknown"].includes(t.type) && d.status === "done") throw new ValidationError("Эта задача закрывается отметкой результата публикации, а не вручную");
  const r = (await ctx.db.query(`UPDATE tasks SET status = coalesce($2, status), assignee_id = CASE WHEN $3::boolean THEN $4::uuid ELSE assignee_id END, completed_at = CASE WHEN $2 = 'done' THEN now() ELSE completed_at END WHERE id = $1 RETURNING *`,
    [taskId, d.status ?? null, d.assignee_id !== undefined, d.assignee_id ?? null])).rows[0];
  await audit(ctx.db, ctx, { action: "task.updated", entity_type: "task", entity_id: taskId, client_id: t.client_id, account_id: t.account_id ?? undefined, details: { status: d.status, assignee_changed: d.assignee_id !== undefined } });
  return r;
}

export async function createTask(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "manage_tasks", { clientId: a.client_id, accountId });
  const d = z.object({ type: z.string().default("internal"), title: z.string().min(1), details: z.string().optional(), due_at: z.string().optional(), estimate_minutes: z.number().int().positive().optional(), assignee_id: z.string().uuid().optional(), definition_of_done: z.string().optional() }).parse(input);
  const t = (await ctx.db.query("INSERT INTO tasks(client_id, account_id, type, title, details, due_at, estimate_minutes, assignee_id, definition_of_done) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
    [a.client_id, accountId, d.type, d.title, d.details ?? null, d.due_at ?? null, d.estimate_minutes ?? null, d.assignee_id ?? null, d.definition_of_done ?? null])).rows[0];
  await audit(ctx.db, ctx, { action: "task.created", entity_type: "task", entity_id: t.id, client_id: a.client_id, account_id: accountId });
  return t;
}

/** Ручной ввод/импорт метрик: источник обязателен, null = нет данных, повторный импорт не дублирует. */
const MetricInput = z.object({
  rows: z.array(z.object({
    metric_key: z.string(), value: z.number().nullable(), content_item_id: z.string().uuid().optional(),
    period_start: z.string().optional(), period_end: z.string().optional(), observed_at: z.string(),
  })).min(1).max(5000),
  source: z.enum(["manual_import", "manual_entry", "client_crm"]),
  source_detail: z.string().min(1),
  import_batch_key: z.string().optional(),
});
export async function enterMetrics(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "enter_metrics", { clientId: a.client_id, accountId });
  const d = MetricInput.parse(input);
  return ctx.db.tx(async (q) => {
    let inserted = 0, duplicates = 0;
    for (const r of d.rows) {
      if (r.content_item_id) {
        const ok = (await q.query("SELECT 1 FROM content_items WHERE id = $1 AND account_id = $2", [r.content_item_id, accountId])).rows[0];
        if (!ok) throw new ValidationError("Материал принадлежит другому аккаунту");
      }
      const res = await q.query(
        `INSERT INTO metric_snapshots(client_id, account_id, content_item_id, metric_key, value, period_start, period_end, observed_at, source, source_detail, availability_status, import_batch_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id`,
        [a.client_id, accountId, r.content_item_id ?? null, r.metric_key, r.value, r.period_start ?? null, r.period_end ?? null, r.observed_at, d.source, d.source_detail, r.value == null ? "not_available" : "available", d.import_batch_key ?? null, ctx.actor.id]);
      res.rows.length ? inserted++ : duplicates++;
    }
    await audit(q, ctx, { action: "metrics.imported", entity_type: "metric_snapshot", client_id: a.client_id, account_id: accountId, details: { inserted, duplicates, source: d.source } });
    return { inserted, duplicates };
  });
}

export async function postMetrics(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "view", { clientId: a.client_id, accountId });
  const rows = (await ctx.db.query(`SELECT ms.content_item_id, ms.metric_key, ms.value::float AS value, ms.observed_at, ms.period_start, ms.period_end, ms.availability_status, ms.source, md.nature
     FROM metric_snapshots ms JOIN metric_definitions md ON md.key = ms.metric_key WHERE ms.account_id = $1 AND ms.content_item_id IS NOT NULL`, [accountId])).rows as (MetricValue & { content_item_id: string; source: string })[];
  const byItem = new Map<string, typeof rows>();
  for (const r of rows) byItem.set(r.content_item_id, [...(byItem.get(r.content_item_id) ?? []), r]);
  return [...byItem.entries()].map(([id, ms]) => {
    const get = (k: string) => { const xs = ms.filter((m) => m.metric_key === k); return xs.length ? aggregate(xs).value : null; };
    const m = { impressions: get("impressions"), reactions: get("reactions"), comments: get("comments"), reposts: get("reposts") };
    return { content_item_id: id, ...m, sources: [...new Set(ms.map((x) => x.source))], interaction_rate: interactionRateByImpressions(m) };
  });
}

/** Еженедельный отчёт клиенту по доступным данным, с явными ограничениями. */
export async function generateWeeklyReport(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "export", { clientId: a.client_id, accountId });
  const d = z.object({ period_start: z.string(), period_end: z.string() }).parse(input);
  const q = ctx.db;
  const p = [accountId, d.period_start, d.period_end, a.timezone];
  const [published, tasksDone, actions, opportunities, pendingClient, next, metrics] = await Promise.all([
    q.query(`SELECT ci.title, ep.url, ep.evidence_type, ep.published_at FROM external_publications ep JOIN content_items ci ON ci.id = ep.content_item_id WHERE ep.account_id = $1 AND (ep.published_at AT TIME ZONE $4)::date BETWEEN $2 AND $3 ORDER BY ep.published_at`, p).then((r) => r.rows),
    q.query(`SELECT title, type, completed_at FROM tasks WHERE account_id = $1 AND status = 'done' AND (completed_at AT TIME ZONE $4)::date BETWEEN $2 AND $3`, p).then((r) => r.rows),
    q.query(`SELECT action_type, origin, evidence_type, count(*)::int AS n FROM action_records WHERE account_id = $1 AND (requested_at AT TIME ZONE $4)::date BETWEEN $2 AND $3 GROUP BY 1,2,3`, p).then((r) => r.rows),
    q.query(`SELECT title, stage, attribution FROM opportunities WHERE account_id = $1 AND (updated_at AT TIME ZONE $4)::date BETWEEN $2 AND $3`, p).then((r) => r.rows),
    q.query(`SELECT ci.title FROM approval_requests r JOIN content_items ci ON ci.id = r.content_item_id WHERE ci.account_id = $1 AND r.stage = 'client' AND r.status = 'pending'`, [accountId]).then((r) => r.rows),
    q.query(`SELECT title, scheduled_at, scheduled_tz FROM content_items WHERE account_id = $1 AND state = 'scheduled' ORDER BY scheduled_at LIMIT 10`, [accountId]).then((r) => r.rows),
    postMetrics(ctx, accountId),
  ]);
  const limits: string[] = [];
  if (!metrics.length) limits.push("Показатели публикаций за период отсутствуют: источник не подключён или данные не внесены. Отсутствие данных не означает нулевой результат.");
  if (published.some((x: any) => x.evidence_type === "manual_mark")) limits.push("Часть публикаций подтверждена ручной отметкой, а не API.");
  limits.push("Журнал платформы не является полной историей активности аккаунта в LinkedIn.");
  const body = {
    account: a.display_name, period: d,
    work_done: tasksDone, published, actions, opportunities,
    metrics: metrics.map((m) => ({ ...m, interaction_rate: m.interaction_rate.status === "ok" ? `${m.interaction_rate.value.toFixed(2)}%` : `не рассчитывается: ${m.interaction_rate.reason}`, definition: m.interaction_rate.definition })),
    data_limitations: limits,
    next_plan: next,
    client_action_required: pendingClient.map((x: any) => `Согласовать: ${x.title}`),
  };
  const r = (await q.query("INSERT INTO reports(client_id, account_id, kind, period_start, period_end, body, created_by) VALUES ($1,$2,'weekly',$3,$4,$5,$6) RETURNING id, created_at", [a.client_id, accountId, d.period_start, d.period_end, JSON.stringify(body), ctx.actor.id])).rows[0];
  await audit(q, ctx, { action: "report.generated", entity_type: "report", entity_id: r.id, client_id: a.client_id, account_id: accountId });
  return { id: r.id, ...body };
}

export async function getReport(ctx: Ctx, reportId: string) {
  const r = (await ctx.db.query("SELECT r.* FROM reports r JOIN clients c ON c.id = r.client_id WHERE r.id = $1 AND c.agency_id = $2", [reportId, ctx.actor.agency_id])).rows[0];
  if (!r) throw new NotFoundError("Отчёт не найден");
  if (r.account_id) await accountScope(ctx.db, ctx, r.account_id);
  requireOp(ctx, "view", { clientId: r.client_id, accountId: r.account_id });
  const { hasInternalRole } = await import("./portal");
  if (r.status !== "shared" && !hasInternalRole(ctx, { clientId: r.client_id, accountId: r.account_id })) throw new NotFoundError("Отчёт не найден");
  return r;
}

export async function auditLog(ctx: Ctx, f: { account_id?: string; limit?: number }) {
  if (f.account_id) {
    const a = await accountScope(ctx.db, ctx, f.account_id);
    const { hasInternalRole } = await import("./portal");
    if (!hasInternalRole(ctx, { clientId: a.client_id, accountId: a.id })) throw new NotFoundError("Нет доступа");
    return (await ctx.db.query("SELECT e.*, u.display_name AS actor_name FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.account_id = $1 ORDER BY e.id DESC LIMIT $2", [f.account_id, f.limit ?? 200])).rows;
  }
  requireOp(ctx, "view_audit", {});
  return (await ctx.db.query("SELECT e.*, u.display_name AS actor_name FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.agency_id = $1 ORDER BY e.id DESC LIMIT $2", [ctx.actor.agency_id, f.limit ?? 200])).rows;
}

export async function addOpportunity(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "enter_metrics", { clientId: a.client_id, accountId });
  const d = z.object({ pipeline: z.enum(["business", "job_search"]), stage: z.string(), title: z.string().min(1), attribution: z.enum(["confirmed_click", "client_mark", "crm_event", "manager_assumption"]) }).parse(input);
  const { PIPELINES } = await import("./engagement");
  if (!(PIPELINES[d.pipeline] as readonly string[]).includes(d.stage)) throw new ValidationError("Этап не относится к выбранной воронке");
  const r = (await ctx.db.query("INSERT INTO opportunities(client_id, account_id, pipeline, stage, title, attribution, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [a.client_id, accountId, d.pipeline, d.stage, d.title, d.attribution, ctx.actor.id])).rows[0];
  await audit(ctx.db, ctx, { action: "opportunity.created", entity_type: "opportunity", entity_id: r.id, client_id: a.client_id, account_id: accountId });
  return r;
}

export async function logTime(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "view", { clientId: a.client_id, accountId });
  if (!isInternal(ctx, { clientId: a.client_id, accountId })) throw new ForbiddenError("view", "Учёт времени ведёт только команда агентства");
  const d = z.object({ minutes: z.number().int().positive().max(24 * 60), work_date: z.string(), task_id: z.string().uuid().optional() }).parse(input);
  return (await ctx.db.query("INSERT INTO time_entries(client_id, account_id, user_id, task_id, minutes, work_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [a.client_id, accountId, ctx.actor.id, d.task_id ?? null, d.minutes, d.work_date])).rows[0];
}

export async function listUsers(ctx: Ctx) {
  // Справочник сотрудников только для внутренних ролей; адреса почты видит только управляющий командой.
  if (!isInternal(ctx)) throw new ForbiddenError("view", "Справочник сотрудников доступен только команде агентства");
  const emails = can(ctx.actor.memberships, "manage_team", {});
  return (await ctx.db.query(`SELECT u.id, u.display_name, ${emails ? "u.email" : "NULL::text AS email"}, array_agg(DISTINCT m.role) AS roles FROM users u JOIN memberships m ON m.user_id = u.id AND m.revoked_at IS NULL WHERE u.agency_id = $1 AND u.is_active GROUP BY u.id ORDER BY u.display_name`, [ctx.actor.agency_id])).rows;
}

/** Отзыв доступа при увольнении. */
export async function offboardUser(ctx: Ctx, userId: string) {
  requireOp(ctx, "manage_team", {});
  if (userId === ctx.actor.id) throw new ValidationError("Нельзя отключить собственную учётную запись");
  return ctx.db.tx(async (q) => {
    const target = (await q.query(
      `SELECT u.id, EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.role = 'owner' AND m.revoked_at IS NULL) AS is_owner
         FROM users u WHERE u.id = $1 AND u.agency_id = $2 AND u.is_active`, [userId, ctx.actor.agency_id])).rows[0];
    if (!target) throw new NotFoundError("Пользователь не найден");
    if (target.is_owner) {
      // Владельца отключает только владелец, и в агентстве должен остаться хотя бы один активный владелец.
      if (!ctx.actor.memberships.some((m) => m.role === "owner" && !m.scope_client_id && !m.scope_account_id)) throw new ForbiddenError("manage_team", "Отключить владельца может только владелец");
      const others = (await q.query(
        `SELECT count(DISTINCT m.user_id)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE u.agency_id = $1 AND u.is_active AND m.role = 'owner' AND m.revoked_at IS NULL AND m.user_id <> $2`, [ctx.actor.agency_id, userId])).rows[0].n;
      if (!others) throw new ConflictError("Нельзя отключить последнего владельца агентства");
    }
    await q.query("UPDATE memberships SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await q.query("UPDATE users SET is_active = false WHERE id = $1 AND agency_id = $2", [userId, ctx.actor.agency_id]);
    const t = await q.query("UPDATE tasks SET assignee_id = NULL WHERE assignee_id = $1 AND status IN ('open','in_progress','blocked') RETURNING id", [userId]);
    await audit(q, ctx, { action: "user.offboarded", entity_type: "user", entity_id: userId, details: { unassigned_tasks: t.rows.length } });
    return { unassigned_tasks: t.rows.length };
  });
}
