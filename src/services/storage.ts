import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Файловое хранилище. Ключи всегда начинаются с clients/{client_id}/…: это даёт изоляцию
 * и позволяет удалить все файлы клиента одной операцией по префиксу.
 */
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  list(prefix: string): Promise<string[]>;
  /** Временная подписанная ссылка на скачивание. */
  signedUrl(key: string, ttlSec: number): Promise<string>;
}

export function clientKey(clientId: string, ...parts: string[]) {
  if (!/^[0-9a-f-]{36}$/.test(clientId)) throw new Error("Некорректный client_id для ключа хранилища");
  for (const p of parts) if (p.includes("..") || p.includes("/")) throw new Error("Недопустимый сегмент ключа");
  return ["clients", clientId, ...parts].join("/");
}

export class LocalStorage implements Storage {
  private root: string;
  constructor(root: string, private secret: string, private baseUrl = "/files") {
    this.root = resolve(root);
  }
  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error("Выход за пределы хранилища");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    try { return await readFile(this.path(key)); } catch { return null; }
  }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
  async deletePrefix(prefix: string) {
    const files = await this.list(prefix);
    await rm(this.path(prefix), { recursive: true, force: true });
    return files.length;
  }
  async list(prefix: string): Promise<string[]> {
    const base = this.path(prefix);
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries: string[] = [];
      try { entries = await readdir(dir); } catch { return; }
      for (const e of entries) {
        const full = join(dir, e);
        if ((await stat(full)).isDirectory()) await walk(full);
        else out.push(full.slice(this.root.length + 1).split(sep).join("/"));
      }
    };
    await walk(base);
    return out;
  }
  sign(key: string, exp: number) {
    return createHmac("sha256", this.secret).update(`${key}|${exp}`).digest("hex");
  }
  verify(key: string, exp: number, sig: string) {
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    const a = Buffer.from(this.sign(key, exp));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async signedUrl(key: string, ttlSec: number) {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `${this.baseUrl}?key=${encodeURIComponent(key)}&exp=${exp}&sig=${this.sign(key, exp)}`;
  }
}

/** S3 / R2 / MinIO. Подписанные ссылки выдаёт сам провайдер. */
export class S3Storage implements Storage {
  private client: any;
  private mod: any;
  constructor(private bucket: string, private opts: { region?: string; endpoint?: string } = {}) {}
  private async c() {
    if (!this.client) {
      this.mod = await import("@aws-sdk/client-s3");
      this.client = new this.mod.S3Client({ region: this.opts.region ?? "auto", endpoint: this.opts.endpoint, forcePathStyle: !!this.opts.endpoint });
    }
    return this.client;
  }
  async put(key: string, data: Buffer, contentType: string) {
    const c = await this.c();
    await c.send(new this.mod.PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: "AES256" }));
  }
  async get(key: string) {
    const c = await this.c();
    try {
      const r = await c.send(new this.mod.GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await r.Body.transformToByteArray());
    } catch { return null; }
  }
  async delete(key: string) {
    const c = await this.c();
    await c.send(new this.mod.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async list(prefix: string) {
    const c = await this.c();
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const r = await c.send(new this.mod.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) keys.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
  async deletePrefix(prefix: string) {
    const c = await this.c();
    const keys = await this.list(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      await c.send(new this.mod.DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
    }
    return keys.length;
  }
  async signedUrl(key: string, ttlSec: number) {
    const c = await this.c();
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    return getSignedUrl(c, new this.mod.GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSec });
  }
}

export function storageFromEnv(env = process.env): Storage {
  if (env.S3_BUCKET) return new S3Storage(env.S3_BUCKET, { region: env.S3_REGION, endpoint: env.S3_ENDPOINT });
  const secret = env.SECRETS_KEY ?? "dev-only-insecure-key";
  return new LocalStorage(env.FILES_DIR ?? "./data/files", secret);
}
