import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup } from "./helpers";
import { actorCtx, loadActor } from "../src/services/context";
import { importXTargets, draftXEngagements, myXEngagements, markXEngagement, parseTweetRef, composeXReply, xEngageLimit } from "../src/services/x_engage";

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { env = await setup(); });
afterEach(async () => { await env.db.close(); });

const uid = async (email: string) => (await env.db.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as string;
const ctxOf = async (email: string) => actorCtx(env.db, (await loadActor(env.db, await uid(email)))!);
const accOf = async (name: string) => (await env.db.query("SELECT id, client_id FROM managed_accounts WHERE display_name LIKE $1", [`${name}%`])).rows[0] as { id: string; client_id: string };

async function makeXAccount() {
  const anna = await accOf("Anna Kovacs");
  const client = anna.client_id;
  const ag = (await env.db.query("SELECT agency_id FROM clients WHERE id = $1", [client])).rows[0].agency_id;
  const annaUid = await uid("anna.k@northwind.example");
  const acc = (await env.db.query("INSERT INTO managed_accounts(client_id, kind, display_name, primary_language, timezone, network, status, linkedin_urn) VALUES ($1,'employee','Anna X','en','Europe/Budapest','x','active','x-user-anna') RETURNING id", [client])).rows[0].id;
  await env.db.query("INSERT INTO memberships(user_id, agency_id, role, scope_account_id) VALUES ($1,$2,'client',$3)", [annaUid, ag, acc]);
  await env.db.query("INSERT INTO account_safety(account_id, client_id, ramp_started_at) VALUES ($1,$2, now() - interval '40 days')", [acc, client]);
  const { buildPassport, passportHash, roleByKey, claimsFromInterview } = await import("../src/core/autopilot");
  const answers = { now: "I lead the ML team building predictive maintenance models.", win: "We moved inference to a separate cluster and alerts now come before failures." };
  const passport = buildPassport(roleByKey("data_ml")!, "Anna X", answers, { topics: ["ml", "data"], length: "short", register: "conversational", humor: false, language: "en", phrases: [], never_topics: [] });
  const src = (await env.db.query("INSERT INTO knowledge_sources(client_id, account_id, title, kind, body, usage_rights) VALUES ($1,$2,'iv','interview',$3,'internal_and_ai') RETURNING id", [client, acc, JSON.stringify(answers)])).rows[0].id;
  for (const c of claimsFromInterview(answers)) await env.db.query("INSERT INTO verified_claims(client_id, account_id, statement, source_id, confirmed_by, valid_as_of) VALUES ($1,$2,$3,$4,'Anna',current_date)", [client, acc, c, src]);
  await env.db.query("INSERT INTO personal_agents(account_id, client_id, user_id, role_key, onboarding_step, passport, passport_version, passport_hash, passport_confirmed_at, autopilot, veto_hours) VALUES ($1,$2,$3,'data_ml','done',$4,1,$5, now() - interval '30 days','on',24)", [acc, client, annaUid, JSON.stringify(passport), passportHash(passport)]);
  await env.db.query("INSERT INTO subscriptions(account_id, client_id, status, period_end, provider) VALUES ($1,$2,'active', now() + interval '25 days','demo')", [acc, client]);
  env.secrets.set(`x/${acc}/seed`, "demo-x-token");
  await env.db.query("INSERT INTO oauth_connections(client_id, account_id, external_subject, granted_scopes, secret_ref, status) VALUES ($1,$2,'x-user-anna','{tweet.write,like.write}',$3,'active')", [client, acc, `x/${acc}/seed`]);
  return acc as string;
}

describe("X-взаимодействия: чистые функции", () => {
  it("parseTweetRef разбирает ссылку и голый id, мусор отбрасывает", () => {
    expect(parseTweetRef("https://x.com/openai/status/1790000000000000001")).toMatchObject({ id: "1790000000000000001", author: "openai" });
    expect(parseTweetRef("https://twitter.com/jack/status/20")).toMatchObject({ id: "20", author: "jack" });
    expect(parseTweetRef("1790000000000000002")).toMatchObject({ id: "1790000000000000002", author: null });
    expect(parseTweetRef("не ссылка")).toBeNull();
  });
  it("composeXReply не длиннее 280 и непустой", () => {
    const r = composeXReply({ me: { role: "ML Lead", company: "Northwind", claim: "мы перенесли инференс в отдельный кластер", language: "ru" } });
    expect(r.length).toBeGreaterThan(10);
    expect(r.length).toBeLessThanOrEqual(280);
  });
  it("xEngageLimit: ответы по комментариям, лайки по реакциям", () => {
    expect(xEngageLimit("reputation", "reply")).toBe(3);
    expect(xEngageLimit("reputation", "like")).toBe(7);
  });
});

describe("X-взаимодействия: поток в одно касание", () => {
  it("импорт целей, черновик ответа, отправка ответа и лайка через адаптер", async () => {
    const acc = await makeXAccount();
    const anna = await ctxOf("anna.k@northwind.example");
    const imp = await importXTargets(anna, acc, { refs: "https://x.com/openai/status/1790000000000000001\nhttps://x.com/jack/status/20", kind: "reply" });
    expect(imp.added).toBe(2);
    const impLike = await importXTargets(anna, acc, { refs: "https://x.com/openai/status/1790000000000000009", kind: "like" });
    expect(impLike.added).toBe(1);

    const d = await draftXEngagements(env.db, new Date());
    expect(d.drafted).toBeGreaterThan(0);

    const list = await myXEngagements(anna, acc);
    expect(list.limits.reply).toBe(xEngageLimit(list.level, "reply"));
    const reply = list.items.find((i: any) => i.kind === "reply" && i.status === "drafted");
    expect(reply).toBeTruthy();

    const sent = await markXEngagement(anna, { xAdapter: env.xAdapter, secrets: env.secrets }, reply.id, { action: "sent" });
    expect(sent.status).toBe("sent");
    expect(sent.external_id).toBeTruthy();

    const likeItem = (await env.db.query("SELECT id FROM x_engagements WHERE account_id = $1 AND kind = 'like'", [acc])).rows[0];
    const liked = await markXEngagement(anna, { xAdapter: env.xAdapter, secrets: env.secrets }, likeItem.id, { action: "sent" });
    expect(liked.status).toBe("sent");
  });

  it("пропуск помечает skipped и не отправляет", async () => {
    const acc = await makeXAccount();
    const anna = await ctxOf("anna.k@northwind.example");
    await importXTargets(anna, acc, { refs: "https://x.com/openai/status/1790000000000000055", kind: "reply" });
    const it = (await env.db.query("SELECT id FROM x_engagements WHERE account_id = $1", [acc])).rows[0];
    const r = await markXEngagement(anna, { xAdapter: env.xAdapter, secrets: env.secrets }, it.id, { action: "skip" });
    expect(r.status).toBe("skipped");
  });

  it("слишком короткий ответ блокируется правилами безопасности", async () => {
    const acc = await makeXAccount();
    const anna = await ctxOf("anna.k@northwind.example");
    await importXTargets(anna, acc, { refs: "https://x.com/openai/status/1790000000000000077", kind: "reply" });
    const it = (await env.db.query("SELECT id FROM x_engagements WHERE account_id = $1", [acc])).rows[0];
    await expect(markXEngagement(anna, { xAdapter: env.xAdapter, secrets: env.secrets }, it.id, { action: "sent", text: "ок" })).rejects.toThrow();
  });

  it("недельный лимит стратегии исчерпан: отправка блокируется", async () => {
    const acc = await makeXAccount();
    const anna = await ctxOf("anna.k@northwind.example");
    const list = await myXEngagements(anna, acc);
    const cap = list.limits.reply;
    const wk = (await import("../src/core/autopilot")).weekKey(new Date());
    const clientId = (await env.db.query("SELECT client_id FROM managed_accounts WHERE id = $1", [acc])).rows[0].client_id;
    for (let i = 0; i < cap; i++) await env.db.query("INSERT INTO x_engagements(client_id, account_id, kind, target_tweet_id, status, week_key, sent_at) VALUES ($1,$2,'reply',$3,'sent',$4, now())", [clientId, acc, `cap${i}`, wk]);
    await importXTargets(anna, acc, { refs: "https://x.com/openai/status/1790000000000000088", kind: "reply" });
    const it = (await env.db.query("SELECT id FROM x_engagements WHERE account_id = $1 AND status = 'new'", [acc])).rows[0];
    await expect(markXEngagement(anna, { xAdapter: env.xAdapter, secrets: env.secrets }, it.id, { action: "sent", text: "Good point, this matches what we see in production work every single day." })).rejects.toThrow(/лимит/);
  });

  it("для аккаунта LinkedIn взаимодействия в X недоступны", async () => {
    const anna = await ctxOf("anna.k@northwind.example");
    const li = await accOf("Anna Kovacs");
    await expect(importXTargets(anna, li.id, { refs: "https://x.com/openai/status/1790000000000000099", kind: "reply" })).rejects.toThrow(/X/);
  });
});
