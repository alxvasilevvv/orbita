/**
 * Единый контракт интеграции. В первой версии реализован только LinkedIn.
 * Ошибки классифицируются: retryable / permanent / unknown_outcome.
 */
export interface PublishRequest {
  idempotencyKey: string;
  authorUrn: string;
  body: string;
  accessToken: string;
  apiVersion: string;
  /** URN изображений, уже загруженных через Images API. 1 = media, 2–20 = multiImage. */
  imageUrns?: string[];
  altTexts?: string[];
}
export interface UploadImageRequest { authorUrn: string; accessToken: string; apiVersion: string; data: Buffer; contentType: string }
export interface PublishResult { externalId: string; url: string | null }

export type IntegrationErrorKind = "retryable" | "permanent" | "auth" | "quota" | "unknown_outcome";
export class IntegrationError extends Error {
  constructor(public kind: IntegrationErrorKind, public code: string, message: string, public retryAfterSec?: number) {
    super(message);
  }
}

export interface SocialAdapter {
  readonly provider: string;
  readonly isDemo: boolean;
  publishPost(req: PublishRequest): Promise<PublishResult>;
  /** Images API: initializeUpload + PUT. Возвращает urn:li:image:… */
  uploadImage(req: UploadImageRequest): Promise<string>;
  /** Поиск ранее опубликованного материала для разрешения publication_unknown. null = проверить невозможно. */
  findPublication(req: { authorUrn: string; accessToken: string; idempotencyKey: string; bodyPrefix: string }): Promise<PublishResult | "not_found" | null>;
  /** Организации, которые пользователь токена администрирует (organizationAcls, роль ADMINISTRATOR, статус APPROVED). */
  listAdministeredOrganizations(req: { accessToken: string; apiVersion: string }): Promise<string[]>;
  /** Social Actions (Community Management API, w_member_social_feed): комментарий и реакция от имени участника. */
  createComment(req: SocialActionRequest & { text: string }): Promise<PublishResult>;
  createReaction(req: SocialActionRequest & { reactionType: string }): Promise<PublishResult>;
}
export interface SocialActionRequest { actorUrn: string; targetUrn: string; accessToken: string; apiVersion: string; idempotencyKey: string }

/** URN поста из ссылки LinkedIn (feed/update/urn:li:activity:…, posts/…-activity-…). null, если ссылка не распознана. */
export function postUrnFromUrl(url: string): string | null {
  const m = /urn:li:(activity|share|ugcPost):(\d+)/.exec(decodeURIComponent(url));
  if (m) return `urn:li:${m[1]}:${m[2]}`;
  const a = /-(activity|share|ugcPost)-(\d{6,})/.exec(url);
  return a ? `urn:li:${a[1]}:${a[2]}` : null;
}

function classify(res: Response, what: string): IntegrationError | null {
  if (res.ok) return null;
  if (res.status === 401) return new IntegrationError("auth", "unauthorized", "Токен недействителен или отозван");
  if (res.status === 403) return new IntegrationError("permanent", "forbidden", `Нет разрешения: ${what}`);
  if (res.status === 429) return new IntegrationError("quota", "throttled", "LinkedIn ограничил частоту действий", Number(res.headers.get("retry-after")) || 86400);
  if (res.status >= 500) return new IntegrationError("unknown_outcome", `http_${res.status}`, "Ошибка на стороне LinkedIn, исход не подтверждён");
  return new IntegrationError("permanent", `http_${res.status}`, `Ошибка запроса: ${what}`);
}

/** Реальный адаптер Posts API. Вызывается только при capability mode=api. */
export class LinkedInHttpAdapter implements SocialAdapter {
  readonly provider = "linkedin";
  readonly isDemo = false;
  constructor(private baseUrl = "https://api.linkedin.com", private timeoutMs = 20000) {}

  async publishPost(req: PublishRequest): Promise<PublishResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/rest/posts`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${req.accessToken}`,
          "LinkedIn-Version": req.apiVersion,
          "X-Restli-Protocol-Version": "2.0.0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          author: req.authorUrn,
          commentary: escapeLittleText(req.body),
          visibility: "PUBLIC",
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
          ...postContent(req),
        }),
      });
    } catch (e: any) {
      // Запрос мог дойти до LinkedIn: исход неизвестен, слепой повтор запрещён.
      throw new IntegrationError("unknown_outcome", e?.name === "AbortError" ? "timeout" : "network", "Ответ LinkedIn не получен");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 201) {
      const id = res.headers.get("x-restli-id");
      if (!id) throw new IntegrationError("unknown_outcome", "missing_id", "LinkedIn вернул 201 без идентификатора");
      return { externalId: id, url: `https://www.linkedin.com/feed/update/${id}/` };
    }
    if (res.status === 401) throw new IntegrationError("auth", "unauthorized", "Токен недействителен или отозван");
    if (res.status === 403) throw new IntegrationError("permanent", "forbidden", "Нет разрешения на операцию");
    if (res.status === 429) throw new IntegrationError("quota", "rate_limited", "Превышена квота LinkedIn", Number(res.headers.get("retry-after")) || 3600);
    if (res.status >= 500) throw new IntegrationError("unknown_outcome", `http_${res.status}`, "Ошибка на стороне LinkedIn, исход публикации не подтверждён");
    throw new IntegrationError("permanent", `http_${res.status}`, await res.text().catch(() => "Ошибка запроса"));
  }

  async uploadImage(req: UploadImageRequest): Promise<string> {
    const headers = { Authorization: `Bearer ${req.accessToken}`, "LinkedIn-Version": req.apiVersion, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" };
    let init: Response;
    try {
      init = await fetch(`${this.baseUrl}/rest/images?action=initializeUpload`, { method: "POST", headers, body: JSON.stringify({ initializeUploadRequest: { owner: req.authorUrn } }) });
    } catch {
      throw new IntegrationError("retryable", "network", "Не удалось начать загрузку изображения");
    }
    if (init.status === 401) throw new IntegrationError("auth", "unauthorized", "Токен недействителен или отозван");
    if (init.status === 429) throw new IntegrationError("quota", "rate_limited", "Превышена квота LinkedIn", Number(init.headers.get("retry-after")) || 3600);
    if (!init.ok) throw new IntegrationError(init.status >= 500 ? "retryable" : "permanent", `image_init_${init.status}`, "Ошибка инициализации загрузки изображения");
    const v = ((await init.json()) as any).value;
    if (!v?.uploadUrl || !v?.image) throw new IntegrationError("permanent", "image_init_shape", "Неожиданный ответ Images API");
    let put: Response;
    try {
      put = await fetch(v.uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${req.accessToken}`, "Content-Type": req.contentType }, body: new Uint8Array(req.data) });
    } catch {
      throw new IntegrationError("retryable", "network", "Не удалось загрузить изображение");
    }
    if (!put.ok) throw new IntegrationError(put.status >= 500 ? "retryable" : "permanent", `image_put_${put.status}`, "Ошибка загрузки изображения");
    return v.image as string;
  }

  async listAdministeredOrganizations(req: { accessToken: string; apiVersion: string }): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`, {
        headers: { Authorization: `Bearer ${req.accessToken}`, "LinkedIn-Version": req.apiVersion, "X-Restli-Protocol-Version": "2.0.0" },
      });
    } catch {
      throw new IntegrationError("retryable", "network", "Не удалось получить список администрируемых страниц");
    }
    if (res.status === 401) throw new IntegrationError("auth", "unauthorized", "Токен недействителен или отозван");
    if (res.status === 403) throw new IntegrationError("permanent", "forbidden", "Нет разрешения на чтение ролей организации");
    if (!res.ok) throw new IntegrationError(res.status >= 500 ? "retryable" : "permanent", `acl_${res.status}`, "Ошибка запроса ролей организации");
    return parseOrganizationAcls(await res.json());
  }

  private headers(token: string, version: string) {
    return { Authorization: `Bearer ${token}`, "LinkedIn-Version": version, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" };
  }
  async createComment(req: SocialActionRequest & { text: string }): Promise<PublishResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/rest/socialActions/${encodeURIComponent(req.targetUrn)}/comments`, { method: "POST", headers: this.headers(req.accessToken, req.apiVersion),
        body: JSON.stringify({ actor: req.actorUrn, object: req.targetUrn, message: { text: escapeLittleText(req.text) } }) });
    } catch { throw new IntegrationError("unknown_outcome", "network", "Ответ LinkedIn не получен"); }
    const err = classify(res, "комментарий"); if (err) throw err;
    const id = res.headers.get("x-restli-id") ?? ((await res.json().catch(() => ({}))) as any).id ?? null;
    if (!id) throw new IntegrationError("unknown_outcome", "missing_id", "LinkedIn не вернул идентификатор комментария");
    return { externalId: String(id), url: null };
  }
  async createReaction(req: SocialActionRequest & { reactionType: string }): Promise<PublishResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/rest/reactions?actor=${encodeURIComponent(req.actorUrn)}`, { method: "POST", headers: this.headers(req.accessToken, req.apiVersion),
        body: JSON.stringify({ root: req.targetUrn, reactionType: req.reactionType }) });
    } catch { throw new IntegrationError("unknown_outcome", "network", "Ответ LinkedIn не получен"); }
    const err = classify(res, "реакция"); if (err) throw err;
    return { externalId: `${req.actorUrn}|${req.targetUrn}`, url: null };
  }

  async findPublication(): Promise<null> {
    // Чтение собственных публикаций требует r_member_social (ограниченный доступ).
    // Пока доступ не подтверждён, автоматическая проверка невозможна → задача человеку.
    return null;
  }
}

/** Ответ organizationAcls → список URN организаций (дубли и некорректные значения отбрасываются). */
export function parseOrganizationAcls(json: any): string[] {
  const out = new Set<string>();
  for (const e of json?.elements ?? []) {
    const org = e?.organization ?? e?.organizationTarget;
    if (typeof org === "string" && /^urn:li:organization:\d+$/.test(org) && (e.role ?? "ADMINISTRATOR") === "ADMINISTRATOR" && (e.state ?? "APPROVED") === "APPROVED") out.add(org);
  }
  return [...out];
}

/** Тело content для Posts API: одно изображение или несколько. */
export function postContent(req: Pick<PublishRequest, "imageUrns" | "altTexts">) {
  const urns = req.imageUrns ?? [];
  if (urns.length === 0) return {};
  if (urns.length === 1) return { content: { media: { id: urns[0], ...(req.altTexts?.[0] ? { altText: req.altTexts[0] } : {}) } } };
  return { content: { multiImage: { images: urns.map((id, i) => ({ id, ...(req.altTexts?.[i] ? { altText: req.altTexts[i] } : {}) })) } } };
}

/** Little Text Format: экранирование зарезервированных символов commentary. */
export function escapeLittleText(s: string): string {
  return s.replace(/[\\|{}@\[\]()<>#*_~]/g, (c) => `\\${c}`);
}

/**
 * Демо-адаптер для локальной разработки и тестов. Никогда не обращается к LinkedIn.
 * Публикации хранятся в памяти и помечены как демонстрационные.
 */
export class DemoLinkedInAdapter implements SocialAdapter {
  readonly provider = "linkedin-demo";
  readonly isDemo = true;
  posts = new Map<string, PublishResult & { body: string; author: string }>();
  calls = 0;
  /** Сценарии отказов для тестов: по префиксу автора. */
  failures = new Map<string, IntegrationErrorKind | "lose_response">();

  async publishPost(req: PublishRequest): Promise<PublishResult> {
    this.calls++;
    this.lastPublish = req;
    const f = this.failures.get(req.authorUrn);
    if (f === "lose_response") {
      this.store(req);
      throw new IntegrationError("unknown_outcome", "timeout", "Ответ не получен (симуляция)");
    }
    if (f) throw new IntegrationError(f, `demo_${f}`, `Симуляция ошибки ${f}`, f === "quota" ? 60 : undefined);
    return this.store(req);
  }
  private store(req: PublishRequest): PublishResult {
    const existing = [...this.posts.values()].find((p) => p.author === req.authorUrn && p.body === req.body);
    if (existing) return existing;
    const id = `urn:li:share:demo-${this.posts.size + 1}`;
    const r = { externalId: id, url: null, body: req.body, author: req.authorUrn };
    this.posts.set(req.idempotencyKey, r);
    return r;
  }
  uploads = 0;
  async uploadImage(req: UploadImageRequest) {
    this.uploads++;
    const f = this.failures.get(req.authorUrn);
    if (f && f !== "lose_response") throw new IntegrationError(f, `demo_${f}`, `Симуляция ошибки ${f}`);
    return `urn:li:image:demo-${this.uploads}`;
  }
  lastPublish: PublishRequest | null = null;
  organizations: string[] = [];
  social: { kind: string; actor: string; target: string; text?: string }[] = [];
  async createComment(req: SocialActionRequest & { text: string }) {
    const f = this.failures.get(req.actorUrn);
    if (f && f !== "lose_response") throw new IntegrationError(f, f === "quota" ? "throttled" : `demo_${f}`, `Симуляция ошибки ${f}`, f === "quota" ? 86400 : undefined);
    this.social.push({ kind: "comment", actor: req.actorUrn, target: req.targetUrn, text: req.text });
    return { externalId: `urn:li:comment:demo-${this.social.length}`, url: null };
  }
  async createReaction(req: SocialActionRequest & { reactionType: string }) {
    const f = this.failures.get(req.actorUrn);
    if (f && f !== "lose_response") throw new IntegrationError(f, f === "quota" ? "throttled" : `demo_${f}`, `Симуляция ошибки ${f}`, f === "quota" ? 86400 : undefined);
    this.social.push({ kind: "reaction", actor: req.actorUrn, target: req.targetUrn });
    return { externalId: `${req.actorUrn}|${req.targetUrn}`, url: null };
  }
  async listAdministeredOrganizations() { return this.organizations; }
  async findPublication(req: { idempotencyKey: string }) {
    const p = this.posts.get(req.idempotencyKey);
    return p ? { externalId: p.externalId, url: p.url } : "not_found" as const;
  }
}
