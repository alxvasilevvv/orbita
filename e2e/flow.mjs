import { chromium } from "playwright";
const B = process.env.BASE_URL ?? "http://localhost:3000";
const users = await (await fetch(B + "/api/dev/users")).json();
const uid = (frag) => users.find((u) => u.display_name.includes(frag)).id;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("TUNNEL") && errs.push(m.text()));
page.on("response", (r) => { if (r.status() === 404 || r.status() >= 500) errs.push(`${r.status()} ${r.url()}`); });
const as = async (frag) => { await page.goto(B + "/"); await page.evaluate((id) => localStorage.setItem("uid", id), uid(frag)); };
const shot = async (n) => { await page.waitForTimeout(700); await page.screenshot({ path: `./e2e/shots/${n}.png`, fullPage: true }); };

await as("Денис"); await page.goto(B + "/#/"); await page.reload(); await shot("01-overview");
await page.goto(B + "/#/accounts"); await shot("02-accounts");
// редактор согласует материал из очереди
await as("Екатерина"); await page.goto(B + "/#/approvals"); await page.reload(); await shot("03-approvals");
await page.click("text=Почему мы полгода пилотировали один завод"); await page.waitForTimeout(800);
await shot("04-content-editor-review");
await page.click("button:has-text('Согласовать версию')"); await page.waitForTimeout(800);
// клиент согласует
await as("Джон"); await page.goto(B + "/#/approvals"); await page.reload(); await page.waitForTimeout(500);
await page.click("text=Почему мы полгода пилотировали один завод"); await page.waitForTimeout(800);
await page.click("button:has-text('Согласовать версию')"); await page.waitForTimeout(800);
// менеджер планирует
await as("Денис"); await page.goto(B + "/#/approvals"); await page.reload();
const acc = (await (await fetch(B + "/api/accounts", { headers: { "x-user-id": uid("Денис") } })).json()).find((a) => a.display_name.startsWith("John"));
const ws = await (await fetch(B + "/api/accounts/" + acc.id, { headers: { "x-user-id": uid("Денис") } })).json();
const item = ws.content.find((c) => c.title.startsWith("Почему"));
await page.goto(B + "/#/content/" + item.id); await page.waitForTimeout(900);
await page.fill("input[type=datetime-local]", "2026-11-01T01:30"); await page.click("button:has-text('Запланировать публикацию')"); await page.waitForTimeout(800);
await shot("05-dst-ambiguity");
await page.click("button:has-text('Позже')"); await page.waitForTimeout(1000);
await shot("06-assisted-publish");
await page.fill("input[type=url]", "https://www.linkedin.com/feed/update/urn:li:share:7300000000000000001/");
await page.click("button:has-text('Отметить публикацию')"); await page.waitForTimeout(1000);
await shot("07-published-manual");
await page.goto(B + "/#/accounts/" + acc.id); await page.waitForTimeout(800);
await page.click("role=tab[name='Настройки и доступы']"); await shot("08-settings-capabilities");
await page.click("role=tab[name='История действий']"); await shot("09-history");
await page.click("role=tab[name='Отчёты']"); await page.click("button:has-text('Сформировать отчёт')"); await page.waitForTimeout(1200); await shot("10-report");
// изоляция: автор другого клиента открывает чужой аккаунт
await as("Павел"); await page.goto(B + "/#/accounts/" + acc.id); await page.reload(); await shot("11-isolation");
await page.setViewportSize({ width: 390, height: 844 }); await as("Денис"); await page.goto(B + "/#/accounts"); await page.reload(); await shot("12-mobile");
console.log("errors:", JSON.stringify(errs));
await browser.close();
