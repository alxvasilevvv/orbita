/**
 * Правила аналитики: null = нет данных (не ноль), накопительные снимки не
 * суммируются, охват и показы не смешиваются, собственные метрики помечены.
 */
export type Nature = "periodic" | "cumulative" | "point_in_time";
export interface MetricValue {
  metric_key: string;
  value: number | null;
  nature: Nature;
  observed_at: string | Date;
  period_start?: string | Date | null;
  period_end?: string | Date | null;
  availability_status: "available" | "not_available" | "pending" | "not_permitted";
}

export type Computed =
  | { status: "ok"; value: number; definition: string }
  | { status: "not_computable"; reason: string; definition: string };

export const INTERACTION_RATE_DEFINITION =
  "Определение платформы Agency LinkedIn OS (v1): (reactions + comments + reposts) / impressions × 100%. Не является метрикой LinkedIn.";

export function interactionRateByImpressions(m: {
  reactions: number | null; comments: number | null; reposts: number | null; impressions: number | null;
}): Computed {
  const def = INTERACTION_RATE_DEFINITION;
  if (m.impressions == null || m.impressions === 0) return { status: "not_computable", reason: "Нет показов или показы равны нулю", definition: def };
  if (m.reactions == null || m.comments == null || m.reposts == null) return { status: "not_computable", reason: "Нет полного набора взаимодействий", definition: def };
  return { status: "ok", value: ((m.reactions + m.comments + m.reposts) / m.impressions) * 100, definition: def };
}

export function ctr(m: { clicks: number | null; impressions: number | null; compatible: boolean }): Computed {
  const def = "clicks / impressions × 100% при совместимых источниках и периодах";
  if (!m.compatible) return { status: "not_computable", reason: "Клики и показы из несовместимых источников/периодов", definition: def };
  if (m.clicks == null || m.impressions == null || m.impressions === 0) return { status: "not_computable", reason: "Нет данных о кликах или показах", definition: def };
  return { status: "ok", value: (m.clicks / m.impressions) * 100, definition: def };
}

/**
 * Агрегирует значения за период. Периодические значения суммируются только при явных
 * непересекающихся периодах; иначе повторные снимки одной величины дали бы двойной счёт,
 * поэтому берётся последний снимок. Для накопительных всегда последний снимок; null не превращается в 0.
 */
export function aggregate(values: MetricValue[]): { value: number | null; completeness: number; note: string } {
  if (values.length === 0) return { value: null, completeness: 0, note: "Нет данных" };
  const natures = new Set(values.map((v) => v.nature));
  if (natures.size > 1) throw new Error("Нельзя агрегировать метрики разной природы");
  const keys = new Set(values.map((v) => v.metric_key));
  if (keys.size > 1) throw new Error("Нельзя смешивать разные метрики (например, охват и показы)");
  const available = values.filter((v) => v.value != null && v.availability_status === "available");
  const completeness = available.length / values.length;
  if (available.length === 0) return { value: null, completeness: 0, note: "Значения отсутствуют" };
  const nature = values[0].nature;
  if (nature === "cumulative" || nature === "point_in_time") {
    const latest = [...available].sort((a, b) => +new Date(b.observed_at) - +new Date(a.observed_at))[0];
    return { value: latest.value, completeness, note: "Последний снимок (накопительные значения не суммируются)" };
  }
  if (values[0].metric_key === "unique_reach") {
    return { value: null, completeness, note: "Уникальный охват разных публикаций не суммируется" };
  }
  if (!periodsDisjoint(available)) {
    const latest = [...available].sort((a, b) => +new Date(b.observed_at) - +new Date(a.observed_at))[0];
    return { value: latest.value, completeness, note: "Периоды не заданы или пересекаются: взят последний снимок, сумма не рассчитывается" };
  }
  const sum = available.reduce((s, v) => s + (v.value as number), 0);
  return { value: sum, completeness, note: completeness < 1 ? "Сумма по доступным периодам, данные неполные" : "Сумма за период" };
}

/** Все значения имеют явный период [start, end) и периоды не пересекаются. Одно значение суммировать не с чем. */
export function periodsDisjoint(values: Pick<MetricValue, "period_start" | "period_end">[]): boolean {
  if (values.length <= 1) return true;
  const ps = values.map((v) => ({ s: v.period_start ? +new Date(v.period_start) : NaN, e: v.period_end ? +new Date(v.period_end) : NaN }));
  if (ps.some((p) => !Number.isFinite(p.s) || !Number.isFinite(p.e) || p.e <= p.s)) return false;
  ps.sort((a, b) => a.s - b.s);
  for (let i = 1; i < ps.length; i++) if (ps[i].s < ps[i - 1].e) return false;
  return true;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const DEFAULT_METRIC_DEFINITIONS = [
  { key: "impressions", name: "Показы", unit: "count", nature: "periodic", definition: "Показы публикации по данным источника" },
  { key: "unique_reach", name: "Уникальный охват", unit: "members", nature: "periodic", definition: "Уникальные участники по данным источника; не суммируется между публикациями" },
  { key: "reactions", name: "Реакции", unit: "count", nature: "cumulative", definition: "Накопительное число реакций на момент наблюдения" },
  { key: "comments", name: "Комментарии", unit: "count", nature: "cumulative", definition: "Накопительное число комментариев на момент наблюдения" },
  { key: "reposts", name: "Репосты", unit: "count", nature: "cumulative", definition: "Накопительное число репостов на момент наблюдения" },
  { key: "clicks", name: "Клики", unit: "count", nature: "periodic", definition: "Клики по данным источника" },
  { key: "followers", name: "Подписчики", unit: "members", nature: "point_in_time", definition: "Число подписчиков на момент наблюдения" },
  { key: "profile_views", name: "Просмотры профиля", unit: "count", nature: "periodic", definition: "Если доступно источнику" },
  { key: "qualified_inquiries", name: "Квалифицированные обращения", unit: "count", nature: "periodic", definition: "Внесено уполномоченным пользователем с указанием атрибуции" },
] as const;
