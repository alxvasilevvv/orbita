import type { Db, Queryable } from "../db/db";
import { scopedDb, type DbScope } from "../db/scope";
import { agencyWide, allowedOperations, can, ForbiddenError, type Membership, type Operation } from "../core/permissions";

export interface Actor { id: string; agency_id: string; display_name: string; memberships: Membership[]; scope: DbScope }
export interface Ctx { db: Db; actor: Actor }

export class NotFoundError extends Error { status = 404; }
export class ValidationError extends Error { status = 422; constructor(msg: string, public details?: unknown) { super(msg); } }
export class ConflictError extends Error { status = 409; constructor(msg: string, public details?: unknown) { super(msg); } }

/** Загружает пользователя системным подключением (до того, как известна его область). */
export async function loadActor(db: Queryable, userId: string): Promise<Actor | null> {
  // Одно обращение к базе: пользователь, роли, клиенты его аккаунтов и клиенты агентства.
  const u = (await db.query(`
    SELECT u.id, u.agency_id, u.display_name,
      coalesce((SELECT json_agg(json_build_object('role', m.role, 'scope_client_id', m.scope_client_id, 'scope_account_id', m.scope_account_id, 'revoked_at', NULL))
                  FROM memberships m WHERE m.user_id = u.id AND m.revoked_at IS NULL), '[]') AS memberships,
      coalesce((SELECT array_agg(DISTINCT a.client_id) FROM memberships m JOIN managed_accounts a ON a.id = m.scope_account_id
                 WHERE m.user_id = u.id AND m.revoked_at IS NULL), '{}') AS account_clients,
      coalesce((SELECT array_agg(c.id) FROM clients c WHERE c.agency_id = u.agency_id), '{}') AS agency_clients
      FROM users u WHERE u.id = $1 AND u.is_active`, [userId])).rows[0];
  if (!u) return null;
  const memberships: Membership[] = typeof u.memberships === "string" ? JSON.parse(u.memberships) : u.memberships;
  const wide = agencyWide(memberships);
  // Для ролей уровня агентства в область попадают все клиенты агентства: политика RLS проверяет членство в списке.
  const clientIds = [...new Set([...(wide ? u.agency_clients : []), ...memberships.filter((m) => m.scope_client_id).map((m) => m.scope_client_id as string), ...u.account_clients])] as string[];
  const scope: DbScope = {
    agencyId: u.agency_id,
    allClients: wide,
    clientIds,
    audit: memberships.some((m) => m.role === "auditor" || m.role === "owner"),
  };
  return { id: u.id, agency_id: u.agency_id, display_name: u.display_name, memberships, scope };
}

/** Контекст запроса: все запросы пользователя идут через RLS-обёртку. */
export function actorCtx(base: Db, actor: Actor): Ctx {
  return { db: scopedDb(base, actor.scope), actor };
}

/** Клиент выводится из аккаунта на сервере: client_id из запроса не принимается на веру. */
export async function accountScope(q: Queryable, ctx: Ctx, accountId: string) {
  const r = (await q.query(
    `SELECT a.id, a.client_id, a.timezone, a.kind, a.display_name, a.publishing_paused, a.confidential_job_search
       FROM managed_accounts a JOIN clients c ON c.id = a.client_id
      WHERE a.id = $1 AND c.agency_id = $2`, [accountId, ctx.actor.agency_id])).rows[0];
  // Чужой или несуществующий объект неразличимы для запрашивающего.
  if (!r || !allowedOperations(ctx.actor.memberships, { clientId: r.client_id, accountId: r.id }).size) throw new NotFoundError("Аккаунт не найден");
  return r as { id: string; client_id: string; timezone: string; kind: string; display_name: string; publishing_paused: boolean; confidential_job_search: boolean };
}

export function requireOp(ctx: Ctx, op: Operation, t: { clientId?: string; accountId?: string }) {
  if (!can(ctx.actor.memberships, op, t)) throw new ForbiddenError(op);
}

/** SQL-фильтр видимых аккаунтов для текущего актора. */
export function visibleAccountsFilter(ctx: Ctx, alias = "a", startIndex = 1): { sql: string; params: unknown[] } {
  if (agencyWide(ctx.actor.memberships)) return { sql: "TRUE", params: [] };
  const clientIds = ctx.actor.memberships.filter((m) => m.scope_client_id && !m.scope_account_id && m.role !== "auditor").map((m) => m.scope_client_id);
  const accountIds = ctx.actor.memberships.filter((m) => m.scope_account_id && m.role !== "auditor").map((m) => m.scope_account_id);
  return {
    sql: `(${alias}.client_id = ANY($${startIndex}::uuid[]) OR ${alias}.id = ANY($${startIndex + 1}::uuid[]))`,
    params: [clientIds, accountIds],
  };
}

export async function audit(q: Queryable, ctx: Ctx | { actor: { id: string | null; agency_id: string } }, e: { action: string; entity_type: string; entity_id?: string; client_id?: string; account_id?: string; details?: Record<string, unknown> }) {
  await q.query(
    "INSERT INTO audit_events(agency_id, client_id, account_id, actor_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [ctx.actor.agency_id, e.client_id ?? null, e.account_id ?? null, ctx.actor.id, e.action, e.entity_type, e.entity_id ?? null, JSON.stringify(e.details ?? {})],
  );
}

export async function emit(q: Queryable, topic: string, clientId: string | null, payload: Record<string, unknown>, dedupeKey?: string) {
  await q.query("INSERT INTO outbox(topic, client_id, payload, dedupe_key) VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING", [topic, clientId, JSON.stringify(payload), dedupeKey ?? null]);
}
