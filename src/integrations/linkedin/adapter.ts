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

  async findPublication(): Promise<null> {
    // Чтение собственных публикаций требует r_member_social (ограниченный доступ).
    // Пока доступ не подтверждён, автоматическая проверка невозможна → задача человеку.
    return null;
  }
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
  async findPublication(req: { idempotencyKey: string }) {
    const p = this.posts.get(req.idempotencyKey);
    return p ? { externalId: p.externalId, url: p.url } : "not_found" as const;
  }
}
