import { z } from "zod";
import { accountScope, audit, requireOp, ValidationError, visibleAccountsFilter, type Ctx } from "./context";
import { activeStrategy } from "./accounts";
import { resolveLocal } from "../core/time";
import { median } from "../core/metrics";
import { STRATEGY_TEMPLATES } from "../core/templates";

const WEEKDAYS: Record<string, number> = { пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
export function parseWindow(w: string): { weekday: number; hh: number; mm: number } | null {
  const m = /^\s*([А-Яа-яA-Za-z]{2,3})\s+(\d{1,2}):(\d{2})\s*$/.exec(w);
  if (!m) return null;
  const wd = WEEKDAYS[m[1].toLowerCase()];
  if (wd === undefined) return null;
  return { weekday: wd, hh: Number(m[2]), mm: Number(m[3]) };
}

/** Распределение направлений по квотам методом наибольших остатков, с чередованием. */
export function distribute(pillars: { name: string; share: number }[], n: number): string[] {
  const total = pillars.reduce((s, p) => s + p.share, 0) || 1;
  const exact = pillars.map((p) => ({ name: p.name, q: (p.share / total) * n }));
  const counts = exact.map((e) => ({ name: e.name, c: Math.floor(e.q), r: e.q - Math.floor(e.q) }));
  let left = n - counts.reduce((s, c) => s + c.c, 0);
  for (const c of [...counts].sort((a, b) => b.r - a.r)) { if (left <= 0) break; c.c++; left--; }
  const out: string[] = [];
  const rem = counts.map((c) => ({ ...c }));
  let last = "";
  while (out.length < n) {
    const pick = rem.filter((c) => c.c > 0).sort((a, b) => (a.name === last ? 1 : 0) - (b.name === last ? 1 : 0) || b.c - a.c)[0];
    if (!pick) break;
    out.push(pick.name); pick.c--; last = pick.name;
  }
  return out;
}

const PlanInput = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  events: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), title: z.string().min(1), time: z.string().regex(/^\d{2}:\d{2}$/).optional() })).default([]),
  dry_run: z.boolean().default(true),
});

/**
 * Алгоритм календаря: события → направления → разнообразие форматов → запас на согласование →
 * стартовые окна → проверка конфликтов. Время — согласованная гипотеза, а не «лучшее время».
 */
export async function planMonth(ctx: Ctx, accountId: string, input: unknown, now = new Date()) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "create_content", { clientId: a.client_id, accountId });
  const d = PlanInput.parse(input);
  const strategy = await activeStrategy(ctx.db, accountId);
  if (!strategy) throw new ValidationError("Нет утверждённой стратегии: план месяца строится из неё");
  const pb = strategy.playbook;
  const sla = (await ctx.db.query("SELECT approval_sla_hours FROM clients WHERE id = $1", [a.client_id])).rows[0]?.approval_sla_hours ?? 48;
  const leadMs = Math.max(72, sla + 48) * 3600_000;
  const earliest = new Date(now.getTime() + leadMs);

  const [y, m] = d.month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const windows = (pb.posting_windows ?? []).map(parseWindow).filter(Boolean) as { weekday: number; hh: number; mm: number }[];
  const usedWindows = windows.length ? windows : [{ weekday: 2, hh: 9, mm: 0 }, { weekday: 4, hh: 9, mm: 0 }];
  const notes: string[] = [];
  if (!windows.length) notes.push("Окна публикации не заданы: использована гипотеза вт и чт 09:00 местного времени аккаунта");

  // Существующие материалы аккаунта на этот месяц (конфликты по дате).
  const busy = new Set((await ctx.db.query(
    `SELECT to_char(coalesce(scheduled_at, planned_for) AT TIME ZONE $2, 'YYYY-MM-DD') AS d FROM content_items
      WHERE account_id = $1 AND state NOT IN ('cancelled','archived') AND coalesce(scheduled_at, planned_for) IS NOT NULL`, [accountId, a.timezone])).rows.map((r: any) => r.d));

  const slots: { local: string; utc: Date; title: string; pillar: string | null; format: string; campaign: string | null; reason: string }[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  // 1. Обязательные события.
  for (const ev of d.events) {
    const local = `${ev.date}T${ev.time ?? `${pad(usedWindows[0].hh)}:${pad(usedWindows[0].mm)}`}`;
    const r = resolveLocal(local, a.timezone);
    const utc = r.kind === "ok" ? r.utc : r.kind === "ambiguous" ? r.earlierUtc : r.suggestedUtc;
    if (utc < earliest) { notes.push(`Событие «${ev.title}» раньше, чем успевает пройти согласование`); }
    slots.push({ local, utc, title: ev.title, pillar: null, format: "text", campaign: ev.title, reason: "обязательное событие" });
    busy.add(ev.date);
  }
  // 2. Кандидаты по окнам.
  const candidates: { local: string; utc: Date; date: string }[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${y}-${pad(m)}-${pad(day)}`;
    const wd = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    for (const w of usedWindows.filter((x) => x.weekday === wd)) {
      const local = `${date}T${pad(w.hh)}:${pad(w.mm)}`;
      const r = resolveLocal(local, a.timezone);
      if (r.kind === "gap") { notes.push(`${local}: время не существует из-за перехода часов, слот пропущен`); continue; }
      const utc = r.kind === "ok" ? r.utc : r.earlierUtc;
      if (utc < earliest) continue;
      if (busy.has(date)) continue;
      candidates.push({ local, utc, date });
    }
  }
  const target = Math.max(0, Math.round((Number(pb.posts_per_week) * daysInMonth) / 7) - d.events.length);
  // Равномерный выбор из кандидатов.
  const chosen = candidates.length <= target ? candidates : Array.from({ length: target }, (_, i) => candidates[Math.floor((i * candidates.length) / target)]);
  if (chosen.length < target) notes.push(`Свободных окон меньше плана: ${chosen.length} из ${target}. Добавьте окна или сократите частоту`);
  // 3. Направления и форматы.
  const tpl = STRATEGY_TEMPLATES[strategy.template];
  const matrix = tpl?.content_matrix.filter((c) => (pb.pillars as string[]).includes(c.pillar));
  const pillars = matrix?.length === pb.pillars.length ? matrix.map((c) => ({ name: c.pillar, share: c.share })) : (pb.pillars as string[]).map((p) => ({ name: p, share: 1 }));
  const order = distribute(pillars, chosen.length);
  const formats: string[] = pb.formats?.length ? pb.formats : ["text"];
  const fmtCounter: Record<string, number> = {};
  chosen.forEach((c, i) => {
    const pillar = order[i];
    const pf = matrix?.find((x) => x.pillar === pillar)?.formats.filter((f) => formats.includes(f)) ?? formats;
    const list = pf.length ? pf : formats;
    const k = (fmtCounter[pillar] = (fmtCounter[pillar] ?? 0) + 1);
    slots.push({ local: c.local, utc: c.utc, title: `Идея: ${pillar}`, pillar, format: list[(k - 1) % list.length], campaign: null, reason: "окно публикации из стратегии" });
  });
  slots.sort((p, q) => +p.utc - +q.utc);
  notes.push("Время публикации — стартовая гипотеза, согласованная с клиентом. Статистически лучшее время на малой выборке не определяется");

  let created = 0;
  if (!d.dry_run) {
    await ctx.db.tx(async (q) => {
      for (const s of slots) {
        await q.query(
          "INSERT INTO content_items(client_id, account_id, title, pillar, format, campaign, planned_for, author_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [a.client_id, accountId, s.title, s.pillar, ["text", "image", "multi_image", "document", "video", "article"].includes(s.format) ? s.format : "text", s.campaign, s.utc.toISOString(), null]);
        created++;
      }
      await audit(q, ctx, { action: "calendar.month_planned", entity_type: "managed_account", entity_id: accountId, client_id: a.client_id, account_id: accountId, details: { month: d.month, slots: created } });
    });
  }
  return { month: d.month, timezone: a.timezone, slots: slots.map((s) => ({ ...s, utc: s.utc.toISOString() })), created, notes };
}

/** Календарь: запланированные, плановые и опубликованные материалы видимых аккаунтов. */
export async function getCalendar(ctx: Ctx, f: { from: string; to: string; account_id?: string }) {
  const from = new Date(f.from), to = new Date(f.to);
  if (isNaN(+from) || isNaN(+to) || +to - +from > 93 * 864e5) throw new ValidationError("Период не более 3 месяцев");
  const vis = visibleAccountsFilter(ctx, "a", 4);
  const params: unknown[] = [ctx.actor.agency_id, from.toISOString(), to.toISOString(), ...vis.params];
  let extra = "";
  if (f.account_id) { await accountScope(ctx.db, ctx, f.account_id); params.push(f.account_id); extra = ` AND a.id = $${params.length}`; }
  return (await ctx.db.query(`
    SELECT ci.id, ci.title, ci.state, ci.pillar, ci.format, ci.campaign, ci.scheduled_tz,
           coalesce(ep.published_at, ci.scheduled_at, ci.planned_for) AS at,
           CASE WHEN ep.id IS NOT NULL THEN 'published' WHEN ci.scheduled_at IS NOT NULL THEN 'scheduled' ELSE 'planned' END AS kind,
           ep.evidence_type, a.id AS account_id, a.display_name AS account_name, a.timezone, c.name AS client_name
      FROM content_items ci JOIN managed_accounts a ON a.id = ci.account_id JOIN clients c ON c.id = a.client_id
      LEFT JOIN external_publications ep ON ep.content_item_id = ci.id
     WHERE c.agency_id = $1 AND ${vis.sql}${extra} AND ci.state NOT IN ('cancelled','archived')
       AND coalesce(ep.published_at, ci.scheduled_at, ci.planned_for) BETWEEN $2 AND $3
     ORDER BY at LIMIT 2000`, params)).rows;
}

/** Сравнение временных окон на накопленных данных, с пометкой малых выборок. */
export async function windowStats(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "view", { clientId: a.client_id, accountId });
  const rows = (await ctx.db.query(`
    SELECT ep.content_item_id, to_char(ep.published_at AT TIME ZONE $2, 'ID') AS dow, to_char(ep.published_at AT TIME ZONE $2, 'HH24') AS hh,
           (SELECT ms.value::float FROM metric_snapshots ms WHERE ms.content_item_id = ep.content_item_id AND ms.metric_key = 'impressions' AND ms.value IS NOT NULL ORDER BY observed_at DESC LIMIT 1) AS impressions
      FROM external_publications ep WHERE ep.account_id = $1 AND ep.published_at < now() - interval '7 days'`, [accountId, a.timezone])).rows;
  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    if (r.impressions == null) continue;
    const k = `${["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"][Number(r.dow)]} ${r.hh}:00`;
    buckets.set(k, [...(buckets.get(k) ?? []), r.impressions]);
  }
  return {
    note: "Сравниваются только публикации старше 7 дней с известными показами. Это наблюдение, а не доказанная причина.",
    windows: [...buckets.entries()].map(([window, xs]) => ({ window, n: xs.length, median_impressions: median(xs), small_sample: xs.length < 5 })).sort((x, y) => y.n - x.n),
    posts_without_data: rows.filter((r: any) => r.impressions == null).length,
  };
}
