import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup } from "./helpers";
import * as acc from "../src/services/accounts";
import * as wf from "../src/services/workflows";
import { processOutbox, runScans } from "../src/services/events";
import { deliverPending, ConsoleMailer, listNotifications } from "../src/services/notify";

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { env = await setup(); });
afterEach(async () => { await env.db.close(); });

const count = async (sql: string, p: unknown[] = []) => (await env.db.query(sql, p)).rows[0].n as number;

describe("события, уведомления, сценарии", () => {
  it("отзыв подключения: встроенный сценарий уведомляет, повторная обработка не дублирует", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    await acc.markConnectionRevoked(await env.ctx("manager"), a1.id);
    await processOutbox(env.db);
    const n1 = await count("SELECT count(*)::int n FROM notifications WHERE kind = 'connection.revoked'");
    expect(n1).toBeGreaterThanOrEqual(2); // менеджер и операционный директор
    await env.db.query("UPDATE outbox SET processed_at = NULL");
    await processOutbox(env.db);
    expect(await count("SELECT count(*)::int n FROM notifications WHERE kind = 'connection.revoked'")).toBe(n1);
    expect(await count("SELECT count(*)::int n FROM workflow_runs WHERE status = 'executed'")).toBe(1);
  });

  it("просроченное согласование: сканер → событие → уведомления и доставка", async () => {
    await env.db.query("UPDATE approval_requests SET created_at = now() - interval '72 hours'");
    const r = await runScans(env.db);
    expect(r.sla_breached).toBeGreaterThan(0);
    await runScans(env.db); // повтор не создаёт новых событий
    expect(await count("SELECT count(*)::int n FROM outbox WHERE topic = 'approval.sla_breached'")).toBe(r.sla_breached);
    await processOutbox(env.db);
    const mine = await listNotifications(await env.ctx("manager"));
    expect(mine.some((n: any) => n.kind === "approval.sla_breached")).toBe(true);
    const mailer = new ConsoleMailer();
    expect(await deliverPending(env.db, mailer)).toBeGreaterThan(0);
    expect(await deliverPending(env.db, mailer)).toBe(0);
  });

  it("материал близко к плановой дате без согласования создаёт задачу", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    await env.db.query("UPDATE content_items SET planned_for = now() + interval '20 hours' WHERE account_id = $1 AND state = 'draft'", [a1.id]);
    await runScans(env.db);
    await processOutbox(env.db);
    expect(await count("SELECT count(*)::int n FROM tasks WHERE type = 'approval_chase'")).toBe(1);
  });

  it("предпросмотр ничего не меняет", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const list = await wf.listWorkflows(await env.ctx("ops"));
    const w = list.workflows.find((x: any) => x.key === "deadline-risk");
    const before = await count("SELECT count(*)::int n FROM tasks");
    const r = await wf.previewWorkflow(await env.ctx("ops"), w.id, { account_id: a1.id });
    expect(r[0].status).toBe("preview");
    expect(r[0].actions.length).toBe(2);
    expect(await count("SELECT count(*)::int n FROM tasks")).toBe(before);
  });

  it("защита от циклов и лимит запусков", async () => {
    const ag = (await env.db.query("SELECT id FROM agencies")).rows[0].id;
    const a1 = await env.acct("John Smith (CEO)");
    const deep = await wf.runWorkflows(env.db, { topic: "plan.week_behind", key: "deep", depth: 3, agency_id: ag, account_id: a1.id, client_id: a1.client_id, payload: {} });
    expect(deep[0].status).toBe("loop_blocked");
    await env.db.query("UPDATE workflow_definitions SET max_runs_per_day = 1 WHERE key = 'week-behind'");
    await wf.runWorkflows(env.db, { topic: "plan.week_behind", key: "e1", agency_id: ag, account_id: a1.id, client_id: a1.client_id, payload: {} });
    const second = await wf.runWorkflows(env.db, { topic: "plan.week_behind", key: "e2", agency_id: ag, account_id: a1.id, client_id: a1.client_id, payload: {} });
    expect(second[0].status).toBe("limited");
  });

  it("свой сценарий с условием и новой версией; неразрешённое действие отклоняется", async () => {
    const ops = await env.ctx("ops");
    await expect(wf.saveWorkflow(ops, { key: "x", name: "x", trigger: "plan.week_behind", actions: [{ type: "publish_post" }] })).rejects.toThrow();
    const v1 = await wf.saveWorkflow(ops, { key: "founders-behind", name: "Отставание у основателей", trigger: "plan.week_behind", conditions: [{ field: "account.kind", op: "eq", value: "founder" }], actions: [{ type: "notify", audience: "strategist" }] });
    const v2 = await wf.saveWorkflow(ops, { key: "founders-behind", name: "Отставание у основателей", trigger: "plan.week_behind", conditions: [{ field: "account.kind", op: "eq", value: "executive" }], actions: [{ type: "notify", audience: "strategist" }] });
    expect(v2.version).toBe(v1.version + 1);
    const ag = (await env.db.query("SELECT id FROM agencies")).rows[0].id;
    const a1 = await env.acct("John Smith (CEO)");
    const r = await wf.runWorkflows(env.db, { topic: "plan.week_behind", key: "k1", agency_id: ag, account_id: a1.id, client_id: a1.client_id, payload: {} });
    expect(r.find((x: any) => x.name === "Отставание у основателей")?.status).toBe("executed");
    await expect(wf.saveWorkflow(await env.ctx("author"), { key: "y", name: "y", trigger: "plan.week_behind", actions: [{ type: "notify", audience: "owner" }] })).rejects.toThrow(/прав/);
  });
});
