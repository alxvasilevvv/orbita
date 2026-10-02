import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/db";
import type { SecretStore } from "./publishing";

/** AES-256-GCM. Ключ берётся из SECRETS_KEY (в production — из KMS). Значения не попадают в логи. */
export class DbSecretStore implements SecretStore {
  private key: Buffer;
  constructor(private db: Db, rawKey = process.env.SECRETS_KEY) {
    if (!rawKey) {
      if (process.env.NODE_ENV === "production") throw new Error("SECRETS_KEY обязателен в production");
      rawKey = "dev-only-insecure-key";
    }
    this.key = createHash("sha256").update(rawKey).digest();
  }
  async set(ref: string, value: string) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
    await this.db.query("INSERT INTO encrypted_secrets(ref, iv, tag, ciphertext) VALUES ($1,$2,$3,$4) ON CONFLICT (ref) DO UPDATE SET iv = EXCLUDED.iv, tag = EXCLUDED.tag, ciphertext = EXCLUDED.ciphertext", [ref, iv, c.getAuthTag(), ct]);
  }
  async get(ref: string) {
    const r = (await this.db.query("SELECT iv, tag, ciphertext FROM encrypted_secrets WHERE ref = $1", [ref])).rows[0];
    if (!r) return null;
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(r.iv));
    d.setAuthTag(Buffer.from(r.tag));
    return Buffer.concat([d.update(Buffer.from(r.ciphertext)), d.final()]).toString("utf8");
  }
  async delete(ref: string) { await this.db.query("DELETE FROM encrypted_secrets WHERE ref = $1", [ref]); }
}
