import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, APPROVED } from "./helpers";
import * as content from "../src/services/content";
import * as acc from "../src/services/accounts";
import * as pub from "../src/services/publishing";
import { uploadMedia, SignatureScanner, sniff, imageSize, mediaUrl } from "../src/services/media";
import { LocalStorage } from "../src/services/storage";
import { planMonth, distribute, getCalendar } from "../src/services/calendar";
import { createProfileAudit, onboardingStatus } from "../src/services/onboarding";

let env: Awaited<ReturnType<typeof setup>>;
let dir: string;
let storage: LocalStorage;
beforeEach(async () => {
  env = await setup();
  process.env.LINKEDIN_APPROVED_PRODUCTS = "";
  dir = await mkdtemp(join(tmpdir(), "alos-"));
  storage = new LocalStorage(dir, "test-secret");
});
afterEach(async () => { await env.db.close(); await rm(dir, { recursive: true, force: true }); });

// Минимальный валидный PNG 2×3
const png = (w = 2, h = 3, salt = 0) => {
  const b = Buffer.alloc(33 + salt);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const deps = () => ({ storage, scanner: new SignatureScanner() });

describe("медиа", () => {
  it("тип определяется по содержимому, а не по имени", async () => {
    expect(sniff(png())?.mime).toBe("image/png");
    expect(imageSize(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    const a1 = await env.acct("John Smith (CEO)");
    await expect(uploadMedia(await env.ctx("author"), deps(), a1.id, { filename: "virus.png", data: Buffer.from("MZ executable") })).rejects.toThrow(/Формат/);
  });
  it("заражённый файл не сохраняется", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const eicar = Buffer.concat([png(), Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")]);
    await expect(uploadMedia(await env.ctx("author"), deps(), a1.id, { filename: "x.png", data: eicar })).rejects.toThrow(/антивирус/);
    expect((await storage.list(`clients/${a1.client_id}`)).length).toBe(0);
  });
  it("слишком большое изображение по пикселям отклоняется", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    await expect(uploadMedia(await env.ctx("author"), deps(), a1.id, { filename: "big.png", data: png(10000, 10000) })).rejects.toThrow(/пикселей/);
  });
  it("повторная загрузка не дублирует, ссылка подписана и истекает", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const m1: any = await uploadMedia(await env.ctx("author"), deps(), a1.id, { filename: "a.png", data: png() });
    const m2: any = await uploadMedia(await env.ctx("author"), deps(), a1.id, { filename: "a-copy.png", data: png() });
    expect(m2.id).toBe(m1.id);
    expect(m2.deduplicated).toBe(true);
    const { url } = await mediaUrl(await env.ctx("author"), storage, m1.id);
    const u = new URL(url, "http://x");
    expect(storage.verify(u.searchParams.get("key")!, Number(u.searchParams.get("exp")), u.searchParams.get("sig")!)).toBe(true);
    expect(storage.verify(u.searchParams.get("key")!, Number(u.searchParams.get("exp")) - 100000, u.searchParams.get("sig")!)).toBe(false);
    await expect(mediaUrl(await env.ctx("author2"), storage, m1.id)).rejects.toThrow(/не найден/);
  });
  it("вложение чужого аккаунта нельзя прикрепить", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const a3 = await env.acct("Елена Петрова");
    const m: any = await uploadMedia(await env.ctx("manager"), deps(), a3.id, { filename: "e.png", data: png() });
    const it = await content.createContentItem(await env.ctx("author"), a1.id, { title: "x" });
    await expect(content.addVersion(await env.ctx("manager"), it.id, { body: "текст", media_ids: [m.id] })).rejects.toThrow(/Вложения/);
  });
  it("API-публикация загружает изображение один раз и прикладывает его к посту", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const author = await env.ctx("author");
    const m: any = await uploadMedia(author, deps(), a1.id, { filename: "a.png", data: png() });
    const it = await content.createContentItem(author, a1.id, { title: "С картинкой" });
    await content.addVersion(author, it.id, { body: "Пост с изображением", media_ids: [m.id] });
    await content.submitForReview(author, it.id);
    await content.decide(await env.ctx("editor"), it.id, { decision: "approved" });
    await content.decide(await env.ctx("client"), it.id, { decision: "approved" });
    process.env.LINKEDIN_APPROVED_PRODUCTS = APPROVED;
    env.secrets.set("tok", "t");
    await acc.recordOAuthConnection(await env.ctx("manager"), a1.id, { external_subject: "urn:li:person:p1", granted_scopes: ["openid", "profile", "w_member_social"], secret_ref: "tok" });
    await pub.enqueuePublication(await env.ctx("manager"), it.id, new Date(Date.now() - 60_000));
    // первая попытка: квота после загрузки картинки
    let calls = 0;
    const orig = env.adapter.publishPost.bind(env.adapter);
    env.adapter.publishPost = async (r) => { if (++calls === 1) { const { IntegrationError } = await import("../src/integrations/linkedin/adapter"); throw new IntegrationError("retryable", "x", "x"); } return orig(r); };
    await env.db.query("UPDATE content_items SET state = 'scheduled' WHERE id = $1", [it.id]);
    const w = { db: env.db, adapter: env.adapter, secrets: env.secrets, workerId: "t", storage };
    expect((await pub.runDueJobs(w))[0].outcome).toMatch(/retry/);
    await env.db.query("UPDATE publication_jobs SET run_at = now() - interval '1 minute'");
    expect((await pub.runDueJobs(w))[0].outcome).toBe("published");
    expect(env.adapter.uploads).toBe(1);
    expect(env.adapter.lastPublish?.imageUrns).toEqual(["urn:li:image:demo-1"]);
  });
});

describe("календарь и онбординг", () => {
  it("распределение направлений по долям без повторов подряд", () => {
    const r = distribute([{ name: "A", share: 0.5 }, { name: "B", share: 0.25 }, { name: "C", share: 0.25 }], 8);
    expect(r.filter((x) => x === "A").length).toBe(4);
    for (let i = 1; i < r.length; i++) if (r[i] === r[i - 1]) expect(r.filter((x) => x === r[i]).length).toBeGreaterThan(4);
  });
  it("план месяца: окна стратегии, запас на согласование, без конфликтов, отметка гипотезы", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const m = await env.ctx("manager");
    const now = new Date("2026-10-28T12:00:00Z");
    const r = await planMonth(m, a1.id, { month: "2026-11", events: [{ date: "2026-11-12", title: "Выступление на конференции" }] }, now);
    // план 9 (2 в неделю × 30 дней), свободных окон вт/чт 7 + событие = 8, и об этом есть пометка
    expect(r.slots.length).toBe(8);
    expect(r.notes.join(" ")).toMatch(/меньше плана: 7 из 8/);
    expect(r.slots.every((s) => new Date(s.utc) > new Date(now.getTime() + 72 * 3600_000))).toBe(true);
    const dates = r.slots.map((s) => s.local.slice(0, 10));
    expect(new Set(dates).size).toBe(dates.length);
    expect(r.slots.some((s) => s.campaign === "Выступление на конференции")).toBe(true);
    expect(r.notes.join(" ")).toMatch(/гипотеза/);
    // локальные 09:00 в Нью-Йорке до и после перехода часов 1 ноября
    const nov3 = r.slots.find((s) => s.local === "2026-11-03T09:00");
    expect(nov3?.utc).toBe("2026-11-03T14:00:00.000Z");
    const created = await planMonth(m, a1.id, { month: "2026-11", dry_run: false }, now);
    expect(created.created).toBeGreaterThan(0);
    const cal = await getCalendar(m, { from: "2026-11-01", to: "2026-12-01", account_id: a1.id });
    expect(cal.length).toBe(created.created);
    const again = await planMonth(m, a1.id, { month: "2026-11" }, now);
    expect(again.slots.length).toBe(0);
  });
  it("аудит профиля создаёт задачи с готовыми текстами; чек-лист онбординга отражает факты", async () => {
    const a1 = await env.acct("John Smith (CEO)");
    const before = await onboardingStatus(await env.ctx("manager"), a1.id);
    expect(before.steps.find((s) => s.key === "audit")?.status).toBe("todo");
    const r = await createProfileAudit(await env.ctx("strategist"), a1.id, { criteria: [
      { key: "headline", status: "improve", finding: "Только должность", proposed_text: "CEO Northwind Robotics | Предиктивное обслуживание на производстве" },
      { key: "about", status: "ok" },
      { key: "cta", status: "missing", proposed_text: "Пишите, если обсуждаете переход на предиктивное обслуживание" },
    ] });
    expect(r.tasks_created).toBe(2);
    const t = (await env.db.query("SELECT details FROM tasks WHERE type = 'profile_update' ORDER BY title")).rows;
    expect(t.some((x: any) => x.details.includes("CEO Northwind Robotics"))).toBe(true);
    const after = await onboardingStatus(await env.ctx("manager"), a1.id);
    expect(after.steps.find((s) => s.key === "audit")?.status).toBe("done");
    expect(after.steps.find((s) => s.key === "integration")?.status).toBe("not_applicable");
  });
});
