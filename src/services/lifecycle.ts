import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/db";
import { audit, ConflictError, emit, NotFoundError, requireOp, ValidationError, type Ctx } from "./context";
import { ForbiddenError } from "../core/permissions";
import type { Storage } from "./storage";
import { cancelPendingJobs } from "./jobs";

/**
 * Порядок удаления данных клиента с учётом внешних ключей. Каждая таблица с client_id
 * обязана быть в списке: иначе процедура откажется работать (защита от забытой новой таблицы).
 */
export const DELETION_ORDER = [
  "billing_events", "agent_messages", "content_plans", "telegram_outbox", "autopilot_posts", "portrait_jobs", "outreach_items", "x_engagements", "promo_redemptions", "subscriptions", "billing_checkouts", "personal_agents", "promo_codes",
  "mission_actions", "agent_runs", "agent_missions", "safety_events", "account_safety", "employee_profiles", "employee_invites", "company_briefs",
  "notifications", "outbox", "workflow_runs", "workflow_definitions", "exports",
  "engagement_recommendations", "engagement_sources",
  "approval_decisions", "approval_requests",
  "external_publications", "publication_jobs", "action_records",
  "metric_snapshots", "opportunities", "reports", "time_entries", "tasks",
  "experiments", "strategy_recommendations", "profile_audits",
  "ai_executions", "content_versions", "content_items", "media_assets",
  "verified_claims", "knowledge_sources", "strategy_versions", "capability_snapshots",
  "oauth_connections", "consents", "account_assignments", "incidents",
  "managed_accounts",
];
/** Журнал аудита хранит только метаданные и остаётся как доказательство выполнения процедуры. */
const KEEP = new Set(["audit_events"]);

export interface SecretDeleter { delete(ref: string): Promise<void> }

/** Начало завершения обслуживания: публикация остановлена, подключения отозваны, токены удалены. */
export async function startOffboarding(ctx: Ctx, deps: { secrets: SecretDeleter }, clientId: string) {
  requireOp(ctx, "manage_clients", { clientId });
  const c = (await ctx.db.query("SELECT id, status FROM clients WHERE id = $1", [clientId])).rows[0];
  if (!c) throw new NotFoundError("Клиент не найден");
  if (c.status === "offboarding") throw new ConflictError("Завершение обслуживания уже начато");
  const refs = (await ctx.db.query("SELECT secret_ref FROM oauth_connections WHERE client_id = $1", [clientId])).rows.map((r: any) => r.secret_ref);
  const r = await ctx.db.tx(async (q) => {
    await q.query("UPDATE clients SET status = 'offboarding', offboarding_started_at = now() WHERE id = $1", [clientId]);
    await q.query("UPDATE managed_accounts SET publishing_paused = true, status = 'paused' WHERE client_id = $1", [clientId]);
    const jobs = { rows: await cancelPendingJobs(q, { clientId }, "client_offboarding", { resetScheduled: true }) };
    await q.query("UPDATE oauth_connections SET status = 'revoked', updated_at = now() WHERE client_id = $1", [clientId]);
    await q.query("UPDATE consents SET revoked_at = now() WHERE client_id = $1 AND revoked_at IS NULL", [clientId]);
    await emit(q, "client.offboarding", clientId, {}, `offboarding:${clientId}`);
    await audit(q, ctx, { action: "client.offboarding_started", entity_type: "client", entity_id: clientId, client_id: clientId, details: { cancelled_jobs: jobs.rows.length } });
    return { cancelled_jobs: jobs.rows.length };
  });
  for (const ref of refs) await deps.secrets.delete(ref);
  return { ...r, secrets_deleted: refs.length };
}

/** Полное удаление данных клиента по всем хранилищам. Только владелец, только после начала завершения. */
export async function deleteClientData(ctx: Ctx, deps: { systemDb: Db; storage: Storage; secrets: SecretDeleter }, clientId: string, input: unknown) {
  if (!ctx.actor.memberships.some((m) => m.role === "owner" && !m.scope_client_id && !m.revoked_at)) throw new ForbiddenError("delete", "Удаление данных клиента выполняет только владелец агентства");
  const d = z.object({ confirm_name: z.string() }).parse(input);
  const c = (await ctx.db.query("SELECT id, name, status FROM clients WHERE id = $1", [clientId])).rows[0];
  if (!c) throw new NotFoundError("Клиент не найден");
  if (c.status !== "offboarding") throw new ConflictError("Сначала начните завершение обслуживания");
  if (d.confirm_name.trim() !== c.name) throw new ValidationError("Название клиента для подтверждения не совпадает");
  const db = deps.systemDb;
  const run = (await db.query("INSERT INTO deletion_runs(agency_id, client_ref, client_name_hash, requested_by, status) VALUES ($1,$2,$3,$4,'running') RETURNING id",
    [ctx.actor.agency_id, clientId, createHash("sha256").update(c.name).digest("hex"), ctx.actor.id])).rows[0].id;
  const steps: { step: string; result: unknown }[] = [];
  try {
    // 0. Проверка полноты списка таблиц.
    const tables = (await db.query("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'")).rows.map((r: any) => r.table_name);
    const missing = tables.filter((t: string) => !DELETION_ORDER.includes(t) && !KEEP.has(t));
    if (missing.length) throw new Error(`Таблицы без правила удаления: ${missing.join(", ")}`);
    // 1. Секреты.
    const refs = (await db.query("SELECT secret_ref FROM oauth_connections WHERE client_id = $1", [clientId])).rows.map((r: any) => r.secret_ref);
    for (const ref of refs) await deps.secrets.delete(ref);
    steps.push({ step: "secrets", result: refs.length });
    // 2. Файлы (медиа, экспорты) по префиксу клиента.
    steps.push({ step: "files", result: await deps.storage.deletePrefix(`clients/${clientId}/`) });
    // 2a. Выгрузки уровня агентства могут содержать строки этого клиента (задачи, время): удаляются целиком,
    // записи о них помечаются истёкшими. Их можно сформировать заново без удалённого клиента.
    const agencyExports = await deps.storage.deletePrefix(`agencies/${ctx.actor.agency_id}/exports/`);
    await db.query("UPDATE exports SET status = 'expired', storage_key = NULL WHERE agency_id = $1 AND client_id IS NULL AND status IN ('ready','queued','running')", [ctx.actor.agency_id]);
    steps.push({ step: "agency_exports", result: agencyExports });
    // 3. База данных. Пользователи, у которых был доступ только как у представителей этого клиента, обезличиваются.
    const clientUsers = (await db.query(
      `SELECT DISTINCT m.user_id FROM memberships m LEFT JOIN managed_accounts a ON a.id = m.scope_account_id
        WHERE m.role IN ('client','client_admin') AND (m.scope_client_id = $1 OR a.client_id = $1)`, [clientId])).rows.map((r: any) => r.user_id);
    const counts: Record<string, number> = {};
    await db.tx(async (q) => {
      for (const t of DELETION_ORDER) {
        if (!tables.includes(t)) continue;
        const r = await q.query(`DELETE FROM ${t} WHERE client_id = $1`, [clientId]);
        counts[t] = (r as any).affectedRows ?? (r as any).rowCount ?? 0;
      }
      await q.query("DELETE FROM managed_accounts WHERE client_id = $1", [clientId]);
      await q.query("DELETE FROM clients WHERE id = $1", [clientId]);
      for (const uid of clientUsers) {
        const left = (await q.query("SELECT count(*)::int n FROM memberships WHERE user_id = $1 AND revoked_at IS NULL", [uid])).rows[0].n;
        if (!left) await q.query("UPDATE users SET email = 'deleted-' || id || '@invalid', display_name = 'Удалённый пользователь', languages = '{}', is_active = false WHERE id = $1", [uid]);
      }
      counts.users_anonymized = clientUsers.length;
    });
    steps.push({ step: "database", result: counts });
    // 4. Проверка: не осталось строк ни в одной таблице с client_id.
    const leftovers: string[] = [];
    for (const t of tables) {
      if (KEEP.has(t)) continue;
      const n = (await db.query(`SELECT count(*)::int n FROM ${t} WHERE client_id = $1`, [clientId])).rows[0].n;
      if (n) leftovers.push(`${t}: ${n}`);
    }
    const files = await deps.storage.list(`clients/${clientId}/`);
    if (leftovers.length || files.length) throw new Error(`Остались данные: ${[...leftovers, files.length ? `files: ${files.length}` : ""].filter(Boolean).join("; ")}`);
    // 5. Производные хранилища: кэша и поискового индекса в платформе нет; резервные копии истекают по ротации.
    const backupDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 35);
    steps.push({ step: "backups", result: `Данные исчезнут из резервных копий после ротации: до ${new Date(Date.now() + backupDays * 864e5).toISOString().slice(0, 10)}` });
    steps.push({ step: "verification", result: "ok" });
    await db.query("UPDATE deletion_runs SET status = 'completed', steps = $2, finished_at = now() WHERE id = $1", [run, JSON.stringify(steps)]);
    await audit(db, ctx, { action: "client.data_deleted", entity_type: "deletion_run", entity_id: run, details: { steps: steps.map((s) => s.step) } });
    return { deletion_run_id: run, steps };
  } catch (e: any) {
    await db.query("UPDATE deletion_runs SET status = 'failed', steps = $2, finished_at = now() WHERE id = $1", [run, JSON.stringify([...steps, { step: "error", result: e.message }])]);
    throw e;
  }
}

/** Применение сроков хранения (ежедневно). Аудит не хранит исходный контент, поэтому удаляется только по сроку. */
export async function runRetention(db: Db, storage: Storage, now = new Date()) {
  const iso = now.toISOString();
  const policy = async (cls: string) => (await db.query("SELECT retention_days FROM retention_policies WHERE data_class = $1", [cls])).rows[0]?.retention_days as number | null;
  const out: Record<string, number> = {};
  const del = async (name: string, sql: string, p: unknown[]) => { const r = await db.query(sql, p); out[name] = r.rows.length; };
  const api = await policy("linkedin_api_data");
  if (api) await del("linkedin_api_metrics", "DELETE FROM metric_snapshots WHERE source = 'linkedin_api' AND observed_at < $1::timestamptz - ($2 || ' days')::interval RETURNING id", [iso, String(api)]);
  const manual = await policy("manual_metrics");
  if (manual) await del("manual_metrics", "DELETE FROM metric_snapshots WHERE source <> 'linkedin_api' AND observed_at < $1::timestamptz - ($2 || ' days')::interval RETURNING id", [iso, String(manual)]);
  const aiDays = await policy("ai_executions");
  if (aiDays) await del("ai_outputs_scrubbed", "UPDATE ai_executions SET output = '{}'::jsonb, quality = NULL WHERE created_at < $1::timestamptz - ($2 || ' days')::interval AND output <> '{}'::jsonb RETURNING id", [iso, String(aiDays)]);
  const auditDays = await policy("audit_events");
  if (auditDays) await del("audit_events", "DELETE FROM audit_events WHERE created_at < $1::timestamptz - ($2 || ' days')::interval RETURNING id", [iso, String(auditDays)]);
  await del("notifications", "DELETE FROM notifications WHERE created_at < $1::timestamptz - interval '90 days' RETURNING id", [iso]);
  await del("outbox", "DELETE FROM outbox WHERE processed_at < $1::timestamptz - interval '30 days' RETURNING id", [iso]);
  await del("workflow_runs", "DELETE FROM workflow_runs WHERE created_at < $1::timestamptz - interval '180 days' RETURNING id", [iso]);
  const expired = (await db.query("UPDATE exports SET status = 'expired' WHERE status = 'ready' AND expires_at < $1 RETURNING storage_key", [iso])).rows;
  for (const e of expired) if (e.storage_key) await storage.delete(e.storage_key);
  out.exports_expired = expired.length;
  return out;
}

let lastRetention = 0;
export async function dailyRetention(db: Db, storage: Storage, now = new Date()) {
  if (now.getTime() - lastRetention < 24 * 3600_000) return { skipped: true };
  lastRetention = now.getTime();
  return runRetention(db, storage, now);
}
