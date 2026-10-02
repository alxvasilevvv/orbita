import { z } from "zod";
import { accountScope, audit, ConflictError, emit, isInternal, NotFoundError, requireOp, ValidationError, visibleAccountsFilter, type Ctx } from "./context";
import { activeStrategy, currentCapabilities, hasConsent } from "./accounts";
import { engagementPriority } from "../core/heuristics";
import { assertNotSelfApproval, can, ForbiddenError } from "../core/permissions";
import { forbiddenTopicHits, jobSearchSignals } from "../core/templates";
import { detectInjection } from "../ai/guard";

/** Лимит исполненных взаимодействий на аккаунт в сутки: защита от массовой активности. */
export const DAILY_ENGAGEMENT_CAP = Number(process.env.DAILY_ENGAGEMENT_CAP ?? 15);
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const linkedinUrl = z.string().url().refine((u) => /^https:\/\/([a-z0-9-]+\.)?linkedin\.com\//i.test(u), "Нужна ссылка на linkedin.com");

const RecInput = z.object({
  target_url: linkedinUrl,
  target_author: z.string().max(200).optional(),
  target_excerpt: z.string().max(3000).optional(),
  source: z.enum(["manager_added", "approved_source_list", "integration", "inbound"]).default("manager_added"),
  action_type: z.enum(["comment", "react", "reply"]),
  relevance: z.number(), audience_fit: z.number(), contribution_value: z.number(), timeliness: z.number(),
  rationale: z.string().min(3),
  proposed_comment: z.string().max(1250).optional(),
  fact_source_ids: z.array(z.string().uuid()).default([]),
});

function normalize(t: string) { return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
export function requiredApprover(strategy: any, action: string): "client" | "account_manager" {
  const personal: string[] = (strategy?.restrictions?.needs_personal_approval ?? []).map((x: string) => x.toLowerCase());
  return action !== "react" && personal.some((p) => p.includes("коммент") || p.includes("comment")) ? "client" : "account_manager";
}

export async function createRecommendation(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "record_manual_action", { clientId: a.client_id, accountId });
  const d = RecInput.parse(input);
  if (d.action_type !== "react" && !d.proposed_comment) throw new ValidationError("Для комментария нужен предлагаемый текст");
  const q = ctx.db;
  if (d.fact_source_ids.length) {
    const own = (await q.query("SELECT count(*)::int n FROM verified_claims WHERE id = ANY($1::uuid[]) AND account_id = $2", [d.fact_source_ids, accountId])).rows[0].n;
    if (own !== d.fact_source_ids.length) throw new ValidationError("Факты должны быть подтверждёнными фактами этого аккаунта");
  }
  const strategy = await activeStrategy(q, accountId);
  const blockers: string[] = [];
  const text = `${d.target_excerpt ?? ""}\n${d.proposed_comment ?? ""}`;
  blockers.push(...forbiddenTopicHits(text, strategy?.restrictions?.forbidden_topics ?? []).map((t) => `Запрещённая тема: ${t}`));
  const scope = d.action_type === "react" ? "react" : "comment";
  if (!(await hasConsent(q, accountId, scope))) blockers.push(`Нет согласия владельца на ${scope === "react" ? "реакции" : "комментарии"}`);
  if (a.confidential_job_search && jobSearchSignals(d.proposed_comment ?? "").length) blockers.push("Сигнал о поиске работы при конфиденциальном режиме");
  // Запрет взаимной поддержки между аккаунтами агентства. Функция возвращает только boolean,
  // а сообщение не раскрывает, какой именно аккаунт или клиент обслуживает агентство.
  const crossClient = (await q.query("SELECT target_is_other_managed_account($1, $2, $3) AS hit", [accountId, d.target_url, d.target_author ?? null])).rows[0].hit;
  if (crossClient) blockers.push("Цель недоступна по правилам агентства: взаимная поддержка между обслуживаемыми аккаунтами запрещена");
  const dup = (await q.query("SELECT 1 FROM engagement_recommendations WHERE account_id = $1 AND target_url = $2 AND action_type = $3 AND status NOT IN ('rejected','expired')", [accountId, d.target_url, d.action_type])).rows.length;
  if (dup) blockers.push("Повтор: такое действие для этой цели уже есть");
  if (d.proposed_comment) {
    const same = (await q.query(
      "SELECT proposed_comment FROM engagement_recommendations WHERE proposed_comment IS NOT NULL AND created_at > now() - interval '30 days' AND account_id <> $1", [accountId])).rows;
    if (same.some((r: any) => normalize(r.proposed_comment) === normalize(d.proposed_comment!))) blockers.push("Однотипный комментарий уже использован для другого аккаунта");
  }
  const risk = detectInjection(d.target_excerpt ?? "");
  const p = engagementPriority({ relevance: clamp(d.relevance), audience_fit: clamp(d.audience_fit), contribution_value: clamp(d.contribution_value), timeliness: clamp(d.timeliness), blockers });
  const row = (await q.query(
    `INSERT INTO engagement_recommendations(client_id, account_id, target_url, target_author, target_excerpt, source, action_type, relevance, audience_fit, contribution_value, timeliness, priority, block_reasons, rationale, proposed_comment, fact_source_ids, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [a.client_id, accountId, d.target_url, d.target_author ?? null, d.target_excerpt ?? null, d.source, d.action_type, clamp(d.relevance), clamp(d.audience_fit), clamp(d.contribution_value), clamp(d.timeliness), p.score, blockers,
     risk.length ? `${d.rationale}\n\nВнимание: во внешнем тексте найдены инструкции, они не исполняются.` : d.rationale, d.proposed_comment ?? null, d.fact_source_ids, blockers.length ? "blocked" : "proposed", ctx.actor.id])).rows[0];
  if (d.source === "inbound") await emit(q, "engagement.inbound", a.client_id, { account_id: accountId, recommendation_id: row.id }, `inbound:${row.id}`);
  await audit(q, ctx, { action: "engagement.recommended", entity_type: "engagement_recommendation", entity_id: row.id, client_id: a.client_id, account_id: accountId, details: { action: d.action_type, blocked: blockers.length > 0 } });
  return { ...row, required_approver: requiredApprover(strategy, d.action_type) };
}

export async function listQueue(ctx: Ctx, f: { account_id?: string; status?: string } = {}) {
  // Очередь взаимодействий: рабочий инструмент команды. Клиент согласует свои комментарии в кабинете.
  if (!isInternal(ctx)) throw new ForbiddenError("view", "Очередь взаимодействий доступна только команде агентства");
  const vis = visibleAccountsFilter(ctx, "a", 2);
  const params: unknown[] = [ctx.actor.agency_id, ...vis.params];
  let where = `c.agency_id = $1 AND ${vis.sql}`;
  if (f.account_id) { await accountScope(ctx.db, ctx, f.account_id); params.push(f.account_id); where += ` AND a.id = $${params.length}`; }
  if (f.status) { params.push(f.status); where += ` AND r.status = $${params.length}`; } else where += " AND r.status IN ('proposed','blocked','approved')";
  const rows = (await ctx.db.query(`
    SELECT r.*, a.display_name AS account_name, c.name AS client_name,
           (SELECT count(*)::int FROM engagement_recommendations x WHERE x.account_id = r.account_id AND x.status = 'executed' AND x.executed_at > now() - interval '24 hours') AS executed_today
      FROM engagement_recommendations r JOIN managed_accounts a ON a.id = r.account_id JOIN clients c ON c.id = a.client_id
     WHERE ${where} ORDER BY (r.status = 'blocked'), r.priority DESC NULLS LAST, r.created_at LIMIT 300`, params)).rows;
  const out = [];
  for (const r of rows) {
    const s = await activeStrategy(ctx.db, r.account_id);
    const caps = await currentCapabilities(ctx.db, r.account_id);
    const write = caps.find((c: any) => c.operation === "write_comments");
    out.push({ ...r, required_approver: requiredApprover(s, r.action_type), execution_mode: write?.mode === "api" ? "api" : "assisted", daily_cap: DAILY_ENGAGEMENT_CAP });
  }
  return out;
}

async function load(ctx: Ctx, id: string) {
  const r = (await ctx.db.query("SELECT * FROM engagement_recommendations WHERE id = $1", [id])).rows[0];
  if (!r) throw new NotFoundError("Рекомендация не найдена");
  await accountScope(ctx.db, ctx, r.account_id);
  return r;
}

export async function decideRecommendation(ctx: Ctx, id: string, input: unknown) {
  const d = z.object({ decision: z.enum(["approved", "rejected"]), comment_text: z.string().max(1250).optional() }).parse(input);
  const r = await load(ctx, id);
  if (r.status !== "proposed") throw new ConflictError(r.status === "blocked" ? `Действие заблокировано: ${r.block_reasons.join("; ")}` : "Рекомендация уже обработана");
  const s = await activeStrategy(ctx.db, r.account_id);
  const who = requiredApprover(s, r.action_type);
  requireOp(ctx, who === "client" ? "client_approve" : "publish", { clientId: r.client_id, accountId: r.account_id });
  if (d.decision === "approved") assertNotSelfApproval({ approverId: ctx.actor.id, versionAuthorId: r.created_by, allowSelfApproval: !!s?.restrictions?.allow_self_approval });
  if (d.comment_text && d.comment_text !== r.proposed_comment) throw new ConflictError("Текст изменился: создайте новую рекомендацию, согласуется конкретный текст");
  await ctx.db.query("UPDATE engagement_recommendations SET status = $2, approver_id = $3, approved_at = now() WHERE id = $1", [id, d.decision, ctx.actor.id]);
  await audit(ctx.db, ctx, { action: `engagement.${d.decision}`, entity_type: "engagement_recommendation", entity_id: id, client_id: r.client_id, account_id: r.account_id });
  return { status: d.decision };
}

/** Исполнение: человек выполнил действие в LinkedIn и отмечает результат (ручная отметка). */
export async function markExecuted(ctx: Ctx, id: string, input: unknown) {
  const d = z.object({ result_url: linkedinUrl.optional() }).parse(input);
  const r = await load(ctx, id);
  requireOp(ctx, "record_manual_action", { clientId: r.client_id, accountId: r.account_id });
  if (r.status !== "approved") throw new ConflictError("Исполнять можно только согласованное действие");
  const scope = r.action_type === "react" ? "react" : "comment";
  if (!(await hasConsent(ctx.db, r.account_id, scope))) throw new ConflictError("Согласие владельца отозвано");
  const today = (await ctx.db.query("SELECT count(*)::int n FROM engagement_recommendations WHERE account_id = $1 AND status = 'executed' AND executed_at > now() - interval '24 hours'", [r.account_id])).rows[0].n;
  if (today >= DAILY_ENGAGEMENT_CAP) throw new ConflictError(`Достигнут суточный лимит взаимодействий аккаунта (${DAILY_ENGAGEMENT_CAP}). Перенесите на завтра`);
  return ctx.db.tx(async (q) => {
    const ar = (await q.query(
      `INSERT INTO action_records(client_id, account_id, actor, action_type, target, origin, approval_id, executed_at, status, evidence_type)
       VALUES ($1,$2,$3,$4,$5,'manual_mark',$6,now(),'succeeded','manual_mark') RETURNING id`,
      [r.client_id, r.account_id, ctx.actor.id, r.action_type, d.result_url ?? r.target_url, r.id])).rows[0];
    await q.query("UPDATE engagement_recommendations SET status = 'executed', executed_by = $2, executed_at = now(), execution_mode = 'assisted', action_record_id = $3 WHERE id = $1", [id, ctx.actor.id, ar.id]);
    await audit(q, ctx, { action: "engagement.executed_manual_mark", entity_type: "engagement_recommendation", entity_id: id, client_id: r.client_id, account_id: r.account_id });
    return { status: "executed", evidence_type: "manual_mark" };
  });
}

export async function addSource(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "edit_strategy", { clientId: a.client_id, accountId });
  const d = z.object({ label: z.string().min(1), url: linkedinUrl, approved_by_name: z.string().min(1) }).parse(input);
  return (await ctx.db.query("INSERT INTO engagement_sources(client_id, account_id, label, url, approved_by_name) VALUES ($1,$2,$3,$4,$5) RETURNING *", [a.client_id, accountId, d.label, d.url, d.approved_by_name])).rows[0];
}
export async function listSources(ctx: Ctx, accountId: string) {
  await accountScope(ctx.db, ctx, accountId);
  return (await ctx.db.query("SELECT * FROM engagement_sources WHERE account_id = $1 ORDER BY created_at DESC", [accountId])).rows;
}

/* ---------- возможности ---------- */
export const PIPELINES = {
  business: ["inbound_interest", "discussion", "meeting", "opportunity", "won", "closed_no_result"],
  job_search: ["contact", "referral", "recruiter", "interview", "offer", "decision"],
} as const;
export const STAGE_RU: Record<string, string> = {
  inbound_interest: "Входящий интерес", discussion: "Обсуждение", meeting: "Встреча", opportunity: "Возможность", won: "Успешный результат", closed_no_result: "Закрыто без результата",
  contact: "Профессиональный контакт", referral: "Рекомендация", recruiter: "Обращение рекрутера", interview: "Интервью", offer: "Оффер", decision: "Решение",
};

export async function listOpportunities(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "view", { clientId: a.client_id, accountId });
  return (await ctx.db.query("SELECT * FROM opportunities WHERE account_id = $1 ORDER BY updated_at DESC", [accountId])).rows;
}
export async function moveOpportunity(ctx: Ctx, id: string, input: unknown) {
  const d = z.object({ stage: z.string() }).parse(input);
  const o = (await ctx.db.query("SELECT * FROM opportunities WHERE id = $1", [id])).rows[0];
  if (!o) throw new NotFoundError("Возможность не найдена");
  await accountScope(ctx.db, ctx, o.account_id);
  requireOp(ctx, "enter_metrics", { clientId: o.client_id, accountId: o.account_id });
  if (!(PIPELINES as any)[o.pipeline].includes(d.stage)) throw new ValidationError("Этап не относится к этой воронке");
  await ctx.db.query("UPDATE opportunities SET stage = $2, updated_at = now() WHERE id = $1", [id, d.stage]);
  await audit(ctx.db, ctx, { action: "opportunity.moved", entity_type: "opportunity", entity_id: id, client_id: o.client_id, account_id: o.account_id, details: { stage: d.stage } });
  return { ok: true };
}
export { can };
