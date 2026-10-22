import { createHmac, createHash, randomBytes, timingSafeEqual, scryptSync } from "node:crypto";

/**
 * Реальная аутентификация: сессии на подписанных куки и вход через Google (OpenID Connect, code flow + PKCE).
 * Активируется переменными GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET; без них платформа работает на демо-входе.
 * Ключ подписи берётся из SECRETS_KEY. Пользователь должен уже существовать (по email): самопровижининг выключен.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sessKey = (env = process.env) => createHash("sha256").update(`${env.SECRETS_KEY ?? "dev-only-insecure-key"}:session`).digest();
const b64 = (b: Buffer) => b.toString("base64url");
const sign = (ns: string, payload: string, env = process.env) => b64(createHmac("sha256", sessKey(env)).update(`${ns}:${payload}`).digest());
const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Подписанный токен сессии: payload.sig, payload = base64url(JSON{uid,exp}). */
export function createSession(userId: string, now = new Date(), ttlSec = 7 * 24 * 3600, env = process.env): string {
  const payload = b64(Buffer.from(JSON.stringify({ uid: userId, exp: Math.floor(now.getTime() / 1000) + ttlSec })));
  return `${payload}.${sign("session", payload, env)}`;
}
export function readSession(token: string | undefined | null, now = new Date(), env = process.env): string | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !eq(sig, sign("session", payload, env))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof p.exp !== "number" || p.exp < Math.floor(now.getTime() / 1000) || !UUID.test(p.uid)) return null;
    return p.uid as string;
  } catch { return null; }
}

/** Короткоживущий подписанный блоб для state+PKCE между /start и /callback. */
export function signState(data: Record<string, string>, now = new Date(), ttlSec = 600, env = process.env): string {
  const payload = b64(Buffer.from(JSON.stringify({ ...data, exp: Math.floor(now.getTime() / 1000) + ttlSec })));
  return `${payload}.${sign("state", payload, env)}`;
}
export function readState(token: string | undefined, now = new Date(), env = process.env): Record<string, string> | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !eq(sig, sign("state", payload, env))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof p.exp !== "number" || p.exp < Math.floor(now.getTime() / 1000)) return null;
    return p;
  } catch { return null; }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) { const i = part.indexOf("="); if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ } } }
  return out;
}
export function cookie(name: string, value: string, opts: { maxAge?: number; secure?: boolean } = {}): string {
  const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.secure !== false) bits.push("Secure");
  bits.push(`Max-Age=${opts.maxAge ?? 0}`);
  return bits.join("; ");
}

/** Пароль: scrypt с солью. Формат хранения `scrypt:<salt_hex>:<hash_hex>`. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(pw, salt, 64).toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  try {
    const want = Buffer.from(hashHex, "hex");
    const got = scryptSync(pw, Buffer.from(saltHex, "hex"), want.length);
    return want.length === got.length && timingSafeEqual(want, got);
  } catch { return false; }
}

export function googleEnabled(env = process.env) { return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET); }
export function pkce() {
  const verifier = b64(randomBytes(32));
  return { verifier, challenge: b64(createHash("sha256").update(verifier).digest()) };
}
export function googleAuthUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const p = new URLSearchParams({ client_id: o.clientId, redirect_uri: o.redirectUri, response_type: "code", scope: "openid email profile", state: o.state, code_challenge: o.challenge, code_challenge_method: "S256", access_type: "online", prompt: "select_account" });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}
/**
 * Обмен кода на id_token и разбор email. id_token получен напрямую от token-эндпоинта Google по TLS
 * с нашим client_secret, поэтому payload можно доверять без повторной проверки подписи (проверяем aud и exp).
 */
export async function exchangeGoogleCode(o: { clientId: string; clientSecret: string; code: string; redirectUri: string; verifier: string }, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<{ email: string; emailVerified: boolean; sub: string } | null> {
  const r = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, code: o.code, grant_type: "authorization_code", redirect_uri: o.redirectUri, code_verifier: o.verifier }).toString(),
  });
  if (!r.ok) return null;
  const t: any = await r.json().catch(() => null);
  if (!t?.id_token) return null;
  const parts = String(t.id_token).split(".");
  if (parts.length < 2) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!c.email || (c.aud && c.aud !== o.clientId)) return null;
    if (c.exp && Number(c.exp) < Math.floor(now.getTime() / 1000)) return null;
    return { email: String(c.email).toLowerCase(), emailVerified: c.email_verified === true || c.email_verified === "true", sub: String(c.sub ?? "") };
  } catch { return null; }
}
