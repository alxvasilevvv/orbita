import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { setup, APPROVED } from "./helpers";
import * as content from "../src/services/content";
import * as acc from "../src/services/accounts";
import * as pub from "../src/services/publishing";
import * as ops from "../src/services/operations";
import * as wf from "../src/services/workflows";
import { aggregate, periodsDisjoint } from "../src/core/metrics";
import { parseOrganizationAcls } from "../src/integrations/linkedin/adapter";
import { buildApp } from "../src/server/app";

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { env = await setup(); process.env.LINKEDIN_APPROVED_PRODUCTS = ""; });
afterEach(async () => { await env.db.close(); });

const worker = () => ({ db: env.db, adapter: env.adapter, secrets: env.secrets, workerId: "test" });
const localIn = (tz: string, d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const soon = () => localIn("America/New_York", new Date(Date.now() + 3600_000));

async function approvedItem(accountName = "John Smith (CEO)", clientApprover = "client") {
  const a = await env.acct(accountName);
  const author = await env.ctx("author");
  const it = await content.createContentItem(author, a.id, { title: "Тест", body: "Мы перевели три завода на предиктивное обслуживание." });
  await content.submitForReview(author, it.id);
  await content.decide(await env.ctx("editor"), it.id, { decision: "approved" });
  await content.decide(await env.ctx(clientApprover), it.id, { decision: "approved" });
  return { a, itemId: it.id as string };
}
const openTasks = async (ref: string) => (await env.db.query("SELECT status FROM tasks WHERE source_ref = $1", [ref])).rows.map((r: any) => r.status);

describe("RLS v3: роль на аккаунт не открывает соседние аккаунты", () => {
  it("представитель клиента с ролью на аккаунт не видит страницу компании того же клиента и внутренние таблицы", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const a2 = await env.acct("Northwind Robotics (страница)");
    const client = await env.ctx("client");
    const accs = (await client.db.query("SELECT id FROM managed_accounts")).rows.map((r: any) => r.id);
    expect(accs).toEqual([a1.id]);
    expect((await client.db.query("SELECT count(*)::int n FROM content_items WHERE account_id = $1", [a2.id])).rows[0].n).toBe(0);
    expect((await client.db.query("SELECT count(*)::int n FROM consents WHERE account_id = $1", [a2.id])).rows[0].n).toBe(0);
    // Внутренние таблицы закрыты целиком, даже по своему аккаунту.
    await env.db.query("INSERT INTO tasks(client_id, account_id, type, title) VALUES ($1,$2,'x','внутренняя')", [a1.client_id, a1.id]);
    for (const t of ["tasks", "time_entries", "workflow_runs", "incidents", "profile_audits", "strategy_recommendations", "experiments"]) {
      expect((await client.db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, t).toBe(0);
    }
    // Клиента видно (строка уровня клиента), его аккаунт тоже.
    expect((await client.db.query("SELECT name FROM clients")).rows.map((r: any) => r.name)).toEqual(["Northwind Robotics"]);
  });

  it("сотрудник агентства продолжает видеть внутренние таблицы", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    await env.db.query("INSERT INTO tasks(client_id, account_id, type, title) VALUES ($1,$2,'x','внутренняя')", [a1.client_id, a1.id]);
    const m = await env.ctx("manager");
    expect((await m.db.query("SELECT count(*)::int n FROM tasks WHERE account_id = $1", [a1.id])).rows[0].n).toBeGreaterThan(0);
  });

  it("проверка взаимной поддержки работает по новой сигнатуре и не раскрывает чужой аккаунт", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const r = (await (await env.ctx("author2")).db.query("SELECT target_is_other_managed_account($1, $2, $3) AS hit", [
      (await env.acct("Елена Петрова")).id, "https://www.linkedin.com/in/example-john-smith/recent-activity", null])).rows[0].hit;
    expect(r).toBe(true);
    const self = (await (await env.ctx("author")).db.query("SELECT target_is_other_managed_account($1, $2, $3) AS hit", [a1.id, "https://www.linkedin.com/in/example-john-smith/x", null])).rows[0].hit;
    expect(self).toBe(false);
  });
});

describe("HTTP: маршруты для клиента и аудитора", () => {
  it("клиенту закрыты внутренние разделы, кабинет и согласование открыты", async () => {
    const app = buildApp({ db: env.db, secrets: env.secrets, authMode: "dev" });
    const H = { "x-user-id": env.u.client };
    for (const url of ["/api/tasks", "/api/accounts", "/api/approvals", "/api/engagement", "/api/users", "/api/overview", "/api/calendar?from=2026-01-01&to=2026-02-01", "/api/workflows", "/api/audit"]) {
      expect((await app.inject({ method: "GET", url, headers: H })).statusCode, url).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: "/api/portal", headers: H })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: H })).statusCode).toBe(200);
    const a1 = await env.acct("John Smith (CEO)");
    expect((await app.inject({ method: "POST", url: `/api/accounts/${a1.id}/time`, headers: H, payload: { minutes: 30, work_date: "2026-10-01" } })).statusCode).toBe(403);
    const aud = { "x-user-id": env.u.auditor };
    expect((await app.inject({ method: "GET", url: "/api/audit", headers: aud })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/tasks", headers: aud })).statusCode).toBe(403);
  });

  it("абонентская плата и адреса почты видны только уполномоченным", async () => {
    const app = buildApp({ db: env.db, secrets: env.secrets, authMode: "dev" });
    const asAuthor = await app.inject({ method: "GET", url: "/api/clients", headers: { "x-user-id": env.u.author } });
    expect(asAuthor.json().every((c: any) => c.monthly_fee == null)).toBe(true);
    const asOwner = await app.inject({ method: "GET", url: "/api/clients", headers: { "x-user-id": env.u.owner } });
    expect(asOwner.json().some((c: any) => c.monthly_fee != null)).toBe(true);
    const users = (await app.inject({ method: "GET", url: "/api/users", headers: { "x-user-id": env.u.author } })).json();
    expect(users.every((u: any) => u.email == null)).toBe(true);
    const usersOwner = (await app.inject({ method: "GET", url: "/api/users", headers: { "x-user-id": env.u.owner } })).json();
    expect(usersOwner.some((u: any) => u.email)).toBe(true);
  });
});

describe("задания публикации и задачи", () => {
  it("правка текста отменяет задачу ручной публикации прежней версии", async () => {
    const { itemId } = await approvedItem();
    const r: any = await content.schedule(await env.ctx("manager"), itemId, { local_time: soon() });
    expect(r.job.mode).toBe("assisted");
    expect(await openTasks(`assisted:${r.job.id}`)).toEqual(["open"]);
    await content.addVersion(await env.ctx("author"), itemId, { body: "Новая формулировка поста." });
    expect((await env.db.query("SELECT status FROM publication_jobs WHERE id = $1", [r.job.id])).rows[0].status).toBe("cancelled");
    expect(await openTasks(`assisted:${r.job.id}`)).toEqual(["cancelled"]);
  });

  it("отзыв согласия клиентом отменяет задание и задачу, материал возвращается в «согласован»", async () => {
    const { a, itemId } = await approvedItem();
    const r: any = await content.schedule(await env.ctx("manager"), itemId, { local_time: soon() });
    await acc.revokeConsent(await env.ctx("client"), a.id, "publish_post");
    expect((await env.db.query("SELECT status FROM publication_jobs WHERE id = $1", [r.job.id])).rows[0].status).toBe("cancelled");
    expect(await openTasks(`assisted:${r.job.id}`)).toEqual(["cancelled"]);
    expect((await env.db.query("SELECT state FROM content_items WHERE id = $1", [itemId])).rows[0].state).toBe("approved");
  });

  it("отмена материала хранит причину в материале, а в журнале только факт её наличия", async () => {
    const { itemId } = await approvedItem();
    await content.cancelContent(await env.ctx("manager"), itemId, "Клиент передумал по личным причинам");
    expect((await env.db.query("SELECT cancel_reason FROM content_items WHERE id = $1", [itemId])).rows[0].cancel_reason).toMatch(/передумал/);
    const ev = (await env.db.query("SELECT details FROM audit_events WHERE entity_id = $1 AND action LIKE '%cancel%'", [itemId])).rows;
    expect(JSON.stringify(ev)).not.toMatch(/передумал/);
    expect(ev.some((e: any) => e.details.has_reason === true)).toBe(true);
  });

  it("после паузы повторное планирование снова ставит задание в очередь", async () => {
    const { a, itemId } = await approvedItem();
    process.env.LINKEDIN_APPROVED_PRODUCTS = APPROVED;
    env.secrets.set("tok:a1", "token");
    await acc.recordOAuthConnection(await env.ctx("manager"), a.id, { external_subject: "urn:li:person:demo1", granted_scopes: ["openid", "profile", "w_member_social"], secret_ref: "tok:a1" });
    await content.schedule(await env.ctx("manager"), itemId, { local_time: soon() });
    await pub.pausePublishing(await env.ctx("manager"), { scope: "account", id: a.id, paused: true });
    await env.db.query("UPDATE publication_jobs SET run_at = now() - interval '1 minute'");
    expect((await pub.runDueJobs(worker()))[0].outcome).toBe("blocked:awaiting_human");
    const job = (await env.db.query("SELECT id, status FROM publication_jobs")).rows[0];
    expect(await openTasks(`publish_blocked:${job.id}`)).toEqual(["open"]);
    await pub.pausePublishing(await env.ctx("manager"), { scope: "account", id: a.id, paused: false });
    const again: any = await content.schedule(await env.ctx("manager"), itemId, { local_time: soon() });
    expect(again.job.deduplicated).toBeUndefined();
    expect(again.job.status).toBe("queued");
    expect(await openTasks(`publish_blocked:${job.id}`)).toEqual(["cancelled"]);
    await env.db.query("UPDATE publication_jobs SET run_at = now() - interval '1 minute'");
    expect((await pub.runDueJobs(worker()))[0].outcome).toBe("published");
  });
});

describe("идентичность LinkedIn", () => {
  it("страница компании без организации не публикуется от имени человека", async () => {
    const { a, itemId } = await approvedItem("Northwind Robotics (страница)", "owner");
    process.env.LINKEDIN_APPROVED_PRODUCTS = APPROVED + ",Community Management API";
    env.secrets.set("tok:a2", "t");
    // Подключение принимается только при подтверждённой роли администратора организации.
    await expect(acc.recordOAuthConnection(await env.ctx("manager"), a.id, { external_subject: "urn:li:person:p", organization_urns: [], granted_scopes: ["w_organization_social"], secret_ref: "tok:a2" })).rejects.toThrow(/не администрирует/);
    // Обход сервиса (старая запись подключения с URN человека) останавливается исполнителем.
    await env.db.query("INSERT INTO oauth_connections(client_id, account_id, external_subject, granted_scopes, secret_ref, status) VALUES ($1,$2,'urn:li:person:p','{w_organization_social}','tok:a2','active')", [a.client_id, a.id]);
    await acc.refreshCapabilities(await env.ctx("manager"), a.id);
    await content.schedule(await env.ctx("manager"), itemId, { local_time: soon() });
    await env.db.query("UPDATE publication_jobs SET run_at = now() - interval '1 minute', mode = 'api', status = 'queued'");
    const r = await pub.runDueJobs(worker());
    expect(r[0].outcome).toBe("blocked:awaiting_human");
    expect((await env.db.query("SELECT last_error_code FROM publication_jobs")).rows[0].last_error_code).toBe("identity");
    expect(env.adapter.calls).toBe(0);
  });

  it("организация выбирается из organizationAcls и используется как автор", async () => {
    const { a, itemId } = await approvedItem("Northwind Robotics (страница)", "owner");
    process.env.LINKEDIN_APPROVED_PRODUCTS = APPROVED + ",Community Management API";
    env.secrets.set("tok:a2", "t");
    const res: any = await acc.recordOAuthConnection(await env.ctx("manager"), a.id, { external_subject: "urn:li:person:admin", organization_urns: ["urn:li:organization:42"], granted_scopes: ["w_organization_social"], secret_ref: "tok:a2" });
    expect(res.identity).toBe("urn:li:organization:42");
    // Другая организация при переподключении отклоняется.
    await expect(acc.recordOAuthConnection(await env.ctx("manager"), a.id, { external_subject: "urn:li:person:admin", organization_urns: ["urn:li:organization:7"], granted_scopes: ["w_organization_social"], secret_ref: "tok:a2" })).rejects.toThrow(/не является администратором/);
    await content.schedule(await env.ctx("manager"), itemId, { local_time: soon() });
    await env.db.query("UPDATE publication_jobs SET run_at = now() - interval '1 minute'");
    expect((await pub.runDueJobs(worker()))[0].outcome).toBe("published");
    expect(env.adapter.lastPublish?.authorUrn).toBe("urn:li:organization:42");
  });

  it("личный профиль: подключение другого человека отклоняется", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    process.env.LINKEDIN_APPROVED_PRODUCTS = APPROVED;
    await acc.recordOAuthConnection(await env.ctx("manager"), a1.id, { external_subject: "urn:li:person:john", granted_scopes: ["w_member_social"], secret_ref: "x" });
    await expect(acc.recordOAuthConnection(await env.ctx("manager"), a1.id, { external_subject: "urn:li:person:someone-else", granted_scopes: ["w_member_social"], secret_ref: "y" })).rejects.toThrow(/другой профиль/);
  });

  it("разбор ответа organizationAcls (контрактная фикстура)", () => {
    const json = JSON.parse(readFileSync("test/fixtures/linkedin/organization-acls.json", "utf8"));
    expect(parseOrganizationAcls(json)).toEqual(["urn:li:organization:2414183"]);
  });
});

describe("команда, процессы, метрики", () => {
  it("последнего владельца нельзя отключить, владельца отключает только владелец", async () => {
    await expect(ops.offboardUser(await env.ctx("ops"), env.u.owner)).rejects.toThrow(/только владелец/);
    await expect(ops.offboardUser(await env.ctx("owner"), env.u.owner)).rejects.toThrow(/собственную/);
    // Второй владелец: теперь первого можно отключить, но не последнего.
    const ag = (await env.db.query("SELECT agency_id FROM users WHERE id = $1", [env.u.owner])).rows[0].agency_id;
    await env.db.query("INSERT INTO memberships(user_id, agency_id, role) VALUES ($1,$2,'owner')", [env.u.ops, ag]);
    await ops.offboardUser(await env.ctx("ops"), env.u.owner);
    expect((await env.db.query("SELECT is_active FROM users WHERE id = $1", [env.u.owner])).rows[0].is_active).toBe(false);
    // Пользователь другого агентства неотличим от несуществующего.
    await expect(ops.offboardUser(await env.ctx("ops"), "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/не найден/);
  });

  it("новая версия процесса клиента не выключает общий процесс агентства с тем же ключом", async () => {
    const c1 = (await env.acct("John Smith (CEO)")).client_id;
    const owner = await env.ctx("owner");
    const base = { key: "sla", name: "SLA", trigger: "approval.sla_breached", conditions: [], actions: [{ type: "notify", audience: "account_manager" }], max_runs_per_day: 10, enabled: true };
    const g: any = await wf.saveWorkflow(owner, base);
    await wf.saveWorkflow(owner, { ...base, client_id: c1 });
    expect((await env.db.query("SELECT enabled FROM workflow_definitions WHERE id = $1", [g.id])).rows[0].enabled).toBe(true);
    await wf.saveWorkflow(owner, base);
    expect((await env.db.query("SELECT enabled FROM workflow_definitions WHERE id = $1", [g.id])).rows[0].enabled).toBe(false);
    expect((await env.db.query("SELECT count(*)::int n FROM workflow_definitions WHERE key = 'sla' AND enabled")).rows[0].n).toBe(2);
  });

  it("периодические значения без явных непересекающихся периодов не суммируются", () => {
    const v = (value: number, observed: string, ps?: string, pe?: string) => ({ metric_key: "impressions", value, nature: "periodic" as const, observed_at: observed, period_start: ps ?? null, period_end: pe ?? null, availability_status: "available" as const });
    expect(aggregate([v(100, "2026-09-02"), v(150, "2026-09-05")]).value).toBe(150);
    expect(aggregate([v(100, "2026-09-08", "2026-09-01", "2026-09-08"), v(50, "2026-09-15", "2026-09-08", "2026-09-15")]).value).toBe(150);
    expect(aggregate([v(100, "2026-09-08", "2026-09-01", "2026-09-08"), v(120, "2026-09-10", "2026-09-01", "2026-09-10")]).value).toBe(120);
    expect(periodsDisjoint([{ period_start: "2026-09-01", period_end: "2026-09-08" }, { period_start: "2026-09-07", period_end: "2026-09-10" }])).toBe(false);
  });
});
