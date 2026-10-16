import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Db, Queryable } from "../db/db";
import { assertAccountOwner, audit, ConflictError, isAccountOwner, isInternal, NotFoundError, requireOp, ValidationError, type Ctx } from "./context";
import { ForbiddenError } from "../core/permissions";
import { PLAN } from "../core/strategy";
import { notify } from "./notify";

/**
 * Подписка «Автопилот аккаунта»: $200 в месяц за аккаунт. Оплата картой (Stripe Checkout, ежемесячно)
 * или промокод на бесплатные месяцы. Платит сотрудник за себя или руководитель компании за всех.
 * Без активной подписки агент не планирует и не публикует.
 */
export interface CheckoutRequest { checkoutId: string; quantity: number; unitUsd: number; description: string; successUrl: string; cancelUrl: string }
export interface PaymentEvent { type: "checkout_paid" | "renewed" | "canceled" | "payment_failed" | "ignored"; eventId?: string; checkoutId?: string; subscriptionRef?: string }
export interface PaymentProvider {
  name: "stripe" | "demo";
  createCheckout(r: CheckoutRequest): Promise<{ sessionId: string; url: string }>;
  parseWebhook(raw: string, headers: Record<string, string | undefined>): PaymentEvent | null;
}

export class StripeProvider implements PaymentProvider {
  name = "stripe" as const;
  constructor(private secretKey: string, private webhookSecret: string, private fetchImpl: typeof fetch = fetch) {}
  async createCheckout(r: CheckoutRequest) {
    const body = new URLSearchParams({
      mode: "subscription", success_url: r.successUrl, cancel_url: r.cancelUrl, client_reference_id: r.checkoutId,
      "metadata[checkout_id]": r.checkoutId, "subscription_data[metadata][checkout_id]": r.checkoutId,
      "line_items[0][quantity]": String(r.quantity),
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(Math.round(r.unitUsd * 100)),
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][price_data][product_data][name]": r.description,
    });
    const res = await this.fetchImpl("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" }, body });
    if (!res.ok) throw new Error(`Stripe вернул ${res.status}`);
    const j: any = await res.json();
    return { sessionId: j.id, url: j.url };
  }
  /** Проверка подписи Stripe-Signature: HMAC-SHA256 от "t.payload", допуск 5 минут. */
  parseWebhook(raw: string, headers: Record<string, string | undefined>): PaymentEvent | null {
    const sig = headers["stripe-signature"] ?? "";
    const parts = Object.fromEntries(sig.split(",").map((p) => p.split("=") as [string, string]));
    const t = Number(parts.t);
    if (!t || Math.abs(Date.now() / 1000 - t) > 300 || !parts.v1) return null;
    const exp = Buffer.from(createHmac("sha256", this.webhookSecret).update(`${t}.${raw}`).digest("hex"));
    const got = Buffer.from(parts.v1);
    if (exp.length !== got.length || !timingSafeEqual(exp, got)) return null;
    const ev = JSON.parse(raw);
    const o = ev.data?.object ?? {};
    const id = ev.id as string | undefined;
    // Касса засчитывается только при оплаченном статусе (на отложенных методах completed приходит до зачисления средств).
    if ((ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") && (o.payment_status === "paid" || o.payment_status === "no_payment_required"))
      return { type: "checkout_paid", eventId: id, checkoutId: o.metadata?.checkout_id ?? o.client_reference_id, subscriptionRef: o.subscription };
    if (ev.type === "invoice.paid" && o.billing_reason !== "subscription_create") return { type: "renewed", eventId: id, subscriptionRef: o.subscription };
    if (ev.type === "invoice.payment_failed") return { type: "payment_failed", eventId: id, subscriptionRef: o.subscription };
    if (ev.type === "customer.subscription.deleted") return { type: "canceled", eventId: id, subscriptionRef: o.id };
    // Подпись верна, но событие нас не касается: это не ошибка, отвечаем 200, иначе Stripe будет повторять.
    return { type: "ignored", eventId: id };
  }
}

/** Демо: оплата подтверждается кнопкой на странице платформы. В production не используется. */
export class DemoPaymentProvider implements PaymentProvider {
  name = "demo" as const;
  async createCheckout(r: CheckoutRequest) { return { sessionId: `demo_${r.checkoutId}`, url: `#/billing/demo/${r.checkoutId}` }; }
  parseWebhook() { return null; }
}

export function paymentsFromEnv(env = process.env): PaymentProvider {
  if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) return new StripeProvider(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET);
  return new DemoPaymentProvider();
}

export async function subscriptionOf(q: Queryable, accountId: string, now = new Date()) {
  const s = (await q.query("SELECT status, period_end, provider, price_usd FROM subscriptions WHERE account_id = $1", [accountId])).rows[0] ?? null;
  const active = !!s && ["active", "trialing"].includes(s.status) && new Date(s.period_end) > now;
  return { ...(s ?? { status: "none", period_end: null, provider: null, price_usd: PLAN.priceUsd }), active, price_usd: Number(s?.price_usd ?? PLAN.priceUsd), plan: PLAN };
}

async function extend(q: Queryable, o: { accountId: string; clientId: string; months: number; status: "active" | "trialing"; provider: string; ref?: string | null; userId?: string | null; promoId?: string | null }) {
  await q.query(`INSERT INTO subscriptions(account_id, client_id, status, period_end, provider, provider_ref, paid_by_user_id, promo_code_id)
      VALUES ($1,$2,$3, now() + make_interval(months => $4::int), $5,$6,$7,$8)
      ON CONFLICT (account_id) DO UPDATE SET status = CASE WHEN subscriptions.status = 'active' AND EXCLUDED.status = 'trialing' THEN 'active' ELSE EXCLUDED.status END,
        period_end = greatest(coalesce(subscriptions.period_end, now()), now()) + make_interval(months => $4::int),
        provider = EXCLUDED.provider, provider_ref = coalesce(EXCLUDED.provider_ref, subscriptions.provider_ref),
        paid_by_user_id = coalesce(EXCLUDED.paid_by_user_id, subscriptions.paid_by_user_id), promo_code_id = coalesce(EXCLUDED.promo_code_id, subscriptions.promo_code_id), updated_at = now()`,
    [o.accountId, o.clientId, o.status, o.months, o.provider, o.ref ?? null, o.userId ?? null, o.promoId ?? null]);
}

const isLeaderOf = (ctx: Ctx, clientId: string) => ctx.actor.memberships.some((m) => !m.revoked_at && m.role === "client_admin" && m.scope_client_id === clientId);

/** Оплата: сотрудник за свой аккаунт, руководитель за выбранных сотрудников компании (по умолчанию за всех без подписки). */
export async function startCheckout(ctx: Ctx, systemDb: Db, deps: { payments: PaymentProvider; appUrl?: string }, input: unknown) {
  const d = z.object({ account_id: z.string().uuid().optional(), client_id: z.string().uuid().optional() }).parse(input);
  let clientId: string, ids: string[];
  if (d.account_id) {
    const a = (await systemDb.query("SELECT a.id, a.client_id, a.kind FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = $1 AND c.agency_id = $2", [d.account_id, ctx.actor.agency_id])).rows[0];
    if (!a || a.kind === "company_page") throw new NotFoundError("Аккаунт не найден");
    if (!isAccountOwner(ctx, a.id) && !isLeaderOf(ctx, a.client_id)) throw new ForbiddenError("billing", "Оплатить может владелец аккаунта или руководитель компании");
    clientId = a.client_id; ids = [a.id];
  } else if (d.client_id) {
    if (!isLeaderOf(ctx, d.client_id) && !isInternal(ctx, { clientId: d.client_id })) throw new ForbiddenError("billing", "Оплатить за компанию может её руководитель");
    clientId = d.client_id;
    ids = (await systemDb.query(`SELECT a.id FROM managed_accounts a LEFT JOIN subscriptions s ON s.account_id = a.id
        WHERE a.client_id = $1 AND a.kind = 'employee' AND a.status = 'active' AND (s.account_id IS NULL OR s.status NOT IN ('active','trialing') OR s.period_end < now())`, [clientId])).rows.map((r: any) => r.id);
    if (!ids.length) throw new ConflictError("Все аккаунты компании уже оплачены");
  } else throw new ValidationError("Укажите аккаунт или компанию");
  const checkout = (await systemDb.query("INSERT INTO billing_checkouts(agency_id, client_id, account_ids, amount_usd, provider, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [ctx.actor.agency_id, clientId, ids, ids.length * PLAN.priceUsd, deps.payments.name, ctx.actor.id])).rows[0];
  const base = deps.appUrl ?? "";
  const s = await deps.payments.createCheckout({ checkoutId: checkout.id, quantity: ids.length, unitUsd: PLAN.priceUsd, description: `${PLAN.label}: ${ids.length} × $${PLAN.priceUsd}/мес`, successUrl: `${base}/#/me/agent?paid=1`, cancelUrl: `${base}/#/me/agent` });
  await systemDb.query("UPDATE billing_checkouts SET provider_session = $2, url = $3 WHERE id = $1", [checkout.id, s.sessionId, s.url]);
  await audit(systemDb, ctx, { action: "billing.checkout_started", entity_type: "billing_checkout", entity_id: checkout.id, client_id: clientId, details: { seats: ids.length, amount_usd: ids.length * PLAN.priceUsd } });
  return { checkout_id: checkout.id, url: s.url, seats: ids.length, amount_usd: ids.length * PLAN.priceUsd };
}

export async function activateCheckout(systemDb: Db, checkoutId: string, ref: string | null) {
  return systemDb.tx(async (q) => {
    const c = (await q.query("UPDATE billing_checkouts SET status = 'paid', paid_at = now() WHERE id = $1 AND status = 'pending' RETURNING *", [checkoutId])).rows[0];
    if (!c) return { activated: 0 };
    for (const id of c.account_ids) await extend(q, { accountId: id, clientId: c.client_id, months: 1, status: "active", provider: c.provider, ref, userId: c.created_by });
    await q.query("INSERT INTO audit_events(agency_id, client_id, actor_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,'billing.paid','billing_checkout',$4,$5)",
      [c.agency_id, c.client_id, c.created_by, c.id, JSON.stringify({ seats: c.account_ids.length, amount_usd: Number(c.amount_usd) })]);
    return { activated: c.account_ids.length };
  });
}

/** Демо-оплата: только при демо-провайдере, только автор оплаты. */
export async function confirmDemoCheckout(ctx: Ctx, systemDb: Db, payments: PaymentProvider, checkoutId: string) {
  if (payments.name !== "demo") throw new NotFoundError("Недоступно");
  const c = (await systemDb.query("SELECT created_by FROM billing_checkouts WHERE id = $1", [checkoutId])).rows[0];
  if (!c || c.created_by !== ctx.actor.id) throw new NotFoundError("Оплата не найдена");
  return activateCheckout(systemDb, checkoutId, `demo:${checkoutId}`);
}

export async function paymentWebhook(systemDb: Db, payments: PaymentProvider, raw: string, headers: Record<string, string | undefined>) {
  const ev = payments.parseWebhook(raw, headers);
  if (!ev) throw Object.assign(new Error("Неверная подпись"), { status: 400 });
  if (ev.type === "ignored") return { ignored: true };
  // Идемпотентность: одно событие провайдера применяется один раз. Повтор доставки или переигрывание пропускаются.
  if (ev.eventId) {
    const first = (await systemDb.query("INSERT INTO billing_events(provider, event_id, type) VALUES ($1,$2,$3) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id", [payments.name, ev.eventId, ev.type])).rows[0];
    if (!first) return { duplicate: true };
  }
  if (ev.type === "checkout_paid" && ev.checkoutId) return activateCheckout(systemDb, ev.checkoutId, ev.subscriptionRef ?? null);
  if (ev.subscriptionRef) {
    const ids = (await systemDb.query("SELECT account_id, client_id FROM subscriptions WHERE provider_ref = $1", [ev.subscriptionRef])).rows;
    for (const r of ids) {
      if (ev.type === "renewed") await extend(systemDb, { accountId: r.account_id, clientId: r.client_id, months: 1, status: "active", provider: "stripe", ref: ev.subscriptionRef });
      else await systemDb.query("UPDATE subscriptions SET status = $2, updated_at = now() WHERE account_id = $1", [r.account_id, ev.type === "canceled" ? "canceled" : "past_due"]);
    }
    return { updated: ids.length };
  }
  return { ignored: true };
}

/** Промокод: бесплатные месяцы. Один код один раз на аккаунт, лимит активаций соблюдается атомарно. */
export async function redeemPromo(ctx: Ctx, systemDb: Db, accountId: string, input: unknown) {
  const d = z.object({ code: z.string().min(3).max(40) }).parse(input);
  assertAccountOwner(ctx, accountId);
  const a = (await systemDb.query("SELECT a.id, a.client_id FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = $1 AND c.agency_id = $2", [accountId, ctx.actor.agency_id])).rows[0];
  if (!a) throw new NotFoundError("Аккаунт не найден");
  return systemDb.tx(async (q) => {
    const p = (await q.query(`UPDATE promo_codes SET redemptions = redemptions + 1 WHERE agency_id = $1 AND upper(code) = upper($2) AND disabled_at IS NULL
        AND (expires_at IS NULL OR expires_at > now()) AND redemptions < max_redemptions AND (client_id IS NULL OR client_id = $3) RETURNING *`, [ctx.actor.agency_id, d.code.trim(), a.client_id])).rows[0];
    if (!p) throw new ValidationError("Промокод недействителен или исчерпан");
    const r = await q.query("INSERT INTO promo_redemptions(promo_code_id, client_id, account_id, redeemed_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id", [p.id, a.client_id, accountId, ctx.actor.id]);
    if (!r.rows.length) throw new ConflictError("Этот промокод уже использован для аккаунта");
    await extend(q, { accountId, clientId: a.client_id, months: p.free_months, status: "trialing", provider: "promo", userId: ctx.actor.id, promoId: p.id });
    await audit(q, ctx, { action: "billing.promo_redeemed", entity_type: "promo_code", entity_id: p.id, client_id: a.client_id, account_id: accountId, details: { months: p.free_months } });
    return { ok: true, free_months: p.free_months };
  });
}

const PromoInput = z.object({ code: z.string().regex(/^[A-Z0-9-]{4,40}$/i), free_months: z.number().int().min(1).max(12).default(1), max_redemptions: z.number().int().min(1).max(10000).default(100), expires_at: z.string().datetime().optional(), client_id: z.string().uuid().optional() });
export async function createPromo(ctx: Ctx, input: unknown) {
  requireOp(ctx, "manage_clients", {});
  const d = PromoInput.parse(input);
  const r = (await ctx.db.query("INSERT INTO promo_codes(agency_id, client_id, code, free_months, max_redemptions, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (agency_id, code) DO NOTHING RETURNING *",
    [ctx.actor.agency_id, d.client_id ?? null, d.code.toUpperCase(), d.free_months, d.max_redemptions, d.expires_at ?? null, ctx.actor.id])).rows[0];
  if (!r) throw new ConflictError("Такой промокод уже есть");
  await audit(ctx.db, ctx, { action: "billing.promo_created", entity_type: "promo_code", entity_id: r.id, details: { months: d.free_months, max: d.max_redemptions } });
  return r;
}
export async function listPromos(ctx: Ctx) {
  requireOp(ctx, "manage_clients", {});
  return (await ctx.db.query("SELECT id, code, free_months, max_redemptions, redemptions, expires_at, disabled_at, client_id, created_at FROM promo_codes WHERE agency_id = $1 ORDER BY created_at DESC", [ctx.actor.agency_id])).rows;
}

/** Места компании: кто оплачен и до какого числа. Руководитель видит это, потому что платит. */
export async function companyBilling(ctx: Ctx, systemDb: Db, clientId: string) {
  requireOp(ctx, "view_company", { clientId });
  const seats = (await systemDb.query(`SELECT a.id AS account_id, a.display_name, coalesce(s.status, 'none') AS status, s.period_end, s.provider,
        (s.status IN ('active','trialing') AND s.period_end > now()) AS active
      FROM managed_accounts a LEFT JOIN subscriptions s ON s.account_id = a.id WHERE a.client_id = $1 AND a.kind = 'employee' AND a.status = 'active' ORDER BY a.display_name`, [clientId])).rows;
  const active = seats.filter((s: any) => s.active).length;
  return { plan: PLAN, seats, active, monthly_usd: active * PLAN.priceUsd, unpaid: seats.length - active };
}

/** Окончание периода: подписка переходит в «просрочена», агент останавливается, сотрудник и руководитель получают напоминание. */
export async function billingTick(db: Db, now = new Date()) {
  const rows = (await db.query(`UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE status IN ('active','trialing') AND period_end < $1 RETURNING account_id, client_id`, [now.toISOString()])).rows;
  for (const r of rows) {
    const who = (await db.query(`SELECT g.user_id, c.agency_id FROM personal_agents g JOIN clients c ON c.id = g.client_id WHERE g.account_id = $1`, [r.account_id])).rows[0];
    const leaders = (await db.query("SELECT user_id FROM memberships WHERE role = 'client_admin' AND scope_client_id = $1 AND revoked_at IS NULL", [r.client_id])).rows.map((x: any) => x.user_id);
    if (who) await notify(db, { agency_id: who.agency_id, client_id: r.client_id, user_ids: [who.user_id, ...leaders], kind: "billing.past_due", title: `Подписка закончилась: агент на паузе. Продлите за $${PLAN.priceUsd} или введите промокод`, link: "#/me/agent", dedupe: `past_due:${r.account_id}:${now.toISOString().slice(0, 10)}` });
  }
  return { past_due: rows.length };
}
