import { z } from "zod";
import { isExternalRole } from "../core/permissions";
import type { Db } from "../db/db";
import { accountScope, audit, emit, NotFoundError, requireOp, ValidationError, type Ctx } from "./context";
import { can, ForbiddenError } from "../core/permissions";
import { clientKey, type Storage } from "./storage";

const CLIENT_ALLOWED = new Set(["content", "actions", "metrics"]);

/** Запрос экспорта. Генерация идёт в фоне, клиент видит только разрешённые ему сведения. */
export async function requestExport(ctx: Ctx, input: unknown) {
  const d = z.object({ kind: z.enum(["content", "actions", "metrics", "tasks", "time"]), account_id: z.string().uuid().optional(), client_id: z.string().uuid().optional() }).parse(input);
  let clientId = d.client_id ?? null;
  if (d.account_id) clientId = (await accountScope(ctx.db, ctx, d.account_id)).client_id;
  if (!clientId && !d.account_id) {
    requireOp(ctx, "view_finance", {});
  } else {
    requireOp(ctx, "export", { clientId: clientId!, accountId: d.account_id });
  }
  const internal = ctx.actor.memberships.some((m) => !isExternalRole(m.role) && !m.revoked_at);
  if (!internal && !CLIENT_ALLOWED.has(d.kind)) throw new ForbiddenError("export");
  if (d.kind === "time" && !can(ctx.actor.memberships, "view_finance", {})) throw new ForbiddenError("export");
  const row = (await ctx.db.query("INSERT INTO exports(agency_id, client_id, account_id, requested_by, kind) VALUES ($1,$2,$3,$4,$5) RETURNING id, status, kind, created_at", [ctx.actor.agency_id, clientId, d.account_id ?? null, ctx.actor.id, d.kind])).rows[0];
  await audit(ctx.db, ctx, { action: "export.requested", entity_type: "export", entity_id: row.id, client_id: clientId ?? undefined, account_id: d.account_id, details: { kind: d.kind } });
  return row;
}

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "﻿";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v == null) return "";
    let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // защита от формул в Excel
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

/** Фоновая сборка экспортов. Данные LinkedIn API не выгружаются, пока это не разрешено условиями. */
export async function processExports(db: Db, storage: Storage, limit = 5) {
  const jobs = (await db.query("UPDATE exports SET status = 'running' WHERE id IN (SELECT id FROM exports WHERE status = 'queued' ORDER BY created_at LIMIT $1) RETURNING *", [limit])).rows;
  for (const j of jobs) {
    try {
      const p: unknown[] = [];
      const scope = (alias: string) => {
        if (j.account_id) { p.push(j.account_id); return `${alias}.account_id = $${p.length}`; }
        if (j.client_id) { p.push(j.client_id); return `${alias}.client_id = $${p.length}`; }
        p.push(j.agency_id); return `${alias}.client_id IN (SELECT id FROM clients WHERE agency_id = $${p.length})`;
      };
      let rows: any[] = [];
      if (j.kind === "content") rows = (await db.query(`SELECT ci.title, ci.state, ci.pillar, ci.format, ci.scheduled_at, ep.published_at, ep.url, ep.evidence_type FROM content_items ci LEFT JOIN external_publications ep ON ep.content_item_id = ci.id WHERE ${scope("ci")} ORDER BY ci.created_at`, p)).rows;
      if (j.kind === "actions") rows = (await db.query(`SELECT action_type, target, origin, status, evidence_type, requested_at, executed_at, external_id FROM action_records ar WHERE ${scope("ar")} ORDER BY requested_at`, p)).rows;
      if (j.kind === "metrics") {
        const allowApi = process.env.LINKEDIN_DATA_EXPORT_ALLOWED === "1";
        rows = (await db.query(`SELECT metric_key, value, period_start, period_end, observed_at, source, source_detail, availability_status, content_item_id FROM metric_snapshots ms WHERE ${scope("ms")} ${allowApi ? "" : "AND ms.source <> 'linkedin_api'"} ORDER BY observed_at`, p)).rows;
      }
      if (j.kind === "tasks") rows = (await db.query(`SELECT t.title, t.type, t.status, t.due_at, t.completed_at, t.estimate_minutes FROM tasks t WHERE ${scope("t")} ORDER BY t.created_at`, p)).rows;
      if (j.kind === "time") rows = (await db.query(`SELECT te.work_date, te.minutes, u.display_name AS employee, c.name AS client FROM time_entries te JOIN users u ON u.id = te.user_id JOIN clients c ON c.id = te.client_id WHERE ${scope("te")} ORDER BY te.work_date`, p)).rows;
      const key = j.client_id ? clientKey(j.client_id, "exports", `${j.id}.csv`) : `agencies/${j.agency_id}/exports/${j.id}.csv`;
      await storage.put(key, Buffer.from(csv(rows), "utf8"), "text/csv");
      await db.query("UPDATE exports SET status = 'ready', storage_key = $2, row_count = $3, finished_at = now(), expires_at = now() + interval '7 days' WHERE id = $1", [j.id, key, rows.length]);
      await emit(db, "export.ready", j.client_id, { user_id: j.requested_by, export_id: j.id, agency_id: j.agency_id }, `export:${j.id}`);
    } catch (e: any) {
      await db.query("UPDATE exports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [j.id, e.message.slice(0, 500)]);
    }
  }
  return jobs.length;
}

export async function listExports(ctx: Ctx) {
  return (await ctx.db.query("SELECT id, kind, status, row_count, error, created_at, finished_at, expires_at, account_id FROM exports WHERE requested_by = $1 ORDER BY created_at DESC LIMIT 50", [ctx.actor.id])).rows;
}

export async function downloadExport(ctx: Ctx, storage: Storage, id: string) {
  const e = (await ctx.db.query("SELECT * FROM exports WHERE id = $1 AND requested_by = $2", [id, ctx.actor.id])).rows[0];
  if (!e) throw new NotFoundError("Экспорт не найден");
  if (e.status !== "ready") throw new ValidationError(e.status === "expired" ? "Срок хранения экспорта истёк, запросите заново" : "Экспорт ещё не готов");
  await audit(ctx.db, ctx, { action: "export.downloaded", entity_type: "export", entity_id: id, client_id: e.client_id ?? undefined });
  return { url: await storage.signedUrl(e.storage_key, 300) };
}
