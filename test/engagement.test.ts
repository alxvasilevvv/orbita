import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup } from "./helpers";
import * as eng from "../src/services/engagement";
import * as ops from "../src/services/operations";
import * as content from "../src/services/content";
import { processOutbox } from "../src/services/events";

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { env = await setup(); });
afterEach(async () => { await env.db.close(); });

const base = { relevance: 0.9, audience_fit: 0.8, contribution_value: 0.7, timeliness: 0.6, rationale: "Профильная дискуссия о предиктивном обслуживании" };

async function grantEngagement(accountId: string) {
  const { grantConsent } = await import("../src/services/accounts");
  const c = await env.ctx("client");
  await grantConsent(c, accountId, { action_scope: "comment", granted_by_name: "John Smith", evidence_ref: "Письмо 01.10" });
  await grantConsent(c, accountId, { action_scope: "react", granted_by_name: "John Smith", evidence_ref: "Письмо 01.10" });
}

describe("взаимодействия", () => {
  it("без согласия действие блокируется независимо от балла", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const r: any = await eng.createRecommendation(await env.ctx("manager"), a1.id, { ...base, target_url: "https://www.linkedin.com/posts/someone_1", action_type: "react" });
    expect(r.status).toBe("blocked");
    expect(r.priority).toBeNull();
    expect(r.block_reasons.join(" ")).toMatch(/согласия/);
  });

  it("взаимная поддержка между клиентами агентства запрещена даже для роли без доступа к другому клиенту", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    await grantEngagement(a1.id);
    const { actorCtx, loadActor } = await import("../src/services/context");
    // community manager только этого клиента
    await env.db.query("INSERT INTO memberships(user_id, agency_id, role, scope_client_id) SELECT $1, agency_id, 'community_manager', $2 FROM users WHERE id = $1", [env.u.author, a1.client_id]);
    const cm = actorCtx(env.db, (await loadActor(env.db, env.u.author))!);
    const r: any = await eng.createRecommendation(cm, a1.id, { ...base, target_url: "https://www.linkedin.com/in/example-elena/recent-activity", action_type: "react" });
    expect(r.block_reasons.join(" ")).toMatch(/взаимная поддержка/);
  });

  it("однотипный комментарий для другого аккаунта и повтор блокируются", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const a3 = await env.acct("Елена Петрова");
    await grantEngagement(a1.id);
    const m = await env.ctx("manager");
    await eng.createRecommendation(m, a3.id, { ...base, target_url: "https://www.linkedin.com/posts/x_1", action_type: "comment", proposed_comment: "Отличный пост, спасибо!" });
    const r: any = await eng.createRecommendation(m, a1.id, { ...base, target_url: "https://www.linkedin.com/posts/x_2", action_type: "comment", proposed_comment: "Отличный пост,   спасибо" });
    expect(r.block_reasons.join(" ")).toMatch(/Однотипный/);
    await eng.createRecommendation(m, a1.id, { ...base, target_url: "https://www.linkedin.com/posts/x_3", action_type: "react" });
    const dup: any = await eng.createRecommendation(m, a1.id, { ...base, target_url: "https://www.linkedin.com/posts/x_3", action_type: "react" });
    expect(dup.block_reasons.join(" ")).toMatch(/Повтор/);
  });

  it("требуется человеческое согласование конкретного текста, исполнение: ручная отметка, есть суточный лимит", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    await grantEngagement(a1.id);
    const cm = await env.ctx("manager");
    const r: any = await eng.createRecommendation(cm, a1.id, { ...base, target_url: "https://www.linkedin.com/posts/y_1", action_type: "comment", proposed_comment: "Мы прошли тот же путь: шесть месяцев пилота на одном заводе окупились." });
    await expect(eng.markExecuted(cm, r.id, {})).rejects.toThrow(/согласованное/);
    await expect(eng.decideRecommendation(cm, r.id, { decision: "approved" })).rejects.toThrow(/собственный/);
    await expect(eng.decideRecommendation(await env.ctx("owner"), r.id, { decision: "approved", comment_text: "другой текст" })).rejects.toThrow(/Текст изменился/);
    await eng.decideRecommendation(await env.ctx("owner"), r.id, { decision: "approved" });
    const done = await eng.markExecuted(cm, r.id, { result_url: "https://www.linkedin.com/feed/update/urn:li:comment:1" });
    expect(done.evidence_type).toBe("manual_mark");
    const ar = (await env.db.query("SELECT origin, evidence_type FROM action_records WHERE action_type = 'comment'")).rows[0];
    expect(ar).toEqual({ origin: "manual_mark", evidence_type: "manual_mark" });
    await env.db.query("UPDATE engagement_recommendations SET status = 'executed', executed_at = now()");
    const many = [];
    for (let i = 0; i < eng.DAILY_ENGAGEMENT_CAP; i++) many.push(env.db.query("INSERT INTO engagement_recommendations(client_id, account_id, target_url, source, action_type, relevance, audience_fit, contribution_value, timeliness, rationale, status, executed_at) VALUES ($1,$2,$3,'manager_added','react',1,1,1,1,'x','executed',now())", [a1.client_id, a1.id, `https://www.linkedin.com/posts/z_${i}`]));
    await Promise.all(many);
    const last: any = await eng.createRecommendation(cm, a1.id, { ...base, target_url: "https://www.linkedin.com/posts/last", action_type: "react" });
    await eng.decideRecommendation(await env.ctx("owner"), last.id, { decision: "approved" });
    await expect(eng.markExecuted(cm, last.id, {})).rejects.toThrow(/лимит/);
  });

  it("входящий комментарий запускает сценарий ответа", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    await eng.createRecommendation(await env.ctx("manager"), a1.id, { ...base, source: "inbound", target_url: "https://www.linkedin.com/feed/update/urn:li:activity:9", action_type: "reply", proposed_comment: "Спасибо за вопрос, отвечу подробнее" });
    await processOutbox(env.db);
    expect((await env.db.query("SELECT count(*)::int n FROM tasks WHERE type = 'reply'")).rows[0].n).toBe(1);
  });
});

describe("возможности и пакетное согласование", () => {
  it("этап проверяется по воронке, атрибуция обязательна", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const an = await env.ctx("analyst");
    await expect(ops.addOpportunity(an, a1.id, { pipeline: "business", stage: "interview", title: "x", attribution: "client_mark" })).rejects.toThrow(/воронке/);
    const o: any = await ops.addOpportunity(an, a1.id, { pipeline: "business", stage: "inbound_interest", title: "Запрос от завода в Огайо", attribution: "client_mark" });
    await eng.moveOpportunity(an, o.id, { stage: "meeting" });
    await expect(eng.moveOpportunity(an, o.id, { stage: "offer" })).rejects.toThrow();
    expect((await eng.listOpportunities(an, a1.id))[0].stage).toBe("meeting");
  });
  it("пакетное согласование возвращает результат по каждому материалу", async () => {
    const editor = await env.ctx("editor");
    const list = await content.listApprovals(editor);
    const items = list.filter((x: any) => x.stage === "editorial").map((x: any) => ({ content_item_id: x.content_item_id, approval_request_id: x.approval_request_id }));
    items.push({ content_item_id: items[0].content_item_id, approval_request_id: "00000000-0000-0000-0000-000000000000" });
    const r = await content.decideBatch(editor, { decision: "approved", items });
    expect(r.results.map((x) => x.status)).toEqual(["client_review", "error"]);
  });
});
