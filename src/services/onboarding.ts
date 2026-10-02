import { z } from "zod";
import { accountScope, audit, requireOp, type Ctx } from "./context";

export const AUDIT_CRITERIA = [
  { key: "headline", label: "Заголовок" },
  { key: "about", label: "About" },
  { key: "photo_cover", label: "Фото и обложка" },
  { key: "experience", label: "Опыт" },
  { key: "expertise_proof", label: "Подтверждение экспертизы" },
  { key: "featured", label: "Featured" },
  { key: "positioning", label: "Понятность позиционирования" },
  { key: "audience_fit", label: "Соответствие целевой аудитории" },
  { key: "cta", label: "Призыв к следующему действию" },
] as const;

const AuditInput = z.object({
  criteria: z.array(z.object({
    key: z.enum(AUDIT_CRITERIA.map((c) => c.key) as [string, ...string[]]),
    status: z.enum(["ok", "improve", "missing"]),
    finding: z.string().default(""),
    proposed_text: z.string().default(""),
  })).min(1),
  summary: z.string().optional(),
  create_tasks: z.boolean().default(true),
});

/**
 * Аудит профиля. API изменения профиля нет, поэтому каждое улучшение становится
 * задачей владельцу с готовым текстом.
 */
export async function createProfileAudit(ctx: Ctx, accountId: string, input: unknown) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "edit_strategy", { clientId: a.client_id, accountId });
  const d = AuditInput.parse(input);
  return ctx.db.tx(async (q) => {
    let tasks = 0;
    const manager = (await q.query("SELECT manager_id FROM managed_accounts WHERE id = $1", [accountId])).rows[0]?.manager_id ?? null;
    const audit_ = (await q.query("INSERT INTO profile_audits(client_id, account_id, criteria, summary, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id", [a.client_id, accountId, JSON.stringify(d.criteria), d.summary ?? null, ctx.actor.id])).rows[0];
    if (d.create_tasks) {
      for (const c of d.criteria.filter((x) => x.status !== "ok")) {
        const label = AUDIT_CRITERIA.find((x) => x.key === c.key)!.label;
        await q.query(
          `INSERT INTO tasks(client_id, account_id, type, title, details, assignee_id, due_at, definition_of_done, source_ref, priority, priority_reason)
           VALUES ($1,$2,'profile_update',$3,$4,$5, now() + interval '5 days', 'Владелец обновил раздел профиля, менеджер проверил', $6, 0.55, 'Аудит профиля')`,
          [a.client_id, accountId, `Передать владельцу: обновить «${label}»`, `${c.finding ? `Что не так: ${c.finding}\n\n` : ""}${c.proposed_text ? `Предлагаемый текст:\n${c.proposed_text}` : "Текст подготовить с владельцем"}\n\nИзменение профиля выполняет сам владелец: API для этого нет.`, manager, `audit:${audit_.id}:${c.key}`]);
        tasks++;
      }
      await q.query("UPDATE profile_audits SET tasks_created = $2 WHERE id = $1", [audit_.id, tasks]);
    }
    await audit(q, ctx, { action: "profile.audited", entity_type: "profile_audit", entity_id: audit_.id, client_id: a.client_id, account_id: accountId, details: { issues: d.criteria.filter((x) => x.status !== "ok").length, tasks } });
    return { id: audit_.id, tasks_created: tasks };
  });
}

type Step = { key: string; label: string; status: "done" | "todo" | "not_applicable"; note?: string };

/** Чек-лист онбординга по фактическим данным (алгоритм первичного подключения, п. 7). */
export async function onboardingStatus(ctx: Ctx, accountId: string): Promise<{ steps: Step[]; done: number; total: number }> {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "view", { clientId: a.client_id, accountId });
  const r = (await ctx.db.query(`
    SELECT
      (a.manager_id IS NOT NULL OR EXISTS (SELECT 1 FROM account_assignments x WHERE x.account_id = a.id)) AS team,
      EXISTS (SELECT 1 FROM consents c WHERE c.account_id = a.id AND c.revoked_at IS NULL) AS consents,
      EXISTS (SELECT 1 FROM oauth_connections o WHERE o.account_id = a.id AND o.status IN ('active','expiring')) AS connected,
      EXISTS (SELECT 1 FROM capability_snapshots s WHERE s.account_id = a.id) AS caps,
      (SELECT count(*) FROM capability_snapshots s WHERE s.account_id = a.id AND s.mode = 'api') AS api_ops,
      EXISTS (SELECT 1 FROM knowledge_sources k WHERE k.account_id = a.id) AS brief,
      EXISTS (SELECT 1 FROM profile_audits p WHERE p.account_id = a.id) AS audited,
      EXISTS (SELECT 1 FROM metric_snapshots m WHERE m.account_id = a.id AND m.content_item_id IS NULL) AS baseline,
      EXISTS (SELECT 1 FROM strategy_versions s WHERE s.account_id = a.id) AS strategy,
      EXISTS (SELECT 1 FROM strategy_versions s WHERE s.account_id = a.id AND s.status = 'approved') AS strategy_ok,
      EXISTS (SELECT 1 FROM content_items ci WHERE ci.account_id = a.id AND (ci.planned_for > now() OR ci.scheduled_at > now())) AS plan,
      a.status = 'active' AS active, a.kind
    FROM managed_accounts a WHERE a.id = $1`, [accountId])).rows[0];
  const s = (key: string, label: string, ok: boolean, note?: string): Step => ({ key, label, status: ok ? "done" : "todo", note });
  const steps: Step[] = [
    s("client", "Клиент и ресурс созданы", true),
    s("team", "Команда назначена", r.team),
    s("consents", "Полномочия и согласия зафиксированы", r.consents),
    r.connected ? s("integration", "Интеграция подключена", true) : { key: "integration", label: "Интеграция подключена", status: "not_applicable", note: "Работа через людей, пока подключение недоступно" },
    s("capabilities", "Возможности аккаунта определены", r.caps, r.caps ? `Операций через API: ${r.api_ops}` : undefined),
    s("brief", "Бриф и исходные материалы", r.brief),
    r.kind === "company_page" ? { key: "audit", label: "Аудит профиля", status: "not_applicable", note: "Для страницы компании аудит страницы проводится вне формы профиля" } : s("audit", "Аудит профиля", r.audited),
    s("baseline", "Исходные показатели зафиксированы", r.baseline),
    s("strategy", "Стратегия подготовлена", r.strategy),
    s("strategy_ok", "Цели, голос и порядок согласованы", r.strategy_ok),
    s("plan", "План ближайшего месяца", r.plan),
    s("launch", "Рабочие процессы запущены", r.active),
  ];
  return { steps, done: steps.filter((x) => x.status !== "todo").length, total: steps.length };
}

export async function listAudits(ctx: Ctx, accountId: string) {
  await accountScope(ctx.db, ctx, accountId);
  return (await ctx.db.query("SELECT id, criteria, summary, tasks_created, created_at FROM profile_audits WHERE account_id = $1 ORDER BY created_at DESC", [accountId])).rows;
}
