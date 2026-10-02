import type { Db, Queryable } from "../db/db";
import { agencyWide, allowedOperations, can, ForbiddenError, type Membership, type Operation } from "../core/permissions";

export interface Actor { id: string; agency_id: string; display_name: string; memberships: Membership[] }
export interface Ctx { db: Db; actor: Actor }

export class NotFoundError extends Error { status = 404; }
export class ValidationError extends Error { status = 422; constructor(msg: string, public details?: unknown) { super(msg); } }
export class ConflictError extends Error { status = 409; constructor(msg: string, public details?: unknown) { super(msg); } }

export async function loadActor(db: Queryable, userId: string): Promise<Actor | null> {
  const u = (await db.query("SELECT id, agency_id, display_name FROM users WHERE id = $1 AND is_active", [userId])).rows[0];
  if (!u) return null;
  const memberships = (await db.query<Membership>("SELECT role, scope_client_id, scope_account_id, revoked_at FROM memberships WHERE user_id = $1 AND revoked_at IS NULL", [userId])).rows;
  return { ...u, memberships };
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
