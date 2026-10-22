import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ZodError, z } from "zod";
import type { Db } from "../db/db";
import { accountScope, actorCtx, isAccountOwner, isInternal, loadActor, requireOp, type Ctx } from "../services/context";
import * as acc from "../services/accounts";
import * as content from "../services/content";
import * as pub from "../services/publishing";
import * as ops from "../services/operations";
import * as notifySvc from "../services/notify";
import * as wf from "../services/workflows";
import * as media from "../services/media";
import * as cal from "../services/calendar";
import * as onb from "../services/onboarding";
import * as eng from "../services/engagement";
import * as ai from "../services/ai";
import * as ins from "../services/insights";
import * as reports from "../services/reports";
import * as exp from "../services/exports";
import * as team from "../services/team";
import * as life from "../services/lifecycle";
import * as portal from "../services/portal";
import * as company from "../services/company";
import * as missions from "../services/missions";
import * as agent from "../services/agent";
import * as billing from "../services/billing";
import * as outreach from "../services/outreach";
import * as xengage from "../services/x_engage";
import * as chat from "../services/chat";
import type { TelegramClient } from "../integrations/telegram";
import type { XSocialAdapter } from "../integrations/x/adapter";
import * as authn from "../services/auth";
import { CAPABILITY_CATALOG } from "../core/capabilities";
import { STRATEGY_TEMPLATES } from "../core/templates";
import { dailyRequestBudget } from "../core/heuristics";
import { allowedOperations, agencyWide } from "../core/permissions";
import { DemoAiProvider, type AiProvider } from "../ai/guard";
import { LocalStorage, type Storage } from "../services/storage";
import { SignatureScanner, type MalwareScanner, MEDIA_LIMITS } from "../services/media";
import { LinkedInHttpAdapter } from "../integrations/linkedin/adapter";
import type { SecretStoreFull } from "../runtime";

const here = dirname(fileURLToPath(import.meta.url));

/** Маршруты, доступные пользователям без роли агентства. Всё остальное для них закрыто (403). */
const CLIENT_ROUTES = new Set([
  "GET /api/me", "PATCH /api/me", "GET /api/meta", "GET /api/portal", "GET /api/portal/accounts/:id",
  "GET /api/content/:id", "POST /api/content/:id/decision", "GET /api/reports/:id", "GET /api/media/:id/url",
  "POST /api/accounts/:id/consents", "POST /api/accounts/:id/consents/:scope/revoke",
  "GET /api/notifications", "POST /api/notifications/read", "POST /api/engagement/:id/decision",
]);
const EMPLOYEE_ROUTES = new Set([
  "GET /api/me/participation", "PATCH /api/me/participation/:accountId", "GET /api/me/actions",
  "POST /api/mission-actions/:id/decision", "POST /api/mission-actions/:id/done", "POST /api/accounts/:id/signals",
  "GET /api/me/agent", "POST /api/me/agent/:accountId/role", "POST /api/me/agent/:accountId/interview", "POST /api/me/agent/:accountId/samples",
  "POST /api/me/agent/:accountId/passport/confirm", "POST /api/me/agent/:accountId/autopilot", "POST /api/autopilot-posts/:id/action",
  "POST /api/me/agent/:accountId/pack/approve", "POST /api/me/agent/:accountId/telegram/link", "POST /api/me/agent/:accountId/telegram/unlink",
  "POST /api/me/agent/:accountId/likeness", "POST /api/me/agent/:accountId/likeness/revoke", "POST /api/me/agent/:accountId/photos",
  "POST /api/me/agent/:accountId/portraits", "POST /api/portrait-jobs/:id/choose", "GET /api/accounts/:id/oauth/start",
  "POST /api/me/agent/:accountId/strategy", "POST /api/me/agent/:accountId/promo", "POST /api/billing/checkout", "POST /api/billing/demo/:id/confirm",
  "GET /api/me/outreach/:accountId", "POST /api/me/outreach/:accountId/import", "POST /api/outreach/:id/mark",
  "GET /api/me/agent/:accountId/chat", "POST /api/me/agent/:accountId/chat", "GET /api/me/agent/:accountId/plan",
  "POST /api/me/agent/:accountId/x/connect", "POST /api/me/agent/add-network",
  "GET /api/me/agent/:accountId/x-engagements", "POST /api/me/agent/:accountId/x-targets", "POST /api/x-engagements/:id/action",
]);
const CLIENT_ADMIN_ROUTES = new Set([
  "GET /api/me", "PATCH /api/me", "GET /api/meta", "GET /api/notifications", "POST /api/notifications/read",
  "GET /api/companies", "GET /api/companies/:id", "POST /api/companies/:id/brief", "POST /api/companies/:id/pause",
  "GET /api/companies/:id/invites", "POST /api/companies/:id/invites", "POST /api/invites/:id/revoke", "POST /api/accounts/:id/confirm-employment",
  "GET /api/companies/:id/missions", "POST /api/companies/:id/missions", "GET /api/missions/:id", "POST /api/missions/:id/cancel",
  "GET /api/content/:id", "POST /api/content/:id/decision", "GET /api/reports/:id", "GET /api/media/:id/url",
  "GET /api/companies/:id/autopilot", "POST /api/companies/:id/autopilot/review",
  "POST /api/companies/:id/strategy", "GET /api/companies/:id/billing", "POST /api/billing/checkout", "POST /api/billing/demo/:id/confirm",
]);
const AUDITOR_ROUTES = new Set(["GET /api/me", "PATCH /api/me", "GET /api/meta", "GET /api/audit", "GET /api/notifications", "POST /api/notifications/read"]);
function externalRouteAllowed(ctx: Ctx, method: string, url: string) {
  const key = `${method} ${url}`;
  const roles = new Set(ctx.actor.memberships.map((m) => m.role));
  return (roles.has("client") && (CLIENT_ROUTES.has(key) || EMPLOYEE_ROUTES.has(key))) || (roles.has("client_admin") && CLIENT_ADMIN_ROUTES.has(key)) || (roles.has("auditor") && AUDITOR_ROUTES.has(key));
}

export interface AppDeps {
  db: Db;
  secrets: SecretStoreFull | (pub.SecretStore & { set?(k: string, v: string): unknown; delete?(k: string): Promise<void> });
  authMode: "dev" | "header";
  storage?: Storage;
  scanner?: MalwareScanner;
  ai?: AiProvider;
  mailer?: import("../services/notify").Mailer;
  /** Модель личных агентов (по умолчанию Opus) и Telegram-бот сотрудников. */
  agentAi?: AiProvider;
  telegram?: TelegramClient;
  payments?: billing.PaymentProvider;
  xAdapter?: XSocialAdapter;
}

/** Простой лимитер запросов на пользователя/IP: защита от случайных циклов в клиентах. Основная защита: WAF. */
function rateLimiter(limitPerMin: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + 60_000 }); return true; }
    h.n++;
    return h.n <= limitPerMin;
  };
}

export function buildApp(deps: AppDeps) {
  const storage = deps.storage ?? new LocalStorage(process.env.FILES_DIR ?? "./data/files", process.env.SECRETS_KEY ?? "dev-only-insecure-key");
  const scanner = deps.scanner ?? new SignatureScanner();
  const aiProvider = deps.ai ?? new DemoAiProvider();
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie", "req.headers[\"x-authenticated-user-id\"]"] },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === "1",
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MEDIA_LIMITS.video.maxBytes }, (_req, body, done) => done(null, body));
  const limit = rateLimiter(Number(process.env.API_RATE_LIMIT_PER_MIN ?? 600));
  const inviteLimit = rateLimiter(20);

  app.addHook("onRequest", async (req, reply) => {
    // В header-режиме доверяем только заголовку от identity-aware proxy; клиентский x-user-id не даёт
    // обойти лимит сменой значения. В dev-режиме идентификатор запроса — это и есть x-user-id.
    const idKey = deps.authMode === "header" ? (req.headers["x-authenticated-user-id"] ?? req.ip) : (req.headers["x-user-id"] ?? req.ip);
    if (req.url.startsWith("/api/") && !limit(`${idKey}`)) {
      return reply.status(429).send({ error: "rate_limited", message: "Слишком много запросов, повторите через минуту" });
    }
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Content-Security-Policy", "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'");
    return payload;
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.status(422).send({ error: "validation_error", message: "Некорректные данные", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) app.log.error({ err: { message: err.message, stack: err.stack } }, "unhandled");
    return reply.status(status).send({ error: err.constructor?.name ?? "Error", message: status >= 500 ? "Внутренняя ошибка" : err.message, details: err.details });
  });

  /**
   * Аутентификация. dev: пользователь из заголовка x-user-id (только вне production).
   * header: доверенный заголовок от identity-aware proxy с MFA, см. docs/adr/0003.
   */
  async function ctxOf(req: FastifyRequest): Promise<Ctx> {
    // Приоритет у подписанной куки-сессии (реальный вход через Google). Иначе fallback на заголовки:
    // dev — x-user-id (только вне production), header — доверенный x-authenticated-user-id от IdP-прокси.
    const sessionUid = authn.readSession(authn.parseCookies(req.headers.cookie)["orbita_session"]);
    const id = sessionUid ?? (deps.authMode === "dev" ? (req.headers["x-user-id"] as string) : (req.headers["x-authenticated-user-id"] as string));
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw Object.assign(new Error("Требуется вход"), { status: 401 });
    const actor = await loadActor(deps.db, id);
    if (!actor) throw Object.assign(new Error("Пользователь не найден или отключён"), { status: 401 });
    return actorCtx(deps.db, actor);
  }
  type Req<P> = FastifyRequest<{ Params: P; Body: any; Querystring: Record<string, string | undefined> }>;
  const h = <P = any>(fn: (ctx: Ctx, req: Req<P>, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest<any>, reply: FastifyReply) => {
      const ctx = await ctxOf(req);
      // Представитель клиента и аудитор видят только разрешённые им маршруты: внутренние экраны закрыты целиком,
      // а не только отфильтрованы. Это второй рубеж после RLS и проверок операций в сервисах.
      if (!isInternal(ctx) && !externalRouteAllowed(ctx, req.method, req.routeOptions.url ?? "")) {
        throw Object.assign(new Error("Раздел доступен только команде агентства"), { status: 403 });
      }
      return fn(ctx, req as Req<P>, reply);
    };

  // Статика UI
  const publicDir = process.env.ORBITA_PUBLIC_DIR || join(here, "../../public");
  const asset = (file: string, type: string) => async (_r: FastifyRequest, reply: FastifyReply) => reply.type(type).header("Cache-Control", "no-cache").send(await readFile(join(publicDir, file)));
  app.get("/", asset("index.html", "text/html; charset=utf-8"));
  app.get("/app.js", asset("app.js", "application/javascript; charset=utf-8"));
  app.get("/app.css", asset("app.css", "text/css; charset=utf-8"));

  // Реальный вход через Google (OpenID Connect, code flow + PKCE). Активен при GOOGLE_CLIENT_ID/SECRET.
  const googleRedirect = () => `${process.env.APP_URL ?? ""}/auth/google/callback`;
  app.get("/auth/login", async (req: FastifyRequest<{ Querystring: { e?: string } }>, reply) => {
    const google = authn.googleEnabled();
    const err = req.query.e === "not_provisioned" ? "Этот аккаунт не заведён в системе. Обратитесь к администратору." : "";
    reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang=ru><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Orbita — вход</title>
<style>*{box-sizing:border-box}body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;background:#0a0a0a;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.card{width:100%;max-width:360px;text-align:center}h1{font-weight:800;letter-spacing:-.02em;margin:.2em 0}.sub{opacity:.6;margin:0 0 20px;font-size:14px}
input{width:100%;padding:12px 14px;margin:6px 0;border-radius:10px;border:1px solid #333;background:#141414;color:#eee;font-size:15px}
button{width:100%;padding:12px;border:0;border-radius:999px;background:#c6f24e;color:#0a0a0a;font-weight:700;font-size:15px;cursor:pointer;margin-top:8px}
.g{display:block;margin-top:14px;color:#c6f24e;text-decoration:none;font-weight:600;font-size:14px}.err{color:#ff8080;font-size:13px;min-height:18px;margin:6px 0}</style>
<body><div class=card><h1>Orbita</h1><p class=sub>агенты ведут соцсети вашей команды</p>
<form id=f><input id=email type=email placeholder=Email autocomplete=username required><input id=pw type=password placeholder=Пароль autocomplete=current-password required><div class=err id=err>${err}</div><button type=submit>Войти</button></form>
${google ? `<a class=g href="/auth/google/start">Войти через Google</a>` : ``}</div>
<script>var f=document.getElementById('f');f.onsubmit=async function(e){e.preventDefault();var err=document.getElementById('err');err.textContent='';try{var r=await fetch('/auth/password/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('pw').value})});if(r.ok){location.href='/#/';}else{var j=await r.json().catch(function(){return{}});err.textContent=j.message||'Неверный email или пароль';}}catch(x){err.textContent='Ошибка сети';}};</script></body></html>`);
  });
  app.post("/auth/password/login", async (req, reply) => {
    const d = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).parse(req.body);
    const u = (await deps.db.query("SELECT id, password_hash FROM users WHERE lower(email) = lower($1) AND is_active", [d.email])).rows[0];
    if (!u || !authn.verifyPassword(d.password, u.password_hash)) throw Object.assign(new Error("Неверный email или пароль"), { status: 401 });
    reply.header("set-cookie", authn.cookie("orbita_session", authn.createSession(u.id), { maxAge: 7 * 24 * 3600 }));
    return { ok: true };
  });
  app.get("/auth/google/start", async (_r, reply) => {
    if (!authn.googleEnabled()) return reply.status(404).send("Вход через Google не настроен");
    const { verifier, challenge } = authn.pkce();
    const state = randomBytes(16).toString("hex");
    reply.header("set-cookie", authn.cookie("orbita_oauth", authn.signState({ state, verifier }), { maxAge: 600 }));
    return reply.redirect(authn.googleAuthUrl({ clientId: process.env.GOOGLE_CLIENT_ID!, redirectUri: googleRedirect(), state, challenge }));
  });
  app.get("/auth/google/callback", async (req: FastifyRequest<{ Querystring: { code?: string; state?: string } }>, reply) => {
    if (!authn.googleEnabled()) return reply.status(404).send();
    const saved = authn.readState(authn.parseCookies(req.headers.cookie)["orbita_oauth"]);
    const { code, state } = req.query;
    reply.header("set-cookie", authn.cookie("orbita_oauth", "", { maxAge: 0 }));
    if (!saved || !code || !state || saved.state !== state) return reply.status(400).send("Сессия входа недействительна, попробуйте снова");
    const info = await authn.exchangeGoogleCode({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET!, code, redirectUri: googleRedirect(), verifier: saved.verifier });
    if (!info || !info.emailVerified) return reply.status(401).send("Google не подтвердил email");
    const u = (await deps.db.query("SELECT id FROM users WHERE lower(email) = $1 AND is_active", [info.email])).rows[0];
    if (!u) return reply.redirect("/auth/login?e=not_provisioned");
    reply.header("set-cookie", authn.cookie("orbita_session", authn.createSession(u.id), { maxAge: 7 * 24 * 3600 }));
    return reply.redirect("/#/");
  });
  app.post("/auth/logout", async (_r, reply) => { reply.header("set-cookie", authn.cookie("orbita_session", "", { maxAge: 0 })); return { ok: true }; });

  app.get("/healthz", async () => { await deps.db.query("SELECT 1"); return { ok: true }; });
  app.get("/readyz", async () => {
    const q = (await deps.db.query("SELECT (SELECT count(*)::int FROM publication_jobs WHERE status = 'queued' AND run_at < now() - interval '15 minutes') AS stuck, (SELECT count(*)::int FROM outbox WHERE processed_at IS NULL AND created_at < now() - interval '15 minutes') AS outbox_lag")).rows[0];
    return { ok: q.stuck === 0 && q.outbox_lag === 0, ...q };
  });

  // Файлы локального хранилища по подписанной ссылке.
  app.get("/files", async (req: FastifyRequest<{ Querystring: { key?: string; exp?: string; sig?: string } }>, reply) => {
    if (!(storage instanceof LocalStorage)) return reply.status(404).send();
    const { key, exp: e, sig } = req.query;
    if (!key || !e || !sig || !storage.verify(key, Number(e), sig)) return reply.status(403).send({ message: "Ссылка недействительна или истекла" });
    const data = await storage.get(key);
    if (!data) return reply.status(404).send();
    const sniffed = media.sniff(data);
    return reply.type(key.endsWith(".csv") ? "text/csv; charset=utf-8" : sniffed?.mime ?? "application/octet-stream").header("Content-Disposition", key.endsWith(".csv") ? "attachment; filename=export.csv" : "inline").send(data);
  });

  // Демо-вход: список пользователей для переключателя (только dev).
  app.get("/api/dev/users", async () => {
    if (deps.authMode !== "dev") throw Object.assign(new Error("Недоступно"), { status: 404 });
    return (await deps.db.query("SELECT u.id, u.display_name, array_agg(m.role) AS roles FROM users u JOIN memberships m ON m.user_id = u.id AND m.revoked_at IS NULL WHERE u.is_active GROUP BY u.id ORDER BY u.display_name")).rows;
  });

  app.get("/api/me", h(async (ctx) => {
    const u = (await deps.db.query("SELECT locale FROM users WHERE id = $1", [ctx.actor.id])).rows[0];
    const internal = isInternal(ctx);
    const roles = new Set(ctx.actor.memberships.map((m) => m.role));
    const own = ctx.actor.memberships.filter((m) => m.role === "client" && m.scope_account_id && !m.revoked_at).map((m) => m.scope_account_id);
    const personal = own.length ? (await deps.db.query("SELECT 1 FROM managed_accounts WHERE id = ANY($1::uuid[]) AND kind = 'employee' LIMIT 1", [own])).rows.length > 0 : false;
    return { personal_agent: personal, id: ctx.actor.id, display_name: ctx.actor.display_name, agency_id: ctx.actor.agency_id, roles: [...roles], agency_wide: agencyWide(ctx.actor.memberships), internal, client_only: !internal && roles.has("client") && !roles.has("client_admin"), company_admin: !internal && roles.has("client_admin"), employee: roles.has("client"), company_ids: ctx.actor.memberships.filter((m) => m.role === "client_admin" && !m.revoked_at).map((m) => m.scope_client_id), auditor_only: !internal && !roles.has("client") && !roles.has("client_admin") && roles.has("auditor"), locale: u?.locale ?? "ru", agency_ops: [...allowedOperations(ctx.actor.memberships, {})] };
  }));
  app.patch("/api/me", h(async (ctx, req) => {
    const d = z.object({ locale: z.enum(["ru", "en"]) }).parse(req.body);
    await ctx.db.query("UPDATE users SET locale = $2 WHERE id = $1", [ctx.actor.id, d.locale]);
    return { ok: true };
  }));
  app.get("/api/meta", async () => ({
    capability_catalog: CAPABILITY_CATALOG, strategy_templates: STRATEGY_TEMPLATES, approved_products: (process.env.LINKEDIN_APPROVED_PRODUCTS ?? "").split(",").filter(Boolean),
    request_budget: [500, 2000].map((n) => ({ accounts: n, ...dailyRequestBudget({ accounts: n, syncsPerDay: 4, requestsPerSync: 3, publicationsPerDay: Math.round(n * 0.4), requestsPerPublication: 2, interactionsPerDay: n, reserve: 0.3 }) })),
    ai_provider: { name: aiProvider.name, model: aiProvider.model }, media_limits: MEDIA_LIMITS, triggers: wf.TRIGGERS, audit_criteria: onb.AUDIT_CRITERIA, pipelines: eng.PIPELINES, stages: eng.STAGE_RU,
    auth: { google: authn.googleEnabled(), dev: deps.authMode === "dev" },
  }));

  // Обзор, клиенты, аккаунты
  app.get("/api/overview", h(async (ctx) => ops.agencyOverview(ctx)));
  app.get("/api/clients", h(async (ctx) => {
    // Абонентская плата видна только тем, кому доступны финансы.
    const fee = allowedOperations(ctx.actor.memberships, {}).has("view_finance") ? "monthly_fee" : "NULL::numeric AS monthly_fee";
    return (await ctx.db.query(`SELECT id, name, status, ${fee}, ai_budget_usd_month, approval_sla_hours FROM clients WHERE agency_id = $1 ORDER BY name`, [ctx.actor.agency_id])).rows;
  }));
  app.post("/api/clients", h(async (ctx, req) => acc.createClient(ctx, req.body)));
  app.patch("/api/clients/:id", h<{ id: string }>(async (ctx, req) => {
    requireOp(ctx, "manage_clients", { clientId: req.params.id });
    const d = z.object({ ai_budget_usd_month: z.number().min(0).nullable().optional(), approval_sla_hours: z.number().int().min(1).max(720).optional(), monthly_fee: z.number().min(0).nullable().optional() }).parse(req.body);
    if (d.monthly_fee !== undefined) requireOp(ctx, "view_finance", {});
    const r = await ctx.db.query(`UPDATE clients SET ai_budget_usd_month = CASE WHEN $2::boolean THEN $3 ELSE ai_budget_usd_month END, approval_sla_hours = coalesce($4, approval_sla_hours), monthly_fee = CASE WHEN $5::boolean THEN $6 ELSE monthly_fee END WHERE id = $1 RETURNING id`,
      [req.params.id, d.ai_budget_usd_month !== undefined, d.ai_budget_usd_month ?? null, d.approval_sla_hours ?? null, d.monthly_fee !== undefined, d.monthly_fee ?? null]);
    if (!r.rows.length) throw Object.assign(new Error("Клиент не найден"), { status: 404 });
    return { ok: true };
  }));
  app.post("/api/clients/:id/offboarding", h<{ id: string }>(async (ctx, req) => life.startOffboarding(ctx, { secrets: deps.secrets as any }, req.params.id)));
  app.post("/api/clients/:id/delete-data", h<{ id: string }>(async (ctx, req) => life.deleteClientData(ctx, { systemDb: deps.db, storage, secrets: deps.secrets as any }, req.params.id, req.body)));
  app.get("/api/accounts", h(async (ctx, req) => acc.listAccounts(ctx, { q: req.query.q, attention: req.query.attention === "1", limit: Number(req.query.limit) || undefined, offset: Number(req.query.offset) || undefined })));
  app.post("/api/accounts", h(async (ctx, req) => acc.createAccount(ctx, req.body)));
  app.get("/api/accounts/:id", h<{ id: string }>(async (ctx, req) => acc.accountWorkspace(ctx, req.params.id)));
  app.post("/api/accounts/:id/capabilities/refresh", h<{ id: string }>(async (ctx, req) => acc.refreshCapabilities(ctx, req.params.id)));
  app.post("/api/accounts/:id/consents", h<{ id: string }>(async (ctx, req) => acc.grantConsent(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/consents/:scope/revoke", h<{ id: string; scope: string }>(async (ctx, req) => acc.revokeConsent(ctx, req.params.id, req.params.scope)));
  app.patch("/api/accounts/:id/identity", h<{ id: string }>(async (ctx, req) => acc.setLinkedInIdentity(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/connection/revoke", h<{ id: string }>(async (ctx, req) => acc.markConnectionRevoked(ctx, req.params.id)));
  app.post("/api/accounts/:id/strategies", h<{ id: string }>(async (ctx, req) => acc.createStrategyVersion(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/strategies/:sid/approve", h<{ id: string; sid: string }>(async (ctx, req) => acc.approveStrategy(ctx, req.params.id, req.params.sid)));
  app.post("/api/accounts/:id/knowledge", h<{ id: string }>(async (ctx, req) => acc.addKnowledge(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/content", h<{ id: string }>(async (ctx, req) => content.createContentItem(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/tasks", h<{ id: string }>(async (ctx, req) => ops.createTask(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/metrics", h<{ id: string }>(async (ctx, req) => ops.enterMetrics(ctx, req.params.id, req.body)));
  app.get("/api/accounts/:id/post-metrics", h<{ id: string }>(async (ctx, req) => ops.postMetrics(ctx, req.params.id)));
  app.post("/api/accounts/:id/reports/weekly", h<{ id: string }>(async (ctx, req) => ops.generateWeeklyReport(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/reports/monthly", h<{ id: string }>(async (ctx, req) => reports.generateMonthlyReport(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/opportunities", h<{ id: string }>(async (ctx, req) => ops.addOpportunity(ctx, req.params.id, req.body)));
  app.get("/api/accounts/:id/opportunities", h<{ id: string }>(async (ctx, req) => eng.listOpportunities(ctx, req.params.id)));
  app.post("/api/opportunities/:id/move", h<{ id: string }>(async (ctx, req) => eng.moveOpportunity(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/time", h<{ id: string }>(async (ctx, req) => ops.logTime(ctx, req.params.id, req.body)));
  app.get("/api/reports/:id", h<{ id: string }>(async (ctx, req) => ops.getReport(ctx, req.params.id)));
  app.post("/api/reports/:id/share", h<{ id: string }>(async (ctx, req) => reports.publishReport(ctx, req.params.id)));
  app.post("/api/reports/:id/ai-summary", h<{ id: string }>(async (ctx, req) => ai.aiReportSummary(ctx, aiProvider, req.params.id)));
  app.get("/api/agency-report", h(async (ctx, req) => reports.agencyReport(ctx, { month: req.query.month ?? new Date().toISOString().slice(0, 7) })));

  // Онбординг, аудит профиля, календарь
  app.get("/api/accounts/:id/onboarding", h<{ id: string }>(async (ctx, req) => onb.onboardingStatus(ctx, req.params.id)));
  app.get("/api/accounts/:id/profile-audits", h<{ id: string }>(async (ctx, req) => onb.listAudits(ctx, req.params.id)));
  app.post("/api/accounts/:id/profile-audits", h<{ id: string }>(async (ctx, req) => onb.createProfileAudit(ctx, req.params.id, req.body)));
  app.get("/api/calendar", h(async (ctx, req) => cal.getCalendar(ctx, { from: req.query.from ?? "", to: req.query.to ?? "", account_id: req.query.account_id, mine: req.query.mine === "1" })));
  app.post("/api/accounts/:id/plan-month", h<{ id: string }>(async (ctx, req) => cal.planMonth(ctx, req.params.id, req.body)));
  app.get("/api/accounts/:id/window-stats", h<{ id: string }>(async (ctx, req) => cal.windowStats(ctx, req.params.id)));

  // Медиа
  app.post("/api/accounts/:id/media", h<{ id: string }>(async (ctx, req) => {
    if (!Buffer.isBuffer(req.body)) throw Object.assign(new Error("Ожидается файл (application/octet-stream)"), { status: 415 });
    const name = decodeURIComponent(String(req.headers["x-filename"] ?? "file"));
    return media.uploadMedia(ctx, { storage, scanner }, req.params.id, { filename: name, data: req.body });
  }));
  app.get("/api/accounts/:id/media", h<{ id: string }>(async (ctx, req) => media.listMedia(ctx, req.params.id)));
  app.get("/api/media/:id/url", h<{ id: string }>(async (ctx, req) => media.mediaUrl(ctx, storage, req.params.id)));

  // Контент и согласования
  app.get("/api/content/:id", h<{ id: string }>(async (ctx, req) => content.contentDetail(ctx, req.params.id)));
  app.post("/api/content/:id/versions", h<{ id: string }>(async (ctx, req) => content.addVersion(ctx, req.params.id, req.body)));
  app.post("/api/content/:id/ai-draft", h<{ id: string }>(async (ctx, req) => content.aiDraft(ctx, req.params.id, req.body, aiProvider)));
  app.post("/api/content/:id/ai-review", h<{ id: string }>(async (ctx, req) => ai.aiReview(ctx, aiProvider, req.params.id, (req.body as any)?.role === "fact_checker" ? "fact_checker" : "editor")));
  app.post("/api/content/:id/submit", h<{ id: string }>(async (ctx, req) => content.submitForReview(ctx, req.params.id)));
  app.post("/api/content/:id/decision", h<{ id: string }>(async (ctx, req) => content.decide(ctx, req.params.id, req.body)));
  app.post("/api/content/:id/schedule", h<{ id: string }>(async (ctx, req) => content.schedule(ctx, req.params.id, req.body)));
  app.post("/api/content/:id/cancel", h<{ id: string }>(async (ctx, req) => content.cancelContent(ctx, req.params.id, (req.body as any)?.comment)));
  app.post("/api/content/:id/mark-published", h<{ id: string }>(async (ctx, req) => pub.markPublishedManually(ctx, req.params.id, req.body)));
  app.post("/api/content/:id/resolve-unknown", h<{ id: string }>(async (ctx, req) => pub.resolveUnknown(ctx, req.params.id, req.body)));
  app.get("/api/approvals", h(async (ctx) => content.listApprovals(ctx)));
  app.post("/api/approvals/batch", h(async (ctx, req) => content.decideBatch(ctx, req.body)));

  // Взаимодействия
  app.get("/api/engagement", h(async (ctx, req) => eng.listQueue(ctx, { account_id: req.query.account_id, status: req.query.status })));
  app.post("/api/accounts/:id/engagement", h<{ id: string }>(async (ctx, req) => eng.createRecommendation(ctx, req.params.id, req.body)));
  app.post("/api/engagement/:id/decision", h<{ id: string }>(async (ctx, req) => eng.decideRecommendation(ctx, req.params.id, req.body)));
  app.post("/api/engagement/:id/executed", h<{ id: string }>(async (ctx, req) => eng.markExecuted(ctx, req.params.id, req.body)));
  app.get("/api/accounts/:id/engagement-sources", h<{ id: string }>(async (ctx, req) => eng.listSources(ctx, req.params.id)));
  app.post("/api/accounts/:id/engagement-sources", h<{ id: string }>(async (ctx, req) => eng.addSource(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/ai/comment", h<{ id: string }>(async (ctx, req) => ai.aiSuggestComment(ctx, aiProvider, req.params.id, req.body)));

  // Улучшение стратегии
  app.get("/api/accounts/:id/insights", h<{ id: string }>(async (ctx, req) => ins.listInsights(ctx, req.params.id)));
  app.post("/api/accounts/:id/insights/run", h<{ id: string }>(async (ctx, req) => ins.runAnalysisNow(ctx, req.params.id)));
  app.post("/api/strategy-recommendations/:id/decision", h<{ id: string }>(async (ctx, req) => ins.decideRecommendation(ctx, req.params.id, req.body)));
  app.post("/api/experiments/:id/conclude", h<{ id: string }>(async (ctx, req) => ins.concludeExperiment(ctx, req.params.id, req.body)));
  app.get("/api/ai/quality", h(async (ctx) => ai.aiQuality(ctx)));

  // Задачи, сценарии, уведомления
  app.get("/api/tasks", h(async (ctx, req) => ops.listTasks(ctx, { mine: req.query.mine === "1", status: req.query.status, limit: Number(req.query.limit) || undefined })));
  app.patch("/api/tasks/:id", h<{ id: string }>(async (ctx, req) => ops.updateTask(ctx, req.params.id, req.body)));
  app.post("/api/bulk/tasks", h(async (ctx, req) => acc.bulkCreateTasks(ctx, req.body)));
  app.get("/api/workflows", h(async (ctx) => wf.listWorkflows(ctx)));
  app.post("/api/workflows", h(async (ctx, req) => wf.saveWorkflow(ctx, req.body)));
  app.post("/api/workflows/:id/enabled", h<{ id: string }>(async (ctx, req) => wf.setWorkflowEnabled(ctx, req.params.id, !!(req.body as any)?.enabled)));
  app.post("/api/workflows/:id/preview", h<{ id: string }>(async (ctx, req) => wf.previewWorkflow(ctx, req.params.id, req.body ?? {})));
  app.get("/api/workflows/:id/runs", h<{ id: string }>(async (ctx, req) => wf.workflowRuns(ctx, req.params.id)));
  app.get("/api/notifications", h(async (ctx, req) => notifySvc.listNotifications(ctx, req.query.unread === "1")));
  app.post("/api/notifications/read", h(async (ctx, req) => notifySvc.markRead(ctx, (req.body as any)?.ids ?? "all")));

  // Публикация: аварийная пауза
  app.post("/api/publishing/pause", h(async (ctx, req) => pub.pausePublishing(ctx, req.body)));

  // Команда, инциденты, аудит, экспорты
  app.get("/api/team", h(async (ctx) => team.listTeam(ctx)));
  app.post("/api/team/invite", h(async (ctx, req) => team.inviteUser(ctx, req.body)));
  app.post("/api/team/roles", h(async (ctx, req) => team.grantRole(ctx, req.body)));
  app.post("/api/team/roles/:id/revoke", h<{ id: string }>(async (ctx, req) => team.revokeRole(ctx, req.params.id)));
  app.patch("/api/team/:id", h<{ id: string }>(async (ctx, req) => team.updateCapacity(ctx, req.params.id, req.body)));
  app.post("/api/users/:id/offboard", h<{ id: string }>(async (ctx, req) => ops.offboardUser(ctx, req.params.id)));
  app.get("/api/users", h(async (ctx) => ops.listUsers(ctx)));
  app.get("/api/incidents", h(async (ctx, req) => team.listIncidents(ctx, req.query.status)));
  app.post("/api/incidents", h(async (ctx, req) => team.createIncident(ctx, req.body)));
  app.post("/api/incidents/:id/resolve", h<{ id: string }>(async (ctx, req) => team.resolveIncident(ctx, req.params.id, req.body)));
  app.get("/api/audit", h(async (ctx, req) => ops.auditLog(ctx, { account_id: req.query.account_id, limit: Number(req.query.limit) || undefined })));
  app.post("/api/exports", h(async (ctx, req) => exp.requestExport(ctx, req.body)));
  app.get("/api/exports", h(async (ctx) => exp.listExports(ctx)));
  app.get("/api/exports/:id/download", h<{ id: string }>(async (ctx, req) => exp.downloadExport(ctx, storage, req.params.id)));

  // Кабинет клиента
  app.get("/api/portal", h(async (ctx) => portal.portalHome(ctx)));

  // B2B: компании, агенты, миссии, сотрудники
  app.get("/api/companies", h(async (ctx) => company.listCompanies(ctx)));
  app.get("/api/companies/portfolio", h(async (ctx) => company.portfolio(ctx, deps.db)));
  app.get("/api/companies/:id", h<{ id: string }>(async (ctx, req) => company.companyOverview(ctx, deps.db, req.params.id)));
  app.post("/api/companies/:id/brief", h<{ id: string }>(async (ctx, req) => company.proposeBrief(ctx, req.params.id, req.body)));
  app.post("/api/briefs/:id/approve", h<{ id: string }>(async (ctx, req) => company.approveBrief(ctx, req.params.id, req.body)));
  app.post("/api/companies/:id/pause", h<{ id: string }>(async (ctx, req) => company.pauseCompany(ctx, deps.db, req.params.id, req.body)));
  app.get("/api/companies/:id/invites", h<{ id: string }>(async (ctx, req) => company.listInvites(ctx, deps.db, req.params.id)));
  app.post("/api/companies/:id/invites", h<{ id: string }>(async (ctx, req) => company.createInvite(ctx, deps.db, req.params.id, req.body, { mailer: deps.mailer, exposeLink: deps.authMode === "dev" })));
  app.post("/api/invites/:id/revoke", h<{ id: string }>(async (ctx, req) => company.revokeInvite(ctx, deps.db, req.params.id)));
  app.get("/api/invites/preview", async (req: FastifyRequest<{ Querystring: { token?: string } }>) => {
    if (!inviteLimit(req.ip)) throw Object.assign(new Error("Слишком много попыток"), { status: 429 });
    return company.invitePreview(deps.db, String(req.query.token ?? ""));
  });
  app.post("/api/invites/accept", async (req: FastifyRequest) => {
    if (!inviteLimit(req.ip)) throw Object.assign(new Error("Слишком много попыток"), { status: 429 });
    const authed = deps.authMode === "header" ? (req.headers["x-authenticated-user-id"] as string | undefined) ?? null : null;
    // В production принять приглашение может только вошедший через IdP пользователь, которому оно выдано.
    return company.acceptInvite(deps.db, req.body, authed, deps.authMode === "header");
  });
  app.post("/api/accounts/:id/confirm-employment", h<{ id: string }>(async (ctx, req) => company.confirmEmployment(ctx, deps.db, req.params.id)));
  app.post("/api/accounts/:id/signals", h<{ id: string }>(async (ctx, req) => company.reportSignal(ctx, deps.db, req.params.id, req.body)));
  app.post("/api/accounts/:id/safety/restore", h<{ id: string }>(async (ctx, req) => company.restoreAccount(ctx, deps.db, req.params.id)));
  app.get("/api/companies/:id/missions", h<{ id: string }>(async (ctx, req) => missions.listMissions(ctx, req.params.id)));
  app.post("/api/companies/:id/missions", h<{ id: string }>(async (ctx, req) => missions.createMission(ctx, { systemDb: deps.db, ai: aiProvider }, req.params.id, req.body)));
  app.get("/api/missions/:id", h<{ id: string }>(async (ctx, req) => missions.missionDetail(ctx, deps.db, req.params.id)));
  app.post("/api/missions/:id/cancel", h<{ id: string }>(async (ctx, req) => missions.cancelMission(ctx, deps.db, req.params.id, req.body)));
  app.get("/api/me/participation", h(async (ctx) => company.myParticipation(ctx)));
  app.patch("/api/me/participation/:accountId", h<{ accountId: string }>(async (ctx, req) => company.updateMyProfile(ctx, req.params.accountId, req.body)));
  app.get("/api/me/actions", h(async (ctx) => missions.myActions(ctx)));
  app.post("/api/mission-actions/:id/decision", h<{ id: string }>(async (ctx, req) => missions.decideAction(ctx, deps.db, req.params.id, req.body)));
  app.post("/api/mission-actions/:id/done", h<{ id: string }>(async (ctx, req) => missions.markActionDone(ctx, req.params.id, req.body, deps.db)));
  // Личный агент сотрудника и автопилот.
  const agentAi = deps.agentAi ?? aiProvider;
  const fileName = (req: FastifyRequest) => decodeURIComponent(String(req.headers["x-filename"] ?? "photo")).slice(0, 200);
  app.get("/api/me/agent", h(async (ctx) => agent.myAgent(ctx, deps.db)));
  app.post("/api/me/agent/:accountId/role", h<{ accountId: string }>(async (ctx, req) => agent.setRole(ctx, req.params.accountId, req.body)));
  app.post("/api/me/agent/:accountId/interview", h<{ accountId: string }>(async (ctx, req) => agent.saveInterview(ctx, req.params.accountId, req.body)));
  app.post("/api/me/agent/:accountId/samples", h<{ accountId: string }>(async (ctx, req) => agent.samplePosts(ctx, deps.db, req.params.accountId, agentAi)));
  app.post("/api/me/agent/:accountId/passport/confirm", h<{ accountId: string }>(async (ctx, req) => agent.confirmPassport(ctx, deps.db, req.params.accountId, req.body)));
  app.post("/api/me/agent/:accountId/autopilot", h<{ accountId: string }>(async (ctx, req) => agent.setAutopilot(ctx, deps.db, req.params.accountId, req.body)));
  app.post("/api/autopilot-posts/:id/action", h<{ id: string }>(async (ctx, req) => agent.ownerPostAction(ctx, deps.db, req.params.id, req.body)));
  app.post("/api/me/agent/:accountId/pack/approve", h<{ accountId: string }>(async (ctx, req) => agent.approvePack(ctx, deps.db, req.params.accountId)));
  app.post("/api/me/agent/:accountId/telegram/link", h<{ accountId: string }>(async (ctx, req) => agent.telegramLink(ctx, req.params.accountId, deps.telegram)));
  app.post("/api/me/agent/:accountId/telegram/unlink", h<{ accountId: string }>(async (ctx, req) => agent.telegramUnlink(ctx, req.params.accountId)));
  app.post("/api/me/agent/:accountId/likeness", h<{ accountId: string }>(async (ctx, req) => agent.grantLikeness(ctx, req.params.accountId)));
  app.post("/api/me/agent/:accountId/likeness/revoke", h<{ accountId: string }>(async (ctx, req) => agent.revokeLikeness(ctx, { storage }, req.params.accountId)));
  app.post("/api/me/agent/:accountId/photos", h<{ accountId: string }>(async (ctx, req) => {
    if (!Buffer.isBuffer(req.body)) throw Object.assign(new Error("Ожидается файл (application/octet-stream)"), { status: 415 });
    return agent.addPortraitPhoto(ctx, { storage, scanner }, req.params.accountId, { filename: fileName(req), data: req.body });
  }));
  app.post("/api/me/agent/:accountId/portraits", h<{ accountId: string }>(async (ctx, req) => agent.requestPortraits(ctx, req.params.accountId, req.body)));
  app.post("/api/portrait-jobs/:id/choose", h<{ id: string }>(async (ctx, req) => agent.choosePortrait(ctx, deps.db, req.params.id, req.body)));
  app.get("/api/companies/:id/autopilot", h<{ id: string }>(async (ctx, req) => agent.companyAutopilot(ctx, deps.db, req.params.id)));
  app.post("/api/companies/:id/autopilot/review", h<{ id: string }>(async (ctx, req) => agent.reviewPosts(ctx, deps.db, req.params.id, req.body)));
  app.post("/api/accounts/:id/agent/budget", h<{ id: string }>(async (ctx, req) => agent.setAgentBudget(ctx, req.params.id, req.body)));
  // Стратегии, подписка, лиды.
  const payments = deps.payments ?? new billing.DemoPaymentProvider();
  app.post("/api/me/agent/:accountId/strategy", h<{ accountId: string }>(async (ctx, req) => agent.setMyStrategy(ctx, deps.db, req.params.accountId, req.body)));
  app.post("/api/companies/:id/strategy", h<{ id: string }>(async (ctx, req) => agent.setCompanyStrategy(ctx, deps.db, req.params.id, req.body)));
  app.post("/api/me/agent/:accountId/promo", h<{ accountId: string }>(async (ctx, req) => billing.redeemPromo(ctx, deps.db, req.params.accountId, req.body)));
  app.post("/api/billing/checkout", h(async (ctx, req) => billing.startCheckout(ctx, deps.db, { payments, appUrl: process.env.APP_URL }, req.body)));
  app.post("/api/billing/demo/:id/confirm", h<{ id: string }>(async (ctx, req) => billing.confirmDemoCheckout(ctx, deps.db, payments, req.params.id)));
  app.get("/api/companies/:id/billing", h<{ id: string }>(async (ctx, req) => billing.companyBilling(ctx, deps.db, req.params.id)));
  app.get("/api/promo-codes", h(async (ctx) => billing.listPromos(ctx)));
  app.post("/api/promo-codes", h(async (ctx, req) => billing.createPromo(ctx, req.body)));
  app.get("/api/me/outreach/:accountId", h<{ accountId: string }>(async (ctx, req) => outreach.myOutreach(ctx, req.params.accountId)));
  app.get("/api/me/agent/:accountId/chat", h<{ accountId: string }>(async (ctx, req) => chat.chatHistory(ctx, req.params.accountId)));
  app.post("/api/me/agent/:accountId/chat", h<{ accountId: string }>(async (ctx, req) => chat.agentChat(ctx, deps.db, req.params.accountId, req.body, agentAi)));
  app.get("/api/me/agent/:accountId/plan", h<{ accountId: string }>(async (ctx, req) => chat.contentPlan(ctx, req.params.accountId)));
  app.post("/api/me/agent/:accountId/x/connect", h<{ accountId: string }>(async (ctx, req) => agent.connectX(ctx, deps.db, deps.secrets as any, req.params.accountId)));
  app.post("/api/me/agent/add-network", h(async (ctx, req) => agent.addNetwork(ctx, deps.db, req.body)));
  app.get("/api/me/agent/:accountId/x-engagements", h<{ accountId: string }>(async (ctx, req) => xengage.myXEngagements(ctx, req.params.accountId)));
  app.post("/api/me/agent/:accountId/x-targets", h<{ accountId: string }>(async (ctx, req) => xengage.importXTargets(ctx, req.params.accountId, req.body)));
  app.post("/api/x-engagements/:id/action", h<{ id: string }>(async (ctx, req) => xengage.markXEngagement(ctx, { xAdapter: deps.xAdapter!, secrets: deps.secrets as any }, req.params.id, req.body)));
  app.post("/api/me/outreach/:accountId/import", h<{ accountId: string }>(async (ctx, req) => outreach.importLeads(ctx, req.params.accountId, req.body)));
  app.post("/api/outreach/:id/mark", h<{ id: string }>(async (ctx, req) => outreach.markOutreach(ctx, req.params.id, req.body)));
  // Вебхук Stripe: подпись проверяется по сырому телу запроса.
  app.register(async (sub) => {
    sub.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    sub.post("/billing/stripe/webhook", async (req: FastifyRequest) => billing.paymentWebhook(deps.db, payments, String(req.body ?? ""), req.headers as Record<string, string | undefined>));
  });
  const tgLimit = rateLimiter(120);
  app.post("/telegram/webhook", async (req: FastifyRequest, reply) => {
    if (!tgLimit(req.ip)) return reply.status(429).send();
    if (!deps.telegram) return reply.status(404).send();
    await agent.handleTelegramUpdate(deps.db, { telegram: deps.telegram, callbackSecret: process.env.TELEGRAM_CALLBACK_SECRET ?? "", webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET, agentAi },
      req.headers["x-telegram-bot-api-secret-token"] as string | undefined, req.body);
    return { ok: true };
  });
  app.get("/api/portal/accounts/:id", h<{ id: string }>(async (ctx, req) => portal.portalAccount(ctx, req.params.id)));

  // LinkedIn OAuth. Работает только при заданных LINKEDIN_CLIENT_ID/SECRET/REDIRECT_URI.
  const pendingStates = new Map<string, { accountId: string; userId: string; exp: number }>();
  app.get("/api/accounts/:id/oauth/start", h<{ id: string }>(async (ctx, req, reply) => {
    const cid = process.env.LINKEDIN_CLIENT_ID, redirect = process.env.LINKEDIN_REDIRECT_URI;
    if (!cid || !redirect) throw Object.assign(new Error("Интеграция LinkedIn не настроена: используйте публикацию через человека"), { status: 409 });
    const a = await accountScope(ctx.db, ctx, req.params.id);
    // Сотрудник подключает свой профиль сам: официальный вход LinkedIn, пароль платформа не видит.
    if (!(a.kind !== "company_page" && isAccountOwner(ctx, a.id))) requireOp(ctx, "manage_connection", { clientId: a.client_id, accountId: a.id });
    for (const [k, v] of pendingStates) if (v.exp < Date.now()) pendingStates.delete(k);
    const state = randomBytes(24).toString("hex");
    pendingStates.set(state, { accountId: a.id, userId: ctx.actor.id, exp: Date.now() + 10 * 60_000 });
    const scopes = a.kind === "company_page" ? "openid profile w_organization_social r_organization_social rw_organization_admin" : "openid profile w_member_social";
    const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}&scope=${encodeURIComponent(scopes)}`;
    return reply.send({ authorize_url: url });
  }));
  app.get("/oauth/linkedin/callback", async (req: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>, reply) => {
    const st = req.query.state && pendingStates.get(req.query.state);
    if (!st || st.exp < Date.now()) return reply.status(400).send("Неверный или просроченный state");
    pendingStates.delete(req.query.state!);
    if (req.query.error || !req.query.code) return reply.status(400).send("Пользователь отказал в доступе");
    const tok = await fetch("https://www.linkedin.com/oauth/v2/accessToken", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: req.query.code, client_id: process.env.LINKEDIN_CLIENT_ID!, client_secret: process.env.LINKEDIN_CLIENT_SECRET!, redirect_uri: process.env.LINKEDIN_REDIRECT_URI! }) });
    if (!tok.ok) return reply.status(502).send("Не удалось получить токен");
    const t: any = await tok.json();
    const info: any = await (await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    const ref = `linkedin/${st.accountId}/${Date.now()}`;
    if (!("set" in deps.secrets) || !deps.secrets.set) return reply.status(500).send("Хранилище секретов только для чтения");
    await deps.secrets.set(ref, t.access_token);
    const actor = await loadActor(deps.db, st.userId);
    if (!actor) return reply.status(401).send("Пользователь отключён");
    if (!info?.sub) return reply.status(502).send("LinkedIn не вернул идентификатор пользователя");
    // Страница компании: публикация только от имени организации, которую пользователь администрирует.
    const kind = (await deps.db.query("SELECT kind FROM managed_accounts WHERE id = $1", [st.accountId])).rows[0]?.kind;
    const organization_urns = kind === "company_page"
      ? await new LinkedInHttpAdapter().listAdministeredOrganizations({ accessToken: t.access_token, apiVersion: process.env.LINKEDIN_API_VERSION ?? "202608" }).catch(() => [])
      : undefined;
    try {
      await acc.recordOAuthConnection(actorCtx(deps.db, actor), st.accountId, { organization_urns, external_subject: `urn:li:person:${info.sub}`, granted_scopes: String(t.scope ?? "").split(/[ ,]/).filter(Boolean), secret_ref: ref, expires_at: new Date(Date.now() + (t.expires_in ?? 0) * 1000).toISOString() });
    } catch (e: any) {
      if (deps.secrets.delete) await deps.secrets.delete(ref);
      return reply.status(e?.status ?? 500).send(e?.message ?? "Не удалось сохранить подключение");
    }
    return reply.redirect(actor.memberships.some((m) => m.role === "client" && m.scope_account_id === st.accountId) ? "/#/me/agent" : `/#/accounts/${st.accountId}`);
  });

  return app;
}
