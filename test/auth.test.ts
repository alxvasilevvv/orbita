import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup } from "./helpers";
import { buildApp } from "../src/server/app";
import * as authn from "../src/services/auth";

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { env = await setup(); });
afterEach(async () => { await env.db.close(); });

const UID = "11111111-2222-3333-4444-555555555555";

describe("сессии и state", () => {
  it("createSession/readSession: round-trip, подделка и истечение отклоняются", () => {
    const t = authn.createSession(UID);
    expect(authn.readSession(t)).toBe(UID);
    expect(authn.readSession(t + "x")).toBeNull();
    expect(authn.readSession(t.replace(/\.[^.]+$/, ".deadbeef"))).toBeNull();
    const expired = authn.createSession(UID, new Date(Date.now() - 10 * 24 * 3600 * 1000));
    expect(authn.readSession(expired)).toBeNull();
    expect(authn.readSession(undefined)).toBeNull();
    expect(authn.readSession("нет-точки")).toBeNull();
  });
  it("signState/readState: round-trip и истечение", () => {
    const s = authn.signState({ state: "abc", verifier: "v" });
    expect(authn.readState(s)).toMatchObject({ state: "abc", verifier: "v" });
    const old = authn.signState({ state: "x" }, new Date(Date.now() - 3600_000));
    expect(authn.readState(old)).toBeNull();
  });
  it("parseCookies разбирает заголовок", () => {
    expect(authn.parseCookies("a=1; orbita_session=tok; b=2")).toMatchObject({ a: "1", orbita_session: "tok", b: "2" });
    expect(authn.parseCookies(undefined)).toEqual({});
  });
  it("cookie ставит HttpOnly/SameSite/Secure", () => {
    const c = authn.cookie("orbita_session", "v", { maxAge: 100 });
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Secure");
    expect(c).toContain("Max-Age=100");
  });
});

describe("Google OIDC", () => {
  const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  it("exchangeGoogleCode разбирает email, проверяет aud и ok", async () => {
    const ok = (async () => ({ ok: true, json: async () => ({ id_token: idToken({ email: "A@B.com", email_verified: true, aud: "cid", exp: Math.floor(Date.now() / 1000) + 600 }) }) })) as any;
    const r = await authn.exchangeGoogleCode({ clientId: "cid", clientSecret: "s", code: "c", redirectUri: "u", verifier: "v" }, ok);
    expect(r).toMatchObject({ email: "a@b.com", emailVerified: true });
    // чужой aud отклоняется
    const badAud = (async () => ({ ok: true, json: async () => ({ id_token: idToken({ email: "x@y.com", aud: "other" }) }) })) as any;
    expect(await authn.exchangeGoogleCode({ clientId: "cid", clientSecret: "s", code: "c", redirectUri: "u", verifier: "v" }, badAud)).toBeNull();
    // не-2xx
    const bad = (async () => ({ ok: false })) as any;
    expect(await authn.exchangeGoogleCode({ clientId: "cid", clientSecret: "s", code: "c", redirectUri: "u", verifier: "v" }, bad)).toBeNull();
  });
  it("googleEnabled зависит от переменных", () => {
    expect(authn.googleEnabled({} as any)).toBe(false);
    expect(authn.googleEnabled({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" } as any)).toBe(true);
  });
});

describe("вход по куки-сессии", () => {
  it("валидная куки-сессия аутентифицирует запрос без x-user-id", async () => {
    const app = buildApp({ db: env.db, secrets: env.secrets, authMode: "dev" });
    const uid = (await env.db.query("SELECT id FROM users WHERE email = 'am@demo.agency'")).rows[0].id as string;
    const sess = authn.createSession(uid);
    const r = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: `orbita_session=${sess}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().id).toBe(uid);
    // поддельная кука не пускает
    const bad = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: "orbita_session=forged.sig" } });
    expect(bad.statusCode).toBe(401);
  });
  it("/auth/login отдаёт страницу; /auth/google/start без настройки 404", async () => {
    const app = buildApp({ db: env.db, secrets: env.secrets, authMode: "dev" });
    expect((await app.inject({ method: "GET", url: "/auth/login" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/google/start" })).statusCode).toBe(404);
  });
});

describe("вход по email и паролю", () => {
  it("hashPassword/verifyPassword: корректный и неверный пароль", () => {
    const h = authn.hashPassword("orbita2026");
    expect(authn.verifyPassword("orbita2026", h)).toBe(true);
    expect(authn.verifyPassword("wrong", h)).toBe(false);
    expect(authn.verifyPassword("x", null)).toBe(false);
  });
  it("демо-пользователь входит по email и паролю по умолчанию, выдаётся сессия", async () => {
    const app = buildApp({ db: env.db, secrets: env.secrets, authMode: "dev" });
    const r = await app.inject({ method: "POST", url: "/auth/password/login", payload: { email: "am@demo.agency", password: "orbita2026" } });
    expect(r.statusCode).toBe(200);
    const setCookie = String(r.headers["set-cookie"]);
    expect(setCookie).toContain("orbita_session=");
    // Куки-сессия из логина действительно аутентифицирует.
    const sess = setCookie.split("orbita_session=")[1].split(";")[0];
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: `orbita_session=${decodeURIComponent(sess)}` } });
    expect(me.statusCode).toBe(200);
    // Неверный пароль — 401.
    const bad = await app.inject({ method: "POST", url: "/auth/password/login", payload: { email: "am@demo.agency", password: "nope" } });
    expect(bad.statusCode).toBe(401);
    // Неизвестный email — 401.
    const nouser = await app.inject({ method: "POST", url: "/auth/password/login", payload: { email: "ghost@demo.agency", password: "orbita2026" } });
    expect(nouser.statusCode).toBe(401);
  });
});
