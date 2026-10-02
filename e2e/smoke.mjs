import { chromium } from "playwright";
const B = process.env.BASE_URL ?? "http://localhost:3000";
const users = await (await fetch(B + "/api/dev/users")).json();
const uid = (frag) => users.find((u) => u.display_name.includes(frag)).id;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errs = [];
page.on("pageerror", (e) => errs.push(`PAGEERR ${page.url()} ${e.message}`));
page.on("response", (r) => { if (r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url()}`); });
const LOC = process.env.LOC ?? "ru";
const as = async (frag) => { await page.goto(B + "/"); await page.evaluate(([id, l]) => { localStorage.setItem("uid", id); localStorage.setItem("locale", l); }, [uid(frag), LOC]); };
const dir = process.env.SHOTS ?? "./e2e/shots";
const shot = async (n) => { await page.waitForTimeout(900); await page.screenshot({ path: `${dir}/${n}.png`, fullPage: true }); };
const visit = async (hash, n) => { await page.goto(B + "/#" + hash); await page.waitForTimeout(300); await page.reload(); await shot(n); };

await as("Ольга");
for (const [h, n] of [["/", "s01-overview"], ["/accounts", "s02-accounts"], ["/calendar", "s03-calendar"], ["/approvals", "s04-approvals"], ["/engagement", "s05-engagement"], ["/tasks", "s06-tasks"], ["/agency-report", "s07-agency"], ["/team", "s08-team"], ["/workflows", "s09-workflows"], ["/incidents", "s10-incidents"], ["/exports", "s11-exports"], ["/audit", "s12-audit"], ["/integrations", "s13-integrations"]]) await visit(h, n);
const accs = await (await fetch(B + "/api/accounts", { headers: { "x-user-id": uid("Ольга") } })).json();
const john = accs.find((a) => a.display_name.startsWith("John"));
await page.goto(B + "/#/accounts/" + john.id); await page.reload(); await page.waitForTimeout(800);
const tabs = await page.$$eval("[role=tab]", (els) => els.map((e) => e.textContent));
for (const [i, tb] of tabs.entries()) { await page.click(`[role=tab]:has-text("${tb}")`); await shot(`a${String(i).padStart(2, "0")}`); }
// материал
const ws = await (await fetch(B + "/api/accounts/" + john.id, { headers: { "x-user-id": uid("Ольга") } })).json();
await visit("/content/" + ws.content[0].id, "c01-content");
// клиент
await as("Джон"); await visit("/", "p01-portal");
await page.setViewportSize({ width: 390, height: 844 }); await as("Денис"); await visit("/calendar", "m01-calendar-mobile"); await visit("/accounts/" + john.id, "m02-account-mobile");
console.log("tabs:", tabs.join(" | "));
console.log("errors:", JSON.stringify(errs, null, 1));
await browser.close();
