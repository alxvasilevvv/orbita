/** Настраиваемые эвристики. Веса не выдаются за алгоритм LinkedIn. */
const clamp01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

export interface Blockable { blockers: string[] }
export type Scored = { score: number | null; blocked: boolean; reason: string };

export const ENGAGEMENT_WEIGHTS = { relevance: 0.3, audience_fit: 0.25, contribution_value: 0.25, timeliness: 0.2 };

export function engagementPriority(c: { relevance: number; audience_fit: number; contribution_value: number; timeliness: number } & Blockable, w = ENGAGEMENT_WEIGHTS): Scored {
  if (c.blockers.length) return { score: null, blocked: true, reason: `Заблокировано: ${c.blockers.join("; ")}` };
  const score = w.relevance * clamp01(c.relevance) + w.audience_fit * clamp01(c.audience_fit) + w.contribution_value * clamp01(c.contribution_value) + w.timeliness * clamp01(c.timeliness);
  return { score, blocked: false, reason: `релевантность ${c.relevance.toFixed(2)}, аудитория ${c.audience_fit.toFixed(2)}, вклад ${c.contribution_value.toFixed(2)}, актуальность ${c.timeliness.toFixed(2)}` };
}

export const TASK_WEIGHTS = { urgency: 0.4, impact: 0.35, blocker_severity: 0.25 };

/** urgency из близости дедлайна: 1 при просрочке, 0 при сроке за горизонтом. */
export function urgencyFromDue(due: Date | null, now = new Date(), horizonHours = 72): number {
  if (!due) return 0.1;
  const h = (due.getTime() - now.getTime()) / 3600_000;
  if (h <= 0) return 1;
  return clamp01(1 - h / horizonHours);
}

export function taskPriority(t: { due: Date | null; impact: number; blocker_severity: number; now?: Date } & Blockable, w = TASK_WEIGHTS): Scored {
  if (t.blockers.length) return { score: null, blocked: true, reason: `Блокировка: ${t.blockers.join("; ")}` };
  const u = urgencyFromDue(t.due, t.now);
  const score = w.urgency * u + w.impact * clamp01(t.impact) + w.blocker_severity * clamp01(t.blocker_severity);
  return { score, blocked: false, reason: `срочность ${u.toFixed(2)}, влияние ${t.impact.toFixed(2)}, блокирует других ${t.blocker_severity.toFixed(2)}` };
}

/** Проверка ёмкости: не назначаем молча сверх доступных часов. */
export function capacityCheck(u: { capacity_minutes: number; assigned_minutes: number }, addMinutes: number) {
  const after = u.assigned_minutes + addMinutes;
  return { ok: after <= u.capacity_minutes, after, overBy: Math.max(0, after - u.capacity_minutes) };
}

/**
 * Бюджет запросов к API:
 * суточные = аккаунты × частота синхронизации × запросы на синхронизацию (с пагинацией)
 *          + публикации + взаимодействия, затем × (1 + резерв).
 */
export function dailyRequestBudget(p: { accounts: number; syncsPerDay: number; requestsPerSync: number; publicationsPerDay: number; requestsPerPublication: number; interactionsPerDay: number; reserve: number }) {
  const sync = p.accounts * p.syncsPerDay * p.requestsPerSync;
  const pub = p.publicationsPerDay * p.requestsPerPublication;
  const total = Math.ceil((sync + pub + p.interactionsPerDay) * (1 + p.reserve));
  return { sync, pub, interactions: p.interactionsPerDay, total };
}
