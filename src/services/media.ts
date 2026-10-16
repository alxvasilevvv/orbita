import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import type { Queryable } from "../db/db";
import { accountScope, audit, NotFoundError, requireOp, ValidationError, type Ctx } from "./context";
import { clientKey, type Storage } from "./storage";

/**
 * Ограничения медиа. Значения для изображений взяты из документации Images API (2026-10-02):
 * JPG, GIF, PNG, до 36 152 320 пикселей. Видео и документы публикуются через человека,
 * пока Videos/Documents API не подтверждены для приложения.
 */
export const MEDIA_LIMITS = {
  image: { types: ["image/jpeg", "image/png", "image/gif"], maxBytes: 20 * 1024 * 1024, maxPixels: 36_152_320, api: true },
  video: { types: ["video/mp4"], maxBytes: 500 * 1024 * 1024, api: false },
  document: { types: ["application/pdf"], maxBytes: 100 * 1024 * 1024, api: false },
} as const;
export const MAX_IMAGES_PER_POST = 20;

/** Определение типа по сигнатуре файла: заявленному Content-Type не доверяем. */
export function sniff(buf: Buffer): { mime: string; kind: keyof typeof MEDIA_LIMITS } | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", kind: "image" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", kind: "image" };
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) return { mime: "image/gif", kind: "image" };
  if (buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-") return { mime: "application/pdf", kind: "document" };
  if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") return { mime: "video/mp4", kind: "video" };
  return null;
}

/** Размеры изображения из заголовка (PNG, GIF, JPEG). */
export function imageSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === "image/png" && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (mime === "image/gif" && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

export interface MalwareScanner { name: string; scan(buf: Buffer): Promise<{ clean: boolean; detail: string }> }

/** Минимальная проверка: тестовая сигнатура EICAR. Для production: ClamAV. */
export class SignatureScanner implements MalwareScanner {
  name = "signature";
  async scan(buf: Buffer) {
    const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    return buf.includes(Buffer.from(eicar)) ? { clean: false, detail: "EICAR test signature" } : { clean: true, detail: "signature check" };
  }
}

/** clamd INSTREAM по TCP (CLAMAV_HOST, CLAMAV_PORT). */
export class ClamAvScanner implements MalwareScanner {
  name = "clamav";
  constructor(private host: string, private port = 3310, private timeoutMs = 30000) {}
  scan(buf: Buffer): Promise<{ clean: boolean; detail: string }> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.port, this.host);
      let out = "";
      sock.setTimeout(this.timeoutMs, () => { sock.destroy(); reject(new Error("clamd timeout")); });
      sock.on("data", (d) => { out += d.toString(); });
      sock.on("end", () => resolve({ clean: /: OK/.test(out), detail: out.trim() }));
      sock.on("error", reject);
      sock.write("zINSTREAM\0");
      for (let i = 0; i < buf.length; i += 64 * 1024) {
        const chunk = buf.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length);
        sock.write(len); sock.write(chunk);
      }
      sock.end(Buffer.from([0, 0, 0, 0]));
    });
  }
}
export function scannerFromEnv(env = process.env): MalwareScanner {
  return env.CLAMAV_HOST ? new ClamAvScanner(env.CLAMAV_HOST, Number(env.CLAMAV_PORT ?? 3310)) : new SignatureScanner();
}

export async function uploadMedia(ctx: Ctx, deps: { storage: Storage; scanner: MalwareScanner }, accountId: string, file: { filename: string; data: Buffer }) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "edit_content", { clientId: a.client_id, accountId });
  if (!file.data.length) throw new ValidationError("Пустой файл");
  const t = sniff(file.data);
  if (!t) throw new ValidationError("Формат не поддерживается: допустимы JPG, PNG, GIF, PDF, MP4");
  const lim = MEDIA_LIMITS[t.kind];
  if (file.data.length > lim.maxBytes) throw new ValidationError(`Файл больше ${Math.round(lim.maxBytes / 1024 / 1024)} МБ`);
  const size = t.kind === "image" ? imageSize(file.data, t.mime) : null;
  if (t.kind === "image" && size && size.width * size.height > MEDIA_LIMITS.image.maxPixels) throw new ValidationError("Изображение больше 36 152 320 пикселей (ограничение LinkedIn Images API)");
  const sha = createHash("sha256").update(file.data).digest("hex");
  // Повторная загрузка того же файла в тот же аккаунт возвращает существующий объект.
  const existing = (await ctx.db.query("SELECT id, mime_type, bytes, scan_status, original_name FROM media_assets WHERE account_id = $1 AND sha256 = $2", [accountId, sha])).rows[0];
  if (existing) return { ...existing, deduplicated: true };
  const scan = await deps.scanner.scan(file.data);
  const id = randomUUID();
  const key = clientKey(a.client_id, "media", id);
  if (scan.clean) await deps.storage.put(key, file.data, t.mime);
  const row = (await ctx.db.query(
    `INSERT INTO media_assets(id, client_id, account_id, storage_key, mime_type, bytes, sha256, scan_status, scan_detail, original_name, width, height, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, mime_type, bytes, scan_status, original_name, width, height`,
    [id, a.client_id, accountId, key, t.mime, file.data.length, sha, scan.clean ? "clean" : "infected", scan.detail, file.filename.slice(0, 200), size?.width ?? null, size?.height ?? null, ctx.actor.id])).rows[0];
  await audit(ctx.db, ctx, { action: scan.clean ? "media.uploaded" : "media.rejected_malware", entity_type: "media_asset", entity_id: id, client_id: a.client_id, account_id: accountId, details: { mime: t.mime, bytes: file.data.length, scanner: deps.scanner.name } });
  if (!scan.clean) throw new ValidationError("Файл не прошёл антивирусную проверку и не сохранён");
  return row;
}

export async function listMedia(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  requireOp(ctx, "view", { clientId: a.client_id, accountId });
  return (await ctx.db.query("SELECT id, mime_type, bytes, scan_status, original_name, width, height, external_urn, created_at, purpose, ai_generated FROM media_assets WHERE account_id = $1 AND scan_status = 'clean' AND purpose <> 'portrait_source' ORDER BY created_at DESC LIMIT 200", [accountId])).rows;
}

export async function mediaUrl(ctx: Ctx, storage: Storage, mediaId: string) {
  const m = (await ctx.db.query("SELECT id, account_id, client_id, storage_key, scan_status FROM media_assets WHERE id = $1", [mediaId])).rows[0];
  if (!m) throw new NotFoundError("Файл не найден");
  await accountScope(ctx.db, ctx, m.account_id);
  if (m.scan_status !== "clean") throw new NotFoundError("Файл не найден");
  return { url: await storage.signedUrl(m.storage_key, 300), expires_in: 300 };
}

/** Проверка медиа версии перед согласованием и публикацией. */
export async function mediaIssues(q: Queryable, accountId: string, mediaIds: string[], mode: "any" | "api"): Promise<string[]> {
  if (!mediaIds?.length) return [];
  const rows = (await q.query("SELECT id, account_id, mime_type, scan_status, purpose FROM media_assets WHERE id = ANY($1::uuid[])", [mediaIds])).rows;
  const issues: string[] = [];
  if (rows.length !== mediaIds.length) issues.push("Часть вложений не найдена");
  if (rows.some((r: any) => r.account_id !== accountId)) issues.push("Вложение принадлежит другому аккаунту");
  if (rows.some((r: any) => r.scan_status !== "clean")) issues.push("Вложение не прошло проверку");
  if (rows.some((r: any) => r.purpose === "portrait_source")) issues.push("Исходные фото для портрета нельзя прикреплять к постам");
  if (mode === "api") {
    if (rows.some((r: any) => !r.mime_type.startsWith("image/"))) issues.push("Видео и документы через API пока не публикуются: нужна публикация через человека");
    if (rows.length > MAX_IMAGES_PER_POST) issues.push(`Больше ${MAX_IMAGES_PER_POST} изображений в одном посте`);
  }
  return issues;
}
