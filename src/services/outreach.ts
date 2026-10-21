import { z } from "zod";
import type { Db, Queryable } from "../db/db";
import { accountScope, assertAccountOwner, audit, ConflictError, isAccountOwner, isInternal, NotFoundError, ValidationError, type Ctx } from "./context";
import { ForbiddenError } from "../core/permissions";
import { outreachLimit, STRATEGIES } from "../core/strategy";
import { weekKey } from "../core/autopilot";
import { loadSafety, lockAccount } from "../agents/officer";
import { subscriptionOf } from "./billing";
import { checkText } from "../core/safety";

/**
 * Лиды и черновики (стратегии «Рост» и выше): агент готовит личные сообщения и приглашения по списку лидов
 * (выгрузка Sales Navigator или CSV), сотрудник отправляет сам одним касанием. Недельный потолок задаёт стратегия.
 */
const LEAD_URL = /^https:\/\/(www\.)?linkedin\.com\/(in|sales\/lead|sales\/people)\/[^\s]+$/i;

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ",") { cur.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; cur.push(cell); rows.push(cur); cur = []; cell = ""; }
    else cell += ch;
  }
  if (cell || cur.length) { cur.push(cell); rows.push(cur); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}
const pick = (r: Record<string, string>, ...keys: string[]) => keys.map((k) => r[k]).find((v) => v) ?? "";

async function ownerOrAgency(ctx: Ctx, accountId: string) {
  const a = await accountScope(ctx.db, ctx, accountId);
  if (!isAccountOwner(ctx, accountId) && !isInternal(ctx, { clientId: a.client_id, accountId })) throw new ForbiddenError("outreach", "Лиды загружает владелец аккаунта или агентство");
  return a;
}

export async function importLeads(ctx: Ctx, accountId: string, input: unknown) {
  const d = z.object({ csv: z.string().min(10).max(500_000), kind: z.enum(["message", "invite"]).default("invite"), source: z.enum(["import", "sales_navigator_export"]).default("import") }).parse(input);
  const a = await ownerOrAgency(ctx, accountId);
  const rows = parseCsv(d.csv).slice(0, 1000);
  let added = 0, skipped = 0;
  for (const r of rows) {
    const name = pick(r, "name", "full name", "имя") || `${pick(r, "first name")} ${pick(r, "last name")}`.trim();
    const url = pick(r, "url", "linkedin url", "profile url", "linkedin", "ссылка");
    if (!name || !LEAD_URL.test(url)) { skipped++; continue; }
    const ins = await ctx.db.query("INSERT INTO outreach_items(client_id, account_id, kind, lead_name, lead_title, lead_company, lead_url, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id",
      [a.client_id, accountId, d.kind, name.slice(0, 120), pick(r, "title", "job title", "должность").slice(0, 160) || null, pick(r, "company", "company name", "компания").slice(0, 160) || null, url, d.source]);
    if (ins.rows.length) added++; else skipped++;
  }
  await audit(ctx.db, ctx, { action: "outreach.imported", entity_type: "managed_account", entity_id: accountId, client_id: a.client_id, account_id: accountId, details: { added, skipped, kind: d.kind } });
  return { added, skipped };
}

/** Черновик сообщения: из паспорта и фактов сотрудника, без выдуманных общих знакомств и обещаний. Приглашение до 300 символов. */
export function composeOutreach(o: { kind: "message" | "invite"; lead: { name: string; title?: string | null; company?: string | null }; me: { role: string; company: string; claim?: string | null; language: "en" | "ru" } }) {
  const first = o.lead.name.split(/\s+/)[0];
  const en = o.me.language === "en";
  const why = o.lead.company ? (en ? `I follow what ${o.lead.company} is building` : `Слежу за тем, что делает ${o.lead.company}`) : (en ? "I came across your profile" : "Увидел ваш профиль");
  if (o.kind === "invite") {
    const t = en ? `Hi ${first}, ${o.me.role} at ${o.me.company} here. ${why} and would be glad to connect and exchange notes.` : `${first}, добрый день. Я ${o.me.role} в ${o.me.company}. ${why}, буду рад обмениваться опытом.`;
    return t.slice(0, 300);
  }
  const claim = o.me.claim ? (en ? ` In my team ${o.me.claim.charAt(0).toLowerCase()}${o.me.claim.slice(1)}` : ` У нас в команде: ${o.me.claim}`) : "";
  return en
    ? `Hi ${first}, thanks for connecting. ${why}.${claim} Would you be open to a short call to compare approaches?`
    : `${first}, спасибо, что приняли приглашение. ${why}.${claim} Будет ли вам интересно коротко созвониться и сравнить подходы?`;
}

/** Агент готовит черновики в пределах недельного потолка стратегии и только при активной подписке и без охлаждения. */
export async function draftOutreach(db: Db, now = new Date()) {
  const accounts = (await db.query(`SELECT DISTINCT o.account_id FROM outreach_items o JOIN personal_agents g ON g.account_id = o.account_id WHERE o.status = 'new' AND g.autopilot = 'on'`)).rows;
  let drafted = 0;
  const wk = weekKey(now);
  for (const { account_id } of accounts) {
    if (!(await subscriptionOf(db, account_id, now)).active) continue;
    const s = await loadSafety(db, account_id);
    if (s.excluded || (s.cooldownUntil && s.cooldownUntil > now) || !s.level) continue;
    const ctx = (await db.query(`SELECT g.passport, c.name AS company, (SELECT statement FROM verified_claims v WHERE v.account_id = g.account_id ORDER BY random() LIMIT 1) AS claim
        FROM personal_agents g JOIN clients c ON c.id = g.client_id WHERE g.account_id = $1`, [account_id])).rows[0];
    for (const kind of ["invite", "message"] as const) {
      const cap = outreachLimit(s.level, kind);
      const used = (await db.query("SELECT count(*)::int n FROM outreach_items WHERE account_id = $1 AND kind = $2 AND week_key = $3 AND status IN ('drafted','sent')", [account_id, kind, wk])).rows[0].n;
      if (used >= cap) continue;
      const items = (await db.query("SELECT * FROM outreach_items WHERE account_id = $1 AND kind = $2 AND status = 'new' ORDER BY created_at LIMIT $3", [account_id, kind, cap - used])).rows;
      for (const it of items) {
        const draft = composeOutreach({ kind, lead: { name: it.lead_name, title: it.lead_title, company: it.lead_company }, me: { role: ctx.passport?.role_label ?? "engineer", company: ctx.company, claim: ctx.claim, language: ctx.passport?.language ?? "en" } });
        await db.query("UPDATE outreach_items SET draft = $2, status = 'drafted', week_key = $3, updated_at = now() WHERE id = $1 AND status = 'new'", [it.id, draft, wk]);
        drafted++;
      }
    }
  }
  return { drafted };
}

export async function myOutreach(ctx: Ctx, accountId: string, now = new Date()) {
  await ownerOrAgency(ctx, accountId);
  const s = await loadSafety(ctx.db, accountId);
  const wk = weekKey(now);
  const used = (await ctx.db.query("SELECT kind, count(*)::int n FROM outreach_items WHERE account_id = $1 AND week_key = $2 AND status = 'sent' GROUP BY kind", [accountId, wk])).rows;
  const items = (await ctx.db.query("SELECT id, kind, lead_name, lead_title, lead_company, lead_url, draft, status, sent_at FROM outreach_items WHERE account_id = $1 AND status IN ('drafted','new','sent') ORDER BY (status = 'drafted') DESC, created_at DESC LIMIT 100", [accountId])).rows;
  const lvl = s.level ?? "reputation";
  return { level: lvl, sales_navigator: STRATEGIES[lvl].salesNavigator, limits: { message: outreachLimit(lvl, "message"), invite: outreachLimit(lvl, "invite") }, sent_this_week: Object.fromEntries(used.map((u: any) => [u.kind, u.n])), items };
}

/** «Отправил» или «Пропустить». Отправка сверх недельного потолка или при охлаждении не засчитывается и блокируется. */
export async function markOutreach(ctx: Ctx, id: string, input: unknown, now = new Date()) {
  const d = z.object({ action: z.enum(["sent", "skip"]), text: z.string().max(1900).optional() }).parse(input);
  const it = (await ctx.db.query("SELECT * FROM outreach_items WHERE id = $1", [id])).rows[0];
  if (!it) throw new NotFoundError("Не найдено");
  assertAccountOwner(ctx, it.account_id);
  if (!["drafted", "new"].includes(it.status)) throw new ConflictError("Уже обработано");
  if (d.action === "skip") {
    await ctx.db.query("UPDATE outreach_items SET status = 'skipped', updated_at = now() WHERE id = $1", [id]);
    return { status: "skipped" };
  }
  if (!(await subscriptionOf(ctx.db, it.account_id, now)).active) throw new ValidationError("Нужна активная подписка");
  const text = (d.text ?? it.draft ?? "").trim();
  if (it.kind === "invite" && text.length > 300) throw new ValidationError("Приглашение длиннее 300 символов");
  const tc = checkText(text, "comment", []);
  if (tc.block.includes("template_phrase")) throw new ValidationError("Шаблонная фраза: перепишите своими словами");
  const wk = weekKey(now);
  // Блокировка аккаунта в транзакции: проверка недельного лимита и отметка «отправлено» атомарны,
  // два одновременных касания не превысят потолок стратегии.
  await ctx.db.tx(async (q) => {
    await lockAccount(q, it.account_id);
    const s = await loadSafety(q, it.account_id);
    if (s.excluded || (s.cooldownUntil && s.cooldownUntil > now)) throw new ValidationError("Аккаунт на охлаждении после сигнала LinkedIn: подождите");
    const sent = (await q.query("SELECT count(*)::int n FROM outreach_items WHERE account_id = $1 AND kind = $2 AND week_key = $3 AND status = 'sent'", [it.account_id, it.kind, wk])).rows[0].n;
    if (sent >= outreachLimit(s.level ?? "reputation", it.kind)) throw new ValidationError("Недельный лимит стратегии исчерпан: продолжим на следующей неделе");
    const upd = await q.query("UPDATE outreach_items SET status = 'sent', draft = $2, week_key = $3, sent_at = now(), updated_at = now() WHERE id = $1 AND status IN ('drafted','new') RETURNING id", [id, text, wk]);
    if (!upd.rows.length) throw new ConflictError("Уже обработано");
  });
  await audit(ctx.db, ctx, { action: "outreach.sent_manually", entity_type: "outreach_item", entity_id: id, client_id: it.client_id, account_id: it.account_id, details: { kind: it.kind } });
  return { status: "sent" };
}

export { parseCsv };
