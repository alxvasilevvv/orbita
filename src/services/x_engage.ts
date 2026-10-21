import { z } from "zod";
import type { Db } from "../db/db";
import { accountScope, assertAccountOwner, ConflictError, isAccountOwner, isInternal, NotFoundError, ValidationError, audit, type Ctx } from "./context";
import { ForbiddenError } from "../core/permissions";
import { STRATEGIES, type StrategyLevel } from "../core/strategy";
import { weekKey } from "../core/autopilot";
import { loadSafety, lockAccount } from "../agents/officer";
import { subscriptionOf } from "./billing";
import { checkText } from "../core/safety";
import type { XSocialAdapter } from "../integrations/x/adapter";
import { IntegrationError } from "../integrations/linkedin/adapter";

/**
 * Взаимодействия в X в одно касание. Агент готовит ответы на целевые твиты (reply), сотрудник отправляет
 * сам или ставит лайк (like) одним касанием через официальный X API v2. Потолки берутся из стратегии:
 * ответы — недельный лимит комментариев, лайки — недельный лимит реакций. Офицер безопасности и охлаждение
 * применяются так же, как для LinkedIn. Сервер ничего не делает без явного касания сотрудника.
 */

/** Недельный потолок по виду действия в X. */
export function xEngageLimit(level: StrategyLevel, kind: "reply" | "like") {
  const p = STRATEGIES[level];
  return kind === "reply" ? p.commentsPerWeek : p.reactionsPerWeek;
}

const STATUS_URL = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})/i;
const BARE_ID = /^(\d{6,25})$/;

/** Разбирает ссылку на твит или голый id. Возвращает id твита и автора (если есть в ссылке). */
export function parseTweetRef(raw: string): { id: string; author: string | null; url: string | null } | null {
  const s = raw.trim();
  const m = STATUS_URL.exec(s);
  if (m) return { id: m[2], author: m[1], url: `https://x.com/${m[1]}/status/${m[2]}` };
  const b = BARE_ID.exec(s);
  if (b) return { id: b[1], author: null, url: `https://x.com/i/web/status/${b[1]}` };
  return null;
}

/** Короткий ответ в голосе сотрудника: по сути треда и своей теме, без шаблонных фраз, до 280 символов. */
export function composeXReply(o: { excerpt?: string | null; me: { role: string; company: string; claim?: string | null; language: "en" | "ru" } }): string {
  const en = o.me.language === "en";
  const claim = o.me.claim ? `${o.me.claim.charAt(0).toLowerCase()}${o.me.claim.slice(1)}` : null;
  const body = en
    ? (claim ? `Good point. In our work ${claim} — happy to compare notes.` : `Good point, this matches what we see in practice. Would be glad to compare notes.`)
    : (claim ? `Интересная мысль. У нас в работе ${claim}, с удовольствием сравню подходы.` : `Интересная мысль, совпадает с тем, что видим на практике. Рад сравнить подходы.`);
  return body.slice(0, 280);
}

async function ownerOrAgency(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  const net = (await ctx.db.query("SELECT network FROM managed_accounts WHERE id = $1", [accountId])).rows[0]?.network;
  if (net !== "x") throw new ValidationError("Взаимодействия в X доступны только для аккаунтов X");
  if (!isAccountOwner(ctx, accountId) && !isInternal(ctx, { clientId: a.client_id, accountId })) throw new ForbiddenError("x_engage", "Цели добавляет владелец аккаунта или агентство");
  return a;
}

export async function importXTargets(ctx: Ctx, accountId: string, input: unknown) {
  const d = z.object({ refs: z.string().min(1).max(100_000), kind: z.enum(["reply", "like"]).default("reply") }).parse(input);
  const a = await ownerOrAgency(ctx, accountId);
  const lines = d.refs.split(/[\n,]/).map((x) => x.trim()).filter(Boolean).slice(0, 500);
  let added = 0, skipped = 0;
  for (const line of lines) {
    const ref = parseTweetRef(line);
    if (!ref) { skipped++; continue; }
    const ins = await ctx.db.query(
      "INSERT INTO x_engagements(client_id, account_id, kind, target_tweet_id, target_url, target_author) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",
      [a.client_id, accountId, d.kind, ref.id, ref.url, ref.author]);
    if (ins.rows.length) added++; else skipped++;
  }
  await audit(ctx.db, ctx, { action: "x_engage.imported", entity_type: "managed_account", entity_id: accountId, client_id: a.client_id, account_id: accountId, details: { added, skipped, kind: d.kind } });
  return { added, skipped };
}

/** Агент готовит черновики ответов в пределах недельного потолка стратегии, при активной подписке и без охлаждения. */
export async function draftXEngagements(db: Db, now = new Date()) {
  const accounts = (await db.query(
    `SELECT DISTINCT x.account_id FROM x_engagements x JOIN personal_agents g ON g.account_id = x.account_id
      JOIN managed_accounts a ON a.id = x.account_id
     WHERE x.kind = 'reply' AND x.status = 'new' AND g.autopilot = 'on' AND a.network = 'x'`)).rows;
  let drafted = 0;
  const wk = weekKey(now);
  for (const { account_id } of accounts) {
    if (!(await subscriptionOf(db, account_id, now)).active) continue;
    const s = await loadSafety(db, account_id);
    if (s.excluded || (s.cooldownUntil && s.cooldownUntil > now) || !s.level) continue;
    const cap = xEngageLimit(s.level, "reply");
    const used = (await db.query("SELECT count(*)::int n FROM x_engagements WHERE account_id = $1 AND kind = 'reply' AND week_key = $2 AND status IN ('drafted','sent')", [account_id, wk])).rows[0].n;
    if (used >= cap) continue;
    const ctx = (await db.query(`SELECT g.passport, c.name AS company, (SELECT statement FROM verified_claims v WHERE v.account_id = g.account_id ORDER BY random() LIMIT 1) AS claim
        FROM personal_agents g JOIN clients c ON c.id = g.client_id WHERE g.account_id = $1`, [account_id])).rows[0];
    const items = (await db.query("SELECT * FROM x_engagements WHERE account_id = $1 AND kind = 'reply' AND status = 'new' ORDER BY created_at LIMIT $2", [account_id, cap - used])).rows;
    for (const it of items) {
      const draft = composeXReply({ excerpt: it.target_excerpt, me: { role: ctx?.passport?.role_label ?? "engineer", company: ctx?.company ?? "", claim: ctx?.claim, language: ctx?.passport?.language ?? "en" } });
      await db.query("UPDATE x_engagements SET draft = $2, status = 'drafted', week_key = $3, updated_at = now() WHERE id = $1 AND status = 'new'", [it.id, draft, wk]);
      drafted++;
    }
  }
  return { drafted };
}

export async function myXEngagements(ctx: Ctx, accountId: string, now = new Date()) {
  await ownerOrAgency(ctx, accountId);
  const s = await loadSafety(ctx.db, accountId);
  const wk = weekKey(now);
  const used = (await ctx.db.query("SELECT kind, count(*)::int n FROM x_engagements WHERE account_id = $1 AND week_key = $2 AND status = 'sent' GROUP BY kind", [accountId, wk])).rows;
  const items = (await ctx.db.query("SELECT id, kind, target_tweet_id, target_url, target_author, draft, status, external_id, sent_at FROM x_engagements WHERE account_id = $1 AND status IN ('drafted','new','sent') ORDER BY (status = 'drafted') DESC, created_at DESC LIMIT 100", [accountId])).rows;
  const lvl = s.level ?? "reputation";
  return { level: lvl, limits: { reply: xEngageLimit(lvl, "reply"), like: xEngageLimit(lvl, "like") }, sent_this_week: Object.fromEntries(used.map((u: any) => [u.kind, u.n])), items };
}

export interface XEngageDeps { xAdapter: XSocialAdapter; secrets: { get(ref: string): Promise<string | null> } }

/** Одно касание: отправить ответ / поставить лайк, либо пропустить. Сверх недельного потолка или при охлаждении не засчитывается. */
export async function markXEngagement(ctx: Ctx, deps: XEngageDeps, id: string, input: unknown, now = new Date()) {
  const d = z.object({ action: z.enum(["sent", "skip"]), text: z.string().max(280).optional() }).parse(input);
  const it = (await ctx.db.query("SELECT * FROM x_engagements WHERE id = $1", [id])).rows[0];
  if (!it) throw new NotFoundError("Не найдено");
  assertAccountOwner(ctx, it.account_id);
  if (!["drafted", "new"].includes(it.status)) throw new ConflictError("Уже обработано");
  if (d.action === "skip") {
    await ctx.db.query("UPDATE x_engagements SET status = 'skipped', updated_at = now() WHERE id = $1", [id]);
    return { status: "skipped" };
  }
  if (!(await subscriptionOf(ctx.db, it.account_id, now)).active) throw new ValidationError("Нужна активная подписка");
  const wk = weekKey(now);

  // Текст ответа валидируем до транзакции.
  let text: string | null = null;
  if (it.kind === "reply") {
    text = (d.text ?? it.draft ?? "").trim();
    if (!text) throw new ValidationError("Пустой ответ");
    if (text.length > 280) throw new ValidationError("Ответ длиннее 280 символов");
    const tc = checkText(text, "comment", []);
    if (tc.block.length) throw new ValidationError(tc.block.includes("template_phrase") ? "Шаблонная фраза: перепишите своими словами" : "Текст заблокирован правилами безопасности");
  }
  // Токен и идентификатор пользователя X берём из активного подключения аккаунта.
  const conn = (await ctx.db.query(`SELECT a.linkedin_urn AS user_id,
      (SELECT secret_ref FROM oauth_connections o WHERE o.account_id = a.id AND o.status IN ('active','expiring') ORDER BY updated_at DESC LIMIT 1) AS secret_ref
      FROM managed_accounts a WHERE a.id = $1`, [it.account_id])).rows[0];
  const token = conn?.secret_ref ? await deps.secrets.get(conn.secret_ref) : null;
  if (!token || !conn?.user_id) throw new ValidationError("Аккаунт X не подключён");

  // Блокировка аккаунта + атомарный захват элемента в транзакции: недельный лимит не превышается при
  // одновременных касаниях, а сбой внешнего вызова откатывает статус (элемент снова доступен к отправке).
  let externalId: string | null = null;
  await ctx.db.tx(async (q) => {
    await lockAccount(q, it.account_id);
    const s = await loadSafety(q, it.account_id);
    if (s.excluded || (s.cooldownUntil && s.cooldownUntil > now)) throw new ValidationError("Аккаунт на охлаждении после сигнала площадки: подождите");
    const sent = (await q.query("SELECT count(*)::int n FROM x_engagements WHERE account_id = $1 AND kind = $2 AND week_key = $3 AND status = 'sent'", [it.account_id, it.kind, wk])).rows[0].n;
    if (sent >= xEngageLimit(s.level ?? "reputation", it.kind)) throw new ValidationError("Недельный лимит стратегии исчерпан: продолжим на следующей неделе");
    const claim = await q.query("UPDATE x_engagements SET status = 'sent', week_key = $2, sent_at = now(), updated_at = now() WHERE id = $1 AND status IN ('drafted','new') RETURNING id", [id, wk]);
    if (!claim.rows.length) throw new ConflictError("Уже обработано");
    try {
      if (it.kind === "reply") {
        const res = await deps.xAdapter.publishTweet({ authorId: conn.user_id, accessToken: token, idempotencyKey: `xe:${id}`, text: text!, replyToId: it.target_tweet_id });
        externalId = res.externalId;
        await q.query("UPDATE x_engagements SET draft = $2, external_id = $3 WHERE id = $1", [id, text, externalId]);
      } else {
        await deps.xAdapter.likeTweet({ userId: conn.user_id, accessToken: token, tweetId: it.target_tweet_id });
        externalId = it.target_tweet_id;
        await q.query("UPDATE x_engagements SET external_id = $2 WHERE id = $1", [id, externalId]);
      }
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      if (e instanceof IntegrationError) throw new ValidationError(`X отклонил действие: ${e.message}`);
      throw e;
    }
  });
  await audit(ctx.db, ctx, { action: "x_engage.sent_manually", entity_type: "x_engagement", entity_id: id, client_id: it.client_id, account_id: it.account_id, details: { kind: it.kind, external_id: externalId } });
  return { status: "sent", external_id: externalId };
}
