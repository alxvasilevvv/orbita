import { z } from "zod";

/**
 * AI-помощники: структурированный результат, без доступа к токенам и публикации.
 * Внешний текст передаётся только как данные внутри разделителей; инструкции в нём не исполняются.
 */
export const AI_ROLES = ["strategist", "author", "editor", "fact_checker", "analyst", "planner", "engagement", "reporter"] as const;

export const AiOutputSchema = z.object({
  account_id: z.string(),
  task_type: z.enum(["content_draft", "editorial_review", "fact_check", "report_draft", "engagement_suggestion"]),
  objective: z.string(),
  draft: z.string(),
  source_ids: z.array(z.string()),
  unverified_claims: z.array(z.string()),
  risk_flags: z.array(z.string()),
  review_notes: z.array(z.string()),
  requires_approval: z.literal(true),
});
export type AiOutput = z.infer<typeof AiOutputSchema>;

export interface AiContextSource { id: string; account_id: string; client_id: string; title: string; body: string; usage_rights: string }

/** Собирает минимальный контекст строго одного аккаунта; чужие источники отбрасываются с ошибкой. */
export function buildIsolatedContext(accountId: string, clientId: string, sources: AiContextSource[]) {
  for (const s of sources) {
    if (s.account_id !== accountId || s.client_id !== clientId) throw new Error(`Изоляция: источник ${s.id} принадлежит другому аккаунту`);
  }
  return sources.filter((s) => s.usage_rights === "internal_and_ai");
}

const INJECTION_PATTERNS = [
  /ignore (all|previous|prior) instructions/i,
  /игнорируй (все |предыдущие )?инструкции/i,
  /\b(publish|опубликуй|post this|delete)\b.*\b(now|сейчас|immediately|немедленно)\b/i,
  /system prompt|системн(ый|ые) промпт/i,
  /you are now|теперь ты/i,
];

export function detectInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter((r) => r.test(text)).map((r) => `Возможная инструкция внутри данных: ${r.source}`);
}

export function wrapUntrusted(id: string, text: string): string {
  return `<untrusted_source id="${id}">\n${text.replaceAll("</untrusted_source>", "")}\n</untrusted_source>`;
}

/** Действия, которые AI вообще может запросить. Публикации и внешних действий нет. */
export const AI_ALLOWED_ACTIONS = new Set(["propose_draft", "propose_review_notes", "ask_client_question", "propose_task"]);

export function filterAiActions(requested: string[]): { allowed: string[]; rejected: string[] } {
  return { allowed: requested.filter((a) => AI_ALLOWED_ACTIONS.has(a)), rejected: requested.filter((a) => !AI_ALLOWED_ACTIONS.has(a)) };
}

export interface AiProvider {
  name: string;
  model: string;
  generate(input: { role: string; promptVersion: string; system: string; user: string; accountId: string }): Promise<{ output: AiOutput; costUsd: number | null }>;
}

/**
 * Демо-провайдер: детерминированный черновик-заготовка из подтверждённых фактов.
 * Явно помечен; не выдаёт себя за реальную модель.
 */
export class DemoAiProvider implements AiProvider {
  name = "demo";
  model = "demo-template-v1";
  async generate(input: { role: string; promptVersion: string; system: string; user: string; accountId: string }) {
    const claims = [...input.user.matchAll(/<claim id="([^"]+)">([^<]+)<\/claim>/g)];
    const objective = /objective: (\S+)/.exec(input.user)?.[1] ?? "professional_authority";
    const topic = /topic: (.+)/.exec(input.user)?.[1] ?? "тема";
    const body = claims.length
      ? `[DEMO AI ЧЕРНОВИК] ${topic}\n\n${claims.map((c) => c[2]).join("\n\n")}\n\n[Вопрос к читателю: требуется редактор]`
      : `[DEMO AI ЧЕРНОВИК] ${topic}\n\n[НУЖНО ОТ КЛИЕНТА: подтверждённый пример или факт по теме]`;
    const output: AiOutput = {
      account_id: input.accountId, task_type: "content_draft", objective, draft: body,
      source_ids: claims.map((c) => c[1]),
      unverified_claims: [],
      risk_flags: claims.length ? [] : ["missing_verified_facts"],
      review_notes: claims.length ? ["Проверьте голос клиента"] : ["Нет подтверждённых фактов: черновик заблокирован до ответа клиента"],
      requires_approval: true,
    };
    return { output, costUsd: 0 };
  }
}

/** Внутренние пометки вида [НУЖНО ОТ КЛИЕНТА: ...] блокируют публикацию. */
export function blockingNotes(body: string): string[] {
  return [...body.matchAll(/\[(НУЖНО ОТ КЛИЕНТА|TODO|ПРОВЕРИТЬ|DEMO AI)[^\]]*\]/g)].map((m) => m[0]);
}
