import { z } from "zod";
import type { Db } from "../db/db";
import { accountScope, audit, ConflictError, emit, NotFoundError, requireOp, ValidationError, type Ctx } from "./context";
import { median } from "../core/metrics";

const MIN_SAMPLE = 5;
const MAX_RECOMMENDATIONS = 3;

interface PostObs { id: string; pillar: string | null; format: string; impressions: number | null; interactions: number | null; age_days: number; obs_days: number | null }

/** Квартили и выбросы по правилу 1.5 IQR. */
export function outliers(xs: number[]) {
  if (xs.length < 4) return { lo: -Infinity, hi: Infinity };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => { const i = (s.length - 1) * p; const f = Math.floor(i); return s[f] + (s[Math.ceil(i)] - s[f]) * (i - f); };
  const iqr = q(0.75) - q(0.25);
  return { lo: q(0.25) - 1.5 * iqr, hi: q(0.75) + 1.5 * iqr };
}

/**
 * Еженедельный анализ (п. 16): полнота данных → сопоставимые публикации → группы →
 * медианы → малые выборки и выбросы → не более трёх изменений → стратегу.
 * Использует только ручные и клиентские данные, пока использование API-данных для рекомендаций не подтверждено.
 */
export async function weeklyAnalysis(db: Db, accountId: string, now = new Date()) {
  const allowApi = process.env.LINKEDIN_DATA_AI_ALLOWED === "1";
  const acc = (await db.query("SELECT id, client_id FROM managed_accounts WHERE id = $1", [accountId])).rows[0];
  if (!acc) throw new NotFoundError("Аккаунт не найден");
  const srcFilter = allowApi ? "" : "AND ms.source <> 'linkedin_api'";
  const rows = (await db.query(`
    SELECT ci.id, ci.pillar, ci.format, ep.published_at,
      (SELECT ms.value::float FROM metric_snapshots ms WHERE ms.content_item_id = ci.id AND ms.metric_key = 'impressions' AND ms.value IS NOT NULL ${srcFilter} ORDER BY observed_at DESC LIMIT 1) AS impressions,
      (SELECT extract(epoch FROM max(ms.observed_at) - ep.published_at) / 86400 FROM metric_snapshots ms WHERE ms.content_item_id = ci.id AND ms.metric_key = 'impressions' ${srcFilter}) AS obs_days,
      (SELECT sum(x.v) FROM (SELECT DISTINCT ON (ms.metric_key) ms.value::float AS v FROM metric_snapshots ms WHERE ms.content_item_id = ci.id AND ms.metric_key IN ('reactions','comments','reposts') AND ms.value IS NOT NULL ${srcFilter} ORDER BY ms.metric_key, ms.observed_at DESC) x) AS interactions
      FROM content_items ci JOIN external_publications ep ON ep.content_item_id = ci.id
     WHERE ci.account_id = $1 AND ep.published_at > $2::timestamptz - interval '56 days' AND ep.published_at < $2::timestamptz - interval '7 days'`, [accountId, now.toISOString()])).rows;
  const posts: PostObs[] = rows.map((r: any) => ({ id: r.id, pillar: r.pillar, format: r.format, impressions: r.impressions, interactions: r.interactions, age_days: (now.getTime() - new Date(r.published_at).getTime()) / 864e5, obs_days: r.obs_days == null ? null : Number(r.obs_days) }));
  const withData = posts.filter((p) => p.impressions != null && p.impressions > 0 && p.interactions != null && (p.obs_days ?? 0) >= 7);
  const completeness = posts.length ? withData.length / posts.length : 0;
  const rate = (p: PostObs) => ((p.interactions as number) / (p.impressions as number)) * 100;
  const rates = withData.map(rate);
  const { lo, hi } = outliers(rates);
  const clean = withData.filter((p) => rate(p) >= lo && rate(p) <= hi);
  const excluded = withData.filter((p) => !clean.includes(p)).map((p) => p.id);
  const overall = median(clean.map(rate));
  const groups = (key: "pillar" | "format") => {
    const m = new Map<string, number[]>();
    for (const p of clean) { const k = p[key] ?? "без направления"; m.set(k, [...(m.get(k) ?? []), rate(p)]); }
    return [...m.entries()].map(([name, xs]) => ({ name, n: xs.length, median_rate: median(xs), small_sample: xs.length < MIN_SAMPLE }));
  };
  const byPillar = groups("pillar"), byFormat = groups("format");
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
  const review = new Date(now.getTime() + 28 * 864e5).toISOString().slice(0, 10);
  const recs: { observation: string; data_used: unknown; limitations: string[]; hypothesis: string; proposed_change: string; expected_signal: string }[] = [];
  const baseLimits = [
    "Сравниваются разные публикации в разных условиях: это последовательный эксперимент, а не A/B-тест",
    "Корреляция не доказывает причину",
    ...(excluded.length ? [`Исключены выбросы: ${excluded.length}`] : []),
    ...(allowApi ? [] : ["Данные LinkedIn API не использованы: цели использования для рекомендаций не подтверждены"]),
  ];
  if (posts.length && completeness < 0.6) {
    recs.push({ observation: `Показатели есть у ${withData.length} из ${posts.length} публикаций за 8 недель`, data_used: { posts: posts.length, with_data: withData.length }, limitations: baseLimits,
      hypothesis: "Без полных данных выводы о темах и форматах ненадёжны", proposed_change: "Наладить внесение показателей через 7 дней после публикации, стратегию пока не менять", expected_signal: "Полнота данных не ниже 80% через 4 недели" });
  }
  if (overall != null) {
    for (const [kind, list] of [["направление", byPillar], ["формат", byFormat]] as const) {
      for (const g of list) {
        if (recs.length >= MAX_RECOMMENDATIONS) break;
        if (g.small_sample || g.median_rate == null) continue;
        if (g.median_rate >= overall * 1.3) recs.push({ observation: `${kind === "направление" ? "Направление" : "Формат"} «${g.name}»: медиана взаимодействий ${g.median_rate.toFixed(2)}% против ${overall.toFixed(2)}% по аккаунту (n=${g.n})`, data_used: { group: g, overall_median: overall, n_total: clean.length }, limitations: baseLimits,
          hypothesis: `«${g.name}» интереснее целевой аудитории`, proposed_change: `Увеличить долю ${kind === "направление" ? "направления" : "формата"} «${g.name}» на 4 недели`, expected_signal: `Медиана взаимодействий по «${g.name}» остаётся выше медианы аккаунта при n ≥ ${MIN_SAMPLE}` });
        else if (g.median_rate <= overall * 0.7) recs.push({ observation: `${kind === "направление" ? "Направление" : "Формат"} «${g.name}»: медиана ${g.median_rate.toFixed(2)}% против ${overall.toFixed(2)}% (n=${g.n})`, data_used: { group: g, overall_median: overall, n_total: clean.length }, limitations: baseLimits,
          hypothesis: `Подача «${g.name}» не попадает в вопросы аудитории`, proposed_change: `Пересмотреть угол подачи «${g.name}», не сокращая долю до проверки`, expected_signal: `Рост медианы по «${g.name}» за 4 недели` });
      }
    }
  }
  const small = [...byPillar, ...byFormat].filter((g) => g.small_sample).map((g) => `${g.name} (n=${g.n})`);
  let stored = 0;
  for (const r of recs.slice(0, MAX_RECOMMENDATIONS)) {
    const lim = small.length ? [...r.limitations, `Малые выборки не использовались для выводов: ${small.join(", ")}`] : r.limitations;
    const ins = await db.query(
      `INSERT INTO strategy_recommendations(client_id, account_id, week_start, observation, data_used, limitations, hypothesis, proposed_change, expected_signal, review_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
      [acc.client_id, accountId, weekStart, r.observation, JSON.stringify(r.data_used), lim, r.hypothesis, r.proposed_change, r.expected_signal, review]);
    stored += ins.rows.length;
  }
  return { completeness, posts: posts.length, comparable: clean.length, overall_median_rate: overall, by_pillar: byPillar, by_format: byFormat, excluded_outliers: excluded, recommendations: stored };
}

/** Еженедельный запуск для всех активных аккаунтов с утверждённой стратегией (по понедельникам). */
let lastWeeklyRun = "";
export async function weeklyAnalysisAll(db: Db, now = new Date()) {
  if (now.getUTCDay() !== 1) return { skipped: "не понедельник" };
  const day = now.toISOString().slice(0, 10);
  if (lastWeeklyRun === day) return { skipped: "уже выполнено сегодня" };
  lastWeeklyRun = day;
  const ids = (await db.query("SELECT DISTINCT a.id FROM managed_accounts a JOIN strategy_versions s ON s.account_id = a.id AND s.status = 'approved' WHERE a.status = 'active'")).rows;
  let recs = 0;
  for (const { id } of ids) recs += (await weeklyAnalysis(db, id, now)).recommendations;
  return { accounts: ids.length, recommendations: recs };
}

export async function runAnalysisNow(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "edit_strategy", { clientId: a.client_id, accountId });
  return weeklyAnalysis(ctx.db, accountId);
}

export async function listInsights(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "view", { clientId: a.client_id, accountId });
  const [recommendations, experiments] = await Promise.all([
    ctx.db.query("SELECT * FROM strategy_recommendations WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50", [accountId]).then((r) => r.rows),
    ctx.db.query("SELECT * FROM experiments WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50", [accountId]).then((r) => r.rows),
  ]);
  return { recommendations, experiments };
}

/** Стратег принимает рекомендацию: создаётся последовательный эксперимент и задача обновить стратегию. */
export async function decideRecommendation(ctx: Ctx, id: string, input: unknown) {
  const d = z.object({ decision: z.enum(["accepted", "rejected"]), metric_key: z.string().default("interaction_rate_by_impressions") }).parse(input);
  const r = (await ctx.db.query("SELECT * FROM strategy_recommendations WHERE id = $1", [id])).rows[0];
  if (!r) throw new NotFoundError("Рекомендация не найдена");
  await accountScope(ctx.db, ctx, r.account_id);
  requireOp(ctx, "approve_strategy", { clientId: r.client_id, accountId: r.account_id });
  if (r.status !== "proposed") throw new ConflictError("Рекомендация уже рассмотрена");
  return ctx.db.tx(async (q) => {
    await q.query("UPDATE strategy_recommendations SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1", [id, d.decision, ctx.actor.id]);
    let experiment = null;
    if (d.decision === "accepted") {
      experiment = (await q.query(
        `INSERT INTO experiments(client_id, account_id, recommendation_id, hypothesis, change, metric_key, expected_signal, start_date, review_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,current_date,$8,$9) RETURNING *`,
        [r.client_id, r.account_id, id, r.hypothesis, r.proposed_change, d.metric_key, r.expected_signal, r.review_at, ctx.actor.id])).rows[0];
      await q.query(`INSERT INTO tasks(client_id, account_id, type, title, details, assignee_id, due_at, source_ref, priority, priority_reason)
                     VALUES ($1,$2,'strategy_update',$3,$4,$5, now() + interval '3 days', $6, 0.6, 'Принята рекомендация по стратегии')`,
        [r.client_id, r.account_id, `Обновить стратегию: ${r.proposed_change}`, `${r.observation}\nГипотеза: ${r.hypothesis}\nСигнал: ${r.expected_signal}\nПересмотр: ${r.review_at}\nНовая версия стратегии требует утверждения.`, ctx.actor.id, `rec:${id}`]);
    }
    await audit(q, ctx, { action: `strategy_recommendation.${d.decision}`, entity_type: "strategy_recommendation", entity_id: id, client_id: r.client_id, account_id: r.account_id });
    return { status: d.decision, experiment };
  });
}

export async function concludeExperiment(ctx: Ctx, id: string, input: unknown) {
  const d = z.object({ status: z.enum(["supported", "not_supported", "inconclusive", "stopped"]), conclusion: z.string().min(5) }).parse(input);
  const e = (await ctx.db.query("SELECT * FROM experiments WHERE id = $1", [id])).rows[0];
  if (!e) throw new NotFoundError("Эксперимент не найден");
  await accountScope(ctx.db, ctx, e.account_id);
  requireOp(ctx, "edit_strategy", { clientId: e.client_id, accountId: e.account_id });
  if (e.status !== "running") throw new ConflictError("Эксперимент уже завершён");
  if (d.status === "supported" && new Date(e.review_date) > new Date()) throw new ValidationError("Подтверждать гипотезу до даты пересмотра нельзя: выборка ещё не созрела");
  await ctx.db.query("UPDATE experiments SET status = $2, conclusion = $3 WHERE id = $1", [id, d.status, d.conclusion]);
  await audit(ctx.db, ctx, { action: "experiment.concluded", entity_type: "experiment", entity_id: id, client_id: e.client_id, account_id: e.account_id, details: { status: d.status } });
  return { ok: true };
}
export { emit };
