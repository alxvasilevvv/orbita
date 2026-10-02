import { z } from "zod";
import type { Db, Queryable } from "../db/db";
import { audit, NotFoundError, requireOp, ValidationError, type Ctx } from "./context";
import { notify, resolveAudience, type Audience } from "./notify";

/**
 * Конструктор сценариев: событие → условия → внутренние действия.
 * Сценарий не может выполнять внешние действия и не может расширять полномочия:
 * доступные действия ограничены списком ниже, публикация остаётся за согласованием и исполнителем.
 */
export const TRIGGERS: Record<string, string> = {
  "content.deadline_risk": "До публикации мало времени, согласования нет",
  "approval.sla_breached": "Согласование дольше SLA клиента",
  "approval.invalidated": "Текст изменён после согласования",
  "analytics.collect": "Публикация подтверждена",
  "content.failed": "Ошибка публикации",
  "content.publication_unknown": "Исход публикации неизвестен",
  "connection.revoked": "Подключение отозвано",
  "connection.expiring": "Подключение скоро истечёт",
  "consent.revoked": "Отозвано согласие",
  "plan.week_behind": "План недели не выполнен",
  "engagement.inbound": "Новый комментарий или обращение",
  "client.offboarding": "Клиент завершил обслуживание",
};

const Condition = z.object({ field: z.string(), op: z.enum(["eq", "neq", "in", "gt", "lt", "exists"]), value: z.unknown().optional() });
const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_task"), title: z.string().min(1), task_type: z.string().default("workflow"), assignee: z.enum(["account_manager", "strategist", "editor", "ops_director", "unassigned"]).default("account_manager"), due_in_hours: z.number().int().positive().default(24), priority: z.number().min(0).max(1).default(0.6) }),
  z.object({ type: z.literal("notify"), audience: z.enum(["account_manager", "editor", "client_approvers", "author", "ops_director", "strategist", "owner"]), title: z.string().optional() }),
  z.object({ type: z.literal("pause_publishing") }),
]);
export const ALLOWED_ACTIONS = ["create_task", "notify", "pause_publishing"] as const;
const DefinitionInput = z.object({
  key: z.string().regex(/^[a-z0-9_.-]+$/),
  name: z.string().min(1),
  trigger: z.enum(Object.keys(TRIGGERS) as [string, ...string[]]),
  conditions: z.array(Condition).max(10).default([]),
  actions: z.array(Action).min(1).max(5),
  max_runs_per_day: z.number().int().positive().max(5000).default(200),
  client_id: z.string().uuid().nullable().optional(),
  enabled: z.boolean().default(true),
});
export type WorkflowEvent = { topic: string; key: string; depth?: number; agency_id: string; client_id?: string | null; account_id?: string | null; content_item_id?: string | null; payload: Record<string, unknown> };

const MAX_DEPTH = 3;

function get(obj: any, path: string) { return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); }
export function evaluate(conds: z.infer<typeof Condition>[], ev: Record<string, unknown>): boolean {
  return conds.every((c) => {
    const v = get(ev, c.field);
    switch (c.op) {
      case "eq": return v === c.value;
      case "neq": return v !== c.value;
      case "in": return Array.isArray(c.value) && c.value.includes(v);
      case "gt": return typeof v === "number" && v > Number(c.value);
      case "lt": return typeof v === "number" && v < Number(c.value);
      case "exists": return v !== undefined && v !== null;
    }
  });
}

async function enrich(q: Queryable, ev: WorkflowEvent) {
  const acc = ev.account_id ? (await q.query("SELECT kind, confidential_job_search, client_id FROM managed_accounts WHERE id = $1", [ev.account_id])).rows[0] : null;
  return { ...ev.payload, topic: ev.topic, account: acc ? { kind: acc.kind, confidential_job_search: acc.confidential_job_search } : null, client_id: ev.client_id ?? acc?.client_id ?? null };
}

async function assigneeFor(q: Queryable, who: string, ev: WorkflowEvent): Promise<string | null> {
  if (who === "unassigned") return null;
  const ids = await resolveAudience(q, who as Audience, { account_id: ev.account_id, client_id: ev.client_id, content_item_id: ev.content_item_id });
  return ids[0] ?? null;
}

/** Запускает все подходящие сценарии для события. mode=preview ничего не меняет. */
export async function runWorkflows(db: Db, ev: WorkflowEvent, mode: "execute" | "preview" = "execute", onlyWorkflowId?: string) {
  const defs = (await db.query(
    `SELECT DISTINCT ON (key, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)) * FROM workflow_definitions
      WHERE agency_id = $1 AND trigger = $2 AND (client_id IS NULL OR client_id = $3) ${onlyWorkflowId ? "AND id = $4" : "AND enabled"}
      ORDER BY key, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid), version DESC`,
    onlyWorkflowId ? [ev.agency_id, ev.topic, ev.client_id ?? null, onlyWorkflowId] : [ev.agency_id, ev.topic, ev.client_id ?? null])).rows;
  const results: any[] = [];
  for (const d of defs) {
    const ctxData = await enrich(db, ev);
    const record = async (status: string, actions: unknown[] = [], error?: string) => {
      await db.query(
        `INSERT INTO workflow_runs(agency_id, client_id, workflow_id, event_key, depth, mode, status, actions_taken, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (workflow_id, event_key, mode) DO NOTHING`,
        [ev.agency_id, ctxData.client_id, d.id, ev.key, ev.depth ?? 0, mode, status, JSON.stringify(actions), error ?? null]);
      results.push({ workflow_id: d.id, name: d.name, status, actions });
    };
    if ((ev.depth ?? 0) >= MAX_DEPTH) { await record("loop_blocked"); continue; }
    if (mode === "execute") {
      const seen = (await db.query("SELECT 1 FROM workflow_runs WHERE workflow_id = $1 AND event_key = $2 AND mode = 'execute'", [d.id, ev.key])).rows.length;
      if (seen) continue; // повторная доставка события
      const today = (await db.query("SELECT count(*)::int n FROM workflow_runs WHERE workflow_id = $1 AND mode = 'execute' AND status = 'executed' AND created_at > now() - interval '24 hours'", [d.id])).rows[0].n;
      if (today >= d.max_runs_per_day) { await record("limited"); continue; }
    }
    if (!evaluate(d.conditions, ctxData)) { await record(mode === "preview" ? "preview" : "skipped", [{ type: "conditions_not_met" }]); continue; }
    const planned: any[] = [];
    try {
      if (mode === "preview") {
        for (const a of d.actions) planned.push({ ...a, would_execute: true });
        await record("preview", planned);
        continue;
      }
      await db.tx(async (q) => {
        for (const a of d.actions as z.infer<typeof Action>[]) {
          if (!(ALLOWED_ACTIONS as readonly string[]).includes(a.type)) throw new Error(`Действие ${a.type} не разрешено сценариям`);
          if (a.type === "create_task") {
            if (!ctxData.client_id) { planned.push({ type: a.type, skipped: "нет клиента у события" }); continue; }
            const assignee = await assigneeFor(q, a.assignee, ev);
            const t = (await q.query(
              `INSERT INTO tasks(client_id, account_id, type, title, assignee_id, due_at, priority, priority_reason, source_ref)
               VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' hours')::interval, $7, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
              [ctxData.client_id, ev.account_id ?? null, a.task_type, a.title, assignee, String(a.due_in_hours), a.priority, `Сценарий «${d.name}» v${d.version}`, `wf:${d.id}:${ev.key}`])).rows[0];
            planned.push({ type: a.type, task_id: t?.id ?? null, assignee });
          } else if (a.type === "notify") {
            const users = await resolveAudience(q, a.audience, { account_id: ev.account_id, client_id: ctxData.client_id, content_item_id: ev.content_item_id });
            const n = await notify(q, { agency_id: ev.agency_id, client_id: ctxData.client_id, user_ids: users, kind: ev.topic, title: a.title, link: ev.content_item_id ? `#/content/${ev.content_item_id}` : ev.account_id ? `#/accounts/${ev.account_id}` : null, dedupe: `wf:${d.id}:${ev.key}` });
            planned.push({ type: a.type, recipients: n });
          } else if (a.type === "pause_publishing") {
            if (!ev.account_id) { planned.push({ type: a.type, skipped: "нет аккаунта" }); continue; }
            await q.query("UPDATE managed_accounts SET publishing_paused = true WHERE id = $1", [ev.account_id]);
            planned.push({ type: a.type, account_id: ev.account_id });
          }
        }
        await q.query(
          `INSERT INTO workflow_runs(agency_id, client_id, workflow_id, event_key, depth, mode, status, actions_taken) VALUES ($1,$2,$3,$4,$5,'execute','executed',$6) ON CONFLICT DO NOTHING`,
          [ev.agency_id, ctxData.client_id, d.id, ev.key, ev.depth ?? 0, JSON.stringify(planned)]);
        await audit(q, { actor: { id: null, agency_id: ev.agency_id } }, { action: "workflow.executed", entity_type: "workflow", entity_id: d.id, client_id: ctxData.client_id ?? undefined, account_id: ev.account_id ?? undefined, details: { event: ev.topic, actions: planned.map((p) => p.type) } });
      });
      results.push({ workflow_id: d.id, name: d.name, status: "executed", actions: planned });
    } catch (e: any) {
      await record("failed", planned, e.message);
    }
  }
  return results;
}

export const BUILTIN_WORKFLOWS: z.input<typeof DefinitionInput>[] = [
  { key: "deadline-risk", name: "Мало времени до публикации, согласования нет", trigger: "content.deadline_risk", actions: [{ type: "notify", audience: "account_manager" }, { type: "create_task", title: "Ускорить согласование материала", task_type: "approval_chase", due_in_hours: 8, priority: 0.85 }] },
  { key: "sla-breach", name: "Согласование дольше SLA", trigger: "approval.sla_breached", actions: [{ type: "notify", audience: "account_manager" }, { type: "notify", audience: "ops_director" }] },
  { key: "collect-analytics", name: "Публикация подтверждена: собрать показатели", trigger: "analytics.collect", actions: [{ type: "create_task", title: "Внести показатели публикации через 7 дней (выгрузка или API)", task_type: "collect_metrics", due_in_hours: 168, assignee: "account_manager", priority: 0.4 }] },
  { key: "approval-invalidated", name: "Текст изменён после согласования", trigger: "approval.invalidated", actions: [{ type: "notify", audience: "editor" }] },
  { key: "connection-revoked", name: "Подключение отозвано", trigger: "connection.revoked", actions: [{ type: "notify", audience: "account_manager" }, { type: "notify", audience: "ops_director" }] },
  { key: "connection-expiring", name: "Подключение скоро истечёт", trigger: "connection.expiring", actions: [{ type: "create_task", title: "Попросить владельца переподключить LinkedIn", task_type: "reconnect", due_in_hours: 72, priority: 0.7 }] },
  { key: "week-behind", name: "План недели не выполнен", trigger: "plan.week_behind", actions: [{ type: "create_task", title: "Разобрать отставание от плана и предложить перераспределение", task_type: "plan_review", due_in_hours: 48, priority: 0.6 }] },
  { key: "inbound-comment", name: "Новый комментарий или обращение", trigger: "engagement.inbound", actions: [{ type: "create_task", title: "Подготовить ответ на комментарий", task_type: "reply", due_in_hours: 24, priority: 0.65 }] },
  { key: "client-offboarding", name: "Клиент завершил обслуживание", trigger: "client.offboarding", actions: [{ type: "notify", audience: "owner" }, { type: "create_task", title: "Подтвердить запуск процедуры удаления данных", task_type: "offboarding", assignee: "ops_director", due_in_hours: 72, priority: 0.7 }] },
  { key: "publish-failed", name: "Ошибка или неизвестный исход публикации", trigger: "content.publication_unknown", actions: [{ type: "notify", audience: "ops_director" }] },
];

export async function seedBuiltinWorkflows(q: Queryable, agencyId: string, ownerId: string | null) {
  for (const w of BUILTIN_WORKFLOWS) {
    const d = DefinitionInput.parse(w);
    await q.query(
      `INSERT INTO workflow_definitions(agency_id, key, name, owner_id, version, trigger, conditions, actions, max_runs_per_day, is_builtin)
       VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,true) ON CONFLICT (agency_id, key, version) DO NOTHING`,
      [agencyId, d.key, d.name, ownerId, d.trigger, JSON.stringify(d.conditions), JSON.stringify(d.actions), d.max_runs_per_day]);
  }
}

export async function listWorkflows(ctx: Ctx) {
  requireOp(ctx, "manage_tasks", {});
  const defs = (await ctx.db.query(
    `SELECT DISTINCT ON (key, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)) w.*, u.display_name AS owner_name,
            (SELECT count(*)::int FROM workflow_runs r WHERE r.workflow_id = w.id AND r.mode = 'execute' AND r.status = 'executed') AS runs,
            (SELECT max(created_at) FROM workflow_runs r WHERE r.workflow_id = w.id AND r.mode = 'execute') AS last_run
       FROM workflow_definitions w LEFT JOIN users u ON u.id = w.owner_id
      WHERE w.agency_id = $1 ORDER BY key, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid), version DESC`, [ctx.actor.agency_id])).rows;
  return { triggers: TRIGGERS, allowed_actions: ALLOWED_ACTIONS, workflows: defs };
}

/** Изменение = новая версия; предыдущая остаётся в истории. */
export async function saveWorkflow(ctx: Ctx, input: unknown) {
  requireOp(ctx, "manage_team", {});
  const d = DefinitionInput.parse(input);
  if (d.client_id) requireOp(ctx, "manage_clients", { clientId: d.client_id });
  return ctx.db.tx(async (q) => {
    const v = (await q.query("SELECT coalesce(max(version),0)+1 AS v FROM workflow_definitions WHERE agency_id = $1 AND key = $2", [ctx.actor.agency_id, d.key])).rows[0].v;
    await q.query("UPDATE workflow_definitions SET enabled = false WHERE agency_id = $1 AND key = $2", [ctx.actor.agency_id, d.key]);
    const w = (await q.query(
      `INSERT INTO workflow_definitions(agency_id, client_id, key, name, owner_id, version, trigger, conditions, actions, max_runs_per_day, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ctx.actor.agency_id, d.client_id ?? null, d.key, d.name, ctx.actor.id, v, d.trigger, JSON.stringify(d.conditions), JSON.stringify(d.actions), d.max_runs_per_day, d.enabled])).rows[0];
    await audit(q, ctx, { action: "workflow.saved", entity_type: "workflow", entity_id: w.id, client_id: d.client_id ?? undefined, details: { key: d.key, version: v, trigger: d.trigger } });
    return w;
  });
}

export async function setWorkflowEnabled(ctx: Ctx, id: string, enabled: boolean) {
  requireOp(ctx, "manage_team", {});
  const r = await ctx.db.query("UPDATE workflow_definitions SET enabled = $2 WHERE id = $1 AND agency_id = $3 RETURNING id, key", [id, enabled, ctx.actor.agency_id]);
  if (!r.rows.length) throw new NotFoundError("Сценарий не найден");
  await audit(ctx.db, ctx, { action: enabled ? "workflow.enabled" : "workflow.disabled", entity_type: "workflow", entity_id: id });
  return { ok: true };
}

/** Предпросмотр на тестовом событии: какие действия выполнились бы. */
export async function previewWorkflow(ctx: Ctx, id: string, input: unknown) {
  requireOp(ctx, "manage_tasks", {});
  const d = z.object({ account_id: z.string().uuid().optional(), payload: z.record(z.string(), z.unknown()).default({}) }).parse(input);
  const w = (await ctx.db.query("SELECT * FROM workflow_definitions WHERE id = $1", [id])).rows[0];
  if (!w) throw new NotFoundError("Сценарий не найден");
  let clientId: string | null = null;
  if (d.account_id) clientId = (await ctx.db.query("SELECT client_id FROM managed_accounts WHERE id = $1", [d.account_id])).rows[0]?.client_id ?? null;
  if (d.account_id && !clientId) throw new ValidationError("Аккаунт не найден");
  return runWorkflows(ctx.db, { topic: w.trigger, key: `preview:${Date.now()}`, agency_id: ctx.actor.agency_id, account_id: d.account_id ?? null, client_id: clientId, payload: d.payload }, "preview", id);
}

export async function workflowRuns(ctx: Ctx, id: string) {
  requireOp(ctx, "manage_tasks", {});
  return (await ctx.db.query("SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT 100", [id])).rows;
}
