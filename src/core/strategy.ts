import type { ActionKind, Window3 } from "./safety";

/**
 * Стратегии активности: от «Репутации» до «Агрессивной». Компания задаёт уровень по умолчанию и потолок,
 * сотрудник может выбрать уровень ниже (осторожнее), но не выше. Уровень открывается только после
 * прогрева и при низком риске аккаунта; иначе действует ближайший открытый уровень ниже.
 * Числа: потолки в неделю. Офицер безопасности применяет их вместе с часовыми и суточными окнами.
 */
export const STRATEGY_LEVELS = ["reputation", "steady", "growth", "active", "aggressive"] as const;
export type StrategyLevel = (typeof STRATEGY_LEVELS)[number];

export interface StrategyPreset {
  key: StrategyLevel; label: string; summary: string;
  postsPerWeek: number; commentsPerWeek: number; reactionsPerWeek: number;
  /** Черновики личных сообщений и приглашений: отправляет сотрудник одним касанием. */
  messagesPerWeek: number; invitesPerWeek: number;
  salesNavigator: boolean;
  /** Сколько дней с начала прогрева нужно, чтобы уровень открылся. */
  unlockAfterDays: number;
}

export const STRATEGIES: Record<StrategyLevel, StrategyPreset> = {
  reputation: { key: "reputation", label: "Репутация", summary: "Минимум действий: пост в неделю, комментарий раз в 2–3 дня, постепенное развитие профиля. Для компаний, которым важна спокойная техническая репутация.", postsPerWeek: 1, commentsPerWeek: 3, reactionsPerWeek: 7, messagesPerWeek: 0, invitesPerWeek: 0, salesNavigator: false, unlockAfterDays: 0 },
  steady: { key: "steady", label: "Спокойный рост", summary: "Пост в неделю, комментарии через день, приглашения коллегам по отрасли.", postsPerWeek: 1, commentsPerWeek: 4, reactionsPerWeek: 10, messagesPerWeek: 0, invitesPerWeek: 10, salesNavigator: false, unlockAfterDays: 0 },
  growth: { key: "growth", label: "Рост", summary: "Два поста в неделю, комментарии почти каждый день, первые личные сообщения по списку лидов.", postsPerWeek: 2, commentsPerWeek: 6, reactionsPerWeek: 15, messagesPerWeek: 5, invitesPerWeek: 20, salesNavigator: false, unlockAfterDays: 21 },
  active: { key: "active", label: "Активный", summary: "Три поста в неделю, ежедневные комментарии, регулярная работа с лидами из Sales Navigator.", postsPerWeek: 3, commentsPerWeek: 10, reactionsPerWeek: 25, messagesPerWeek: 15, invitesPerWeek: 35, salesNavigator: true, unlockAfterDays: 30 },
  aggressive: { key: "aggressive", label: "Агрессивный", summary: "Максимум в безопасных пределах: до 4 постов в неделю, больше комментариев, личные сообщения и приглашения каждый рабочий день, Sales Navigator.", postsPerWeek: 4, commentsPerWeek: 14, reactionsPerWeek: 35, messagesPerWeek: 30, invitesPerWeek: 60, salesNavigator: true, unlockAfterDays: 45 },
};

export const levelRank = (l: StrategyLevel) => STRATEGY_LEVELS.indexOf(l);
export const isLevel = (x: unknown): x is StrategyLevel => typeof x === "string" && (STRATEGY_LEVELS as readonly string[]).includes(x);

/**
 * Действующий уровень: не выше потолка компании и выбора сотрудника, открыт по дням прогрева,
 * при среднем риске и выше не больше «Спокойного роста».
 */
export function effectiveLevel(o: { company: StrategyLevel; employee?: StrategyLevel | null; daysSinceStart: number; riskLevel: "low" | "medium" | "high" | "blocked" }): { level: StrategyLevel; requested: StrategyLevel; capped_by: "warmup" | "risk" | null } {
  const requested = o.employee && levelRank(o.employee) < levelRank(o.company) ? o.employee : o.company;
  let level: StrategyLevel = requested;
  let capped: "warmup" | "risk" | null = null;
  while (levelRank(level) > 0 && STRATEGIES[level].unlockAfterDays > o.daysSinceStart) { level = STRATEGY_LEVELS[levelRank(level) - 1]; capped = "warmup"; }
  if (o.riskLevel !== "low" && levelRank(level) > levelRank("steady")) { level = "steady"; capped = "risk"; }
  return { level, requested, capped_by: capped };
}

/** Окна лимитов офицера для уровня: неделя из пресета, сутки и час производные. */
export function levelLimits(level: StrategyLevel, kind: ActionKind): Window3 {
  const p = STRATEGIES[level];
  const week = kind === "post" ? p.postsPerWeek : kind === "repost_note" ? Math.max(1, Math.ceil(p.postsPerWeek / 2)) : kind === "comment" ? p.commentsPerWeek : p.reactionsPerWeek;
  const day = kind === "post" || kind === "repost_note" ? 1 : Math.max(1, Math.ceil(week / 4));
  const hour = kind === "react" ? Math.min(3, day) : 1;
  return { week, day, hour };
}

/** Потолок черновиков сообщений и приглашений в неделю (их отправляет сотрудник). */
export function outreachLimit(level: StrategyLevel, kind: "message" | "invite") {
  const p = STRATEGIES[level];
  return kind === "message" ? p.messagesPerWeek : p.invitesPerWeek;
}

/* ---------- Подписка ---------- */
export const PLAN = { key: "autopilot", priceUsd: 200, label: "Автопилот аккаунта", includes: [
  "Личный AI-агент сотрудника и паспорт голоса",
  "Прогрев 30 дней и стратегия от «Репутации» до «Агрессивной»",
  "Посты, новости компании, визуалы и портрет профиля",
  "Комментарии, реакции, сообщения и приглашения в одно касание",
  "Офицер безопасности, отчёты сотруднику и руководителю",
] };
