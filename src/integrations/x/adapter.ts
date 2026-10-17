import { IntegrationError } from "../linkedin/adapter";

/**
 * X (Twitter) адаптер. Публикация твитов и тредов от имени аккаунта через официальный X API v2
 * (POST /2/tweets, пользовательский OAuth2-токен). Тот же гибрид, что для LinkedIn: сервер публикует
 * посты, более рискованные действия (подписки, личные сообщения, лайки чужого) остаются за человеком.
 */
export interface XPublishRequest { authorId: string; accessToken: string; idempotencyKey: string; text: string; replyToId?: string | null }
export interface XPublishResult { externalId: string; url: string | null }
export interface XLikeRequest { userId: string; accessToken: string; tweetId: string }
export interface XSocialAdapter {
  readonly provider: string;
  readonly isDemo: boolean;
  /** Публикует один твит. Для треда вызывается по цепочке через replyToId. Ответ на чужой твит — тот же вызов с replyToId. */
  publishTweet(req: XPublishRequest): Promise<XPublishResult>;
  /** Лайк твита от имени пользователя (POST /2/users/:id/likes). */
  likeTweet(req: XLikeRequest): Promise<{ liked: boolean }>;
  /** Личность токена: id и username (users/me). */
  me(req: { accessToken: string }): Promise<{ id: string; username: string }>;
}

/** X ограничивает твит 280 символами (без X Premium). Режем по границам слов, тред делаем позже. */
export const X_LIMIT = 280;
export function splitThread(text: string, limit = X_LIMIT): string[] {
  const clean = text.replace(/\r/g, "").trim();
  if (clean.length <= limit) return [clean];
  const words = clean.split(/\s+/);
  const parts: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > limit - 6) { if (cur) parts.push(cur.trim()); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) parts.push(cur.trim());
  const n = parts.length;
  return n > 1 ? parts.map((p, i) => `${p} ${i + 1}/${n}`) : parts;
}

export class XHttpAdapter implements XSocialAdapter {
  provider = "x";
  isDemo = false;
  constructor(private baseUrl = "https://api.twitter.com", private timeoutMs = 30000, private fetchImpl: typeof fetch = fetch) {}
  private async call(path: string, token: string, body?: unknown, method = "POST") {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await this.fetchImpl(`${this.baseUrl}${path}`, { method, signal: ctrl.signal, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 429) throw new IntegrationError("quota", "rate_limited", "X: превышен лимит запросов");
      if (r.status === 401 || r.status === 403) throw new IntegrationError("permanent", "forbidden", `X отклонил запрос (${r.status})`);
      if (!r.ok) throw new IntegrationError("retryable", "http_error", `X вернул ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e instanceof IntegrationError) throw e;
      if ((e as any)?.name === "AbortError") throw new IntegrationError("unknown_outcome", "timeout", "X не ответил вовремя");
      throw new IntegrationError("unknown_outcome", "network", String((e as any)?.message ?? e));
    } finally { clearTimeout(timer); }
  }
  async publishTweet(req: XPublishRequest): Promise<XPublishResult> {
    const body: any = { text: req.text.slice(0, X_LIMIT) };
    if (req.replyToId) body.reply = { in_reply_to_tweet_id: req.replyToId };
    const data: any = await this.call("/2/tweets", req.accessToken, body);
    const id = data?.data?.id;
    if (!id) throw new IntegrationError("unknown_outcome", "no_id", "X не вернул идентификатор твита");
    return { externalId: id, url: `https://x.com/i/web/status/${id}` };
  }
  async likeTweet(req: XLikeRequest): Promise<{ liked: boolean }> {
    const data: any = await this.call(`/2/users/${encodeURIComponent(req.userId)}/likes`, req.accessToken, { tweet_id: req.tweetId });
    return { liked: data?.data?.liked !== false };
  }
  async me(req: { accessToken: string }) {
    const data: any = await this.call("/2/users/me", req.accessToken, undefined, "GET");
    return { id: data?.data?.id ?? "", username: data?.data?.username ?? "" };
  }
}

/** Демо-адаптер: детерминированный id, ничего не отправляет наружу. */
export class DemoXAdapter implements XSocialAdapter {
  provider = "x";
  isDemo = true;
  async publishTweet(req: XPublishRequest): Promise<XPublishResult> {
    const id = `demo${Math.abs([...req.idempotencyKey].reduce((a, c) => Math.imul(a, 31) + c.charCodeAt(0), 7)) % 1e15}`;
    return { externalId: id, url: `https://x.com/i/web/status/${id}` };
  }
  async likeTweet() { return { liked: true }; }
  async me() { return { id: "demo-x-user", username: "demo" }; }
}

export function xAdapterFromEnv(env = process.env): XSocialAdapter {
  return env.X_ADAPTER === "http" ? new XHttpAdapter() : new DemoXAdapter();
}
