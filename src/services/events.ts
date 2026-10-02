import type { Db } from "../db/db";
import { emit } from "./context";
import { notify, resolveAudience, type Audience } from "./notify";
import { runWorkflows } from "./workflows";
import { writeCapabilities } from "./accounts";

/** Какие системные события порождают уведомления и кому. */
const SYSTEM_ROUTES: Record<string, Audience[]> = {
  "content.failed": ["account_manager"],
  "content.publication_unknown": ["account_manager"],
  "content.published": ["account_manager"],
  "consent.revoked": ["account_manager"],
  "connection.expiring": ["account_manager"],
  "approval.sla_breached": [],
};

/**
 * Обработка transactional outbox: уведомления, сценарии. Идемпотентно:
 * событие помечается обработанным, повторная доставка не дублирует задачи и уведомления (dedupe_key).
 */
export async function processOutbox(db: Db, limit = 200) {
  const rows = (await db.query("SELECT * FROM outbox WHERE processed_at IS NULL ORDER BY id LIMIT $1", [limit])).rows;
  let handled = 0;
  for (const ev of rows) {
    try {
      const p = ev.payload ?? {};
      const contentId = p.content_item_id ?? null;
      let accountId = p.account_id ?? null;
      if (!accountId && contentId) accountId = (await db.query("SELECT account_id FROM content_items WHERE id = $1", [contentId])).rows[0]?.account_id ?? null;
      const clientId = ev.client_id ?? null;
      const agencyId = clientId
        ? (await db.query("SELECT agency_id FROM clients WHERE id = $1", [clientId])).rows[0]?.agency_id
        : p.agency_id ?? null;
      if (!agencyId) { await db.query("UPDATE outbox SET processed_at = now() WHERE id = $1", [ev.id]); continue; }
      const domainTopic = ev.topic === "notification" ? p.event : ev.topic;
      const link = contentId ? `#/content/${contentId}` : accountId ? `#/accounts/${accountId}` : p.link ?? null;

      if (ev.topic === "notification") {
        const users = await resolveAudience(db, p.audience, { account_id: accountId, client_id: clientId, content_item_id: contentId });
        await notify(db, { agency_id: agencyId, client_id: clientId, user_ids: users, kind: p.event, link, dedupe: `outbox:${ev.id}` });
      } else if (SYSTEM_ROUTES[ev.topic]) {
        for (const aud of SYSTEM_ROUTES[ev.topic]) {
          const users = await resolveAudience(db, aud, { account_id: accountId, client_id: clientId, content_item_id: contentId });
          await notify(db, { agency_id: agencyId, client_id: clientId, user_ids: users, kind: ev.topic, link, dedupe: `outbox:${ev.id}:${aud}` });
        }
      } else if (ev.topic === "export.ready" && p.user_id) {
        await notify(db, { agency_id: agencyId, client_id: clientId, user_ids: [p.user_id], kind: "export.ready", link: "#/exports", dedupe: `outbox:${ev.id}` });
      }
      // Сценарии работают только с бизнес-событиями (не с каждым уведомлением о шаге согласования).
      if (domainTopic) {
        await runWorkflows(db, { topic: domainTopic, key: ev.dedupe_key ?? `outbox:${ev.id}`, depth: p.depth ?? 0, agency_id: agencyId, client_id: clientId, account_id: accountId, content_item_id: contentId, payload: p });
      }
      await db.query("UPDATE outbox SET processed_at = now() WHERE id = $1", [ev.id]);
      handled++;
    } catch (e) {
      // Событие останется необработанным и будет повторено; ошибка не блокирует остальные.
      console.error(JSON.stringify({ msg: "outbox handler failed", id: ev.id, error: (e as Error).message }));
    }
  }
  return handled;
}

function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((+t - +y) / 864e5 + 1) / 7)}`;
}

/** Периодические проверки: SLA, сроки, истечение подключений, отставание от плана. */
export async function runScans(db: Db, now = new Date()) {
  const out: Record<string, number> = {};
  const iso = now.toISOString();
  // 1. Согласования дольше SLA клиента.
  const sla = (await db.query(
    `SELECT r.id, ci.id AS content_item_id, ci.account_id, ci.client_id FROM approval_requests r
       JOIN content_items ci ON ci.id = r.content_item_id JOIN clients c ON c.id = ci.client_id
      WHERE r.status = 'pending' AND r.created_at < $1::timestamptz - (c.approval_sla_hours || ' hours')::interval`, [iso])).rows;
  for (const r of sla) await emit(db, "approval.sla_breached", r.client_id, { content_item_id: r.content_item_id, account_id: r.account_id, approval_request_id: r.id }, `sla:${r.id}`);
  out.sla_breached = sla.length;
  // 2. Плановая дата близко, а материал не согласован.
  const risk = (await db.query(
    `SELECT id, account_id, client_id, planned_for FROM content_items
      WHERE planned_for BETWEEN $1::timestamptz AND $1::timestamptz + interval '48 hours'
        AND state IN ('idea','brief','draft','editorial_review','client_review','changes_requested')`, [iso])).rows;
  for (const r of risk) await emit(db, "content.deadline_risk", r.client_id, { content_item_id: r.id, account_id: r.account_id, planned_for: r.planned_for }, `deadline:${r.id}:${new Date(r.planned_for).toISOString().slice(0, 10)}`);
  out.deadline_risk = risk.length;
  // 3. Истечение подключений.
  const expiring = (await db.query(
    `UPDATE oauth_connections SET status = 'expiring', updated_at = now()
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < $1::timestamptz + interval '7 days' AND expires_at > $1::timestamptz
      RETURNING id, account_id, client_id`, [iso])).rows;
  for (const r of expiring) await emit(db, "connection.expiring", r.client_id, { account_id: r.account_id }, `expiring:${r.id}`);
  const expired = (await db.query(
    `UPDATE oauth_connections SET status = 'expired', updated_at = now() WHERE status IN ('active','expiring') AND expires_at IS NOT NULL AND expires_at <= $1::timestamptz
      RETURNING id, account_id, client_id`, [iso])).rows;
  for (const r of expired) {
    const kind = (await db.query("SELECT kind FROM managed_accounts WHERE id = $1", [r.account_id])).rows[0]?.kind;
    await writeCapabilities(db, r.account_id, r.client_id, kind, "expired", [], "token_expired");
    await emit(db, "connection.revoked", r.client_id, { account_id: r.account_id, reason: "expired" }, `expired:${r.id}`);
  }
  out.connections_expiring = expiring.length;
  out.connections_expired = expired.length;
  // 4. Отставание от недельного плана (проверка раз в неделю на аккаунт).
  const week = isoWeek(now);
  const behind = (await db.query(
    `SELECT a.id, a.client_id, (s.playbook->>'posts_per_week')::numeric AS plan,
            (SELECT count(*)::int FROM external_publications ep WHERE ep.account_id = a.id AND ep.published_at > $1::timestamptz - interval '7 days') AS fact
       FROM managed_accounts a JOIN strategy_versions s ON s.account_id = a.id AND s.status = 'approved'
      WHERE a.status = 'active' AND NOT a.publishing_paused AND a.created_at < $1::timestamptz - interval '7 days'`, [iso])).rows.filter((r: any) => r.fact < Math.floor(Number(r.plan)));
  for (const r of behind) await emit(db, "plan.week_behind", r.client_id, { account_id: r.id, plan: Number(r.plan), fact: r.fact }, `behind:${r.id}:${week}`);
  out.week_behind = behind.length;
  return out;
}
