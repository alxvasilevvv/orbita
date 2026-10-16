import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/db";
import { assertAccountOwner, audit, ConflictError, isInternal, NotFoundError, requireOp, ValidationError, type Ctx } from "./context";
import { ForbiddenError } from "../core/permissions";
import { NATURAL } from "../core/safety";
import { check, lockAccount, VETO_RU } from "../agents/officer";
import { approvedBrief, planMission } from "../agents/orchestrator";
import { blockingNotes, type AiProvider, DemoAiProvider } from "../ai/guard";
import { contentHash } from "../core/contentStateMachine";

/**
 * Миссии агентов: руководитель компании или менеджер агентства ставит задачу, агенты раскладывают её
 * на предложения сотрудникам, каждый сотрудник сам одобряет, правит или пропускает своё действие.
 */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const K_MIN = 5;
const linkedinUrl = z.string().url().refine((u) => /^https:\/\/([a-z0-9-]+\.)?linkedin\.com\//i.test(u), "Нужна ссылка на linkedin.com");
export const MISSION_TYPES = ["amplify_post", "company_news", "discussion", "tech_breakdown", "engineering_blog", "open_source", "event_talk", "hiring"] as const;

const MissionInput = z.object({
  type: z.enum(MISSION_TYPES),
  title: z.string().min(3).max(200),
  objective: z.string().max(1000).default(""),
  target_url: linkedinUrl.optional(),
  target_content_item_id: z.string().uuid().optional(),
  target_excerpt: z.string().max(3000).optional(),
  target_published_at: z.string().datetime().optional(),
  target_is_company_post: z.boolean().default(false),
  topic_tags: z.array(z.string()).max(5).default([]),
  starts_in_hours: z.number().min(0).max(72).default(0),
  window_hours: z.number().min(NATURAL.windowMinHours).max(NATURAL.windowMaxHours).default(48),
  max_participants: z.number().int().min(1).max(NATURAL.participantsMax).default(NATURAL.participantsMax),
  idem_key: z.string().max(100).optional(),
});

export async function createMission(ctx: Ctx, deps: { systemDb: Db; ai?: AiProvider }, clientId: string, input: unknown, now = new Date()) {
  const c = (await ctx.db.query("SELECT id, engagement_paused_at FROM clients WHERE id = $1 AND agency_id = $2", [clientId, ctx.actor.agency_id])).rows[0];
  if (!c) throw new NotFoundError("Компания не найдена");
  requireOp(ctx, "direct_agents", { clientId });
  const d = MissionInput.parse(input);
  if (c.engagement_paused_at) throw new ConflictError("Активность компании остановлена: миссии не создаются до решения агентства");
  const brief = await approvedBrief(deps.systemDb, clientId);
  if (!brief) throw new ValidationError("Сначала нужен утверждённый бриф компании");
  const known = new Set((brief.topics ?? []).map((t: any) => t.tag));
  const unknownTags = d.topic_tags.filter((t) => !known.has(t));
  if (unknownTags.length) throw new ValidationError("Теги не из словаря брифа", unknownTags);
  const own = ["tech_breakdown", "engineering_blog", "open_source", "event_talk"].includes(d.type);
  let target_url = d.target_url ?? null, excerpt = d.target_excerpt ?? null, published = d.target_published_at ? new Date(d.target_published_at) : null, isCompany = d.target_is_company_post;
  if (d.target_content_item_id) {
    // Пост страницы компании из платформы: ссылка, текст и время берутся из системы, а не из запроса.
    const it = (await deps.systemDb.query(`SELECT ci.id, ep.url, ep.published_at, cv.body FROM content_items ci JOIN managed_accounts a ON a.id = ci.account_id
        LEFT JOIN external_publications ep ON ep.content_item_id = ci.id LEFT JOIN content_versions cv ON cv.id = ci.current_version_id
       WHERE ci.id = $1 AND a.client_id = $2 AND a.kind = 'company_page'`, [d.target_content_item_id, clientId])).rows[0];
    if (!it) throw new ValidationError("Материал не найден среди постов страницы компании");
    if (!it.url) throw new ValidationError("Пост ещё не опубликован");
    target_url = it.url; excerpt = it.body; published = it.published_at ? new Date(it.published_at) : null; isCompany = true;
  }
  if (!own && !target_url) throw new ValidationError("Для поддержки нужен пост: ссылка или материал страницы компании");
  if (!d.target_content_item_id) {
    // Признак «пост нашей страницы» не принимается на слово: только если ссылка совпадает с опубликованным постом страницы компании в платформе.
    const known = target_url ? (await deps.systemDb.query(`SELECT ep.published_at, cv.body FROM external_publications ep JOIN managed_accounts a ON a.id = ep.account_id
        JOIN content_items ci ON ci.id = ep.content_item_id LEFT JOIN content_versions cv ON cv.id = ci.current_version_id
       WHERE a.client_id = $1 AND a.kind = 'company_page' AND ep.url = $2`, [clientId, target_url])).rows[0] : null;
    isCompany = !!known;
    if (known) { published = published ?? (known.published_at ? new Date(known.published_at) : null); excerpt = excerpt ?? known.body; }
  }
  const start = new Date(now.getTime() + d.starts_in_hours * 36e5);
  const end = new Date(start.getTime() + d.window_hours * 36e5);
  const idem = d.idem_key ?? sha(`${d.type}|${target_url ?? ""}|${d.title}|${now.toISOString().slice(0, 10)}`);
  const m = (await ctx.db.query(
    `INSERT INTO agent_missions(client_id, created_by, type, title, objective, target_url, target_content_item_id, target_is_company_post, target_published_at, target_excerpt, topic_tags, window_start, window_end, max_participants, idem_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (client_id, idem_key) DO NOTHING RETURNING *`,
    [clientId, ctx.actor.id, d.type, d.title, d.objective, target_url, d.target_content_item_id ?? null, isCompany, published?.toISOString() ?? null, excerpt, d.topic_tags, start.toISOString(), end.toISOString(), d.max_participants, idem])).rows[0];
  if (!m) throw new ConflictError("Такая миссия уже создана сегодня");
  await audit(ctx.db, ctx, { action: "mission.created", entity_type: "agent_mission", entity_id: m.id, client_id: clientId, details: { type: d.type, window_hours: d.window_hours } });
  const plan = await planMission(deps.systemDb, m.id, now, deps.ai ?? new DemoAiProvider());
  const mission = (await deps.systemDb.query("SELECT * FROM agent_missions WHERE id = $1", [m.id])).rows[0];
  if (!isInternal(ctx, { clientId })) return { mission: trimForLeader(mission), plan: plan ? { planned: plan.planned, participants: plan.participants, reasons: plan.reasons } : null };
  return { mission, plan, veto_labels: VETO_RU };
}

/** Руководителю не отдаются причины отсева по людям: по ним при малой команде вычисляется риск или пауза конкретного сотрудника. */
function trimForLeader(m: any) {
  const ps = m.plan_summary ?? {};
  return { ...m, plan_summary: { planned: ps.planned, participants: ps.participants, tags: ps.tags } };
}

/** Миссия для руководителя: агрегаты и решения агентов; для агентства дополнительно строки действий. */
export async function missionDetail(ctx: Ctx, systemDb: Db, id: string) {
  const m = (await ctx.db.query("SELECT * FROM agent_missions WHERE id = $1", [id])).rows[0];
  if (!m) throw new NotFoundError("Миссия не найдена");
  requireOp(ctx, "view_company", { clientId: m.client_id });
  const agg = (await systemDb.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'done')::int AS done,
      count(*) FILTER (WHERE status IN ('awaiting_owner','approved','executing'))::int AS in_progress,
      count(*) FILTER (WHERE status NOT IN ('done','awaiting_owner','approved','executing'))::int AS not_done,
      count(*) FILTER (WHERE kind = 'comment')::int AS comments, count(*) FILTER (WHERE kind = 'react')::int AS reactions
     FROM mission_actions WHERE mission_id = $1`, [id])).rows[0];
  const internal = isInternal(ctx, { clientId: m.client_id });
  const runs = internal ? (await systemDb.query("SELECT agent, status, decisions, started_at, finished_at, error FROM agent_runs WHERE mission_id = $1 ORDER BY started_at", [id])).rows : null;
  // Счётчики по миссии руководителю показываются только при 5 и более участниках.
  const outputVisible = internal || agg.total >= K_MIN;
  const actions = internal ? (await systemDb.query(`SELECT ma.id, ma.kind, ma.status, ma.scheduled_at, ma.done_at, ma.exec_mode, ma.veto_codes, ma.warnings, ma.relevance, ma.ai_drafted, a.display_name
      FROM mission_actions ma JOIN managed_accounts a ON a.id = ma.account_id WHERE ma.mission_id = $1 ORDER BY ma.scheduled_at`, [id])).rows : null;
  return {
    mission: internal ? m : trimForLeader(m), output: outputVisible ? agg : null, output_hidden_below: K_MIN,
    // Результат миссии: только органические взаимодействия при известных показах; иначе «не рассчитывается».
    outcome: { status: "not_computable", reason: "Показы и взаимодействия поста недоступны без одобренного Community Management API или ручного импорта; действия команды не считаются результатом" },
    agents: runs, actions, veto_labels: VETO_RU,
  };
}

export async function cancelMission(ctx: Ctx, systemDb: Db, id: string, input: unknown) {
  const d = z.object({ reason: z.string().min(3).max(500) }).parse(input);
  const m = (await ctx.db.query("SELECT * FROM agent_missions WHERE id = $1", [id])).rows[0];
  if (!m) throw new NotFoundError("Миссия не найдена");
  requireOp(ctx, "direct_agents", { clientId: m.client_id });
  if (!["planned", "active", "blocked"].includes(m.status)) throw new ConflictError("Миссия уже завершена");
  await systemDb.tx(async (q) => {
    await q.query("UPDATE agent_missions SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1", [id, d.reason]);
    await q.query("UPDATE mission_actions SET status = 'blocked', veto_codes = array_append(veto_codes, 'mission_inactive') WHERE mission_id = $1 AND status IN ('awaiting_owner','approved')", [id]);
  });
  await audit(systemDb, ctx, { action: "mission.cancelled", entity_type: "agent_mission", entity_id: id, client_id: m.client_id, details: { has_reason: true } });
  return { ok: true };
}

/* ---------- Сотрудник: мои предложения ---------- */
export async function myActions(ctx: Ctx) {
  const ids = ctx.actor.memberships.filter((m) => m.role === "client" && m.scope_account_id && !m.revoked_at).map((m) => m.scope_account_id);
  if (!ids.length) return [];
  return (await ctx.db.query(`
    SELECT ma.id, ma.kind, ma.status, ma.proposed_text, ma.final_text, ma.ai_drafted, ma.warnings, ma.veto_codes, ma.scheduled_at, ma.window_end, ma.exec_mode, ma.rationale, ma.done_at,
           m.title AS mission_title, m.type AS mission_type, m.target_url, a.display_name AS account_name, a.timezone
      FROM mission_actions ma JOIN agent_missions m ON m.id = ma.mission_id JOIN managed_accounts a ON a.id = ma.account_id
     WHERE ma.account_id = ANY($1::uuid[]) AND (ma.status IN ('awaiting_owner','approved','unknown') OR ma.created_at > now() - interval '14 days')
     ORDER BY (ma.status = 'awaiting_owner') DESC, ma.scheduled_at`, [ids])).rows;
}

const DecisionInput = z.object({ decision: z.enum(["approve", "skip"]), text: z.string().max(3000).optional() });

/** Решение владельца аккаунта. Одобрение привязано к хешу текста: правка после одобрения его аннулирует. */
export async function decideAction(ctx: Ctx, systemDb: Db, id: string, input: unknown, now = new Date()) {
  const d = DecisionInput.parse(input);
  const a = (await ctx.db.query("SELECT * FROM mission_actions WHERE id = $1", [id])).rows[0];
  if (!a) throw new NotFoundError("Предложение не найдено");
  assertAccountOwner(ctx, a.account_id);
  if (a.status !== "awaiting_owner") throw new ConflictError("Предложение уже обработано");
  if (d.decision === "skip") {
    // Пропуск без объяснения и без последствий: руководитель не видит, кто пропустил.
    const r = await ctx.db.query("UPDATE mission_actions SET status = 'skipped', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'awaiting_owner' RETURNING id", [id, ctx.actor.id]);
    if (!r.rows.length) throw new ConflictError("Предложение уже обработано");
    return { status: "skipped" };
  }
  const text = a.kind === "react" ? null : (d.text ?? a.final_text ?? a.proposed_text ?? "").trim();
  if (a.kind !== "react" && !text) throw new ValidationError("Напишите текст: черновик не подготовлен");
  if (text) {
    const notes = blockingNotes(text);
    if (notes.length) throw new ValidationError("Уберите служебные пометки и допишите текст своими словами", notes);
  }
  const m = (await systemDb.query("SELECT * FROM agent_missions WHERE id = $1", [a.mission_id])).rows[0];
  if (m.status !== "active") throw new ConflictError("Миссия не активна");
  const brief = await approvedBrief(systemDb, a.client_id);
  const verdict = await systemDb.tx(async (q) => {
    await lockAccount(q, a.account_id);
    // Повторная проверка под блокировкой: статус мог смениться (пауза компании, сигнал LinkedIn, отмена миссии, параллельное решение).
    const fresh = (await q.query("SELECT ma.status, ma.window_end, m.status AS mission_status FROM mission_actions ma JOIN agent_missions m ON m.id = ma.mission_id WHERE ma.id = $1 FOR UPDATE OF ma", [id])).rows[0];
    if (fresh.status !== "awaiting_owner") throw new ConflictError("Предложение уже обработано или остановлено");
    if (fresh.mission_status !== "active") throw new ConflictError("Миссия не активна");
    if (new Date(fresh.window_end) <= now) throw new ConflictError("Окно миссии закрыто");
    const at = new Date(Math.max(now.getTime(), new Date(a.scheduled_at).getTime()));
    const v = await check(q, { accountId: a.account_id, kind: a.kind, at, missionId: a.mission_id, targetUrl: m.target_url, text, industry: brief?.industry ?? "general", complianceApproved: !!brief?.compliance_approved_at,
      disclosureMode: brief?.disclosure_mode ?? "profile", disclosureText: brief?.disclosure_text ?? "#employee", excludeActionId: a.id, phase: "commit" }, now);
    if (v.veto.length) return v;
    let contentItemId: string | null = null;
    if (a.kind === "post") contentItemId = await handOffPost(q, a, m, text!, ctx.actor.id);
    const upd = await q.query(`UPDATE mission_actions SET status = $2, final_text = $3, approved_text_sha256 = $4, decided_by = $5, decided_at = now(), content_item_id = $6, done_at = CASE WHEN $2 = 'done' THEN now() ELSE done_at END WHERE id = $1 AND status = 'awaiting_owner' RETURNING id`,
      [id, a.kind === "post" ? "done" : "approved", text, text ? sha(text) : null, ctx.actor.id, contentItemId]);
    if (!upd.rows.length) throw new ConflictError("Предложение уже обработано");
    return v;
  });
  if (verdict.veto.length) throw new ValidationError("Офицер безопасности не пропустил действие", verdict.veto.map((x) => VETO_RU[x] ?? x));
  await audit(systemDb, ctx, { action: "mission_action.approved", entity_type: "mission_action", entity_id: id, client_id: a.client_id, account_id: a.account_id, details: { kind: a.kind, edited: text != null && text !== a.proposed_text } });
  return { status: a.kind === "post" ? "handed_to_editorial" : "approved", exec_mode: a.exec_mode, warnings: verdict.warn.map((x) => VETO_RU[x] ?? x) };
}

/** Собственный пост сотрудника уходит в обычный конвейер: редактор, согласование версии, публикация. */
async function handOffPost(q: any, a: any, m: any, text: string, userId: string) {
  const it = (await q.query("INSERT INTO content_items(client_id, account_id, title, objective, state, author_id) VALUES ($1,$2,$3,$4,'draft',$5) RETURNING id", [a.client_id, a.account_id, m.title, m.type, userId])).rows[0];
  const hash = await contentHash({ body: text, media_ids: [], target_account_id: a.account_id });
  const v = (await q.query("INSERT INTO content_versions(client_id, content_item_id, version, body, media_ids, target_account_id, content_hash, created_by, origin) VALUES ($1,$2,1,$3,'{}',$4,$5,$6,$7) RETURNING id",
    [a.client_id, it.id, text, a.account_id, hash, userId, a.ai_drafted ? "ai_draft" : "human"])).rows[0];
  await q.query("UPDATE content_items SET current_version_id = $2 WHERE id = $1", [it.id, v.id]);
  return it.id as string;
}

/** «Сделал»: сотрудник выполнил действие сам. Отметка списывает лимит и пишется в журнал как ручная. */
export async function markActionDone(ctx: Ctx, id: string, input: unknown, systemDb?: Db, now = new Date()) {
  const d = z.object({ url: linkedinUrl.optional() }).parse(input ?? {});
  const a = (await ctx.db.query("SELECT * FROM mission_actions WHERE id = $1", [id])).rows[0];
  if (!a) throw new NotFoundError("Предложение не найдено");
  assertAccountOwner(ctx, a.account_id);
  if (a.status !== "approved" || a.exec_mode !== "assisted") throw new ConflictError("Отметить можно только одобренное действие, которое вы выполняете сами");
  const db = systemDb ?? ctx.db;
  const m = (await db.query("SELECT target_url, status FROM agent_missions WHERE id = $1", [a.mission_id])).rows[0];
  const brief = await approvedBrief(db, a.client_id);
  const verdict = await db.tx(async (q) => {
    await lockAccount(q, a.account_id);
    // Перед отметкой те же проверки: остановка компании, охлаждение, лимит. Текст уже проверен при одобрении.
    const v = await check(q, { accountId: a.account_id, kind: a.kind, at: now, missionId: a.mission_id, targetUrl: m?.target_url ?? null, text: null, industry: brief?.industry ?? "general",
      complianceApproved: !!brief?.compliance_approved_at, disclosureMode: brief?.disclosure_mode ?? "profile", disclosureText: brief?.disclosure_text ?? "#employee", excludeActionId: a.id, phase: "commit" }, now);
    const hard = v.veto.filter((x) => !["same_target_24h"].includes(x));
    if (hard.length) return hard;
    const upd = await q.query("UPDATE mission_actions SET status = 'done', done_at = now() WHERE id = $1 AND status = 'approved' RETURNING id", [id]);
    if (!upd.rows.length) throw new ConflictError("Действие уже отмечено");
    await q.query("INSERT INTO action_records(client_id, account_id, actor, action_type, target, origin, executed_at, status, evidence_type) VALUES ($1,$2,$3,$4,$5,'manual_mark',now(),'succeeded','manual_mark')",
      [a.client_id, a.account_id, ctx.actor.id, `mission_${a.kind}`, d.url ?? m?.target_url ?? null]);
    return [];
  });
  if (verdict.length) throw new ValidationError("Сейчас выполнять действие нельзя", verdict.map((x) => VETO_RU[x] ?? x));
  return { status: "done", evidence: "manual_mark" };
}

/** Агентство: список миссий всех компаний (для портфеля). */
export async function listMissions(ctx: Ctx, clientId: string) {
  requireOp(ctx, "view_company", { clientId });
  if (!isInternal(ctx, { clientId }) && !ctx.actor.memberships.some((m) => m.role === "client_admin" && m.scope_client_id === clientId)) throw new ForbiddenError("view_company");
  return (await ctx.db.query("SELECT id, type, title, status, window_start, window_end, plan_summary, blocked_reasons, created_at FROM agent_missions WHERE client_id = $1 ORDER BY created_at DESC LIMIT 100", [clientId])).rows;
}
