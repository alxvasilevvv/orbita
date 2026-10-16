import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./helpers";
import * as content from "../src/services/content";
import * as pub from "../src/services/publishing";
import * as acc from "../src/services/accounts";
import * as reports from "../src/services/reports";
import * as exp from "../src/services/exports";
import * as team from "../src/services/team";
import * as portal from "../src/services/portal";
import * as life from "../src/services/lifecycle";
import { uploadMedia, SignatureScanner } from "../src/services/media";
import { LocalStorage } from "../src/services/storage";
import { processOutbox } from "../src/services/events";
import { buildApp } from "../src/server/app";

let env: Awaited<ReturnType<typeof setup>>;
let dir: string;
let storage: LocalStorage;
beforeEach(async () => { env = await setup(); process.env.LINKEDIN_APPROVED_PRODUCTS = ""; dir = await mkdtemp(join(tmpdir(), "alos-")); storage = new LocalStorage(dir, "s"); });
afterEach(async () => { await env.db.close(); await rm(dir, { recursive: true, force: true }); });

async function publishedItem(title = "Пост") {
  const a1 = await env.acct("John Smith (CEO)");
  const author = await env.ctx("author");
  const it = await content.createContentItem(author, a1.id, { title, body: `${title}: три завода на предиктивном обслуживании.` });
  await content.submitForReview(author, it.id);
  await content.decide(await env.ctx("editor"), it.id, { decision: "approved" });
  await content.decide(await env.ctx("client"), it.id, { decision: "approved" });
  await pub.enqueuePublication(await env.ctx("manager"), it.id, new Date());
  await pub.markPublishedManually(await env.ctx("manager"), it.id, { url: "https://www.linkedin.com/feed/update/1/" });
  return { a1, itemId: it.id as string };
}

describe("отчёты", () => {
  it("месячный отчёт честно сообщает об отсутствии данных и сравнивает периоды", async () => {
    const { a1 } = await publishedItem();
    const month = new Date().toISOString().slice(0, 7);
    const r: any = await reports.generateMonthlyReport(await env.ctx("manager"), a1.id, { month });
    expect(r.production.current.published).toBe(1);
    expect(r.progress.current.metric).toBeNull();
    expect(r.data_limitations.join(" ")).toMatch(/не внесён/);
    expect(r.best_materials.items).toEqual([]);
  });
  it("отчёт руководителю: себестоимость по формуле, причины перерасхода, без финансов для менеджера", async () => {
    const month = new Date().toISOString().slice(0, 7);
    process.env.INFRA_COST_MONTH_USD = "300";
    await env.db.query("UPDATE time_entries SET work_date = current_date");
    const r: any = await reports.agencyReport(await env.ctx("owner"), { month });
    const nw = r.clients.find((c: any) => c.name === "Northwind Robotics");
    expect(nw.labor_cost).toBeCloseTo(240 / 60 * 30 + 180 / 60 * 40, 1);
    expect(nw.overhead).toBeCloseTo(300 * 8 / 9, 1); // 8 из 9 аккаунтов агентства у Northwind (страница, CEO, 6 сотрудников)
    expect(nw.margin).toBeLessThan(1);
    delete process.env.INFRA_COST_MONTH_USD;
    await expect(reports.agencyReport(await env.ctx("manager"), { month })).rejects.toThrow(/прав/);
  });
  it("клиент видит отчёт только после публикации менеджером", async () => {
    const { a1 } = await publishedItem();
    const r: any = await reports.generateMonthlyReport(await env.ctx("manager"), a1.id, { month: new Date().toISOString().slice(0, 7) });
    const { getReport } = await import("../src/services/operations");
    await expect(getReport(await env.ctx("client"), r.id)).rejects.toThrow(/не найден/);
    await reports.publishReport(await env.ctx("manager"), r.id);
    expect((await getReport(await env.ctx("client"), r.id)).id).toBe(r.id);
  });
});

describe("экспорты", () => {
  it("фоновый CSV, данные LinkedIn API не выгружаются, защита от формул, клиенту недоступны затраты", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    await env.db.query("INSERT INTO metric_snapshots(client_id, account_id, metric_key, value, observed_at, source, source_detail, availability_status) VALUES ($1,$2,'followers',100,now(),'linkedin_api','api','available'),($1,$2,'followers',90,now(),'manual_entry','=HYPERLINK(\"x\")','available')", [a1.client_id, a1.id]);
    const e: any = await exp.requestExport(await env.ctx("analyst"), { kind: "metrics", account_id: a1.id });
    expect(e.status).toBe("queued");
    await exp.processExports(env.db, storage);
    const { url } = await exp.downloadExport(await env.ctx("analyst"), storage, e.id);
    const key = new URL(url, "http://x").searchParams.get("key")!;
    const text = (await storage.get(key))!.toString("utf8");
    expect(text).not.toContain("linkedin_api");
    expect(text).toContain("'=HYPERLINK");
    await processOutbox(env.db);
    expect((await env.db.query("SELECT count(*)::int n FROM notifications WHERE kind = 'export.ready'")).rows[0].n).toBe(1);
    await expect(exp.requestExport(await env.ctx("client"), { kind: "time", account_id: a1.id })).rejects.toThrow();
    await expect(exp.downloadExport(await env.ctx("manager"), storage, e.id)).rejects.toThrow(/не найден/);
  });
});

describe("команда и кабинет клиента", () => {
  it("роль клиента только с областью, последнего владельца не отозвать, ставку меняет только владелец", async () => {
    const ops = await env.ctx("ops");
    const u: any = await team.inviteUser(ops, { email: "new@demo.agency", display_name: "Новый автор" });
    await expect(team.grantRole(ops, { user_id: u.id, role: "client" })).rejects.toThrow(/только на клиента/);
    await expect(team.grantRole(ops, { user_id: u.id, role: "owner" })).rejects.toThrow(/владелец/);
    const a1 = await env.acct("John Smith (CEO)");
    await team.grantRole(ops, { user_id: u.id, role: "author", scope_client_id: a1.client_id });
    await expect(team.updateCapacity(ops, u.id, { internal_hourly_rate: 50 })).rejects.toThrow(/прав/);
    await team.updateCapacity(await env.ctx("owner"), u.id, { internal_hourly_rate: 50 });
    const own = (await env.db.query("SELECT id FROM memberships WHERE role = 'owner'")).rows[0].id;
    await expect(team.revokeRole(await env.ctx("owner"), own)).rejects.toThrow(/последнего владельца/);
  });
  it("клиент не попадает во внутреннее пространство, видит кабинет без внутренних данных", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const client = await env.ctx("client");
    await expect(acc.accountWorkspace(client, a1.id)).rejects.toThrow(/кабинет клиента/);
    const { listTasks } = await import("../src/services/operations");
    expect(await listTasks(client)).toEqual([]);
    const home = await portal.portalHome(client);
    expect(home.accounts.length).toBe(1);
    expect(Object.keys(home.accounts[0])).not.toContain("tasks");
    const item = (await env.db.query("SELECT id FROM content_items WHERE account_id = $1 LIMIT 1", [a1.id])).rows[0];
    const d: any = await content.contentDetail(client, item.id);
    expect(d.client_view).toBe(true);
    expect(d.jobs).toEqual([]);
  });
});

describe("жизненный цикл данных", () => {
  it("завершение обслуживания и удаление: все хранилища очищены, проверка остатков пройдена", async () => {
    const { a1 } = await publishedItem();
    env.secrets.set("tok:del", "token");
    await env.db.query("INSERT INTO oauth_connections(client_id, account_id, external_subject, secret_ref, status) VALUES ($1,$2,'urn:li:person:x','tok:del','active')", [a1.client_id, a1.id]);
    await uploadMedia(await env.ctx("author"), { storage, scanner: new SignatureScanner() }, a1.id, { filename: "a.pdf", data: Buffer.from("%PDF-1.4 test") });
    const owner = await env.ctx("owner");
    await expect(life.deleteClientData(owner, { systemDb: env.db, storage, secrets: env.secrets }, a1.client_id, { confirm_name: "Northwind Robotics" })).rejects.toThrow(/Сначала/);
    const off = await life.startOffboarding(owner, { secrets: env.secrets }, a1.client_id);
    expect(off.secrets_deleted).toBe(6); // 1 тестовое + 5 подключений сотрудников из сида
    expect(await env.secrets.get("tok:del")).toBeNull();
    await expect(life.deleteClientData(await env.ctx("ops"), { systemDb: env.db, storage, secrets: env.secrets }, a1.client_id, { confirm_name: "Northwind Robotics" })).rejects.toThrow(/владелец/);
    await expect(life.deleteClientData(owner, { systemDb: env.db, storage, secrets: env.secrets }, a1.client_id, { confirm_name: "Northwind" })).rejects.toThrow(/не совпадает/);
    const r = await life.deleteClientData(owner, { systemDb: env.db, storage, secrets: env.secrets }, a1.client_id, { confirm_name: "Northwind Robotics" });
    expect(r.steps.find((s) => s.step === "verification")?.result).toBe("ok");
    const tables = (await env.db.query("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id' AND table_name <> 'audit_events'")).rows;
    for (const t of tables) expect((await env.db.query(`SELECT count(*)::int n FROM ${t.table_name} WHERE client_id = $1`, [a1.client_id])).rows[0].n, t.table_name).toBe(0);
    expect(await storage.list(`clients/${a1.client_id}/`)).toEqual([]);
    const clientUser = (await env.db.query("SELECT email, is_active FROM users WHERE id = $1", [env.u.client])).rows[0];
    expect(clientUser.is_active).toBe(false);
    expect(clientUser.email).toMatch(/^deleted-/);
    // Аудит хранит факт удаления без содержимого
    const leaked = (await env.db.query("SELECT count(*)::int n FROM audit_events WHERE details::text LIKE '%Northwind%' OR details::text LIKE '%предиктивном%'")).rows[0].n;
    expect(leaked).toBe(0);
    // Другой клиент не затронут
    expect((await env.db.query("SELECT count(*)::int n FROM clients")).rows[0].n).toBe(1);
  });
  it("каждая таблица с client_id имеет правило удаления", async () => {
    const tables = (await env.db.query("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'")).rows.map((r: any) => r.table_name);
    expect(tables.filter((t: string) => !life.DELETION_ORDER.includes(t) && t !== "audit_events")).toEqual([]);
  });
  it("сроки хранения: истёкшие экспорты удаляются вместе с файлами, вывод AI очищается", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const e: any = await exp.requestExport(await env.ctx("manager"), { kind: "content", account_id: a1.id });
    await exp.processExports(env.db, storage);
    await env.db.query("UPDATE exports SET expires_at = now() - interval '1 day'");
    await env.db.query("INSERT INTO ai_executions(client_id, account_id, role, provider, model, prompt_version, output, created_at) VALUES ($1,$2,'author','demo','m','v','{\"draft\":\"x\"}', now() - interval '200 days')", [a1.client_id, a1.id]);
    const r = await life.runRetention(env.db, storage);
    expect(r.exports_expired).toBe(1);
    expect(r.ai_outputs_scrubbed).toBe(1);
    expect(await storage.list(`clients/${a1.client_id}/exports`)).toEqual([]);
    void e;
  });
  it("через HTTP клиент получает 403 во внутреннем пространстве", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const app = buildApp({ db: env.db, secrets: env.secrets, authMode: "dev" } as any);
    const r = await app.inject({ method: "GET", url: `/api/accounts/${a1.id}`, headers: { "x-user-id": env.u.client } });
    expect(r.statusCode).toBe(403);
  });
});
