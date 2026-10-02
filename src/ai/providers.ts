import { AiOutputSchema, DemoAiProvider, type AiOutput, type AiProvider, type AiUsage } from "./guard";

/** Инструкция формата: модель обязана вернуть один JSON-объект по схеме. */
export const JSON_CONTRACT = `Верни только один JSON-объект без пояснений со схемой:
{"account_id": string, "task_type": "content_draft"|"editorial_review"|"fact_check"|"report_draft"|"engagement_suggestion",
 "objective": string, "draft": string, "source_ids": string[], "unverified_claims": string[], "risk_flags": string[],
 "review_notes": string[], "requires_approval": true, "scores": [{"criterion": string, "score": 1-5, "reason": string}]}`;

export function parseAiJson(text: string, accountId: string): AiOutput {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Модель не вернула JSON");
  const raw = JSON.parse(text.slice(start, end + 1));
  const parsed = AiOutputSchema.safeParse({ ...raw, requires_approval: true });
  if (!parsed.success) throw new Error(`Ответ модели не соответствует схеме: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  if (parsed.data.account_id !== accountId) throw new Error("Ответ модели относится к другому аккаунту");
  return parsed.data;
}

function cost(tokensIn: number | null, tokensOut: number | null, env = process.env): number | null {
  const pin = Number(env.AI_PRICE_IN_PER_MTOK), pout = Number(env.AI_PRICE_OUT_PER_MTOK);
  if (!Number.isFinite(pin) || !Number.isFinite(pout) || !env.AI_PRICE_IN_PER_MTOK || tokensIn == null || tokensOut == null) return null;
  return (tokensIn * pin + tokensOut * pout) / 1_000_000;
}

/** Anthropic Messages API. Ключ в ANTHROPIC_API_KEY, модель в AI_MODEL. */
export class AnthropicProvider implements AiProvider {
  name = "anthropic";
  constructor(private apiKey: string, public model: string, private baseUrl = "https://api.anthropic.com", private timeoutMs = 60000) {}
  async generate(input: { role: string; system: string; user: string; accountId: string }) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST", signal: ctrl.signal,
        headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, max_tokens: 2000, system: `${input.system}\n\n${JSON_CONTRACT}`, messages: [{ role: "user", content: input.user }] }),
      });
      if (!r.ok) throw new Error(`AI-провайдер вернул ${r.status}`);
      const data: any = await r.json();
      const text = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      const usage: AiUsage = { tokensIn: data.usage?.input_tokens ?? null, tokensOut: data.usage?.output_tokens ?? null, latencyMs: Date.now() - t0 };
      return { output: parseAiJson(text, input.accountId), costUsd: cost(usage.tokensIn, usage.tokensOut), usage };
    } finally { clearTimeout(timer); }
  }
}

/** OpenAI-совместимый шлюз (LiteLLM, Portkey, Cloudflare AI Gateway и др.). */
export class OpenAiCompatibleProvider implements AiProvider {
  name = "openai_compatible";
  constructor(private apiKey: string, public model: string, private baseUrl: string, private timeoutMs = 60000) {}
  async generate(input: { role: string; system: string; user: string; accountId: string }) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", signal: ctrl.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, response_format: { type: "json_object" }, messages: [{ role: "system", content: `${input.system}\n\n${JSON_CONTRACT}` }, { role: "user", content: input.user }] }),
      });
      if (!r.ok) throw new Error(`AI-шлюз вернул ${r.status}`);
      const data: any = await r.json();
      const usage: AiUsage = { tokensIn: data.usage?.prompt_tokens ?? null, tokensOut: data.usage?.completion_tokens ?? null, latencyMs: Date.now() - t0 };
      return { output: parseAiJson(data.choices?.[0]?.message?.content ?? "", input.accountId), costUsd: cost(usage.tokensIn, usage.tokensOut), usage };
    } finally { clearTimeout(timer); }
  }
}

export function aiProviderFromEnv(env = process.env): AiProvider {
  if (env.AI_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.AI_MODEL ?? "claude-sonnet-5-5");
  if (env.AI_PROVIDER === "openai_compatible" && env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL) return new OpenAiCompatibleProvider(env.AI_API_KEY, env.AI_MODEL, env.AI_BASE_URL);
  return new DemoAiProvider();
}
