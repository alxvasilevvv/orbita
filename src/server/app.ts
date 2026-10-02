import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ZodError } from "zod";
import type { Db } from "../db/db";
import { loadActor, type Ctx } from "../services/context";
import * as acc from "../services/accounts";
import * as content from "../services/content";
import * as pub from "../services/publishing";
import * as ops from "../services/operations";
import { CAPABILITY_CATALOG } from "../core/capabilities";
import { STRATEGY_TEMPLATES } from "../core/templates";
import { dailyRequestBudget } from "../core/heuristics";
import type { SecretStore } from "../services/publishing";

const here = dirname(fileURLToPath(import.meta.url));

export interface AppDeps { db: Db; secrets: SecretStore & { set?(k: string, v: string): unknown }; authMode: "dev" | "header" }

export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie"] } });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.status(422).send({ error: "validation_error", message: "Некорректные данные", details: err.issues });
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) app.log.error({ err: { message: err.message, stack: err.stack } }, "unhandled");
    return reply.status(status).send({ error: err.constructor?.name ?? "Error", message: status >= 500 ? "Внутренняя ошибка" : err.message, details: err.details });
  });

  /**
   * Аутентификация. dev: пользователь из заголовка x-user-id (только вне production).
   * header: доверенный заголовок от OIDC-прокси с MFA (oauth2-proxy / IdP), см. docs/adr/0003.
   */
  async function ctxOf(req: FastifyRequest): Promise<Ctx> {
    const id = deps.authMode === "dev" ? (req.headers["x-user-id"] as string) : (req.headers["x-authenticated-user-id"] as string);
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw Object.assign(new Error("Требуется вход"), { status: 401 });
    const actor = await loadActor(deps.db, id);
    if (!actor) throw Object.assign(new Error("Пользователь не найден или отключён"), { status: 401 });
    return { db: deps.db, actor };
  }
  type Req<P> = FastifyRequest<{ Params: P; Body: any; Querystring: Record<string, string | undefined> }>;
  const h = <P = any>(fn: (ctx: Ctx, req: Req<P>, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest<any>, reply: FastifyReply) => fn(await ctxOf(req), req as Req<P>, reply);

  // Статика UI
  app.get("/", async (_r, reply) => reply.type("text/html").send(await readFile(join(here, "../../public/index.html"))));
  app.get("/app.js", async (_r, reply) => reply.type("application/javascript").send(await readFile(join(here, "../../public/app.js"))));
  app.get("/app.css", async (_r, reply) => reply.type("text/css").send(await readFile(join(here, "../../public/app.css"))));
  app.get("/healthz", async () => {
    await deps.db.query("SELECT 1");
    return { ok: true };
  });

  // Демо-вход: список пользователей для переключателя (только dev).
  app.get("/api/dev/users", async () => {
    if (deps.authMode !== "dev") throw Object.assign(new Error("Недоступно"), { status: 404 });
    return (await deps.db.query("SELECT u.id, u.display_name, array_agg(m.role) AS roles FROM users u JOIN memberships m ON m.user_id = u.id AND m.revoked_at IS NULL WHERE u.is_active GROUP BY u.id ORDER BY u.display_name")).rows;
  });

  app.get("/api/me", h(async (ctx) => ctx.actor));
  app.get("/api/meta", async () => ({ capability_catalog: CAPABILITY_CATALOG, strategy_templates: STRATEGY_TEMPLATES, approved_products: (process.env.LINKEDIN_APPROVED_PRODUCTS ?? "").split(",").filter(Boolean),
    request_budget: [500, 2000].map((n) => ({ accounts: n, ...dailyRequestBudget({ accounts: n, syncsPerDay: 4, requestsPerSync: 3, publicationsPerDay: Math.round(n * 0.4), requestsPerPublication: 2, interactionsPerDay: n, reserve: 0.3 }) })) }));

  app.get("/api/overview", h(async (ctx) => ops.agencyOverview(ctx)));
  app.get("/api/accounts", h(async (ctx, req) => acc.listAccounts(ctx, { q: req.query.q, attention: req.query.attention === "1", limit: Number(req.query.limit) || undefined, offset: Number(req.query.offset) || undefined })));
  app.post("/api/clients", h(async (ctx, req) => acc.createClient(ctx, req.body)));
  app.post("/api/accounts", h(async (ctx, req) => acc.createAccount(ctx, req.body)));
  app.get<{ Params: { id: string } }>("/api/accounts/:id", h<{ id: string }>(async (ctx, req) => acc.accountWorkspace(ctx, req.params.id)));
  app.post("/api/accounts/:id/capabilities/refresh", h<{ id: string }>(async (ctx, req) => acc.refreshCapabilities(ctx, req.params.id)));
  app.post("/api/accounts/:id/consents", h<{ id: string }>(async (ctx, req) => acc.grantConsent(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/consents/:scope/revoke", h<{ id: string; scope: string }>(async (ctx, req) => acc.revokeConsent(ctx, req.params.id, req.params.scope)));
  app.post("/api/accounts/:id/connection/revoke", h<{ id: string }>(async (ctx, req) => acc.markConnectionRevoked(ctx, req.params.id)));
  app.post("/api/accounts/:id/strategies", h<{ id: string }>(async (ctx, req) => acc.createStrategyVersion(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/strategies/:sid/approve", h<{ id: string; sid: string }>(async (ctx, req) => acc.approveStrategy(ctx, req.params.id, req.params.sid)));
  app.post("/api/accounts/:id/knowledge", h<{ id: string }>(async (ctx, req) => acc.addKnowledge(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/content", h<{ id: string }>(async (ctx, req) => content.createContentItem(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/tasks", h<{ id: string }>(async (ctx, req) => ops.createTask(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/metrics", h<{ id: string }>(async (ctx, req) => ops.enterMetrics(ctx, req.params.id, req.body)));
  app.get("/api/accounts/:id/post-metrics", h<{ id: string }>(async (ctx, req) => ops.postMetrics(ctx, req.params.id)));
  app.post("/api/accounts/:id/reports/weekly", h<{ id: string }>(async (ctx, req) => ops.generateWeeklyReport(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/opportunities", h<{ id: string }>(async (ctx, req) => ops.addOpportunity(ctx, req.params.id, req.body)));
  app.post("/api/accounts/:id/time", h<{ id: string }>(async (ctx, req) => ops.logTime(ctx, req.params.id, req.body)));
  app.get("/api/reports/:id", h<{ id: string }>(async (ctx, req) => ops.getReport(ctx, req.params.id)));

  app.get("/api/content/:id", h<{ id: string }>(async (ctx, req) => content.contentDetail(ctx, req.params.id)));
  app.post("/api/content/:id/versions", h<{ id: string }>(async (ctx, req) => content.addVersion(ctx, req.params.id, req.body)));
  app.post("/api/content/:id/ai-draft", h<{ id: string }>(async (ctx, req) => content.aiDraft(ctx, req.params.id, req.body)));
  app.post("/api/content/:id/submit", h<{ id: string }>(async (ctx, req) => content.submitForReview(ctx, req.params.id)));
  app.post("/api/content/:id/decision", h<{ id: string }>(async (ctx, req) => content.decide(ctx, req.params.id, req.body)));
  app.post("/api/content/:id/schedule", h<{ id: string }>(async (ctx, req) => content.schedule(ctx, req.params.id, req.body)));
  app.post("/api/content/:id/cancel", h<{ id: string }>(async (ctx, req) => content.cancelContent(ctx, req.params.id, (req.body as any)?.comment)));
  app.post("/api/content/:id/mark-published", h<{ id: string }>(async (ctx, req) => pub.markPublishedManually(ctx, req.params.id, req.body)));
  app.post("/api/content/:id/resolve-unknown", h<{ id: string }>(async (ctx, req) => pub.resolveUnknown(ctx, req.params.id, req.body)));

  app.get("/api/approvals", h(async (ctx) => content.listApprovals(ctx)));
  app.get("/api/tasks", h(async (ctx, req) => ops.listTasks(ctx, { mine: req.query.mine === "1", status: req.query.status })));
  app.patch("/api/tasks/:id", h<{ id: string }>(async (ctx, req) => ops.updateTask(ctx, req.params.id, req.body)));
  app.post("/api/bulk/tasks", h(async (ctx, req) => acc.bulkCreateTasks(ctx, req.body)));
  app.post("/api/publishing/pause", h(async (ctx, req) => pub.pausePublishing(ctx, req.body)));
  app.get("/api/audit", h(async (ctx, req) => ops.auditLog(ctx, { account_id: req.query.account_id, limit: Number(req.query.limit) || undefined })));
  app.get("/api/users", h(async (ctx) => ops.listUsers(ctx)));
  app.post("/api/users/:id/offboard", h<{ id: string }>(async (ctx, req) => ops.offboardUser(ctx, req.params.id)));

  // LinkedIn OAuth. Работает только при заданных LINKEDIN_CLIENT_ID/SECRET/REDIRECT_URI.
  const pendingStates = new Map<string, { accountId: string; userId: string; exp: number }>();
  app.get("/api/accounts/:id/oauth/start", h<{ id: string }>(async (ctx, req, reply) => {
    const cid = process.env.LINKEDIN_CLIENT_ID, redirect = process.env.LINKEDIN_REDIRECT_URI;
    if (!cid || !redirect) throw Object.assign(new Error("Интеграция LinkedIn не настроена: используйте assisted-процесс"), { status: 409 });
    const a = await import("../services/context").then((m) => m.accountScope(ctx.db, ctx, req.params.id));
    (await import("../services/context")).requireOp(ctx, "manage_connection", { clientId: a.client_id, accountId: a.id });
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
    if (!deps.secrets.set) return reply.status(500).send("Хранилище секретов только для чтения");
    await deps.secrets.set(ref, t.access_token);
    const actor = await loadActor(deps.db, st.userId);
    await acc.recordOAuthConnection({ db: deps.db, actor: actor! }, st.accountId, { external_subject: `urn:li:person:${info.sub}`, granted_scopes: String(t.scope ?? "").split(/[ ,]/).filter(Boolean), secret_ref: ref, expires_at: new Date(Date.now() + (t.expires_in ?? 0) * 1000).toISOString() });
    return reply.redirect(`/#/accounts/${st.accountId}`);
  });

  return app;
}
