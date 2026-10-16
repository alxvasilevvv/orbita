import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Db, Queryable } from "../db/db";
import { accountScope, actorCtx, assertAccountOwner, audit, ConflictError, isInternal, loadActor, NotFoundError, requireOp, ValidationError, type Ctx } from "./context";
import { ForbiddenError } from "../core/permissions";
import { buildPassport, claimsFromInterview, INTERVIEW, passportHash, roleByKey, ROLE_CATALOG, verifyCallback, warmup, WARMUP_PLAN, type Passport } from "../core/autopilot";
import { agentContext, AUTOPILOT_OPEN, monthKey, reviewRequired, upsertContent, writePost, tgEnqueue } from "../agents/autopilot";
import { approvedBrief } from "../agents/orchestrator";
import { checkPost, lockAccount, VETO_RU } from "../agents/officer";
import { cancelPendingJobs } from "./jobs";
import { sniff, imageSize, MEDIA_LIMITS, type MalwareScanner } from "./media";
import { clientKey, type Storage } from "./storage";
import { notify } from "./notify";
import type { AiProvider } from "../ai/guard";
import { DemoAiProvider } from "../ai/guard";
import { signCallback } from "../core/autopilot";
import type { TelegramClient } from "../integrations/telegram";
import { effectiveLevel, isLevel, levelRank, PLAN, STRATEGIES, STRATEGY_LEVELS, type StrategyLevel } from "../core/strategy";
import { loadSafety } from "../agents/officer";
import { subscriptionOf } from "./billing";

/**
 * Личный агент сотрудника: онбординг (роль, интервью, паспорт голоса, фото), автопилот постов,
 * окно отмены, Telegram, портреты. Кабинет руководителя: охват, календарь, проверка постов компанией.
 * Действия от имени аккаунта выполняет только его владелец; руководитель видит агрегаты и посты, которые идут публично.
 */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const K = 5;
const masked = (n: number) => (n >= K ? n : "<5");

/** Условия автопилота, которые сотрудник видит и принимает. Хранятся в согласии вместе с версией паспорта. */
export const AUTOPILOT_TERMS = [
  "Агент пишет посты от моего имени только по моему паспорту голоса и только из фактов, которые я сам сообщил.",
  "Каждый пост я вижу заранее: в платформе и в Telegram. Пока не истекло окно отмены, я могу отменить, изменить или опубликовать сразу.",
  "Посты выходят через официальный API LinkedIn по моему подключению. Платформа не знает мой пароль и не использует браузер от моего имени.",
  "Комментарии и реакции на чужие посты агент только предлагает: каждое действие одобряю я.",
  "Я могу поставить паузу или выключить автопилот в один клик. Отзыв согласия отменяет все неопубликованные посты.",
];
export const AUTOPILOT_TERMS_REVIEW = "Перед публикацией посты проверяет компания (compliance). Отменённые мной посты компания не видит.";

async function owned(ctx: Ctx, accountId: string) {
  assertAccountOwner(ctx, accountId);
  const a = await accountScope(ctx.db, ctx, accountId);
  if (a.kind === "company_page") throw new ValidationError("Личный агент работает только для личных аккаунтов");
  return a;
}

async function ensureAgent(q: Queryable, a: { id: string; client_id: string }, userId: string) {
  await q.query("INSERT INTO personal_agents(account_id, client_id, user_id) VALUES ($1,$2,$3) ON CONFLICT (account_id) DO NOTHING", [a.id, a.client_id, userId]);
  return (await q.query("SELECT * FROM personal_agents WHERE account_id = $1", [a.id])).rows[0];
}

const ownedIds = (ctx: Ctx) => ctx.actor.memberships.filter((m) => m.role === "client" && m.scope_account_id && !m.revoked_at).map((m) => m.scope_account_id as string);

/* ---------- Кабинет сотрудника ---------- */
export async function myAgent(ctx: Ctx, systemDb: Db, now = new Date()) {
  const out = [];
  for (const id of ownedIds(ctx)) {
    const a = (await ctx.db.query("SELECT a.id, a.client_id, a.display_name, a.kind, a.timezone, a.status, a.network, c.name AS company FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = $1", [id])).rows[0];
    if (!a || a.kind === "company_page") continue;
    const g = await ensureAgent(ctx.db, a, ctx.actor.id);
    const brief = await approvedBrief(systemDb, a.client_id);
    const conn = (await ctx.db.query("SELECT status, expires_at FROM oauth_connections WHERE account_id = $1 AND status IN ('active','expiring') ORDER BY updated_at DESC LIMIT 1", [id])).rows[0] ?? null;
    const pubOp = a.network === "x" ? "publish_post_x" : "publish_post_member";
    const cap = (await ctx.db.query("SELECT mode, unavailable_reason FROM capability_snapshots WHERE account_id = $1 AND operation = $2 ORDER BY checked_at DESC LIMIT 1", [id, pubOp])).rows[0] ?? null;
    const ramp = (await ctx.db.query("SELECT ramp_started_at FROM account_safety WHERE account_id = $1", [id])).rows[0]?.ramp_started_at ?? g.created_at;
    const posts = (await ctx.db.query(`SELECT p.id, p.kind, p.status, p.topic_tag, p.publish_at, p.body, p.media_id, p.veto_codes, p.warnings, p.review_required, p.reviewed_at, p.review_comment, p.owner_action, p.external_url, p.source_url
        FROM autopilot_posts p WHERE p.account_id = $1 AND (p.status = ANY($2::text[]) OR p.publish_at > $3::timestamptz - interval '30 days') ORDER BY p.publish_at DESC LIMIT 40`, [id, AUTOPILOT_OPEN, now.toISOString()])).rows;
    const portrait = (await ctx.db.query("SELECT id, status, style, result_media_ids, banner_media_id, chosen_media_id, cardinality(source_media_ids) AS sources, error FROM portrait_jobs WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1", [id])).rows[0] ?? null;
    const consents = (await ctx.db.query("SELECT action_scope, granted_at, terms FROM consents WHERE account_id = $1 AND revoked_at IS NULL", [id])).rows;
    const pack = (await ctx.db.query("SELECT count(*)::int n FROM mission_actions WHERE account_id = $1 AND status = 'awaiting_owner'", [id])).rows[0].n;
    const w = warmup((now.getTime() - new Date(ramp).getTime()) / 864e5, brief?.intensity ?? "low");
    const safety = await loadSafety(systemDb, id);
    const sub = await subscriptionOf(ctx.db, id, now);
    if (g.onboarding_step === "payment" && sub.active) { await ctx.db.query("UPDATE personal_agents SET onboarding_step = 'done' WHERE account_id = $1", [id]); g.onboarding_step = "done"; }
    const company = (await systemDb.query("SELECT autopilot_strategy FROM clients WHERE id = $1", [a.client_id])).rows[0].autopilot_strategy as StrategyLevel;
    out.push({
      strategy: { company, employee: g.strategy, effective: safety.level ?? company, capped_by: safety.levelCappedBy },
      subscription: sub,
      account: a, agent: { ...g, telegram_link_hash: undefined, spent_usd: g.spent_month === monthKey(now) ? Number(g.spent_usd) : 0, budget_usd_month: Number(g.budget_usd_month), telegram_linked: !!g.telegram_chat_id, telegram_chat_id: undefined },
      network: a.network, linkedin: { connected: !!conn, api: cap?.mode === "api", reason: cap?.unavailable_reason ?? null },
      warmup: w, review_by_company: reviewRequired(brief), brief_topics: (brief?.topics ?? []).map((t: any) => t.tag),
      posts: posts.map((p: any) => ({ ...p, veto_ru: p.veto_codes.map((c: string) => VETO_RU[c] ?? c) })), portrait, consents: consents.map((c: any) => c.action_scope), pack,
    });
  }
  return { accounts: out, catalog: { roles: ROLE_CATALOG, interview: INTERVIEW, warmup: WARMUP_PLAN, terms: AUTOPILOT_TERMS, terms_review: AUTOPILOT_TERMS_REVIEW, strategies: STRATEGY_LEVELS.map((k) => STRATEGIES[k]), plan: PLAN } };
}

export async function setRole(ctx: Ctx, accountId: string, input: unknown) {
  const a = await owned(ctx, accountId);
  const d = z.object({ role_key: z.string(), title: z.string().min(2).max(120).optional() }).parse(input);
  if (!roleByKey(d.role_key)) throw new ValidationError("Неизвестная роль");
  await ensureAgent(ctx.db, a, ctx.actor.id);
  await ctx.db.query("UPDATE personal_agents SET role_key = $2, title = coalesce($3, title), onboarding_step = CASE WHEN onboarding_step = 'role' THEN 'interview' ELSE onboarding_step END, updated_at = now() WHERE account_id = $1", [accountId, d.role_key, d.title?.replace(/[<>]/g, "") ?? null]);
  return { ok: true };
}

const InterviewInput = z.object({
  answers: z.object({ now: z.string().min(20).max(2000), win: z.string().min(20).max(2000), lesson: z.string().max(2000).default(""), stack: z.string().max(1000).default(""), extra: z.string().max(2000).default("") }),
  topics: z.array(z.string().min(2).max(40)).min(1).max(5),
  length: z.enum(["short", "medium", "long"]).default("medium"),
  register: z.enum(["formal", "conversational"]).default("conversational"),
  humor: z.boolean().default(false),
  language: z.enum(["en", "ru"]).default("en"),
  phrases: z.array(z.string().max(80)).max(5).default([]),
  never_topics: z.array(z.string().max(60)).max(10).default([]),
});

/** Интервью: агент собирает паспорт голоса и факты. Факты сказаны самим сотрудником и подтверждены им. */
export async function saveInterview(ctx: Ctx, accountId: string, input: unknown) {
  const a = await owned(ctx, accountId);
  const d = InterviewInput.parse(input);
  return ctx.db.tx(async (q) => {
    const g = await ensureAgent(q, a, ctx.actor.id);
    const role = roleByKey(g.role_key);
    if (!role) throw new ValidationError("Сначала выберите роль");
    const passport = buildPassport(role, a.display_name, d.answers, d);
    const claims = claimsFromInterview(d.answers);
    if (claims.length < 2) throw new ValidationError("Расскажите чуть подробнее: агенту нужны хотя бы два конкретных факта о вашей работе");
    if (g.interview_source_id) {
      await q.query("UPDATE personal_agents SET interview_source_id = NULL WHERE account_id = $1", [accountId]);
      await q.query("DELETE FROM verified_claims WHERE source_id = $1", [g.interview_source_id]);
      await q.query("DELETE FROM knowledge_sources WHERE id = $1", [g.interview_source_id]);
    }
    const src = (await q.query("INSERT INTO knowledge_sources(client_id, account_id, title, kind, body, usage_rights, created_by) VALUES ($1,$2,'Интервью личного агента','interview',$3,'internal_and_ai',$4) RETURNING id",
      [a.client_id, accountId, JSON.stringify(d.answers), ctx.actor.id])).rows[0].id;
    for (const c of claims) await q.query("INSERT INTO verified_claims(client_id, account_id, statement, source_id, confirmed_by, valid_as_of) VALUES ($1,$2,$3,$4,$5,current_date)", [a.client_id, accountId, c, src, a.display_name]);
    await lockAccount(q, accountId);
    await q.query("UPDATE personal_agents SET interview = $2, interview_source_id = $3, passport = $4, passport_hash = $5, passport_confirmed_at = NULL, autopilot = CASE WHEN autopilot = 'on' THEN 'paused' ELSE autopilot END, onboarding_step = 'passport', updated_at = now() WHERE account_id = $1",
      [accountId, JSON.stringify(d.answers), src, JSON.stringify(passport), passportHash(passport)]);
    // Паспорт изменился и больше не подтверждён: прежнее согласие было дано на старую версию, отзываем его и снимаем открытые посты.
    if (g.passport_confirmed_at) {
      await q.query("UPDATE consents SET revoked_at = now() WHERE account_id = $1 AND action_scope = 'autopilot_posts' AND revoked_at IS NULL", [accountId]);
      await cancelOpenPosts(q, accountId, "passport_changed");
    }
    await audit(q, ctx, { action: "agent.interview_saved", entity_type: "personal_agent", entity_id: accountId, client_id: a.client_id, account_id: accountId, details: { claims: claims.length, role: role.key, reconfirm: !!g.passport_confirmed_at } });
    return { passport, passport_hash: passportHash(passport), claims };
  });
}

/** «Так будет звучать»: два примера постов по паспорту. Ничего не сохраняется и не публикуется. */
export async function samplePosts(ctx: Ctx, systemDb: Db, accountId: string, ai: AiProvider = new DemoAiProvider()) {
  const a = await owned(ctx, accountId);
  const actx = await agentContext(systemDb, accountId);
  if (!actx?.passport) throw new ValidationError("Сначала пройдите интервью");
  const brief = await approvedBrief(systemDb, a.client_id);
  const out = [];
  for (const [i, topic] of actx.passport.topics.slice(0, 2).entries()) {
    const w = await writePost(systemDb, ai, { ctx: actx, brief, topic, kind: "post", seed: `sample:${accountId}:${i}:${actx.passport_hash}` });
    if (w.cost) await systemDb.query("UPDATE personal_agents SET spent_usd = CASE WHEN spent_month = $2 THEN spent_usd ELSE 0 END + $3, spent_month = $2 WHERE account_id = $1", [accountId, monthKey(new Date()), w.cost]);
    out.push({ topic, text: w.text, flags: w.flags.map((f) => VETO_RU[f] ?? f) });
  }
  return { samples: out };
}

const PassportEdit = z.object({
  expected_hash: z.string().length(64),
  headline: z.string().max(120).optional(), about: z.string().max(600).optional(),
  topics: z.array(z.string().min(2).max(40)).min(1).max(5).optional(),
  phrases: z.array(z.string().max(80)).max(5).optional(), never_topics: z.array(z.string().max(60)).max(10).optional(),
});
/** «Да, это я»: подтверждение паспорта. Согласие на автопилот привязывается к новой версии. */
export async function confirmPassport(ctx: Ctx, systemDb: Db, accountId: string, input: unknown) {
  const a = await owned(ctx, accountId);
  const d = PassportEdit.parse(input);
  const brief = await approvedBrief(systemDb, a.client_id);
  return ctx.db.tx(async (q) => {
    const g = (await q.query("SELECT * FROM personal_agents WHERE account_id = $1 FOR UPDATE", [accountId])).rows[0];
    if (!g?.passport) throw new ValidationError("Сначала пройдите интервью");
    if (g.passport_hash !== d.expected_hash) throw new ConflictError("Паспорт изменился: обновите страницу");
    const p: Passport = { ...g.passport };
    if (d.headline) p.headline = d.headline.replace(/[<>]/g, "");
    if (d.about) p.about = d.about.replace(/[<>]/g, "");
    if (d.topics) p.topics = [...new Set(d.topics.map((t) => t.toLowerCase().trim()))];
    if (d.phrases) p.phrases = d.phrases;
    if (d.never_topics) p.never_topics = d.never_topics.map((x) => x.toLowerCase());
    const hash = passportHash(p);
    await q.query("UPDATE personal_agents SET passport = $2, passport_hash = $3, passport_version = passport_version + 1, passport_confirmed_at = now(), onboarding_step = CASE WHEN onboarding_step IN ('role','interview','passport') THEN 'photos' ELSE onboarding_step END, updated_at = now() WHERE account_id = $1",
      [accountId, JSON.stringify(p), hash]);
    await q.query("UPDATE employee_profiles SET expertise_tags = $2, expertise_confirmed_by = $3, expertise_confirmed_at = now(), updated_at = now() WHERE account_id = $1", [accountId, p.topics, ctx.actor.id]);
    if (g.autopilot === "on") await grantAutopilotConsent(q, ctx, brief, a, { veto_hours: g.veto_hours, passport_hash: hash, passport_version: g.passport_version + 1 });
    await audit(q, ctx, { action: "agent.passport_confirmed", entity_type: "personal_agent", entity_id: accountId, client_id: a.client_id, account_id: accountId, details: { version: g.passport_version + 1 } });
    return { ok: true, passport: p, passport_hash: hash };
  });
}

async function grantAutopilotConsent(q: Queryable, ctx: Ctx, brief: any, a: { id: string; client_id: string; display_name: string }, t: { veto_hours: number; passport_hash: string; passport_version: number }) {
  const terms = { ...t, review_by_company: reviewRequired(brief), text: [...AUTOPILOT_TERMS, ...(reviewRequired(brief) ? [AUTOPILOT_TERMS_REVIEW] : [])] };
  await q.query("UPDATE consents SET revoked_at = now() WHERE account_id = $1 AND action_scope = 'autopilot_posts' AND revoked_at IS NULL", [a.id]);
  const c = (await q.query("INSERT INTO consents(client_id, account_id, action_scope, granted_by_name, evidence_ref, granted_by_user_id, terms) VALUES ($1,$2,'autopilot_posts',$3,'Автопилот: согласие в платформе',$4,$5) RETURNING id",
    [a.client_id, a.id, a.display_name, ctx.actor.id, JSON.stringify(terms)])).rows[0].id;
  for (const scope of ["publish_post", "ai_processing"]) {
    const has = (await q.query("SELECT 1 FROM consents WHERE account_id = $1 AND action_scope = $2 AND revoked_at IS NULL", [a.id, scope])).rows.length;
    if (!has) await q.query("INSERT INTO consents(client_id, account_id, action_scope, granted_by_name, evidence_ref, granted_by_user_id) VALUES ($1,$2,$3,$4,'Автопилот: согласие в платформе',$5)", [a.client_id, a.id, scope, a.display_name, ctx.actor.id]);
  }
  // Открытые посты переходят на новое согласие: условия принял тот же владелец.
  await q.query("UPDATE autopilot_posts SET consent_id = $2 WHERE account_id = $1 AND status = ANY($3::text[])", [a.id, c, AUTOPILOT_OPEN]);
  return c as string;
}

/** Отменяет открытые посты аккаунта: задания публикации, материалы, статус. Публикуемые прямо сейчас не трогаются. */
export async function cancelOpenPosts(q: Queryable, accountId: string, code: string, onlyBefore?: Date) {
  const rows = (await q.query(`SELECT id, content_item_id FROM autopilot_posts WHERE account_id = $1 AND status = ANY($2::text[]) AND ($3::timestamptz IS NULL OR publish_at < $3)`, [accountId, AUTOPILOT_OPEN, onlyBefore?.toISOString() ?? null])).rows;
  for (const r of rows) {
    if (r.content_item_id) {
      await cancelPendingJobs(q, { contentItemId: r.content_item_id }, code);
      await q.query("UPDATE content_items SET state = 'cancelled', cancel_reason = $2, updated_at = now(), row_version = row_version + 1 WHERE id = $1 AND state NOT IN ('publishing','published','publication_unknown','archived','cancelled')", [r.content_item_id, `Автопилот: ${code}`]);
    }
    await q.query("UPDATE autopilot_posts SET status = 'blocked', veto_codes = array_append(veto_codes, $2), updated_at = now() WHERE id = $1 AND status = ANY($3::text[])", [r.id, code, AUTOPILOT_OPEN]);
  }
  return rows.length;
}

const AutopilotInput = z.object({ mode: z.enum(["on", "off", "pause"]), veto_hours: z.number().int().min(4).max(72).optional(), images_enabled: z.boolean().optional(), pause_days: z.number().int().min(1).max(60).optional() });
export async function setAutopilot(ctx: Ctx, systemDb: Db, accountId: string, input: unknown) {
  const a = await owned(ctx, accountId);
  const d = AutopilotInput.parse(input);
  const brief = await approvedBrief(systemDb, a.client_id);
  return ctx.db.tx(async (q) => {
    const g = (await q.query("SELECT * FROM personal_agents WHERE account_id = $1 FOR UPDATE", [accountId])).rows[0];
    if (!g) throw new NotFoundError("Агент не найден");
    if (d.mode === "on") {
      if (!g.passport_confirmed_at) throw new ValidationError("Сначала подтвердите паспорт голоса");
      const veto = d.veto_hours ?? g.veto_hours;
      await grantAutopilotConsent(q, ctx, brief, a, { veto_hours: veto, passport_hash: g.passport_hash, passport_version: g.passport_version });
      const paid = (await subscriptionOf(q, accountId)).active;
      await q.query("UPDATE personal_agents SET autopilot = 'on', autopilot_paused_until = NULL, veto_hours = $2, images_enabled = coalesce($3, images_enabled), onboarding_step = $4, updated_at = now() WHERE account_id = $1", [accountId, veto, d.images_enabled ?? null, paid ? "done" : "payment"]);
    } else if (d.mode === "pause") {
      const until = new Date(Date.now() + (d.pause_days ?? 7) * 864e5);
      await q.query("UPDATE personal_agents SET autopilot = 'paused', autopilot_paused_until = $2, updated_at = now() WHERE account_id = $1", [accountId, until.toISOString()]);
      await cancelOpenPosts(q, accountId, "paused_by_owner", until);
    } else {
      await q.query("UPDATE personal_agents SET autopilot = 'off', updated_at = now() WHERE account_id = $1", [accountId]);
      await q.query("UPDATE consents SET revoked_at = now() WHERE account_id = $1 AND action_scope = 'autopilot_posts' AND revoked_at IS NULL", [accountId]);
      await cancelOpenPosts(q, accountId, "autopilot_off");
    }
    if (d.images_enabled != null && d.mode !== "on") await q.query("UPDATE personal_agents SET images_enabled = $2 WHERE account_id = $1", [accountId, d.images_enabled]);
    await audit(q, ctx, { action: `agent.autopilot_${d.mode}`, entity_type: "personal_agent", entity_id: accountId, client_id: a.client_id, account_id: accountId, details: { veto_hours: d.veto_hours ?? null, pause_days: d.pause_days ?? null } });
    return { ok: true, mode: d.mode };
  });
}

/* ---------- Решения владельца по посту ---------- */
const PostAction = z.object({ action: z.enum(["veto", "publish_now", "approve", "edit"]), text: z.string().min(10).max(3000).optional() });
export async function ownerPostAction(ctx: Ctx, systemDb: Db, postId: string, input: unknown, now = new Date()) {
  const d = PostAction.parse(input);
  const p = (await ctx.db.query("SELECT * FROM autopilot_posts WHERE id = $1", [postId])).rows[0];
  if (!p) throw new NotFoundError("Пост не найден");
  assertAccountOwner(ctx, p.account_id);
  const agencyId = ctx.actor.agency_id;
  return systemDb.tx(async (q) => {
    await lockAccount(q, p.account_id);
    const post = (await q.query("SELECT * FROM autopilot_posts WHERE id = $1 FOR UPDATE", [postId])).rows[0];
    if (d.action === "veto") {
      if (!AUTOPILOT_OPEN.includes(post.status)) throw new ConflictError(post.status === "published" ? "Пост уже опубликован: удалить его можно в LinkedIn" : "Пост уже обработан");
      if (post.content_item_id) {
        // FOR UPDATE: если исполнитель прямо сейчас берёт задание в работу, его lease-UPDATE подождёт нашу транзакцию,
        // а после отмены задания его захват не состоится. Так вето не разойдётся с публикацией (гонка TOCTOU).
        const job = (await q.query("SELECT status FROM publication_jobs WHERE content_item_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [post.content_item_id])).rows[0];
        if (job && ["leased", "running", "publishing"].includes(job.status)) throw new ConflictError("Пост уже публикуется: удалить его можно в LinkedIn через минуту");
        await cancelPendingJobs(q, { contentItemId: post.content_item_id }, "owner_veto");
        await q.query("UPDATE content_items SET state = 'cancelled', cancel_reason = 'Отменён владельцем', updated_at = now(), row_version = row_version + 1 WHERE id = $1 AND state NOT IN ('publishing','published','publication_unknown','archived','cancelled')", [post.content_item_id]);
      }
      await q.query("UPDATE autopilot_posts SET status = 'vetoed', owner_action = 'vetoed', owner_action_at = now(), updated_at = now() WHERE id = $1", [postId]);
      await audit(q, ctx, { action: "autopilot.vetoed", entity_type: "autopilot_post", entity_id: postId, client_id: post.client_id, account_id: post.account_id });
      return { status: "vetoed" };
    }
    if (d.action === "publish_now") {
      if (post.status !== "veto_window") throw new ConflictError(post.status === "review" ? "Пост ещё проверяет компания" : "Опубликовать сразу можно только подготовленный пост");
      await q.query("UPDATE autopilot_posts SET publish_at = $2, owner_action = 'published_now', owner_action_at = now(), updated_at = now() WHERE id = $1", [postId, now.toISOString()]);
      await audit(q, ctx, { action: "autopilot.publish_now", entity_type: "autopilot_post", entity_id: postId, client_id: post.client_id, account_id: post.account_id });
      return { status: "veto_window", publish_at: now.toISOString() };
    }
    if (!["needs_owner", "review", "veto_window"].includes(post.status)) throw new ConflictError("Пост нельзя изменить в текущем состоянии");
    const text = (d.action === "edit" ? d.text : post.body)?.trim();
    if (!text) throw new ValidationError("Напишите текст поста");
    const brief = await approvedBrief(q, post.client_id);
    const actx = await agentContext(q, post.account_id);
    const at = new Date(Math.max(new Date(post.publish_at).getTime(), now.getTime() + 36e5));
    const v = await checkPost(q, { accountId: post.account_id, at, text, industry: brief?.industry ?? "general", reviewApproved: false, disclosureMode: brief?.disclosure_mode ?? "profile",
      disclosureText: brief?.disclosure_text ?? "#employee", forbidden: [...(brief?.forbidden_topics ?? []), ...(actx?.passport?.never_topics ?? [])], excludePostId: postId, phase: "propose" }, now);
    if (v.veto.length) throw new ValidationError("Офицер безопасности не пропустил текст", v.veto.map((x) => VETO_RU[x] ?? x));
    const itemId = await upsertContent(q, agencyId, post, text, post.media_id ? [post.media_id] : [], ctx.actor.id, text === post.body ? "ai_draft" : "human", post.ai_execution_id);
    // Правка сотрудника снимает прежнюю проверку компании: компания смотрит итоговый текст.
    const changed = text !== post.body;
    const status = post.review_required && (changed || !post.reviewed_at) ? "review" : "veto_window";
    await q.query(`UPDATE autopilot_posts SET body = $2, body_sha256 = $3, content_item_id = $4, status = $5, publish_at = $6, veto_codes = '{}', warnings = $7,
        reviewed_at = CASE WHEN $8::boolean THEN NULL ELSE reviewed_at END, reviewed_by = CASE WHEN $8::boolean THEN NULL ELSE reviewed_by END,
        owner_action = $9, owner_action_at = now(), updated_at = now() WHERE id = $1`,
      [postId, text, sha(text), itemId, status, at.toISOString(), v.warn, changed, d.action === "edit" ? "edited" : "approved"]);
    await audit(q, ctx, { action: `autopilot.${d.action}`, entity_type: "autopilot_post", entity_id: postId, client_id: post.client_id, account_id: post.account_id, details: { changed } });
    return { status, publish_at: at.toISOString(), warnings: v.warn.map((x) => VETO_RU[x] ?? x) };
  });
}

/** Пакет предложений миссий: одно касание одобряет каждое действие отдельно, с проверкой офицера для каждого. */
export async function approvePack(ctx: Ctx, systemDb: Db, accountId: string) {
  assertAccountOwner(ctx, accountId);
  const { decideAction } = await import("./missions");
  const ids = (await ctx.db.query("SELECT id FROM mission_actions WHERE account_id = $1 AND status = 'awaiting_owner' ORDER BY scheduled_at", [accountId])).rows.map((r: any) => r.id);
  let approved = 0;
  const failed: string[] = [];
  for (const id of ids) {
    try { await decideAction(ctx, systemDb, id, { decision: "approve" }); approved++; } catch (e: any) { failed.push(e?.details?.[0] ?? e?.message ?? "error"); }
  }
  return { approved, failed };
}

/* ---------- Telegram ---------- */
export async function telegramLink(ctx: Ctx, accountId: string, telegram?: TelegramClient) {
  await owned(ctx, accountId);
  const token = randomBytes(18).toString("base64url");
  await ctx.db.query("UPDATE personal_agents SET telegram_link_hash = $2, telegram_link_expires = now() + interval '30 minutes', updated_at = now() WHERE account_id = $1", [accountId, sha(token)]);
  const bot = telegram?.botUsername ?? process.env.TELEGRAM_BOT_USERNAME ?? null;
  return { url: bot ? `https://t.me/${bot}?start=${token}` : null, token, expires_in: 1800 };
}
export async function telegramUnlink(ctx: Ctx, accountId: string) {
  await owned(ctx, accountId);
  await ctx.db.query("UPDATE personal_agents SET telegram_chat_id = NULL, telegram_linked_at = NULL, telegram_link_hash = NULL, updated_at = now() WHERE account_id = $1", [accountId]);
  return { ok: true };
}

/** Вебхук Telegram: привязка по одноразовому коду, кнопки с подписью, решение от имени владельца, чей чат привязан. */
export async function handleTelegramUpdate(systemDb: Db, deps: { telegram: TelegramClient; callbackSecret: string; webhookSecret?: string; agentAi?: AiProvider }, headerSecret: string | undefined, update: any) {
  const wh = Buffer.from(deps.webhookSecret ?? ""), hs = Buffer.from(headerSecret ?? "");
  if (!deps.webhookSecret || wh.length !== hs.length || !timingSafeEqual(wh, hs)) throw Object.assign(new Error("Неверный секрет вебхука"), { status: 401 });
  if (!deps.callbackSecret || deps.callbackSecret.length < 16) throw Object.assign(new Error("Не задан TELEGRAM_CALLBACK_SECRET"), { status: 503 });
  const msg = update?.message;
  if (msg?.text && msg.chat?.type === "private") {
    const chatId = String(msg.chat.id);
    const m = /^\/start\s+([A-Za-z0-9_-]{20,40})$/.exec(msg.text.trim());
    if (m) {
      const g = (await systemDb.query("UPDATE personal_agents SET telegram_chat_id = $2, telegram_linked_at = now(), telegram_link_hash = NULL, telegram_link_expires = NULL, updated_at = now() WHERE telegram_link_hash = $1 AND telegram_link_expires > now() RETURNING account_id", [sha(m[1]), chatId]).catch(() => ({ rows: [] as any[] }))).rows[0];
      await deps.telegram.send(chatId, g ? "Готово: агент будет присылать сюда посты до публикации и предложения для одобрения в одно касание." : "Код недействителен или истёк. Получите новый в платформе.", []);
      return { linked: !!g };
    }
    if (msg.text.trim() === "/stop") {
      await systemDb.query("UPDATE personal_agents SET telegram_chat_id = NULL, telegram_linked_at = NULL WHERE telegram_chat_id = $1", [chatId]);
      await deps.telegram.send(chatId, "Уведомления отключены. Подключить снова можно в платформе.", []);
      return { unlinked: true };
    }
    // Свободный текст от привязанного сотрудника: разговор с личным агентом прямо в Telegram.
    const g = (await systemDb.query("SELECT account_id, user_id FROM personal_agents WHERE telegram_chat_id = $1", [chatId])).rows[0];
    if (!g) { await deps.telegram.send(chatId, "Этот чат не привязан к аккаунту. Получите ссылку в платформе.", []); return { ignored: true }; }
    const actor = await loadActor(systemDb, g.user_id);
    if (!actor) return { ignored: true };
    const { agentChat } = await import("./chat");
    const ai = deps.agentAi ?? new DemoAiProvider();
    // Применяем простые действия сразу (стратегия, план, тема, факты); пост сотрудник подтверждает в платформе.
    const apply = !/пост|draft|черновик/i.test(msg.text);
    const r = await agentChat(actorCtx(systemDb, actor), systemDb, g.account_id, { text: msg.text.slice(0, 4000), channel: "telegram", apply }, ai).catch((e: any) => ({ reply: String(e?.message ?? "Не получилось"), action: null }));
    await deps.telegram.send(chatId, r.reply, r.action && !(r.action as any).applied && ["set_strategy", "add_topic", "content_plan", "draft_post", "file_facts"].includes((r.action as any).type) ? [[{ text: "Применить", data: `ap|c|${g.account_id}|${signCallback(deps.callbackSecret, "c", g.account_id, chatId)}` }]] : []);
    return { chat: true };
  }
  const cb = update?.callback_query;
  if (!cb?.data || !cb.from?.id) return { ignored: true };
  const chatId = String(cb.from.id);
  const [prefix, action, ref, sig] = String(cb.data).split("|");
  if (prefix !== "ap" || !["v", "p", "k", "c"].includes(action) || !/^[0-9a-f-]{36}$/.test(ref ?? "") || !verifyCallback(deps.callbackSecret, action, ref, chatId, sig)) {
    await deps.telegram.answer(cb.id, "Кнопка недействительна");
    return { rejected: true };
  }
  const agent = (action === "k" || action === "c")
    ? (await systemDb.query("SELECT account_id, user_id FROM personal_agents WHERE telegram_chat_id = $1 AND account_id = $2", [chatId, ref])).rows[0]
    : (await systemDb.query("SELECT g.account_id, g.user_id FROM personal_agents g JOIN autopilot_posts p ON p.account_id = g.account_id WHERE g.telegram_chat_id = $1 AND p.id = $2", [chatId, ref])).rows[0];
  if (!agent) { await deps.telegram.answer(cb.id, "Кнопка недействительна"); return { rejected: true }; }
  const actor = await loadActor(systemDb, agent.user_id);
  if (!actor) { await deps.telegram.answer(cb.id, "Пользователь отключён"); return { rejected: true }; }
  const ctx = actorCtx(systemDb, actor);
  try {
    if (action === "k") {
      const r = await approvePack(ctx, systemDb, agent.account_id);
      await deps.telegram.answer(cb.id, `Одобрено: ${r.approved}${r.failed.length ? `, не прошли проверку: ${r.failed.length}` : ""}`);
      return r;
    }
    if (action === "c") {
      // Применить последнее предложение агента: повторяем последнее сообщение сотрудника с apply=true.
      const last = (await systemDb.query("SELECT body FROM agent_messages WHERE account_id = $1 AND role = 'user' ORDER BY created_at DESC LIMIT 1", [agent.account_id])).rows[0];
      const { agentChat } = await import("./chat");
      const r = last ? await agentChat(ctx, systemDb, agent.account_id, { text: last.body, channel: "telegram", apply: true }, deps.agentAi ?? new DemoAiProvider()) : { reply: "Нет предложения" };
      await deps.telegram.answer(cb.id, "Применено");
      await deps.telegram.send(chatId, r.reply, []);
      return r;
    }
    const r = await ownerPostAction(ctx, systemDb, ref, { action: action === "v" ? "veto" : "publish_now" });
    await deps.telegram.answer(cb.id, action === "v" ? "Пост отменён" : "Пост выйдет в ближайшие минуты");
    return r;
  } catch (e: any) {
    await deps.telegram.answer(cb.id, String(e?.message ?? "Не получилось").slice(0, 150));
    return { error: e?.message };
  }
}

/* ---------- Портрет по своим фото ---------- */
export async function grantLikeness(ctx: Ctx, accountId: string) {
  const a = await owned(ctx, accountId);
  const has = (await ctx.db.query("SELECT id FROM consents WHERE account_id = $1 AND action_scope = 'likeness_processing' AND revoked_at IS NULL", [accountId])).rows[0];
  if (has) return { consent_id: has.id };
  const c = (await ctx.db.query("INSERT INTO consents(client_id, account_id, action_scope, granted_by_name, evidence_ref, granted_by_user_id, terms) VALUES ($1,$2,'likeness_processing',$3,'Портрет: согласие в платформе',$4,$5) RETURNING id",
    [a.client_id, accountId, a.display_name, ctx.actor.id, JSON.stringify({ purpose: "Профессиональный портрет и обложка для моего профиля", retention: "Исходные фото удаляются сразу после генерации", likeness: "Портрет сохраняет моё лицо: это я, а не другой человек" })])).rows[0];
  await audit(ctx.db, ctx, { action: "consent.granted", entity_type: "consent", entity_id: c.id, client_id: a.client_id, account_id: accountId, details: { scope: "likeness_processing" } });
  return { consent_id: c.id };
}

/** Отзыв согласия на фото: исходники и созданные портреты удаляются. */
export async function revokeLikeness(ctx: Ctx, deps: { storage: Storage }, accountId: string) {
  const a = await owned(ctx, accountId);
  const media = (await ctx.db.query("SELECT id, storage_key FROM media_assets WHERE account_id = $1 AND purpose IN ('portrait_source','portrait')", [accountId])).rows;
  for (const m of media) await deps.storage.delete(m.storage_key);
  await ctx.db.query("UPDATE portrait_jobs SET status = 'cancelled', source_media_ids = '{}', result_media_ids = '{}', banner_media_id = NULL, chosen_media_id = NULL, updated_at = now() WHERE account_id = $1", [accountId]);
  await ctx.db.query("DELETE FROM media_assets WHERE account_id = $1 AND purpose IN ('portrait_source','portrait') AND id NOT IN (SELECT unnest(media_ids) FROM content_versions WHERE target_account_id = $1)", [accountId]);
  await ctx.db.query("UPDATE consents SET revoked_at = now() WHERE account_id = $1 AND action_scope = 'likeness_processing' AND revoked_at IS NULL", [accountId]);
  await audit(ctx.db, ctx, { action: "consent.revoked", entity_type: "consent", client_id: a.client_id, account_id: accountId, details: { scope: "likeness_processing", files_deleted: media.length } });
  return { deleted: media.length };
}

export async function addPortraitPhoto(ctx: Ctx, deps: { storage: Storage; scanner: MalwareScanner }, accountId: string, file: { filename: string; data: Buffer }) {
  const a = await owned(ctx, accountId);
  if (!(await ctx.db.query("SELECT 1 FROM consents WHERE account_id = $1 AND action_scope = 'likeness_processing' AND revoked_at IS NULL", [accountId])).rows.length) throw new ValidationError("Сначала дайте согласие на обработку своих фото");
  const t = sniff(file.data);
  if (!t || t.kind !== "image" || !["image/jpeg", "image/png"].includes(t.mime)) throw new ValidationError("Нужны фотографии JPG или PNG");
  if (file.data.length > MEDIA_LIMITS.image.maxBytes) throw new ValidationError("Файл слишком большой");
  const size = imageSize(file.data, t.mime);
  if (size && (size.width < 256 || size.height < 256)) throw new ValidationError("Фото слишком маленькое: нужно от 256×256");
  return ctx.db.tx(async (q) => {
    let job = (await q.query("SELECT * FROM portrait_jobs WHERE account_id = $1 AND status = 'collecting' ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [accountId])).rows[0];
    if (!job) job = (await q.query("INSERT INTO portrait_jobs(client_id, account_id, created_by, consent_id) VALUES ($1,$2,$3,(SELECT id FROM consents WHERE account_id = $2 AND action_scope = 'likeness_processing' AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1)) RETURNING *", [a.client_id, accountId, ctx.actor.id])).rows[0];
    if (job.source_media_ids.length >= 10) throw new ValidationError("Хватит 10 фотографий");
    const scan = await deps.scanner.scan(file.data);
    if (!scan.clean) throw new ValidationError("Файл не прошёл антивирусную проверку");
    const hash = createHash("sha256").update(file.data).digest("hex");
    const dup = (await q.query("SELECT id FROM media_assets WHERE account_id = $1 AND sha256 = $2", [accountId, hash])).rows[0];
    if (dup) return { job_id: job.id, photos: job.source_media_ids.length, deduplicated: true };
    const id = randomUUID();
    const key = clientKey(a.client_id, "media", id);
    await deps.storage.put(key, file.data, t.mime);
    await q.query("INSERT INTO media_assets(id, client_id, account_id, storage_key, mime_type, bytes, sha256, scan_status, scan_detail, original_name, width, height, uploaded_by, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7,'clean',$8,$9,$10,$11,$12,'portrait_source')",
      [id, a.client_id, accountId, key, t.mime, file.data.length, hash, scan.detail, file.filename.slice(0, 200), size?.width ?? null, size?.height ?? null, ctx.actor.id]);
    await q.query("UPDATE portrait_jobs SET source_media_ids = array_append(source_media_ids, $2::uuid), updated_at = now() WHERE id = $1", [job.id, id]);
    return { job_id: job.id, photos: job.source_media_ids.length + 1 };
  });
}

export async function requestPortraits(ctx: Ctx, accountId: string, input: unknown) {
  await owned(ctx, accountId);
  const d = z.object({ style: z.enum(["studio", "office", "outdoor"]).default("studio") }).parse(input ?? {});
  const r = await ctx.db.query("UPDATE portrait_jobs SET status = 'queued', style = $2, updated_at = now() WHERE account_id = $1 AND status = 'collecting' AND cardinality(source_media_ids) >= 3 RETURNING id", [accountId, d.style]);
  if (!r.rows.length) throw new ValidationError("Загрузите от 3 до 10 своих фотографий");
  return { job_id: r.rows[0].id, status: "queued" };
}

/** Выбор портрета: агентство получает задачу оформить профиль вместе с сотрудником (фото, обложка, заголовок, «О себе»). */
export async function choosePortrait(ctx: Ctx, systemDb: Db, jobId: string, input: unknown) {
  const d = z.object({ media_id: z.string().uuid() }).parse(input);
  const j = (await ctx.db.query("SELECT * FROM portrait_jobs WHERE id = $1", [jobId])).rows[0];
  if (!j) throw new NotFoundError("Портрет не найден");
  const a = await owned(ctx, j.account_id);
  if (j.status !== "ready" && j.status !== "chosen") throw new ConflictError("Портреты ещё не готовы");
  if (!j.result_media_ids.includes(d.media_id)) throw new ValidationError("Выберите один из предложенных портретов");
  await ctx.db.query("UPDATE portrait_jobs SET status = 'chosen', chosen_media_id = $2, updated_at = now() WHERE id = $1", [jobId, d.media_id]);
  const g = (await ctx.db.query("SELECT passport FROM personal_agents WHERE account_id = $1", [j.account_id])).rows[0];
  const manager = (await systemDb.query("SELECT manager_id FROM managed_accounts WHERE id = $1", [j.account_id])).rows[0]?.manager_id ?? null;
  const p = g?.passport as Passport | null;
  await systemDb.query(`INSERT INTO tasks(client_id, account_id, type, title, details, assignee_id, due_at, definition_of_done, source_ref, priority, priority_reason)
      VALUES ($1,$2,'profile_setup',$3,$4,$5,now() + interval '3 days','Фото, обложка, заголовок и «О себе» обновлены владельцем профиля',$6,0.7,'Прогрев: оформление профиля в первую неделю') ON CONFLICT DO NOTHING`,
    [a.client_id, j.account_id, `Оформить профиль: ${a.display_name}`, [
      "Вместе с сотрудником, в его LinkedIn, с его входа:",
      "1. Фото профиля: выбранный портрет (платформа, вкладка «Мой агент»).",
      "2. Обложка: сгенерированный баннер.",
      p ? `3. Заголовок: ${p.headline}` : "3. Заголовок по паспорту голоса.",
      p ? `4. «О себе»: ${p.about}` : "4. «О себе» по паспорту голоса.",
      "Историю работы и должности не меняем: только то, что сотрудник подтверждает сам.",
    ].join("\n"), manager, `profile_setup:${jobId}`]);
  return { ok: true };
}

/* ---------- Кабинет руководителя ---------- */
export async function companyAutopilot(ctx: Ctx, systemDb: Db, clientId: string, now = new Date()) {
  const c = (await systemDb.query("SELECT id, name, engagement_paused_at FROM clients WHERE id = $1 AND agency_id = $2", [clientId, ctx.actor.agency_id])).rows[0];
  if (!c) throw new NotFoundError("Компания не найдена");
  requireOp(ctx, "view_company", { clientId });
  const brief = await approvedBrief(systemDb, clientId);
  const review = reviewRequired(brief);
  const internal = isInternal(ctx, { clientId });
  const cov = (await systemDb.query(`SELECT count(*)::int AS employees,
      count(*) FILTER (WHERE g.passport_confirmed_at IS NOT NULL)::int AS passports,
      count(*) FILTER (WHERE g.autopilot = 'on')::int AS autopilot_on,
      count(*) FILTER (WHERE g.telegram_chat_id IS NOT NULL)::int AS telegram,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM oauth_connections o WHERE o.account_id = a.id AND o.status IN ('active','expiring')))::int AS connected,
      coalesce(sum(CASE WHEN g.spent_month = $2 THEN g.spent_usd ELSE 0 END), 0)::float AS spent, coalesce(sum(g.budget_usd_month), 0)::float AS budget
      FROM managed_accounts a LEFT JOIN personal_agents g ON g.account_id = a.id WHERE a.client_id = $1 AND a.kind = 'employee' AND a.status = 'active'`, [clientId, monthKey(now)])).rows[0];
  const stagesRaw = (await systemDb.query(`SELECT coalesce(s.ramp_started_at, a.created_at) AS start FROM managed_accounts a LEFT JOIN account_safety s ON s.account_id = a.id
      JOIN personal_agents g ON g.account_id = a.id AND g.autopilot = 'on' WHERE a.client_id = $1 AND a.kind = 'employee'`, [clientId])).rows;
  const stages: Record<string, number> = { profile: 0, first_posts: 0, rhythm: 0, steady: 0 };
  for (const r of stagesRaw) stages[warmup((now.getTime() - new Date(r.start).getTime()) / 864e5).stage]++;
  // Календарь: посты, которые компания проверяет, и уже опубликованные (они публичны). Отменённые сотрудником не показываются.
  const visible = review ? ["review", "veto_window", "scheduled", "published"] : ["published"];
  const posts = (await systemDb.query(`SELECT p.id, p.kind, p.status, p.topic_tag, p.publish_at, p.body, p.review_required, p.reviewed_at, p.external_url, p.media_id, a.display_name AS author
      FROM autopilot_posts p JOIN managed_accounts a ON a.id = p.account_id
     WHERE p.client_id = $1 AND p.status = ANY($2::text[]) AND p.publish_at BETWEEN $3::timestamptz - interval '14 days' AND $3::timestamptz + interval '14 days' ORDER BY p.publish_at`, [clientId, visible, now.toISOString()])).rows;
  const upcoming = (await systemDb.query(`SELECT date_trunc('day', publish_at) AS day, count(*)::int n FROM autopilot_posts WHERE client_id = $1 AND status = ANY($2::text[]) AND publish_at BETWEEN $3 AND $3::timestamptz + interval '14 days' GROUP BY 1 ORDER BY 1`,
    [clientId, ["planned", "review", "veto_window", "scheduled"], now.toISOString()])).rows;
  const topics = (await systemDb.query(`SELECT topic_tag AS tag, count(*)::int n FROM autopilot_posts WHERE client_id = $1 AND status IN ('scheduled','published','veto_window','review','planned') AND publish_at > $2::timestamptz - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`, [clientId, now.toISOString()])).rows;
  const published30 = (await systemDb.query("SELECT count(*)::int n FROM autopilot_posts WHERE client_id = $1 AND status = 'published' AND publish_at > $2::timestamptz - interval '30 days'", [clientId, now.toISOString()])).rows[0].n;
  const canReview = ctx.actor.memberships.some((m) => !m.revoked_at && m.role === "client_admin" && m.scope_client_id === clientId);
  return {
    company: c, review_by_company: review, can_review: canReview && review, industry: brief?.industry ?? "general",
    coverage: internal ? cov : { employees: cov.employees, passports: masked(cov.passports), autopilot_on: masked(cov.autopilot_on), telegram: masked(cov.telegram), connected: masked(cov.connected), spent: cov.spent, budget: cov.budget },
    stages: internal ? stages : Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, masked(v)])),
    calendar: posts.map((p: any) => ({ ...p, body: p.status === "published" || (review && p.review_required) ? p.body : null })),
    upcoming_by_day: upcoming, topics, published_30d: published30, warmup_plan: WARMUP_PLAN,
    strategy: { level: (await systemDb.query("SELECT autopilot_strategy FROM clients WHERE id = $1", [clientId])).rows[0].autopilot_strategy, presets: STRATEGY_LEVELS.map((k) => STRATEGIES[k]) },
  };
}

const ReviewInput = z.object({ post_ids: z.array(z.string().uuid()).min(1).max(100), decision: z.enum(["approve", "reject"]), comment: z.string().max(500).optional() });
/** Проверка компанией (compliance): одно решение на пачку постов недели. Отклонение уходит автору с причиной. */
export async function reviewPosts(ctx: Ctx, systemDb: Db, clientId: string, input: unknown) {
  const d = ReviewInput.parse(input);
  requireOp(ctx, "direct_agents", { clientId });
  if (!ctx.actor.memberships.some((m) => !m.revoked_at && m.role === "client_admin" && m.scope_client_id === clientId)) throw new ForbiddenError("review", "Посты проверяет руководитель компании (compliance)");
  if (d.decision === "reject" && !d.comment) throw new ValidationError("Укажите причину: автор увидит её");
  const brief = await approvedBrief(systemDb, clientId);
  if (!reviewRequired(brief)) throw new ConflictError("Проверка постов компанией не включена в брифе");
  let done = 0;
  const agencyId = ctx.actor.agency_id;
  for (const id of d.post_ids) {
    const r = await systemDb.tx(async (q) => {
      const p = (await q.query("SELECT * FROM autopilot_posts WHERE id = $1 AND client_id = $2 FOR UPDATE", [id, clientId])).rows[0];
      if (!p || !p.review_required || p.reviewed_at || !["review", "veto_window"].includes(p.status)) return null;
      if (d.decision === "approve") {
        await q.query("UPDATE autopilot_posts SET reviewed_by = $2, reviewed_at = now(), status = 'veto_window', updated_at = now() WHERE id = $1", [id, ctx.actor.id]);
      } else {
        if (p.content_item_id) {
          await cancelPendingJobs(q, { contentItemId: p.content_item_id }, "company_rejected");
          await q.query("UPDATE content_items SET state = 'cancelled', cancel_reason = 'Отклонено компанией', updated_at = now() WHERE id = $1 AND state NOT IN ('publishing','published','publication_unknown','archived','cancelled')", [p.content_item_id]);
        }
        await q.query("UPDATE autopilot_posts SET reviewed_by = $2, reviewed_at = now(), status = 'blocked', veto_codes = '{company_rejected}', review_comment = $3, updated_at = now() WHERE id = $1", [id, ctx.actor.id, d.comment]);
        const owner = (await q.query("SELECT user_id FROM personal_agents WHERE account_id = $1", [p.account_id])).rows[0]?.user_id;
        if (owner) await notify(q, { agency_id: agencyId, client_id: clientId, user_ids: [owner], kind: "autopilot.rejected", title: `Компания отклонила пост: ${d.comment}`, link: "#/me/agent", dedupe: `rejected:${id}` });
      }
      await audit(q, ctx, { action: `autopilot.review_${d.decision}`, entity_type: "autopilot_post", entity_id: id, client_id: clientId, account_id: p.account_id });
      return true;
    });
    if (r) done++;
  }
  return { processed: done };
}

/** Агентство: бюджет агента сотрудника. */
export async function setAgentBudget(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  if (!isInternal(ctx, { clientId: a.client_id, accountId })) throw new NotFoundError("Аккаунт не найден");
  requireOp(ctx, "manage_connection", { clientId: a.client_id, accountId });
  const d = z.object({ budget_usd_month: z.number().min(0).max(200) }).parse(input);
  await ctx.db.query("UPDATE personal_agents SET budget_usd_month = $2, updated_at = now() WHERE account_id = $1", [accountId, d.budget_usd_month]);
  await audit(ctx.db, ctx, { action: "agent.budget_set", entity_type: "personal_agent", entity_id: accountId, client_id: a.client_id, account_id: accountId, details: d });
  return { ok: true };
}

/** Подключение X (Twitter). В production возвращает ссылку авторизации X OAuth2; в демо сразу привязывает тестовый токен. */
export async function connectX(ctx: Ctx, systemDb: Db, secrets: { set(ref: string, v: string): unknown | Promise<unknown> }, accountId: string) {
  const a = await owned(ctx, accountId);
  const net = (await systemDb.query("SELECT network FROM managed_accounts WHERE id = $1", [accountId])).rows[0]?.network;
  if (net !== "x") throw new ValidationError("Этот аккаунт не в сети X");
  const { writeXCapability } = await import("./accounts");
  const cid = process.env.X_CLIENT_ID, redirect = process.env.X_REDIRECT_URI;
  if (cid && redirect) {
    const state = randomBytes(16).toString("hex");
    const url = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent("tweet.read tweet.write users.read offline.access")}&state=${state}&code_challenge=challenge&code_challenge_method=plain`;
    return { authorize_url: url };
  }
  // Демо: привязываем тестовый токен и включаем публикацию через API.
  const ref = `x/${accountId}/${Date.now()}`;
  await secrets.set(ref, `demo-x-token-${accountId}`);
  await systemDb.tx(async (q) => {
    await q.query("UPDATE managed_accounts SET linkedin_urn = $2 WHERE id = $1", [accountId, `x-user-${accountId.slice(0, 8)}`]);
    await q.query("UPDATE oauth_connections SET status = 'revoked', updated_at = now() WHERE account_id = $1 AND status IN ('active','expiring')", [accountId]);
    await q.query("INSERT INTO oauth_connections(client_id, account_id, external_subject, granted_scopes, secret_ref, status, connected_by) VALUES ($1,$2,$3,'{tweet.write,users.read}',$4,'active',$5)",
      [a.client_id, accountId, `x-user-${accountId.slice(0, 8)}`, ref, ctx.actor.id]);
    await writeXCapability(q, accountId, a.client_id, true);
    await audit(q, ctx, { action: "connection.created", entity_type: "oauth_connection", client_id: a.client_id, account_id: accountId, details: { network: "x" } });
  });
  return { connected: true };
}

export { tgEnqueue };

/* ---------- Стратегии ---------- */
/** Уровень компании (по умолчанию и потолок): руководитель или агентство. */
export async function setCompanyStrategy(ctx: Ctx, systemDb: Db, clientId: string, input: unknown) {
  const d = z.object({ level: z.enum(STRATEGY_LEVELS) }).parse(input);
  requireOp(ctx, "direct_agents", { clientId });
  const c = (await systemDb.query("SELECT autopilot_strategy FROM clients WHERE id = $1 AND agency_id = $2", [clientId, ctx.actor.agency_id])).rows[0];
  if (!c) throw new NotFoundError("Компания не найдена");
  await systemDb.query("UPDATE clients SET autopilot_strategy = $2 WHERE id = $1", [clientId, d.level]);
  await audit(systemDb, ctx, { action: "strategy.company_set", entity_type: "client", entity_id: clientId, client_id: clientId, details: { from: c.autopilot_strategy, to: d.level } });
  return { level: d.level };
}

/** Сотрудник может выбрать уровень осторожнее, чем у компании; выше потолка компании нельзя. null: как у компании. */
export async function setMyStrategy(ctx: Ctx, systemDb: Db, accountId: string, input: unknown) {
  const a = await owned(ctx, accountId);
  const d = z.object({ level: z.enum(STRATEGY_LEVELS).nullable() }).parse(input);
  const company = (await systemDb.query("SELECT autopilot_strategy FROM clients WHERE id = $1", [a.client_id])).rows[0].autopilot_strategy as StrategyLevel;
  if (d.level && levelRank(d.level) > levelRank(company)) throw new ValidationError(`Компания разрешает уровень не выше «${STRATEGIES[company].label}»`);
  await ensureAgent(ctx.db, a, ctx.actor.id);
  await ctx.db.query("UPDATE personal_agents SET strategy = $2, updated_at = now() WHERE account_id = $1", [accountId, d.level]);
  await audit(ctx.db, ctx, { action: "strategy.employee_set", entity_type: "personal_agent", entity_id: accountId, client_id: a.client_id, account_id: accountId, details: { level: d.level } });
  return { level: d.level ?? company };
}

export { effectiveLevel, isLevel };
