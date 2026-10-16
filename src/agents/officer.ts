import type { Queryable } from "../db/db";
import {
  allowedByRisk, checkText, disclosureMissing, limitsFor, quotaReasons, regulatedReasons, riskScore,
  type ActionKind, type RiskResult, type SafetyState,
} from "../core/safety";

/**
 * Офицер безопасности: проверяет каждое действие дважды, перед предложением и перед исполнением.
 * Счётчики считаются внутри транзакции под блокировкой аккаунта (pg_advisory_xact_lock),
 * поэтому два параллельных планировщика или исполнителя не пробьют лимит (урок плейбука #4).
 * Право вето без права разрешить сверх правил.
 */
export const CONSENT_FOR: Record<ActionKind, string> = { react: "react", comment: "comment", repost_note: "publish_post", post: "publish_post" };
const ACTIVE = ["awaiting_owner", "approved", "executing", "done", "unknown"];
/** При одобрении и исполнении считаются только обязательства; при предложении резервируют и ожидающие ответа. */
const COMMITTED = ["approved", "executing", "done", "unknown"];

export async function lockAccount(q: Queryable, accountId: string) {
  await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`acct:${accountId}`]);
}

export async function loadSafety(q: Queryable, accountId: string): Promise<SafetyState & { clientId: string }> {
  const r = (await q.query(`
    SELECT a.id, a.client_id, s.ramp_started_at, s.cooldown_until, s.half_until, coalesce(s.excluded, false) AS excluded,
           p.frequency, p.paused_until, p.self_reported_activity,
           EXISTS (SELECT 1 FROM oauth_connections o WHERE o.account_id = a.id AND o.status IN ('error','expired')) AS connection_error,
           coalesce((SELECT array_agg(e.occurred_at) FROM safety_events e WHERE e.account_id = a.id AND e.occurred_at > now() - interval '30 days'
                      AND e.kind IN ('warning','captcha','restriction','identity_check','throttled','comment_hidden')
                      -- после разбора и восстановления агентством прежние сигналы не учитываются повторно
                      AND e.occurred_at > coalesce((SELECT max(r.occurred_at) FROM safety_events r WHERE r.account_id = a.id AND r.kind = 'restored'), '-infinity')), '{}') AS warnings
      FROM managed_accounts a LEFT JOIN account_safety s ON s.account_id = a.id LEFT JOIN employee_profiles p ON p.account_id = a.id
     WHERE a.id = $1`, [accountId])).rows[0];
  if (!r) throw new Error("Аккаунт не найден");
  const d = (x: any) => (x ? new Date(x) : null);
  return {
    clientId: r.client_id,
    rampStartedAt: d(r.ramp_started_at) ?? new Date(),
    cooldownUntil: d(r.cooldown_until), halfUntil: d(r.half_until), excluded: r.excluded,
    warningsAt: (r.warnings ?? []).map((w: any) => new Date(w)),
    connectionError: r.connection_error, pausedUntil: d(r.paused_until), frequency: r.frequency ?? "weekly",
    selfReportedActivity: r.self_reported_activity ?? null,
  };
}

/**
 * Наибольшее число действий в любом скользящем окне длины w, которое содержит момент t.
 * Так действие в 23:50 и в 00:05 попадают в одно окно, а лимит не удваивается на границе суток.
 */
export function maxInWindow(times: number[], t: number, w: number) {
  const starts = [t - w + 1, ...times.filter((x) => x > t - w && x <= t)];
  let max = 0;
  for (const s of starts) max = Math.max(max, times.filter((x) => x >= s && x < s + w).length);
  return max;
}

/** Использование в скользящих окнах 60 мин, 24 ч и 7 дней, содержащих момент t. */
export async function usageAround(q: Queryable, accountId: string, kind: ActionKind, t: Date, excludeActionId?: string, phase: "propose" | "commit" = "propose") {
  const times = (await q.query(`
    SELECT coalesce(done_at, scheduled_at) AS x FROM mission_actions
     WHERE account_id = $1 AND kind = $2 AND status = ANY($4::text[]) AND ($5::uuid IS NULL OR id <> $5::uuid)
       AND coalesce(done_at, scheduled_at) > $3::timestamptz - interval '7 days' AND coalesce(done_at, scheduled_at) < $3::timestamptz + interval '7 days'`,
    [accountId, kind, t.toISOString(), phase === "propose" ? ACTIVE : COMMITTED, excludeActionId ?? null])).rows.map((r: any) => new Date(r.x).getTime());
  const at = t.getTime();
  return { hour: maxInWindow(times, at, 36e5), day: maxInWindow(times, at, 864e5), week: maxInWindow(times, at, 7 * 864e5) };
}

export interface Verdict { veto: string[]; warn: string[]; risk: RiskResult; mode: string }

export interface ProposeInput {
  accountId: string; kind: ActionKind; at: Date; missionId: string; targetUrl: string | null;
  text?: string | null; industry: string; complianceApproved: boolean; disclosureMode: "profile" | "inline"; disclosureText: string;
  excludeActionId?: string; requireAiConsent?: boolean;
  /** propose: планирование (резерв под ожидающие); commit: одобрение и исполнение. */
  phase?: "propose" | "commit";
}

/** Полная проверка действия. Вызывать внутри транзакции после lockAccount. */
export async function check(q: Queryable, i: ProposeInput, now: Date): Promise<Verdict> {
  const s = await loadSafety(q, i.accountId);
  const lim = limitsFor(s, i.kind, i.at);
  // Частота запросов сотруднику проверяется под той же блокировкой: две параллельные миссии не дадут двух запросов за период.
  let frequencyHit = false;
  if ((i.phase ?? "propose") === "propose") {
    const days = s.frequency === "biweekly" ? 14 : 7;
    const other = (await q.query("SELECT count(DISTINCT mission_id)::int n FROM mission_actions WHERE account_id = $1 AND mission_id <> $2 AND created_at > $3::timestamptz - make_interval(days => $4::int)",
      [i.accountId, i.missionId, now.toISOString(), days])).rows[0].n;
    frequencyHit = other > 0;
  }
  const used = await usageAround(q, i.accountId, i.kind, i.at, i.excludeActionId, i.phase ?? "propose");
  const usedRatio = lim.day ? used.day / lim.day : 1;
  const risk = riskScore({ state: s, now, usedRatio });
  const veto: string[] = [];
  const warn: string[] = [];
  if (frequencyHit) veto.push("frequency");
  if (lim.mode === "blocked") veto.push(s.cooldownUntil && s.cooldownUntil > i.at ? "cooldown" : s.excluded ? "excluded" : "paused_by_owner");
  else veto.push(...quotaReasons(lim, used));
  if (!allowedByRisk(risk.level, i.kind)) veto.push(`risk_${risk.level}`);
  const consent = (await q.query("SELECT 1 FROM consents WHERE account_id = $1 AND action_scope = $2 AND revoked_at IS NULL AND paused_at IS NULL", [i.accountId, CONSENT_FOR[i.kind]])).rows.length;
  if (!consent) veto.push(`no_consent_${CONSENT_FOR[i.kind]}`);
  const c = (await q.query("SELECT c.engagement_paused_at, a.publishing_paused, a.status FROM managed_accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = $1", [i.accountId])).rows[0];
  if (c.engagement_paused_at) veto.push("company_paused");
  if (c.publishing_paused || c.status === "paused") veto.push("account_paused");
  // Одно действие на одну цель от аккаунта в сутки и запрет взаимной поддержки между клиентами агентства.
  if (i.targetUrl) {
    const same = (await q.query(`SELECT count(*)::int n FROM mission_actions ma JOIN agent_missions m ON m.id = ma.mission_id
       WHERE ma.account_id = $1 AND m.target_url = $2 AND ma.status = ANY($3::text[]) AND ma.mission_id <> $4 AND coalesce(ma.done_at, ma.scheduled_at) > $5::timestamptz - interval '24 hours'`,
      [i.accountId, i.targetUrl, ACTIVE, i.missionId, i.at.toISOString()])).rows[0].n;
    if (same) veto.push("same_target_24h");
    const other = (await q.query("SELECT target_is_other_managed_account($1, $2, NULL) AS hit", [i.accountId, i.targetUrl])).rows[0].hit;
    if (other) veto.push("cross_client_target");
  }
  if (i.text) {
    const others = (await q.query(`
      (SELECT coalesce(final_text, proposed_text) AS t FROM mission_actions WHERE mission_id = $1 AND account_id <> $2 AND coalesce(final_text, proposed_text) IS NOT NULL)
      UNION ALL (SELECT coalesce(final_text, proposed_text) FROM mission_actions WHERE account_id = $2 AND status = 'done' AND coalesce(final_text, proposed_text) IS NOT NULL ORDER BY done_at DESC LIMIT 30)
      UNION ALL (SELECT coalesce(final_text, proposed_text) FROM mission_actions WHERE status IN ('approved','done') AND account_id <> $2 AND created_at > now() - interval '90 days' AND coalesce(final_text, proposed_text) IS NOT NULL ORDER BY created_at DESC LIMIT 500)`,
      [i.missionId, i.accountId])).rows.map((r: any) => r.t as string);
    const tc = checkText(i.text, i.kind, others);
    veto.push(...tc.block); warn.push(...tc.warn);
    veto.push(...regulatedReasons(i.text, i.industry, i.complianceApproved).map((x) => `regulated_${x}`));
    if (i.kind !== "react" && disclosureMissing(i.text, i.disclosureMode, i.disclosureText, i.industry)) veto.push("disclosure_missing");
  }
  return { veto: [...new Set(veto)], warn, risk, mode: lim.mode };
}

/** Тексты причин вето для интерфейса. */
export const VETO_RU: Record<string, string> = {
  cooldown: "Аккаунт на охлаждении после сигнала LinkedIn",
  excluded: "Аккаунт исключён из миссий до решения менеджера",
  paused_by_owner: "Сотрудник поставил паузу",
  limit_hour: "Достигнут часовой лимит",
  limit_day: "Достигнут суточный лимит",
  limit_week: "Достигнут недельный лимит",
  risk_medium: "Средний риск: разрешены только реакции",
  risk_high: "Высокий риск: действия не предлагаются",
  risk_blocked: "Действия заблокированы",
  no_consent_react: "Нет согласия на реакции",
  no_consent_comment: "Нет согласия на комментарии",
  no_consent_publish_post: "Нет согласия на публикации",
  company_paused: "Активность компании остановлена",
  account_paused: "Публикация аккаунта приостановлена",
  same_target_24h: "Аккаунт уже взаимодействовал с этим постом за сутки",
  cross_client_target: "Цель недоступна по правилам агентства",
  too_short: "Текст короче 8 слов",
  template_phrase: "Шаблонная фраза",
  link_in_comment: "Ссылки в комментариях запрещены",
  mentions: "Слишком много упоминаний",
  similar_text: "Текст слишком похож на другой комментарий",
  similar_text_warn: "Текст похож на другой комментарий: лучше переформулировать",
  regulated_return_promise: "Обещание доходности запрещено",
  regulated_fomo: "Давление и FOMO запрещены",
  regulated_past_performance: "Прошлая доходность без оговорки",
  regulated_call_to_deposit: "Призыв к депозиту или регистрации",
  regulated_needs_compliance: "Нужно утверждение compliance клиента",
  disclosure_missing: "Нет раскрытия связи с работодателем",
  not_verified: "Трудоустройство не подтверждено",
  frequency: "Сотрудник уже получал запрос в этот период",
  no_slot: "Нет подходящего окна времени",
  approved_text_changed: "Текст изменился после одобрения",
  mission_inactive: "Миссия не активна",
  missing_verified_facts: "Нет подтверждённых фактов сотрудника: текст пишет он сам",
  ai_not_allowed_external_post: "К чужому посту AI черновик не готовит",
  no_ai_consent: "Сотрудник не разрешил AI-черновики",
  unverified_numbers: "Цифры без подтверждённого источника",
};
