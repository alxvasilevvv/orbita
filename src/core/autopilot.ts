import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { resolveLocal } from "./time";
import { seededJitter } from "./safety";

/**
 * Автопилот сотрудника: каталог ролей и интервью, паспорт голоса, прогрев 30 дней, недельный план постов компании.
 * Чистые функции без БД. Правила: docs/autopilot.md.
 */

/* ---------- Роли и интервью ---------- */
export interface RoleDef { key: string; label: string; topics: string[]; extra: string }
export const ROLE_CATALOG: RoleDef[] = [
  { key: "backend", label: "Backend-разработчик", topics: ["architecture", "performance", "api"], extra: "Какую систему или сервис вы спроектировали или сильно ускорили?" },
  { key: "frontend", label: "Frontend-разработчик", topics: ["frontend", "ux", "performance"], extra: "Какое решение в интерфейсе заметно улучшило продукт для пользователей?" },
  { key: "platform", label: "DevOps / платформа", topics: ["kubernetes", "reliability", "infrastructure"], extra: "Какой инцидент или миграцию инфраструктуры вы провели и что поменяли после?" },
  { key: "security", label: "Безопасность", topics: ["security", "compliance", "reliability"], extra: "Какую практику безопасности вы внедрили так, что командам стало проще?" },
  { key: "data_ml", label: "Data / ML / AI", topics: ["ml", "data", "ai"], extra: "Какая модель или пайплайн данных дошли до продакшна и что было самым сложным?" },
  { key: "qa", label: "QA / тестирование", topics: ["quality", "testing", "reliability"], extra: "Как вы ловите ошибки раньше, чем их увидит пользователь?" },
  { key: "tech_lead", label: "Техлид", topics: ["architecture", "engineering_culture", "hiring"], extra: "Какое техническое решение команды вы защищали и оказались правы или неправы?" },
  { key: "executive", label: "Руководитель (CTO, CEO, Head)", topics: ["strategy", "engineering_culture", "product"], extra: "Какой принцип управления командой вы считаете главным и почему?" },
  { key: "product", label: "Продакт-менеджер", topics: ["product", "ux", "strategy"], extra: "Какую гипотезу вы проверили и что показали данные?" },
  { key: "talent", label: "HR / найм", topics: ["hiring", "engineering_culture", "career"], extra: "Что, по-вашему, отличает сильного кандидата в вашу команду?" },
];
export const roleByKey = (k: string | null | undefined) => ROLE_CATALOG.find((r) => r.key === k) ?? null;

export const INTERVIEW: { key: string; q: string }[] = [
  { key: "now", q: "Чем вы занимаетесь в компании сейчас: команда, продукт, зона ответственности?" },
  { key: "win", q: "Какой результат за последний год вы считаете своим лучшим? Что именно вы сделали?" },
  { key: "lesson", q: "Какой подход не сработал и чему это научило?" },
  { key: "stack", q: "Технологии, инструменты и практики, в которых вы сильны." },
  { key: "extra", q: "Вопрос по вашей роли" },
];

/* ---------- Паспорт голоса ---------- */
export interface Passport {
  role_key: string; role_label: string;
  headline: string; about: string;
  topics: string[];
  tone: { length: "short" | "medium" | "long"; register: "formal" | "conversational"; humor: boolean };
  language: "en" | "ru";
  phrases: string[];
  never_topics: string[];
  formats: ("lesson" | "how_to" | "opinion" | "story" | "checklist")[];
}
export interface PassportChoices { topics: string[]; length: Passport["tone"]["length"]; register: Passport["tone"]["register"]; humor: boolean; language: Passport["language"]; phrases: string[]; never_topics: string[] }

const clean = (s: string, max = 600) => s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

export function buildPassport(role: RoleDef, displayName: string, answers: Record<string, string>, c: PassportChoices): Passport {
  const topics = [...new Set((c.topics.length ? c.topics : role.topics).map((t) => t.toLowerCase().trim()).filter((t) => /^[\p{L}\p{N}_ -]{2,40}$/u.test(t)))].slice(0, 5);
  const name = displayName.replace(/\s*\(.*\)$/, "");
  return {
    role_key: role.key, role_label: role.label,
    headline: clean(`${role.label} · ${topics.slice(0, 3).join(" · ")}`, 120),
    about: clean(answers.now ?? `${name}: ${role.label}`),
    topics,
    tone: { length: c.length, register: c.register, humor: c.humor },
    language: c.language,
    phrases: c.phrases.map((p) => clean(p, 80)).filter(Boolean).slice(0, 5),
    never_topics: c.never_topics.map((p) => clean(p, 60).toLowerCase()).filter(Boolean).slice(0, 10),
    formats: c.register === "formal" ? ["how_to", "lesson", "checklist"] : ["lesson", "story", "opinion", "how_to"],
  };
}

/** Устойчивый хеш паспорта: согласие на автопилот привязано к конкретной версии. */
export function passportHash(p: Passport): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(sort(p))).digest("hex");
}

/** Факты из интервью: предложения от 6 слов, сказанные самим сотрудником. Только они идут в тексты агента. */
export function claimsFromInterview(answers: Record<string, string>): string[] {
  const out: string[] = [];
  for (const k of ["now", "win", "lesson", "stack", "extra"]) {
    const t = clean(answers[k] ?? "", 2000);
    for (const s of t.split(/(?<=[.!?])\s+/)) {
      const x = s.trim();
      if (x.split(/\s+/).length >= 6 && x.length <= 400) out.push(x);
    }
  }
  return [...new Set(out)].slice(0, 12);
}

/* ---------- Прогрев 30 дней ---------- */
export const WARMUP_DAYS = 30;
export type WarmupStage = "profile" | "first_posts" | "rhythm" | "steady";
/** Сколько постов агент планирует в неделю. Новости компании входят в тот же лимит. */
export function warmup(daysSinceStart: number, intensity: "low" | "normal" = "low"): { stage: WarmupStage; postsPerWeek: number; newsAllowed: boolean; day: number } {
  const day = Math.max(0, Math.floor(daysSinceStart));
  if (day < 7) return { stage: "profile", postsPerWeek: 0, newsAllowed: false, day };
  if (day < 14) return { stage: "first_posts", postsPerWeek: 1, newsAllowed: false, day };
  if (day < WARMUP_DAYS) return { stage: "rhythm", postsPerWeek: 1, newsAllowed: true, day };
  return { stage: "steady", postsPerWeek: intensity === "normal" ? 2 : 1, newsAllowed: true, day };
}
export const WARMUP_PLAN: { days: string; stage: WarmupStage; what: string }[] = [
  { days: "1–7", stage: "profile", what: "Оформление профиля: портрет, обложка, заголовок и раздел «О себе» по паспорту. Постов нет, только реакции на посты компании по одобрению" },
  { days: "8–14", stage: "first_posts", what: "Первый пост в неделю на самую сильную тему паспорта" },
  { days: "15–30", stage: "rhythm", what: "Пост в неделю и новости компании с личным комментарием в пределах того же лимита" },
  { days: "31+", stage: "steady", what: "Штатный ритм: 1 пост в неделю (2 при интенсивности «обычная»)" },
];

/* ---------- План недели компании ---------- */
export const COMPANY = {
  /** Не больше постов сотрудников компании в день: max(1, ceil(n/5)). */
  perDayShare: 5,
  minGapMinutes: 120,
  topicCooldownDays: 3,  // мягкое правило: при нехватке тем берётся самая редкая
  ownGapDays: 2,
  leadHours: 30,
  localSlots: ["09:30", "11:45", "14:00", "16:15"],
  weekdays: [1, 2, 3, 0, 4] as number[], // смещение от понедельника: вт, ср, чт, пн, пт
};
export const maxCompanyPostsPerDay = (n: number) => Math.max(1, Math.ceil(n / COMPANY.perDayShare));

export function weekStartUtc(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7;
  return new Date(x.getTime() - dow * 864e5);
}
export function weekKey(d: Date): string {
  const ws = weekStartUtc(d);
  const thursday = new Date(ws.getTime() + 3 * 864e5);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface PlanEmployee { accountId: string; tz: string; quota: number; topics: string[]; preferred: string[] }
export interface PlannedSlot { accountId: string; at: Date; tag: string | null }
export interface NewSlot extends PlannedSlot { slotKey: string }

/**
 * Недельный план: разнос постов сотрудников компании во времени и по темам.
 * existing: уже запланированные и опубликованные посты компании (все сотрудники), включая эту неделю.
 */
export function planWeek(o: { weekStart: Date; employees: PlanEmployee[]; existing: PlannedSlot[]; companyEmployees: number; now: Date; seed: string }): NewSlot[] {
  const cap = maxCompanyPostsPerDay(o.companyEmployees);
  const all: PlannedSlot[] = [...o.existing];
  const out: NewSlot[] = [];
  const wk = weekKey(o.weekStart);
  const weekEnd = o.weekStart.getTime() + 7 * 864e5;
  const inWeek = (s: PlannedSlot) => s.at.getTime() >= o.weekStart.getTime() && s.at.getTime() < weekEnd;
  const order = [...o.employees].sort((a, b) => all.filter((s) => s.accountId === a.accountId && inWeek(s)).length - all.filter((s) => s.accountId === b.accountId && inWeek(s)).length || a.accountId.localeCompare(b.accountId));
  for (const e of order) {
    let have = all.filter((s) => s.accountId === e.accountId && inWeek(s)).length;
    let n = have;
    while (have < e.quota && n < e.quota + 3) {
      n++;
      const slot = findSlot(o, e, all, cap, `${o.seed}:${e.accountId}:${wk}:${n}`);
      if (!slot) break;
      const s = { accountId: e.accountId, at: slot.at, tag: slot.tag, slotKey: `${wk}:${n}` };
      if (all.some((x) => x.accountId === e.accountId && Math.abs(x.at.getTime() - s.at.getTime()) < 6e4)) continue;
      out.push(s); all.push(s); have++;
    }
  }
  return out;
}

function localDateOf(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function findSlot(o: { weekStart: Date; now: Date }, e: PlanEmployee, all: PlannedSlot[], cap: number, seed: string): { at: Date; tag: string | null } | null {
  const own = all.filter((s) => s.accountId === e.accountId).sort((a, b) => b.at.getTime() - a.at.getTime());
  const recentOwnTags = own.slice(0, 2).map((s) => s.tag);
  const jitter = seededJitter(seed, 25);
  const shift = seededJitter(seed + ":d", COMPANY.weekdays.length);
  const days = [...COMPANY.weekdays.slice(shift), ...COMPANY.weekdays.slice(0, shift)];
  for (const d of days) {
    const date = new Date(o.weekStart.getTime() + d * 864e5 + 12 * 36e5).toISOString().slice(0, 10);
    for (const lt of COMPANY.localSlots) {
      const r = resolveLocal(`${date}T${lt}`, e.tz);
      if (r.kind !== "ok") continue;
      const at = new Date(r.utc.getTime() + jitter * 6e4);
      if (at.getTime() < o.now.getTime() + COMPANY.leadHours * 36e5) continue;
      const day = localDateOf(at, e.tz);
      if (all.filter((s) => localDateOf(s.at, e.tz) === day).length >= cap) continue;
      if (all.some((s) => Math.abs(s.at.getTime() - at.getTime()) < COMPANY.minGapMinutes * 6e4)) continue;
      if (own.some((s) => Math.abs(s.at.getTime() - at.getTime()) < COMPANY.ownGapDays * 864e5)) continue;
      const near = all.filter((s) => s.accountId !== e.accountId && Math.abs(s.at.getTime() - at.getTime()) < COMPANY.topicCooldownDays * 864e5).map((s) => s.tag);
      const pool = e.preferred.length ? [...e.preferred, ...e.topics.filter((t) => !e.preferred.includes(t))] : e.topics;
      // Тема: свободная у коллег в ближайшие дни; иначе самая давно использованная. Одна тема у двух сотрудников в один день запрещена.
      const sameDay = all.filter((s) => s.accountId !== e.accountId && localDateOf(s.at, e.tz) === day).map((s) => s.tag);
      const usable = pool.filter((t) => !sameDay.includes(t));
      if (pool.length && !usable.length) continue;
      const tag = usable.find((t) => !near.includes(t) && !recentOwnTags.includes(t)) ?? usable.find((t) => !near.includes(t))
        ?? [...usable].sort((a, b) => near.filter((x) => x === a).length - near.filter((x) => x === b).length)[0] ?? null;
      return { at, tag };
    }
  }
  return null;
}

/* ---------- Черновик без внешней модели (демо и запасной режим) ---------- */
const RU = {
  hook: ["Короткий разбор из нашей практики.", "Одна вещь, которую я понял за последний год.", "Делюсь опытом, который пригодится командам."],
  worked: "Что сработало:", lesson: "Что я сделал бы иначе:", q: ["А как это устроено у вас?", "Интересно сравнить подходы: что выбрали бы вы?", "Какие подводные камни видели вы?"],
  news: "Мы выпустили новость, и вот почему для меня это важно.",
};
const EN = {
  hook: ["A short breakdown from our practice.", "One thing I learned this year.", "Sharing an experience that may help other teams."],
  worked: "What worked:", lesson: "What I would do differently:", q: ["How does your team handle this?", "Curious how others approach it.", "What pitfalls have you seen?"],
  news: "We just shared some news, and here is why it matters to me.",
};
/** Пост только из фактов, которые сотрудник сам сообщил в интервью. Без фактов текста нет. */
export function composePost(o: { passport: Passport; topic: string; claims: string[]; kind: "post" | "company_news"; sourceUrl?: string | null; disclosure?: string | null; seed: string }): string | null {
  if (!o.claims.length) return null;
  const L = o.passport.language === "en" ? EN : RU;
  const pick = <T,>(xs: T[], salt: string) => xs[seededJitter(o.seed + salt, xs.length)];
  const c1 = pick(o.claims, ":c1");
  const rest = o.claims.filter((c) => c !== c1);
  const c2 = rest.length ? pick(rest, ":c2") : null;
  const parts: string[] = [];
  if (o.kind === "company_news") {
    parts.push(L.news, c1);
    if (o.sourceUrl) parts.push(o.sourceUrl);
  } else {
    parts.push(pick(L.hook, ":h"), c1);
    if (c2 && o.passport.tone.length !== "short") parts.push(`${o.passport.formats[0] === "lesson" ? L.lesson : L.worked} ${c2}`);
    if (o.passport.phrases.length) parts.push(pick(o.passport.phrases, ":p"));
    parts.push(pick(L.q, ":q"));
  }
  const tag = `#${o.topic.replace(/[^\p{L}\p{N}]/gu, "")}`;
  let text = `${parts.join("\n\n")}\n\n${tag}`;
  if (o.disclosure) text += ` ${o.disclosure}`;
  return text;
}

/* ---------- Подпись кнопок Telegram ---------- */
export function signCallback(secret: string, action: string, ref: string, chatId: string): string {
  return createHmac("sha256", secret).update(`${action}|${ref}|${chatId}`).digest("hex").slice(0, 16);
}
export function verifyCallback(secret: string, action: string, ref: string, chatId: string, sig: string): boolean {
  const exp = Buffer.from(signCallback(secret, action, ref, chatId));
  const got = Buffer.from(sig ?? "");
  return exp.length === got.length && timingSafeEqual(exp, got);
}
