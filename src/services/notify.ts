import type { Db, Queryable } from "../db/db";
import { audit, NotFoundError, type Ctx } from "./context";

/** Доставка уведомлений во внешние каналы. В приложении уведомление есть всегда. */
export interface Mailer {
  name: string;
  send(msg: { to: string; subject: string; text: string; link?: string | null }): Promise<void>;
}
export class ConsoleMailer implements Mailer {
  name = "console";
  sent: { to: string; subject: string }[] = [];
  async send(m: { to: string; subject: string }) { this.sent.push({ to: m.to, subject: m.subject }); }
}
/** Postmark HTTP API. Токен в POSTMARK_TOKEN, отправитель в MAIL_FROM. */
export class PostmarkMailer implements Mailer {
  name = "postmark";
  constructor(private token: string, private from: string, private appUrl: string) {}
  async send(m: { to: string; subject: string; text: string; link?: string | null }) {
    const r = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "X-Postmark-Server-Token": this.token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ From: this.from, To: m.to, Subject: m.subject, TextBody: `${m.text}${m.link ? `\n\n${this.appUrl}/${m.link}` : ""}`, MessageStream: "outbound" }),
    });
    if (!r.ok) throw new Error(`Postmark ${r.status}`);
  }
}
/** Вебхук (Slack, Telegram-бот, n8n). Получает JSON без клиентского контента. */
export class WebhookMailer implements Mailer {
  name = "webhook";
  constructor(private url: string) {}
  async send(m: { to: string; subject: string; link?: string | null }) {
    const r = await fetch(this.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: m.to, text: m.subject, link: m.link }) });
    if (!r.ok) throw new Error(`Webhook ${r.status}`);
  }
}
export function mailerFromEnv(env = process.env): Mailer {
  if (env.POSTMARK_TOKEN && env.MAIL_FROM) return new PostmarkMailer(env.POSTMARK_TOKEN, env.MAIL_FROM, env.APP_URL ?? "");
  if (env.NOTIFY_WEBHOOK_URL) return new WebhookMailer(env.NOTIFY_WEBHOOK_URL);
  return new ConsoleMailer();
}

export type Audience = "account_manager" | "editor" | "client_approvers" | "author" | "ops_director" | "strategist" | "owner" | "assignee";

/** Разрешает адресатов в пользователей с действующим доступом к аккаунту. */
export async function resolveAudience(q: Queryable, audience: Audience, ref: { account_id?: string | null; client_id?: string | null; content_item_id?: string | null; user_id?: string | null }): Promise<string[]> {
  const acc = ref.account_id ? (await q.query("SELECT id, client_id, manager_id FROM managed_accounts WHERE id = $1", [ref.account_id])).rows[0] : null;
  const clientId = acc?.client_id ?? ref.client_id ?? null;
  const byRole = async (role: string) => (await q.query(
    `SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.role = $1 AND m.revoked_at IS NULL AND u.is_active
        AND (m.scope_client_id IS NULL AND m.scope_account_id IS NULL OR m.scope_client_id = $2 OR m.scope_account_id = $3)`, [role, clientId, acc?.id ?? null])).rows.map((r: any) => r.user_id);
  switch (audience) {
    case "account_manager": return acc?.manager_id ? [acc.manager_id] : byRole("account_manager");
    case "author": {
      if (!ref.content_item_id) return [];
      const r = (await q.query("SELECT author_id FROM content_items WHERE id = $1", [ref.content_item_id])).rows[0];
      return r?.author_id ? [r.author_id] : [];
    }
    case "client_approvers": return byRole("client");
    case "assignee": return ref.user_id ? [ref.user_id] : [];
    default: return byRole(audience);
  }
}

const TITLES: Record<string, string> = {
  "content.sent_to_editor": "Материал ждёт редакторской проверки",
  "content.editor_approved": "Материал ждёт вашего согласования",
  "content.changes_requested": "По материалу запрошены правки",
  "content.client_approved": "Клиент согласовал материал",
  "content.scheduled": "Публикация запланирована",
  "content.published": "Публикация подтверждена",
  "content.failed": "Ошибка публикации",
  "content.publication_unknown": "Исход публикации неизвестен: нужна проверка",
  "content.cancelled": "Материал отменён",
  "approval.sla_breached": "Согласование просрочено",
  "connection.expiring": "Подключение LinkedIn скоро истечёт",
  "consent.revoked": "Клиент отозвал согласие",
  "export.ready": "Экспорт готов",
};

export async function notify(q: Queryable, n: { agency_id: string; client_id?: string | null; user_ids: string[]; kind: string; title?: string; link?: string | null; dedupe: string }) {
  let created = 0;
  for (const uid of [...new Set(n.user_ids)]) {
    const r = await q.query(
      "INSERT INTO notifications(agency_id, client_id, user_id, kind, title, link, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id",
      [n.agency_id, n.client_id ?? null, uid, n.kind, n.title ?? TITLES[n.kind] ?? n.kind, n.link ?? null, `${n.dedupe}:${uid}`]);
    created += r.rows.length;
  }
  return created;
}

/** Отправка недоставленных уведомлений во внешний канал. */
export async function deliverPending(db: Db, mailer: Mailer, limit = 100) {
  const rows = (await db.query(
    "SELECT n.id, n.title, n.link, u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.delivered_at IS NULL AND u.is_active ORDER BY n.created_at LIMIT $1", [limit])).rows;
  let ok = 0;
  for (const r of rows) {
    try {
      await mailer.send({ to: r.email, subject: r.title, text: r.title, link: r.link });
      await db.query("UPDATE notifications SET delivered_at = now() WHERE id = $1", [r.id]);
      ok++;
    } catch { /* повторим на следующем проходе */ }
  }
  return ok;
}

export async function listNotifications(ctx: Ctx, unreadOnly = false) {
  return (await ctx.db.query(`SELECT id, kind, title, link, created_at, read_at FROM notifications WHERE user_id = $1 ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT 100`, [ctx.actor.id])).rows;
}
export async function markRead(ctx: Ctx, ids: string[] | "all") {
  if (ids === "all") await ctx.db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [ctx.actor.id]);
  else {
    const r = await ctx.db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) RETURNING id", [ctx.actor.id, ids]);
    if (!r.rows.length && ids.length) throw new NotFoundError("Уведомление не найдено");
  }
  return { ok: true };
}
export { audit };
