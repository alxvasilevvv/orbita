import { accountScope, requireOp, type Ctx } from "./context";
import { membershipApplies } from "../core/permissions";

/** Есть ли у пользователя внутренняя (агентская) роль для цели. Клиенту доступен только кабинет. */
export function hasInternalRole(ctx: Ctx, t: { clientId?: string; accountId?: string }) {
  return ctx.actor.memberships.some((m) => m.role !== "client" && membershipApplies(m, t));
}

/** Кабинет клиента: только его ресурсы и только разрешённые ему сведения (без внутренних задач, затрат и журналов команды). */
export async function portalHome(ctx: Ctx) {
  const ids = (await ctx.db.query(
    `SELECT DISTINCT a.id FROM managed_accounts a
      WHERE a.id = ANY($1::uuid[]) OR a.client_id = ANY($2::uuid[])`,
    [ctx.actor.memberships.filter((m) => m.role === "client" && m.scope_account_id).map((m) => m.scope_account_id),
     ctx.actor.memberships.filter((m) => m.role === "client" && m.scope_client_id).map((m) => m.scope_client_id)])).rows.map((r: any) => r.id);
  const accounts = [];
  for (const id of ids) accounts.push(await portalAccount(ctx, id));
  return { accounts };
}

export async function portalAccount(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "view", { clientId: a.client_id, accountId });
  const q = ctx.db;
  const [account, strategy, approvals, published, upcoming, reports, consents] = await Promise.all([
    q.query("SELECT a.id, a.display_name, a.kind, a.timezone, a.profile_url, c.name AS client_name FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = $1", [accountId]).then((r) => r.rows[0]),
    q.query("SELECT playbook->>'goal' AS goal, playbook->>'posts_per_week' AS posts_per_week, playbook->'pillars' AS pillars, version FROM strategy_versions WHERE account_id = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1", [accountId]).then((r) => r.rows[0] ?? null),
    q.query(`SELECT r.id AS approval_request_id, ci.id AS content_item_id, ci.title, cv.version, cv.body, cv.media_ids, coalesce(ci.scheduled_at, ci.planned_for) AS due_at, r.created_at
               FROM approval_requests r JOIN content_items ci ON ci.id = r.content_item_id JOIN content_versions cv ON cv.id = r.content_version_id
              WHERE ci.account_id = $1 AND r.stage = 'client' AND r.status = 'pending' ORDER BY r.created_at`, [accountId]).then((r) => r.rows),
    q.query(`SELECT ci.title, ep.url, ep.evidence_type, ep.published_at FROM external_publications ep JOIN content_items ci ON ci.id = ep.content_item_id
              WHERE ep.account_id = $1 ORDER BY ep.published_at DESC LIMIT 20`, [accountId]).then((r) => r.rows),
    q.query("SELECT ci.title, ci.scheduled_at, ci.state FROM content_items ci WHERE ci.account_id = $1 AND ci.state = 'scheduled' ORDER BY scheduled_at LIMIT 20", [accountId]).then((r) => r.rows),
    q.query("SELECT id, kind, period_start, period_end, created_at FROM reports WHERE account_id = $1 AND status = 'shared' ORDER BY created_at DESC", [accountId]).then((r) => r.rows),
    q.query("SELECT id, action_scope, granted_by_name, granted_at, revoked_at FROM consents WHERE account_id = $1 ORDER BY granted_at DESC", [accountId]).then((r) => r.rows),
  ]);
  return { account, strategy, approvals, published, upcoming, reports, consents };
}
