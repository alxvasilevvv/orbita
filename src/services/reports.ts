import { z } from "zod";
import { accountScope, audit, requireOp, ValidationError, type Ctx } from "./context";
import { activeStrategy } from "./accounts";
import { interactionRateByImpressions, median } from "../core/metrics";

const Month = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) });
function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)), end = new Date(Date.UTC(y, m, 1));
  const prevStart = new Date(Date.UTC(y, m - 2, 1));
  return { start, end, prevStart, prevEnd: start };
}

/**
 * Ежемесячный отчёт: прогресс к цели, сравнение сопоставимых периодов, лучшие материалы
 * с критериями, неудачные гипотезы, предлагаемые изменения, план следующего месяца.
 */
export async function generateMonthlyReport(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "export", { clientId: a.client_id, accountId });
  const { month } = Month.parse(input);
  const r = monthRange(month);
  const q = ctx.db;
  const s = await activeStrategy(q, accountId);
  const kpi = s?.playbook?.primary_kpi ?? "qualified_inquiries";
  const kpiSum = async (from: Date, to: Date) => {
    const m = (await q.query(`SELECT sum(value)::float AS v, count(*)::int AS n FROM metric_snapshots WHERE account_id = $1 AND metric_key = $2 AND value IS NOT NULL AND content_item_id IS NULL AND coalesce(period_end, observed_at) >= $3 AND coalesce(period_end, observed_at) < $4`, [accountId, kpi, from.toISOString(), to.toISOString()])).rows[0];
    const o = (await q.query("SELECT count(*)::int AS n FROM opportunities WHERE account_id = $1 AND created_at >= $2 AND created_at < $3", [accountId, from.toISOString(), to.toISOString()])).rows[0];
    return { metric: m.n ? m.v : null, observations: m.n, opportunities: o.n };
  };
  const production = async (from: Date, to: Date) => (await q.query(`
    SELECT (SELECT count(*)::int FROM external_publications WHERE account_id = $1 AND published_at >= $2 AND published_at < $3) AS published,
           (SELECT count(*)::int FROM approval_decisions d JOIN approval_requests rq ON rq.id = d.approval_request_id JOIN content_items ci ON ci.id = rq.content_item_id WHERE ci.account_id = $1 AND d.decision = 'changes_requested' AND d.decided_at >= $2 AND d.decided_at < $3) AS revisions,
           (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM d.decided_at - rq.created_at) / 3600) FROM approval_decisions d JOIN approval_requests rq ON rq.id = d.approval_request_id JOIN content_items ci ON ci.id = rq.content_item_id WHERE ci.account_id = $1 AND rq.stage = 'client' AND d.decided_at >= $2 AND d.decided_at < $3)::float AS median_client_approval_hours`,
    [accountId, from.toISOString(), to.toISOString()])).rows[0];
  // Лучшие материалы: только с окном наблюдения ≥ 7 дней и полными показателями.
  const posts = (await q.query(`
    SELECT ci.id, ci.title, ci.pillar, ep.published_at, ep.url,
      (SELECT jsonb_object_agg(metric_key, v) FROM (SELECT DISTINCT ON (metric_key) metric_key, value::float AS v FROM metric_snapshots ms WHERE ms.content_item_id = ci.id AND ms.value IS NOT NULL AND ms.observed_at >= ep.published_at + interval '7 days' ORDER BY metric_key, observed_at DESC) x) AS m
      FROM content_items ci JOIN external_publications ep ON ep.content_item_id = ci.id
     WHERE ci.account_id = $1 AND ep.published_at >= $2 AND ep.published_at < $3`, [accountId, r.start.toISOString(), r.end.toISOString()])).rows;
  const scored = posts.map((p: any) => {
    const m = p.m ?? {};
    const ir = interactionRateByImpressions({ reactions: m.reactions ?? null, comments: m.comments ?? null, reposts: m.reposts ?? null, impressions: m.impressions ?? null });
    return { id: p.id, title: p.title, pillar: p.pillar, url: p.url, impressions: m.impressions ?? null, interaction_rate: ir.status === "ok" ? ir.value : null };
  });
  const ranked = scored.filter((p) => p.interaction_rate != null).sort((x, y) => (y.interaction_rate as number) - (x.interaction_rate as number));
  const [cur, prev, prodCur, prodPrev] = await Promise.all([kpiSum(r.start, r.end), kpiSum(r.prevStart, r.prevEnd), production(r.start, r.end), production(r.prevStart, r.prevEnd)]);
  const failed = (await q.query("SELECT hypothesis, change, conclusion FROM experiments WHERE account_id = $1 AND status IN ('not_supported','inconclusive') AND created_at < $2", [accountId, r.end.toISOString()])).rows;
  const proposals = (await q.query("SELECT proposed_change, hypothesis, status FROM strategy_recommendations WHERE account_id = $1 AND created_at >= $2 AND created_at < $3", [accountId, r.start.toISOString(), r.end.toISOString()])).rows;
  const next = (await q.query(`SELECT title, pillar, coalesce(scheduled_at, planned_for) AS at, state FROM content_items WHERE account_id = $1 AND coalesce(scheduled_at, planned_for) >= $2 AND coalesce(scheduled_at, planned_for) < $2::timestamptz + interval '1 month' AND state NOT IN ('cancelled','archived') ORDER BY at`, [accountId, r.end.toISOString()])).rows;
  const limitations: string[] = [];
  if (cur.metric == null) limitations.push(`Основной показатель «${kpi}» за месяц не внесён: прогресс оценивается по возможностям и производству`);
  if (scored.length && !ranked.length) limitations.push("У публикаций месяца нет показателей с окном наблюдения не менее 7 дней: лучшие материалы не определяются");
  if (ranked.length && ranked.length < 5) limitations.push(`Сравнение материалов по ${ranked.length} публикациям: малая выборка`);
  limitations.push("Сравнение месяцев учитывает только данные из тех же источников; журнал платформы не является полной историей аккаунта");
  const body = {
    kind: "monthly", account: a.display_name, month, goal: s?.playbook?.goal ?? null, primary_kpi: kpi,
    progress: { current: cur, previous: prev, comparable: cur.observations > 0 && prev.observations > 0 },
    production: { current: prodCur, previous: prodPrev, planned_per_month: s ? Math.round((Number(s.playbook.posts_per_week) * 30) / 7) : null },
    best_materials: { criteria: "Interaction rate по показам (определение платформы), только публикации с окном наблюдения ≥ 7 дней", items: ranked.slice(0, 3), median_rate: median(ranked.map((x) => x.interaction_rate as number)) },
    failed_hypotheses: failed, proposed_changes: proposals, next_month_plan: next, data_limitations: limitations,
  };
  const row = (await q.query("INSERT INTO reports(client_id, account_id, kind, period_start, period_end, body, created_by) VALUES ($1,$2,'monthly',$3,$4,$5,$6) RETURNING id", [a.client_id, accountId, r.start.toISOString().slice(0, 10), new Date(r.end.getTime() - 864e5).toISOString().slice(0, 10), JSON.stringify(body), ctx.actor.id])).rows[0];
  await audit(q, ctx, { action: "report.monthly_generated", entity_type: "report", entity_id: row.id, client_id: a.client_id, account_id: accountId });
  return { id: row.id, ...body };
}

/**
 * Отчёт руководителю агентства. Себестоимость = трудозатраты × внутренняя ставка +
 * прямые расходы (AI) + распределённые накладные (инфраструктура пропорционально числу аккаунтов).
 */
export async function agencyReport(ctx: Ctx, input: unknown) {
  requireOp(ctx, "view_finance", {});
  const { month } = Month.parse(input);
  const r = monthRange(month);
  const infra = Number(process.env.INFRA_COST_MONTH_USD ?? NaN);
  const rows = (await ctx.db.query(`
    SELECT c.id, c.name, c.monthly_fee::float AS revenue,
      (SELECT count(*)::int FROM managed_accounts a WHERE a.client_id = c.id AND a.status <> 'offboarded') AS accounts,
      coalesce((SELECT sum(te.minutes) FROM time_entries te WHERE te.client_id = c.id AND te.work_date >= $2 AND te.work_date < $3), 0)::int AS minutes,
      coalesce((SELECT sum(te.minutes * coalesce(u.internal_hourly_rate, 0) / 60.0) FROM time_entries te JOIN users u ON u.id = te.user_id WHERE te.client_id = c.id AND te.work_date >= $2 AND te.work_date < $3), 0)::float AS labor_cost,
      (SELECT count(*)::int FROM time_entries te JOIN users u ON u.id = te.user_id WHERE te.client_id = c.id AND u.internal_hourly_rate IS NULL AND te.work_date >= $2 AND te.work_date < $3) AS unrated_entries,
      coalesce((SELECT sum(cost_usd) FROM ai_executions e WHERE e.client_id = c.id AND e.created_at >= $2 AND e.created_at < $3), 0)::float AS ai_cost,
      (SELECT count(*)::int FROM ai_executions e WHERE e.client_id = c.id AND e.cost_usd IS NULL AND e.provider <> 'demo' AND e.created_at >= $2 AND e.created_at < $3) AS unpriced_ai_runs,
      (SELECT count(*)::int FROM tasks t WHERE t.client_id = c.id AND t.status IN ('open','in_progress','blocked') AND t.due_at < now()) AS overdue,
      (SELECT count(*)::int FROM approval_decisions d WHERE d.client_id = c.id AND d.decision = 'changes_requested' AND d.decided_at >= $2 AND d.decided_at < $3) AS revisions,
      coalesce((SELECT sum((s.playbook->>'time_budget_hours_month')::numeric) FROM strategy_versions s JOIN managed_accounts a ON a.id = s.account_id WHERE a.client_id = c.id AND s.status = 'approved'), 0)::float AS budget_hours
      FROM clients c WHERE c.agency_id = $1 AND c.status <> 'closed' ORDER BY c.name`, [ctx.actor.agency_id, r.start.toISOString().slice(0, 10), r.end.toISOString().slice(0, 10)])).rows;
  const totalAccounts = rows.reduce((s: number, x: any) => s + x.accounts, 0) || 1;
  const clients = rows.map((x: any) => {
    const overhead = Number.isFinite(infra) ? (infra * x.accounts) / totalAccounts : null;
    const cost = x.labor_cost + x.ai_cost + (overhead ?? 0);
    const hours = x.minutes / 60;
    const reasons: string[] = [];
    if (x.budget_hours && hours > x.budget_hours) reasons.push(`Часы сверх бюджета стратегии: ${(hours - x.budget_hours).toFixed(1)} ч`);
    if (x.revisions > 3) reasons.push(`Много доработок: ${x.revisions}`);
    if (x.unrated_entries) reasons.push(`Нет внутренней ставки у части записей времени (${x.unrated_entries}): себестоимость занижена`);
    if (x.unpriced_ai_runs) reasons.push(`Цена AI-провайдера не задана для ${x.unpriced_ai_runs} вызовов`);
    return { ...x, hours, overhead, cost, margin: x.revenue ? (x.revenue - cost) / x.revenue : null, overrun_reasons: reasons };
  });
  const load = (await ctx.db.query(`
    SELECT u.display_name, u.weekly_capacity_hours::float AS capacity, coalesce(sum(te.minutes), 0)::int AS minutes
      FROM users u LEFT JOIN time_entries te ON te.user_id = u.id AND te.work_date >= $2 AND te.work_date < $3
     WHERE u.agency_id = $1 AND u.is_active AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.revoked_at IS NULL AND m.role NOT IN ('client','auditor'))
     GROUP BY u.id ORDER BY u.display_name`, [ctx.actor.agency_id, r.start.toISOString().slice(0, 10), r.end.toISOString().slice(0, 10)])).rows.map((u: any) => ({ ...u, utilization: u.capacity ? u.minutes / 60 / (u.capacity * 4.33) : null }));
  return {
    month, clients, team: load,
    totals: { revenue: clients.reduce((s, c) => s + (c.revenue ?? 0), 0), cost: clients.reduce((s, c) => s + c.cost, 0), hours: clients.reduce((s, c) => s + c.hours, 0) },
    formula: "Себестоимость = минуты × внутренняя ставка / 60 + AI + инфраструктура × доля аккаунтов клиента",
    notes: Number.isFinite(infra) ? [] : ["INFRA_COST_MONTH_USD не задан: накладные расходы не распределены"],
  };
}

export async function listReports(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "view", { clientId: a.client_id, accountId });
  return (await ctx.db.query("SELECT id, kind, period_start, period_end, status, created_at FROM reports WHERE account_id = $1 ORDER BY created_at DESC", [accountId])).rows;
}

/** Отчёт отправляется клиенту только после проверки менеджером. */
export async function publishReport(ctx: Ctx, reportId: string) {
  const r = (await ctx.db.query("SELECT * FROM reports WHERE id = $1", [reportId])).rows[0];
  if (!r) throw new ValidationError("Отчёт не найден");
  await accountScope(ctx.db, ctx, r.account_id);
  requireOp(ctx, "export", { clientId: r.client_id, accountId: r.account_id });
  await ctx.db.query("UPDATE reports SET status = 'shared' WHERE id = $1", [reportId]);
  await audit(ctx.db, ctx, { action: "report.shared", entity_type: "report", entity_id: reportId, client_id: r.client_id, account_id: r.account_id });
  return { status: "shared" };
}
