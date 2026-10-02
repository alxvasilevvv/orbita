import { z } from "zod";
import type { Db, Queryable } from "../db/db";
import { accountScope, audit, ConflictError, emit, NotFoundError, requireOp, ValidationError, type Ctx } from "./context";
import { currentCapabilities, hasConsent } from "./accounts";
import { IntegrationError, type SocialAdapter } from "../integrations/linkedin/adapter";
import { readinessIssues } from "./content";
import { mediaIssues } from "./media";
import type { Storage } from "./storage";

export interface SecretStore { get(ref: string): Promise<string | null> }
/** Dev-хранилище. В продакшне: AWS Secrets Manager / Vault через тот же интерфейс. */
export class MemorySecretStore implements SecretStore {
  constructor(private m = new Map<string, string>()) {}
  set(ref: string, v: string) { this.m.set(ref, v); }
  async get(ref: string) { return this.m.get(ref) ?? null; }
  async delete(ref: string) { this.m.delete(ref); }
}

const SYSTEM = (agencyId: string) => ({ actor: { id: null, agency_id: agencyId } });

function publishOperation(kind: string) { return kind === "company_page" ? "publish_post_org" : "publish_post_member"; }

/** Ставит публикацию в очередь. Ключ идемпотентности = материал + согласованная версия. */
export async function enqueuePublication(ctx: Ctx, itemId: string, runAt: Date) {
  return ctx.db.tx(async (q) => {
    const it = (await q.query("SELECT * FROM content_items WHERE id = $1 FOR UPDATE", [itemId])).rows[0];
    if (!it) throw new NotFoundError("Материал не найден");
    const a = await accountScope(q, ctx, it.account_id);
    requireOp(ctx, "schedule", { clientId: it.client_id, accountId: it.account_id });
    if (!it.approved_version_id || it.approved_version_id !== it.current_version_id) throw new ConflictError("Нет согласованной текущей версии");
    const caps = await currentCapabilities(q, it.account_id);
    const cap = caps.find((c: any) => c.operation === publishOperation(a.kind));
    const mode = cap?.mode === "api" ? "api" : "assisted";
    const key = `pub:${it.id}:${it.approved_version_id}`;
    const ins = await q.query(
      `INSERT INTO publication_jobs(client_id, account_id, content_item_id, content_version_id, idempotency_key, mode, status, run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [it.client_id, it.account_id, it.id, it.approved_version_id, key, mode, mode === "api" ? "queued" : "awaiting_human", runAt.toISOString()]);
    let job = ins.rows[0];
    if (!job) {
      job = (await q.query("SELECT * FROM publication_jobs WHERE idempotency_key = $1", [key])).rows[0];
      if (job.status === "cancelled") {
        job = (await q.query("UPDATE publication_jobs SET status = $2, run_at = $3, mode = $4, attempts = 0, last_error_code = NULL, updated_at = now() WHERE id = $1 RETURNING *", [job.id, mode === "api" ? "queued" : "awaiting_human", runAt.toISOString(), mode])).rows[0];
      } else return { ...job, deduplicated: true };
    }
    if (mode === "assisted") {
      const ver = (await q.query("SELECT body FROM content_versions WHERE id = $1", [it.approved_version_id])).rows[0];
      const manager = (await q.query("SELECT manager_id FROM managed_accounts WHERE id = $1", [it.account_id])).rows[0]?.manager_id;
      await q.query(
        `INSERT INTO tasks(client_id, account_id, type, title, details, assignee_id, due_at, definition_of_done, links, source_ref, priority, priority_reason)
         VALUES ($1,$2,'assisted_publish',$3,$4,$5,$6,'Пост опубликован владельцем, ссылка внесена в платформу',$7,$8,0.8,$9) ON CONFLICT DO NOTHING`,
        [it.client_id, it.account_id, `Опубликовать вручную: ${it.title}`, ver.body, manager ?? null, runAt.toISOString(),
         JSON.stringify([{ label: "Профиль", url: (await q.query("SELECT profile_url FROM managed_accounts WHERE id = $1", [it.account_id])).rows[0]?.profile_url }]),
         `assisted:${job.id}`, `Автоматическая публикация недоступна: ${cap?.unavailable_reason ?? "нет данных о возможностях"}`]);
    }
    await audit(q, ctx, { action: "publication.enqueued", entity_type: "publication_job", entity_id: job.id, client_id: it.client_id, account_id: it.account_id, details: { mode, run_at: runAt.toISOString(), reason: cap?.unavailable_reason ?? null } });
    return job;
  });
}

export interface WorkerDeps { db: Db; adapter: SocialAdapter; secrets: SecretStore; workerId: string; memberDailyLimit?: number; leaseSeconds?: number; now?: () => Date; apiVersion?: string; storage?: Storage }

/** Один проход исполнителя. Ошибка одного аккаунта не останавливает остальных. */
export async function runDueJobs(deps: WorkerDeps, limit = 50) {
  const now = deps.now?.() ?? new Date();
  await reapExpiredLeases(deps, now);
  // Справедливость: не более одного задания на аккаунт за проход.
  const due = (await deps.db.query(
    `SELECT id FROM (SELECT DISTINCT ON (account_id) id, run_at FROM publication_jobs
       WHERE status = 'queued' AND mode = 'api' AND run_at <= $1 ORDER BY account_id, run_at) s ORDER BY run_at LIMIT $2`,
    [now.toISOString(), limit])).rows;
  const results: { job_id: string; outcome: string; error?: string }[] = [];
  for (const { id } of due) {
    try {
      results.push({ job_id: id, outcome: await executeJob(deps, id, now) });
    } catch (e: any) {
      results.push({ job_id: id, outcome: "worker_error", error: e.message });
    }
  }
  return results;
}

async function systemSetContent(q: Queryable, job: any, agencyId: string, state: string, extra = "", details: Record<string, unknown> = {}) {
  await q.query(`UPDATE content_items SET state = $2, ${extra} updated_at = now(), row_version = row_version + 1 WHERE id = $1`, [job.content_item_id, state]);
  await audit(q, SYSTEM(agencyId), { action: `content.${state}`, entity_type: "content_item", entity_id: job.content_item_id, client_id: job.client_id, account_id: job.account_id, details: { job_id: job.id, ...details } });
  if (["published", "failed", "publication_unknown"].includes(state)) {
    await emit(q, `content.${state}`, job.client_id, { content_item_id: job.content_item_id, account_id: job.account_id }, `content.${state}:${job.id}`);
  }
}

async function humanTask(q: Queryable, job: any, type: string, title: string, details: string) {
  await q.query(
    `INSERT INTO tasks(client_id, account_id, type, title, details, assignee_id, due_at, source_ref, priority, priority_reason)
     VALUES ($1,$2,$3,$4,$5,(SELECT manager_id FROM managed_accounts WHERE id = $2), now() + interval '4 hours', $6, 0.95, 'Внешнее действие остановлено')
     ON CONFLICT DO NOTHING`, [job.client_id, job.account_id, type, title, details, `${type}:${job.id}`]);
}

async function agencyOf(q: Queryable, clientId: string) {
  return (await q.query("SELECT agency_id FROM clients WHERE id = $1", [clientId])).rows[0].agency_id as string;
}

export async function executeJob(deps: WorkerDeps, jobId: string, now = new Date()): Promise<string> {
  const leaseUntil = new Date(now.getTime() + (deps.leaseSeconds ?? 120) * 1000);
  // 7. Резервирование: атомарный захват одним исполнителем.
  const claimed = (await deps.db.query(
    "UPDATE publication_jobs SET status = 'leased', lease_owner = $2, lease_until = $3, updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING *",
    [jobId, deps.workerId, leaseUntil.toISOString()])).rows[0];
  if (!claimed) return "skipped_not_queued";
  const job = claimed;
  const agencyId = await agencyOf(deps.db, job.client_id);

  // 1–6. Проверки перед внешним действием.
  const pre = await deps.db.tx(async (q) => {
    const it = (await q.query("SELECT * FROM content_items WHERE id = $1 FOR UPDATE", [job.content_item_id])).rows[0];
    const acc = (await q.query("SELECT a.*, c.status AS client_status FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = $1", [job.account_id])).rows[0];
    const blockers: { code: string; msg: string; final?: boolean }[] = [];
    if (!["scheduled", "approved"].includes(it.state)) blockers.push({ code: "state", msg: `Материал в состоянии ${it.state}`, final: true });
    if (it.approved_version_id !== job.content_version_id || it.current_version_id !== job.content_version_id) blockers.push({ code: "version_mismatch", msg: "Согласованная версия изменилась", final: true });
    if (acc.publishing_paused || acc.client_status === "paused") blockers.push({ code: "paused", msg: "Публикация приостановлена" });
    if (!(await hasConsent(q, job.account_id, "publish_post"))) blockers.push({ code: "consent_revoked", msg: "Нет действующего согласия на публикацию", final: true });
    const caps = await currentCapabilities(q, job.account_id);
    const cap = caps.find((c: any) => c.operation === publishOperation(acc.kind));
    const conn = (await q.query("SELECT * FROM oauth_connections WHERE account_id = $1 AND status IN ('active','expiring') ORDER BY updated_at DESC LIMIT 1", [job.account_id])).rows[0];
    if (cap?.mode !== "api" || !conn) blockers.push({ code: "capability", msg: cap?.unavailable_reason ?? "Нет активного подключения" });
    if (conn?.expires_at && new Date(conn.expires_at) <= now) blockers.push({ code: "token_expired", msg: "Срок токена истёк" });
    const ver = (await q.query("SELECT body, media_ids FROM content_versions WHERE id = $1", [job.content_version_id])).rows[0];
    const apiMedia = await mediaIssues(q, job.account_id, ver.media_ids, "api");
    if (apiMedia.length) blockers.push({ code: "capability", msg: apiMedia.join("; ") });
    const issues = await readinessIssues(q, it);
    if (issues.length) blockers.push({ code: "readiness", msg: issues.join("; "), final: true });
    const used = (await q.query("SELECT count(*)::int AS n FROM action_records WHERE account_id = $1 AND origin = 'platform_api' AND requested_at > $2::timestamptz - interval '24 hours'", [job.account_id, now.toISOString()])).rows[0].n;
    if (used >= (deps.memberDailyLimit ?? 100)) blockers.push({ code: "quota_local", msg: "Исчерпан локальный суточный бюджет запросов аккаунта" });

    if (blockers.length) {
      const final = blockers.some((b) => b.final);
      const quotaOnly = blockers.every((b) => b.code === "quota_local");
      const status = quotaOnly ? "queued" : final ? "cancelled" : "awaiting_human";
      await q.query("UPDATE publication_jobs SET status = $2, last_error_code = $3, last_error = $4, lease_owner = NULL, lease_until = NULL, run_at = CASE WHEN $2 = 'queued' THEN now() + interval '1 hour' ELSE run_at END, updated_at = now() WHERE id = $1",
        [job.id, status, blockers[0].code, blockers.map((b) => b.msg).join("; ")]);
      if (!quotaOnly) {
        if (it.state === "scheduled") await systemSetContent(q, job, agencyId, "approved", "scheduled_at = NULL,", { reason: blockers.map((b) => b.code) });
        await humanTask(q, job, "publish_blocked", `Публикация остановлена: ${it.title}`, blockers.map((b) => b.msg).join("\n"));
      }
      await audit(q, SYSTEM(agencyId), { action: "publication.blocked", entity_type: "publication_job", entity_id: job.id, client_id: job.client_id, account_id: job.account_id, details: { blockers: blockers.map((b) => b.code) } });
      return { blocked: true as const, status };
    }
    const body = ver.body as string;
    const media = ver.media_ids?.length ? (await q.query("SELECT id, storage_key, mime_type, external_urn FROM media_assets WHERE id = ANY($1::uuid[])", [ver.media_ids])).rows : [];
    const orderedMedia = (ver.media_ids as string[]).map((id) => media.find((m: any) => m.id === id));
    await systemSetContent(q, job, agencyId, "publishing");
    await q.query("UPDATE publication_jobs SET attempts = attempts + 1 WHERE id = $1", [job.id]);
    const ar = (await q.query("INSERT INTO action_records(client_id, account_id, action_type, target, origin, requested_at, status, evidence_type) VALUES ($1,$2,'publish_post',$3,'platform_api',now(),'requested','unconfirmed') RETURNING id", [job.client_id, job.account_id, job.content_item_id])).rows[0];
    return { blocked: false as const, body, conn, actionId: ar.id as string, title: it.title, media: orderedMedia };
  });
  if (pre.blocked) return `blocked:${pre.status}`;

  // 8. Внешний запрос.
  try {
    const token = await deps.secrets.get(pre.conn.secret_ref);
    if (!token) throw new IntegrationError("auth", "secret_missing", "Токен не найден в хранилище секретов");
    // Изображения загружаются один раз: URN сохраняется и переиспользуется при повторах.
    const imageUrns: string[] = [];
    for (const m of pre.media) {
      if (m.external_urn) { imageUrns.push(m.external_urn); continue; }
      if (!deps.storage) throw new IntegrationError("permanent", "storage_missing", "Хранилище файлов недоступно исполнителю");
      const data = await deps.storage.get(m.storage_key);
      if (!data) throw new IntegrationError("permanent", "media_missing", "Файл вложения не найден в хранилище");
      const urn = await deps.adapter.uploadImage({ authorUrn: pre.conn.external_subject, accessToken: token, apiVersion: deps.apiVersion ?? "202608", data, contentType: m.mime_type });
      await deps.db.query("UPDATE media_assets SET external_urn = $2 WHERE id = $1", [m.id, urn]);
      imageUrns.push(urn);
    }
    const res = await deps.adapter.publishPost({ idempotencyKey: job.idempotency_key, authorUrn: pre.conn.external_subject, body: pre.body, accessToken: token, apiVersion: deps.apiVersion ?? "202608", imageUrns });
    await recordSuccess(deps.db, job, agencyId, pre.actionId, res, "api_confirmed");
    return "published";
  } catch (e) {
    const err = e instanceof IntegrationError ? e : new IntegrationError("unknown_outcome", "unexpected", String((e as any)?.message ?? e));
    return handleFailure(deps, job, agencyId, pre.actionId, err, now, pre.title, pre.conn, pre.body);
  }
}

async function recordSuccess(db: Db, job: any, agencyId: string, actionId: string, res: { externalId: string; url: string | null }, evidence: "api_confirmed" | "manual_mark", userId: string | null = null) {
  await db.tx(async (q) => {
    // 9–10. Сохраняем внешний идентификатор, историю, интерфейс.
    await q.query("UPDATE publication_jobs SET status = 'succeeded', lease_owner = NULL, lease_until = NULL, last_error_code = NULL, updated_at = now() WHERE id = $1", [job.id]);
    await q.query(`INSERT INTO external_publications(client_id, account_id, content_item_id, publication_job_id, external_id, url, evidence_type, published_at, recorded_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8) ON CONFLICT (content_item_id) DO UPDATE SET external_id = EXCLUDED.external_id, url = EXCLUDED.url, evidence_type = EXCLUDED.evidence_type`,
      [job.client_id, job.account_id, job.content_item_id, job.id, res.externalId, res.url, evidence, userId]);
    await q.query("UPDATE action_records SET status = 'succeeded', executed_at = now(), external_id = $2, evidence_type = $3 WHERE id = $1", [actionId, res.externalId, evidence]);
    await systemSetContent(q, job, agencyId, "published", "", { external_id: res.externalId, evidence });
    await emit(q, "analytics.collect", job.client_id, { content_item_id: job.content_item_id, account_id: job.account_id }, `analytics:${job.content_item_id}`);
  });
}

function backoffSeconds(attempt: number) {
  const base = Math.min(3600, 30 * 2 ** attempt);
  return Math.round(base / 2 + Math.random() * (base / 2)); // full jitter, нижняя граница base/2
}

async function handleFailure(deps: WorkerDeps, job: any, agencyId: string, actionId: string, err: IntegrationError, now: Date, title: string, conn: any, body: string): Promise<string> {
  const db = deps.db;
  if (err.kind === "unknown_outcome") {
    // Запрос ушёл, ответ потерян: слепой повтор запрещён.
    await db.tx(async (q) => {
      await q.query("UPDATE publication_jobs SET status = 'unknown', last_error_code = $2, last_error = $3, lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = $1", [job.id, err.code, err.message]);
      await q.query("UPDATE action_records SET status = 'unknown', error_code = $2 WHERE id = $1", [actionId, err.code]);
      await systemSetContent(q, job, agencyId, "publication_unknown", "", { error: err.code });
    });
    const token = (await deps.secrets.get(conn.secret_ref)) ?? "";
    const found = await deps.adapter.findPublication({ authorUrn: conn.external_subject, accessToken: token, idempotencyKey: job.idempotency_key, bodyPrefix: body.slice(0, 200) }).catch(() => null);
    if (found && found !== "not_found") {
      await db.tx(async (q) => { await q.query("UPDATE content_items SET state = 'publishing' WHERE id = $1", [job.content_item_id]); });
      await recordSuccess(db, job, agencyId, actionId, found, "api_confirmed");
      return "unknown_resolved_published";
    }
    await db.tx((q) => humanTask(q, job, "resolve_unknown", `Проверить, опубликован ли пост: ${title}`,
      `Ответ LinkedIn не получен (${err.code}). ${found === "not_found" ? "Автоматическая проверка не нашла пост, но это не гарантия." : "Автоматическая проверка недоступна."} Откройте профиль, найдите пост и отметьте результат. Не публикуйте повторно до проверки.`));
    return "unknown";
  }
  const retryable = err.kind === "retryable" || err.kind === "quota";
  const attempts = job.attempts + 1;
  if (retryable && attempts < job.max_attempts) {
    const delay = err.kind === "quota" ? (err.retryAfterSec ?? 3600) : backoffSeconds(attempts);
    await db.tx(async (q) => {
      await q.query("UPDATE publication_jobs SET status = 'queued', run_at = $2, last_error_code = $3, last_error = $4, lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = $1",
        [job.id, new Date(now.getTime() + delay * 1000).toISOString(), err.code, err.message]);
      await q.query("UPDATE action_records SET status = 'failed', error_code = $2 WHERE id = $1", [actionId, err.code]);
      await systemSetContent(q, job, agencyId, "scheduled", "", { retry_in_sec: delay, error: err.code });
    });
    return `retry_in_${delay}s`;
  }
  await db.tx(async (q) => {
    const status = retryable ? "dead" : err.kind === "auth" ? "awaiting_human" : "failed";
    await q.query("UPDATE publication_jobs SET status = $2, last_error_code = $3, last_error = $4, lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = $1", [job.id, status, err.code, err.message]);
    await q.query("UPDATE action_records SET status = 'failed', error_code = $2 WHERE id = $1", [actionId, err.code]);
    await systemSetContent(q, job, agencyId, "failed", "", { error: err.code });
    if (err.kind === "auth") await q.query("UPDATE oauth_connections SET status = 'error', updated_at = now() WHERE account_id = $1 AND status IN ('active','expiring')", [job.account_id]);
    await humanTask(q, job, err.kind === "auth" ? "reconnect" : "publish_failed", `${err.kind === "auth" ? "Переподключить LinkedIn" : "Разобрать ошибку публикации"}: ${title}`, `${err.code}: ${err.message}`);
    if (retryable) await q.query("INSERT INTO incidents(agency_id, client_id, account_id, severity, kind, summary) VALUES ($1,$2,$3,'medium','publication_dead_letter',$4)", [agencyId, job.client_id, job.account_id, `Задание ${job.id} исчерпало попытки: ${err.code}`]);
  });
  return `failed:${err.code}`;
}

/** Исполнитель упал во время запроса: исход неизвестен. */
export async function reapExpiredLeases(deps: WorkerDeps, now: Date) {
  const expired = (await deps.db.query("SELECT * FROM publication_jobs WHERE status = 'leased' AND lease_until < $1", [now.toISOString()])).rows;
  for (const job of expired) {
    const agencyId = await agencyOf(deps.db, job.client_id);
    await deps.db.tx(async (q) => {
      const upd = await q.query("UPDATE publication_jobs SET status = 'unknown', last_error_code = 'lease_expired', lease_owner = NULL, updated_at = now() WHERE id = $1 AND status = 'leased' RETURNING id", [job.id]);
      if (!upd.rows.length) return;
      const st = (await q.query("SELECT state FROM content_items WHERE id = $1", [job.content_item_id])).rows[0].state;
      if (st === "publishing") await systemSetContent(q, job, agencyId, "publication_unknown", "", { error: "lease_expired" });
      await humanTask(q, job, "resolve_unknown", "Проверить исход публикации после сбоя исполнителя", "Исполнитель не завершил задание. Проверьте профиль перед повтором.");
    });
  }
}

/** Assisted: человек опубликовал сам и вносит ссылку. Это ручная отметка, не подтверждение API. */
export async function markPublishedManually(ctx: Ctx, itemId: string, input: unknown) {
  const d = z.object({ url: z.string().url(), published_at: z.string().optional() }).parse(input);
  const it = (await ctx.db.query("SELECT * FROM content_items WHERE id = $1", [itemId])).rows[0];
  if (!it) throw new NotFoundError("Материал не найден");
  await accountScope(ctx.db, ctx, it.account_id);
  requireOp(ctx, "publish", { clientId: it.client_id, accountId: it.account_id });
  if (!["approved", "scheduled"].includes(it.state)) throw new ConflictError("Отметить публикацию можно только для согласованного материала");
  if (!it.approved_version_id || it.approved_version_id !== it.current_version_id) throw new ConflictError("Текущая версия не согласована");
  return ctx.db.tx(async (q) => {
    await q.query("UPDATE content_items SET state = 'published', updated_at = now(), row_version = row_version + 1 WHERE id = $1", [itemId]);
    await q.query("UPDATE publication_jobs SET status = 'succeeded', updated_at = now() WHERE content_item_id = $1 AND status IN ('awaiting_human','queued')", [itemId]);
    await q.query(`INSERT INTO external_publications(client_id, account_id, content_item_id, url, evidence_type, published_at, recorded_by) VALUES ($1,$2,$3,$4,'manual_mark',$5,$6)
                   ON CONFLICT (content_item_id) DO UPDATE SET url = EXCLUDED.url, evidence_type = 'manual_mark', recorded_by = EXCLUDED.recorded_by`,
      [it.client_id, it.account_id, itemId, d.url, d.published_at ?? new Date().toISOString(), ctx.actor.id]);
    await q.query("INSERT INTO action_records(client_id, account_id, actor, action_type, target, origin, executed_at, status, evidence_type) VALUES ($1,$2,$3,'publish_post',$4,'manual_mark',$5,'succeeded','manual_mark')",
      [it.client_id, it.account_id, ctx.actor.id, d.url, d.published_at ?? new Date().toISOString()]);
    await q.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE source_ref IN (SELECT 'assisted:' || id FROM publication_jobs WHERE content_item_id = $1) AND status <> 'done'", [itemId]);
    await audit(q, ctx, { action: "content.published_manual_mark", entity_type: "content_item", entity_id: itemId, client_id: it.client_id, account_id: it.account_id, details: { evidence: "manual_mark" } });
    await emit(q, "analytics.collect", it.client_id, { content_item_id: itemId, account_id: it.account_id }, `analytics:${itemId}`);
    return { state: "published", evidence_type: "manual_mark" };
  });
}

/** Разрешение publication_unknown человеком. */
export async function resolveUnknown(ctx: Ctx, itemId: string, input: unknown) {
  const d = z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("published"), url: z.string().url() }),
    z.object({ outcome: z.literal("not_published"), comment: z.string().min(1) }),
  ]).parse(input);
  const it = (await ctx.db.query("SELECT * FROM content_items WHERE id = $1", [itemId])).rows[0];
  if (!it) throw new NotFoundError("Материал не найден");
  await accountScope(ctx.db, ctx, it.account_id);
  requireOp(ctx, "publish", { clientId: it.client_id, accountId: it.account_id });
  if (!["publication_unknown", "failed"].includes(it.state)) throw new ConflictError("Материал не в неопределённом состоянии");
  return ctx.db.tx(async (q) => {
    if (d.outcome === "published") {
      await q.query("UPDATE content_items SET state = 'published', updated_at = now() WHERE id = $1", [itemId]);
      await q.query(`INSERT INTO external_publications(client_id, account_id, content_item_id, url, evidence_type, published_at, recorded_by) VALUES ($1,$2,$3,$4,'manual_mark',now(),$5)
                     ON CONFLICT (content_item_id) DO UPDATE SET url = EXCLUDED.url, evidence_type = 'manual_mark'`, [it.client_id, it.account_id, itemId, d.url, ctx.actor.id]);
      await q.query("UPDATE publication_jobs SET status = 'succeeded', updated_at = now() WHERE content_item_id = $1 AND status IN ('unknown','failed','dead')", [itemId]);
      await q.query("UPDATE action_records SET status = 'succeeded', evidence_type = 'manual_mark' WHERE target = $1 AND status = 'unknown'", [itemId]);
    } else {
      await q.query("UPDATE content_items SET state = 'approved', scheduled_at = NULL, updated_at = now() WHERE id = $1", [itemId]);
      // Задание отменяется; повторная постановка создаст его заново после явного планирования.
      await q.query("UPDATE publication_jobs SET status = 'cancelled', updated_at = now() WHERE content_item_id = $1 AND status IN ('unknown','failed','dead')", [itemId]);
    }
    await q.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE source_ref IN (SELECT 'resolve_unknown:' || id FROM publication_jobs WHERE content_item_id = $1) OR source_ref IN (SELECT 'publish_failed:' || id FROM publication_jobs WHERE content_item_id = $1)", [itemId]);
    await audit(q, ctx, { action: "publication.unknown_resolved", entity_type: "content_item", entity_id: itemId, client_id: it.client_id, account_id: it.account_id, details: { outcome: d.outcome } });
    return { state: d.outcome === "published" ? "published" : "approved" };
  });
}

/** Аварийная остановка: аккаунт, клиент или всё агентство. */
export async function pausePublishing(ctx: Ctx, input: unknown) {
  const d = z.object({ scope: z.enum(["account", "client", "agency"]), id: z.string().uuid().optional(), paused: z.boolean() }).parse(input);
  if (d.scope === "agency") requireOp(ctx, "manage_team", {});
  return ctx.db.tx(async (q) => {
    let r;
    if (d.scope === "account") {
      const a = await accountScope(q, ctx, d.id!);
      requireOp(ctx, "publish", { clientId: a.client_id, accountId: a.id });
      r = await q.query("UPDATE managed_accounts SET publishing_paused = $2 WHERE id = $1 RETURNING id", [d.id, d.paused]);
    } else if (d.scope === "client") {
      requireOp(ctx, "manage_clients", { clientId: d.id });
      r = await q.query("UPDATE managed_accounts SET publishing_paused = $2 WHERE client_id = $1 AND client_id IN (SELECT id FROM clients WHERE agency_id = $3) RETURNING id", [d.id, d.paused, ctx.actor.agency_id]);
    } else {
      r = await q.query("UPDATE managed_accounts SET publishing_paused = $1 WHERE client_id IN (SELECT id FROM clients WHERE agency_id = $2) RETURNING id", [d.paused, ctx.actor.agency_id]);
    }
    await audit(q, ctx, { action: d.paused ? "publishing.paused" : "publishing.resumed", entity_type: d.scope, entity_id: d.id, details: { accounts: r.rows.length } });
    return { accounts: r.rows.length };
  });
}

export { ValidationError };
