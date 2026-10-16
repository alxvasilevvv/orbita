/**
 * Движок безопасности аккаунтов сотрудников: лимиты, разгон, охлаждение, оценка риска,
 * правила естественности, проверка текстов. Чистые функции без БД: их вызывает офицер безопасности
 * дважды (перед предложением и перед исполнением), а счётчики считаются в одной транзакции с блокировкой аккаунта.
 * Цифры и правила: docs/b2b-orchestration-concept.md, раздел 5 (версия после шести аудитов).
 */
import { levelLimits } from "./strategy";
export type ActionKind = "react" | "comment" | "repost_note" | "post";
export interface Window3 { day: number; hour: number; week: number }

/** Лимиты участия сотрудника через платформу (скользящие окна 24 ч, 60 мин, 7 дней). */
export const LIMITS: Record<ActionKind, { normal: Window3; ramp: Window3 }> = {
  comment: { normal: { day: 2, hour: 1, week: 6 }, ramp: { day: 1, hour: 1, week: 3 } },
  react: { normal: { day: 5, hour: 3, week: 20 }, ramp: { day: 3, hour: 2, week: 10 } },
  repost_note: { normal: { day: 1, hour: 1, week: 1 }, ramp: { day: 1, hour: 1, week: 1 } },
  post: { normal: { day: 1, hour: 1, week: 2 }, ramp: { day: 1, hour: 1, week: 1 } },
};
export const RAMP_DAYS = 14;
export const COOLDOWN_HOURS = 24;
export const HALF_DAYS = 7;
export const EXCLUDE_AFTER_WARNINGS = 3;
/** Сигналы LinkedIn, после которых действия аккаунта останавливаются. */
export const SIGNAL_COOLDOWN_HOURS: Record<string, number> = {
  warning: 24, captcha: 24, restriction: 24, identity_check: 24, throttled: 24, comment_hidden: 24 * 7, token_revoked: 0, api_forbidden: 0,
};

export interface SafetyState {
  rampStartedAt: Date;
  cooldownUntil: Date | null;
  halfUntil: Date | null;
  excluded: boolean;
  warningsAt: Date[];          // сигналы за последние 30 дней
  connectionError: boolean;
  pausedUntil?: Date | null;   // пауза, которую поставил сам сотрудник
  frequency?: "weekly" | "biweekly" | "paused";
  selfReportedActivity?: "rare" | "weekly" | "daily" | null;
  /** Действующий уровень стратегии (core/strategy.ts). Без уровня: штатные лимиты сотрудника. */
  level?: import("./strategy").StrategyLevel | null;
}

const DAY = 864e5;
export function inRamp(s: SafetyState, now: Date) { return now.getTime() - s.rampStartedAt.getTime() < RAMP_DAYS * DAY; }

/** Действующие лимиты с учётом разгона, охлаждения и половинного режима. */
export function limitsFor(s: SafetyState, kind: ActionKind, now: Date): Window3 & { mode: "blocked" | "ramp" | "half" | "normal" } {
  if (s.excluded || (s.cooldownUntil && s.cooldownUntil > now) || s.frequency === "paused" || (s.pausedUntil && s.pausedUntil > now)) return { day: 0, hour: 0, week: 0, mode: "blocked" };
  const base = inRamp(s, now) ? LIMITS[kind].ramp : s.level ? levelLimits(s.level, kind) : LIMITS[kind].normal;
  if (s.halfUntil && s.halfUntil > now) {
    const h = (n: number) => Math.max(kind === "react" ? 1 : 0, Math.floor(n / 2));
    return { day: h(base.day), hour: Math.max(h(base.hour), h(base.day) ? 1 : 0), week: h(base.week), mode: "half" };
  }
  return { ...base, mode: inRamp(s, now) ? "ramp" : "normal" };
}

/** Проверка квоты: использовано плюс зарезервировано (одобрено, но не выполнено) в каждом окне. */
export function quotaReasons(lim: Window3, used: Window3): string[] {
  const out: string[] = [];
  if (used.hour >= lim.hour) out.push("limit_hour");
  if (used.day >= lim.day) out.push("limit_day");
  if (used.week >= lim.week) out.push("limit_week");
  return out;
}

export interface RiskInput {
  state: SafetyState;
  now: Date;
  /** Максимальная доля использованного дневного лимита по видам действий, 0–1. */
  usedRatio: number;
}
export interface RiskResult { blocked: boolean; reasons: string[]; score: number | null; level: "low" | "medium" | "high" | "blocked"; parts: Record<string, number> }

/**
 * Оценка риска v2. Сначала запреты (не баллы): охлаждение, исключение, ошибка подключения, 3+ сигнала за 30 дней.
 * Затем балл 0–100, веса в сумме 100: 35 сигналы с затуханием (10 дней), 25 скорость, 15 разгон,
 * 15 «одностороннее поведение» (самооценка активности вне платформы), 10 неизвестность.
 * При нехватке данных уровень не ниже среднего.
 */
export const RISK_MODEL_VERSION = "risk-v2";
export function riskScore(i: RiskInput): RiskResult {
  const { state: s, now } = i;
  const reasons: string[] = [];
  const recent = s.warningsAt.filter((w) => now.getTime() - w.getTime() < 30 * DAY);
  if (s.excluded) reasons.push("excluded");
  if (s.cooldownUntil && s.cooldownUntil > now) reasons.push("cooldown");
  if (s.connectionError) reasons.push("connection_error");
  if (recent.length >= EXCLUDE_AFTER_WARNINGS) reasons.push("warnings_30d");
  if (reasons.length) return { blocked: true, reasons, score: null, level: "blocked", parts: {} };
  const signals = Math.min(1, recent.reduce((a, w) => a + Math.exp(-(now.getTime() - w.getTime()) / DAY / 10), 0));
  const velocity = Math.max(0, Math.min(1, i.usedRatio));
  const d = (now.getTime() - s.rampStartedAt.getTime()) / DAY;
  const ramp = Math.max(0, 1 - d / RAMP_DAYS);
  const act = s.selfReportedActivity;
  const oneSided = act === "rare" ? 1 : act === "weekly" ? 0.5 : act === "daily" ? 0 : 0;
  const unknown = act ? 0 : 1;
  const parts = { signals: 35 * signals, velocity: 25 * velocity, ramp: 15 * ramp, one_sided: 15 * oneSided, unknown: 10 * unknown };
  const score = Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 10) / 10;
  let level: RiskResult["level"] = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
  if (unknown && level === "low") level = "medium";
  return { blocked: false, reasons: [], score, level, parts };
}

/** Что разрешено при уровне риска: высокий и заблокированный ничего, средний только реакции. */
export function allowedByRisk(level: RiskResult["level"], kind: ActionKind) {
  if (level === "blocked" || level === "high") return false;
  if (level === "medium") return kind === "react";
  return true;
}

/* ---------- Правила естественности на уровне поста ---------- */
export const NATURAL = {
  participantsShare: 0.25,
  participantsMax: 5,
  minConnected: 4,
  quietFirstMinutes: 60,
  minGapMinutes: 45,
  windowMinHours: 2,
  windowMaxHours: 72,
  repostsPer48h: 3,
  workdayStartHour: 8,
  workdayEndHour: 21,
};

/** Участников на пост: не больше 25% подключённых (с округлением вверх) и не больше 5; при меньше 4 подключённых никто. */
export function maxParticipants(connectedEmployees: number, requested?: number) {
  if (connectedEmployees < NATURAL.minConnected) return 0;
  const byShare = Math.ceil(connectedEmployees * NATURAL.participantsShare);
  return Math.max(0, Math.min(NATURAL.participantsMax, byShare, requested ?? NATURAL.participantsMax));
}

/** Локальный час в поясе сотрудника. */
export function localHour(d: Date, tz: string) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(d));
}

/** Детерминированный псевдослучайный сдвиг: одинаковый для одной пары миссия/аккаунт, разный между аккаунтами. */
export function seededJitter(seed: string, maxMinutes: number) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (Math.abs(h) % Math.max(1, maxMinutes));
}

/**
 * Время действия: не раньше тихого часа после публикации, в рабочие часы сотрудника,
 * с разносом не меньше 45 минут от уже запланированных действий компании на этом посте.
 */
export function pickSlot(o: { windowStart: Date; windowEnd: Date; publishedAt: Date | null; tz: string; taken: Date[]; seed: string; now: Date }): Date | null {
  const earliest = Math.max(o.windowStart.getTime(), o.now.getTime(), o.publishedAt ? o.publishedAt.getTime() + NATURAL.quietFirstMinutes * 6e4 : 0);
  const start = earliest + seededJitter(o.seed, 90) * 6e4;
  for (let t = start; t <= o.windowEnd.getTime(); t += 15 * 6e4) {
    const d = new Date(t);
    const h = localHour(d, o.tz);
    if (h < NATURAL.workdayStartHour || h >= NATURAL.workdayEndHour) continue;
    if (o.taken.some((x) => Math.abs(x.getTime() - t) < NATURAL.minGapMinutes * 6e4)) continue;
    return d;
  }
  return null;
}

/* ---------- Тексты ---------- */
export function normalizeText(s: string) {
  return s.toLowerCase().replace(/ё/g, "е").replace(/https?:\/\/\S+/g, " ").replace(/@\S+/g, " ").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}
export function shingles(s: string, k = 5) {
  const t = normalizeText(s).replace(/\s/g, "_");
  const out = new Set<string>();
  if (t.length <= k) { if (t) out.add(t); return out; }
  for (let i = 0; i + k <= t.length; i++) out.add(t.slice(i, i + k));
  return out;
}
export function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
export const SIMILARITY_BLOCK = 0.35;
export const SIMILARITY_WARN = 0.25;
const TEMPLATE_PHRASES = ["great post", "thanks for sharing", "totally agree", "well said", "congrats", "congratulations", "отличный пост", "спасибо что поделились", "полностью согласен", "полностью согласна", "супер", "круто", "поздравляю"];

export interface TextCheck { block: string[]; warn: string[] }
/**
 * Проверка текста комментария или заметки: длина, шаблоны, ссылки и упоминания,
 * похожесть на другие тексты миссии, историю сотрудника и тексты агентства.
 */
export function checkText(text: string, kind: ActionKind, others: string[]): TextCheck {
  const block: string[] = [], warn: string[] = [];
  const words = normalizeText(text).split(" ").filter(Boolean);
  if ((kind === "comment" || kind === "repost_note") && words.length < 8) block.push("too_short");
  const norm = normalizeText(text);
  if (TEMPLATE_PHRASES.some((p) => norm === p || (norm.startsWith(p) && words.length < 12))) block.push("template_phrase");
  if (kind === "comment" && /https?:\/\//i.test(text)) block.push("link_in_comment");
  if ((text.match(/@\w+/g) ?? []).length > (kind === "post" ? 3 : 0)) block.push("mentions");
  const mine = shingles(text);
  let max = 0;
  for (const o of others) max = Math.max(max, jaccard(mine, shingles(o)));
  if (max >= SIMILARITY_BLOCK) block.push("similar_text");
  else if (max >= SIMILARITY_WARN) warn.push("similar_text_warn");
  return { block, warn };
}

/* ---------- Отраслевые ограничения (финансы, крипто) ---------- */
export const REGULATED_RULES: { code: string; re: RegExp }[] = [
  { code: "return_promise", re: /\b(guarantee\w*|risk[- ]?free|passive income|x\d{1,3}\b|\d+\s?%\s*(apy|apr|roi|profit|monthly|daily))|гарантир\w*|без риска|пассивн\w+ доход|прибыл\w* \d+/iu },
  { code: "fomo", re: /\b(easy money|can'?t lose|don'?t miss|last chance|to the moon)\b|легк\w+ заработ\w*|успей\w*/iu },
  { code: "past_performance", re: /\b(returned|made|earned)\b[^.]{0,40}\d+\s?%|заработал\w*[^.]{0,40}\d+\s?%/iu },
  { code: "call_to_deposit", re: /\b(sign up|deposit|buy now|start trading)\b|зарегистрир\w+|пополн\w+ сч[её]т|начните торговать/iu },
];
export function regulatedReasons(text: string, industry: string, complianceApproved: boolean): string[] {
  if (industry !== "crypto" && industry !== "fin") return [];
  const out = REGULATED_RULES.filter((r) => r.re.test(text)).map((r) => r.code);
  if (out.length && !complianceApproved) out.push("needs_compliance");
  return out;
}

/** Раскрытие связи с работодателем: для регулируемых отраслей и режима inline обязательна пометка в тексте. */
export function disclosureMissing(text: string, mode: "profile" | "inline", disclosureText: string, industry: string) {
  if (mode !== "inline" && industry !== "crypto" && industry !== "fin") return false;
  const t = text.toLowerCase();
  return !(t.includes(disclosureText.toLowerCase()) || /#employee|i work at|работаю в/i.test(text));
}

/* ---------- Релевантность участника ---------- */
export interface Topic { tag: string; weight: number; keywords: string[] }
/** Теги поста только из словаря компании и только с цитатой из текста: агент не додумывает. */
export function tagPost(text: string, topics: Topic[]): { tag: string; weight: number; quote: string }[] {
  const out: { tag: string; weight: number; quote: string }[] = [];
  const low = text.toLowerCase();
  for (const tp of topics) {
    const kw = [tp.tag, ...tp.keywords].find((k) => k && low.includes(k.toLowerCase()));
    if (kw) {
      const i = low.indexOf(kw.toLowerCase());
      out.push({ tag: tp.tag, weight: tp.weight, quote: text.slice(Math.max(0, i - 30), i + kw.length + 30).trim() });
    }
  }
  return out;
}
/** rel = Σ w(теги поста ∩ экспертиза) / Σ w(теги поста). Комментарий при rel ≥ 0,5 и совпадении основного тега. */
export function relevance(postTags: { tag: string; weight: number }[], expertise: string[]) {
  const total = postTags.reduce((a, t) => a + t.weight, 0);
  if (!total) return { rel: 0, mainMatch: false, canComment: false };
  const e = new Set(expertise.map((x) => x.toLowerCase()));
  const rel = postTags.filter((t) => e.has(t.tag.toLowerCase())).reduce((a, t) => a + t.weight, 0) / total;
  const main = [...postTags].sort((a, b) => b.weight - a.weight)[0];
  const mainMatch = e.has(main.tag.toLowerCase());
  return { rel: Math.round(rel * 1000) / 1000, mainMatch, canComment: rel >= 0.5 && mainMatch };
}

/** Последствия сигнала LinkedIn для состояния аккаунта. */
export function applySignal(s: SafetyState, kind: string, now: Date): SafetyState {
  const hours = SIGNAL_COOLDOWN_HOURS[kind] ?? 24;
  const warningsAt = [...s.warningsAt.filter((w) => now.getTime() - w.getTime() < 30 * DAY), now];
  const cooldownUntil = hours ? new Date(now.getTime() + hours * 36e5) : s.cooldownUntil;
  const halfUntil = hours ? new Date((cooldownUntil as Date).getTime() + HALF_DAYS * DAY) : s.halfUntil;
  return { ...s, warningsAt, cooldownUntil, halfUntil, excluded: s.excluded || warningsAt.length >= EXCLUDE_AFTER_WARNINGS };
}
