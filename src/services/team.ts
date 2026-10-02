import { z } from "zod";
import { audit, NotFoundError, requireOp, ValidationError, type Ctx } from "./context";
import { can, ForbiddenError, ROLES } from "../core/permissions";

export async function listTeam(ctx: Ctx) {
  requireOp(ctx, "manage_team", {});
  const finance = can(ctx.actor.memberships, "view_finance", {});
  const users = (await ctx.db.query(`
    SELECT u.id, u.email, u.display_name, u.is_active, u.mfa_enrolled, u.languages, u.weekly_capacity_hours::float AS weekly_capacity_hours,
           ${finance ? "u.internal_hourly_rate::float" : "NULL"} AS internal_hourly_rate,
           coalesce(json_agg(json_build_object('id', m.id, 'role', m.role, 'client_id', m.scope_client_id, 'account_id', m.scope_account_id,
             'client_name', c.name, 'account_name', a.display_name)) FILTER (WHERE m.id IS NOT NULL), '[]') AS memberships
      FROM users u LEFT JOIN memberships m ON m.user_id = u.id AND m.revoked_at IS NULL
      LEFT JOIN clients c ON c.id = m.scope_client_id LEFT JOIN managed_accounts a ON a.id = m.scope_account_id
     WHERE u.agency_id = $1 GROUP BY u.id ORDER BY u.is_active DESC, u.display_name`, [ctx.actor.agency_id])).rows;
  return { users, roles: ROLES };
}

const Grant = z.object({ user_id: z.string().uuid(), role: z.enum(ROLES), scope_client_id: z.string().uuid().nullable().optional(), scope_account_id: z.string().uuid().nullable().optional() });

/** Выдача роли на уровне агентства, клиента или аккаунта. */
export async function grantRole(ctx: Ctx, input: unknown) {
  requireOp(ctx, "manage_team", {});
  const d = Grant.parse(input);
  if (d.role === "owner" && !ctx.actor.memberships.some((m) => m.role === "owner")) throw new ForbiddenError("manage_team", "Роль владельца выдаёт только владелец");
  if (d.role === "client" && !d.scope_client_id && !d.scope_account_id) throw new ValidationError("Роль клиента выдаётся только на клиента или аккаунт");
  if (d.scope_client_id && d.scope_account_id) throw new ValidationError("Укажите либо клиента, либо аккаунт");
  const u = (await ctx.db.query("SELECT id FROM users WHERE id = $1 AND agency_id = $2", [d.user_id, ctx.actor.agency_id])).rows[0];
  if (!u) throw new NotFoundError("Пользователь не найден");
  if (d.scope_client_id && !(await ctx.db.query("SELECT 1 FROM clients WHERE id = $1", [d.scope_client_id])).rows.length) throw new NotFoundError("Клиент не найден");
  if (d.scope_account_id && !(await ctx.db.query("SELECT 1 FROM managed_accounts WHERE id = $1", [d.scope_account_id])).rows.length) throw new NotFoundError("Аккаунт не найден");
  const m = (await ctx.db.query("INSERT INTO memberships(user_id, agency_id, role, scope_client_id, scope_account_id) VALUES ($1,$2,$3,$4,$5) RETURNING id", [d.user_id, ctx.actor.agency_id, d.role, d.scope_client_id ?? null, d.scope_account_id ?? null])).rows[0];
  await audit(ctx.db, ctx, { action: "role.granted", entity_type: "membership", entity_id: m.id, client_id: d.scope_client_id ?? undefined, account_id: d.scope_account_id ?? undefined, details: { user_id: d.user_id, role: d.role } });
  return m;
}

export async function revokeRole(ctx: Ctx, membershipId: string) {
  requireOp(ctx, "manage_team", {});
  const m = (await ctx.db.query("SELECT * FROM memberships WHERE id = $1 AND agency_id = $2 AND revoked_at IS NULL", [membershipId, ctx.actor.agency_id])).rows[0];
  if (!m) throw new NotFoundError("Роль не найдена");
  if (m.role === "owner") {
    const owners = (await ctx.db.query("SELECT count(*)::int n FROM memberships WHERE agency_id = $1 AND role = 'owner' AND revoked_at IS NULL", [ctx.actor.agency_id])).rows[0].n;
    if (owners <= 1) throw new ValidationError("Нельзя отозвать роль последнего владельца");
  }
  await ctx.db.query("UPDATE memberships SET revoked_at = now() WHERE id = $1", [membershipId]);
  await audit(ctx.db, ctx, { action: "role.revoked", entity_type: "membership", entity_id: membershipId, details: { user_id: m.user_id, role: m.role } });
  return { ok: true };
}

/** Приглашение сотрудника или клиента. Пароль не хранится: вход через IdP с MFA. */
export async function inviteUser(ctx: Ctx, input: unknown) {
  requireOp(ctx, "manage_team", {});
  const d = z.object({ email: z.string().email(), display_name: z.string().min(1), languages: z.array(z.string()).default([]), weekly_capacity_hours: z.number().min(0).max(80).default(40) }).parse(input);
  const exists = (await ctx.db.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [d.email])).rows.length;
  if (exists) throw new ValidationError("Пользователь с таким email уже есть");
  const u = (await ctx.db.query("INSERT INTO users(agency_id, email, display_name, languages, weekly_capacity_hours) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, display_name", [ctx.actor.agency_id, d.email.toLowerCase(), d.display_name, d.languages, d.weekly_capacity_hours])).rows[0];
  await audit(ctx.db, ctx, { action: "user.invited", entity_type: "user", entity_id: u.id });
  return u;
}

export async function updateCapacity(ctx: Ctx, userId: string, input: unknown) {
  requireOp(ctx, "manage_team", {});
  const d = z.object({ weekly_capacity_hours: z.number().min(0).max(80).optional(), internal_hourly_rate: z.number().min(0).nullable().optional(), languages: z.array(z.string()).optional() }).parse(input);
  if (d.internal_hourly_rate !== undefined) requireOp(ctx, "view_finance", {});
  const r = await ctx.db.query(
    `UPDATE users SET weekly_capacity_hours = coalesce($2, weekly_capacity_hours), internal_hourly_rate = CASE WHEN $3::boolean THEN $4 ELSE internal_hourly_rate END, languages = coalesce($5, languages)
      WHERE id = $1 AND agency_id = $6 RETURNING id`,
    [userId, d.weekly_capacity_hours ?? null, d.internal_hourly_rate !== undefined, d.internal_hourly_rate ?? null, d.languages ?? null, ctx.actor.agency_id]);
  if (!r.rows.length) throw new NotFoundError("Пользователь не найден");
  await audit(ctx.db, ctx, { action: "user.capacity_updated", entity_type: "user", entity_id: userId, details: { rate_changed: d.internal_hourly_rate !== undefined } });
  return { ok: true };
}

/* ---------- инциденты ---------- */
export async function listIncidents(ctx: Ctx, status?: string) {
  requireOp(ctx, "manage_tasks", {});
  return (await ctx.db.query(`SELECT i.*, c.name AS client_name, a.display_name AS account_name, u.display_name AS owner_name
      FROM incidents i LEFT JOIN clients c ON c.id = i.client_id LEFT JOIN managed_accounts a ON a.id = i.account_id LEFT JOIN users u ON u.id = i.owner_id
     WHERE i.agency_id = $1 ${status ? "AND i.status = $2" : ""} ORDER BY (i.status = 'open') DESC, i.created_at DESC LIMIT 200`, status ? [ctx.actor.agency_id, status] : [ctx.actor.agency_id])).rows;
}
export async function createIncident(ctx: Ctx, input: unknown) {
  requireOp(ctx, "manage_tasks", {});
  const d = z.object({ severity: z.enum(["low", "medium", "high", "critical"]), kind: z.string().min(1), summary: z.string().min(3), account_id: z.string().uuid().optional() }).parse(input);
  let clientId: string | null = null;
  if (d.account_id) clientId = (await ctx.db.query("SELECT client_id FROM managed_accounts WHERE id = $1", [d.account_id])).rows[0]?.client_id ?? null;
  const r = (await ctx.db.query("INSERT INTO incidents(agency_id, client_id, account_id, severity, kind, summary, owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [ctx.actor.agency_id, clientId, d.account_id ?? null, d.severity, d.kind, d.summary, ctx.actor.id])).rows[0];
  await audit(ctx.db, ctx, { action: "incident.created", entity_type: "incident", entity_id: r.id, client_id: clientId ?? undefined });
  return r;
}
export async function resolveIncident(ctx: Ctx, id: string, input: unknown) {
  requireOp(ctx, "manage_tasks", {});
  const d = z.object({ resolution: z.string().min(3) }).parse(input);
  const r = await ctx.db.query("UPDATE incidents SET status = 'resolved', resolved_at = now(), resolution = $2, owner_id = coalesce(owner_id, $3) WHERE id = $1 AND agency_id = $4 AND status = 'open' RETURNING id, client_id", [id, d.resolution, ctx.actor.id, ctx.actor.agency_id]);
  if (!r.rows.length) throw new NotFoundError("Открытый инцидент не найден");
  await audit(ctx.db, ctx, { action: "incident.resolved", entity_type: "incident", entity_id: id, client_id: r.rows[0].client_id ?? undefined });
  return { ok: true };
}
