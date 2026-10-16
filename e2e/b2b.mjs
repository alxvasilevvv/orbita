import { chromium } from "playwright";
const B = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.env.SHOTS ?? "./e2e/shots";
const users = await (await fetch(B + "/api/dev/users")).json();
const uid = (f) => users.find((u) => u.display_name.includes(f)).id;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("response", (r) => { if (r.status() >= 500) errs.push(`${r.status()} ${r.url()}`); });
const as = async (f) => { await page.goto(B + "/"); await page.waitForTimeout(500); await page.evaluate((i) => { localStorage.setItem("uid", i); localStorage.setItem("locale", "ru"); }, uid(f)); };
const shot = async (n, full = false) => { await page.waitForTimeout(900); await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: full }); };
const go = async (h) => { await page.goto(B + "/#" + h); await page.reload(); await page.waitForTimeout(600); };

// Руководитель компании: обзор, новая миссия
await as("Кира"); await go("/"); await shot("b01-company-overview", true);
await page.click("[role=tab]:has-text('Миссии агентов')");
await page.fill("label:has-text('Тема') input", "Поддержать разбор ML-архитектуры");
await page.fill("input[type=url]", "https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000042/");
await page.fill("label:has-text('Текст поста') textarea", "Наша ML-команда перевела три завода на предиктивное обслуживание: модели на телеметрии оборудования, кластер Kubernetes для инференса, отдельный контур безопасности данных.");
await page.click("button:has-text('Запустить агентов')"); await shot("b02-mission-created", true);
await page.click("[role=tab]:has-text('Команда')"); await shot("b03-team-leader");
await page.click("[role=tab]:has-text('Бриф компании')"); await shot("b04-brief", true);
// Сотрудник: предложение агента
await as("Anna Kovacs"); await go("/"); await shot("b05-employee-actions", true);
// Агентство: портфель и компания
await as("Денис"); await go("/companies"); await shot("b06-portfolio");
const comp = await (await fetch(B + "/api/companies", { headers: { "x-user-id": uid("Денис") } })).json();
const nw = comp.find((c) => c.name === "Northwind Robotics");
await go("/companies/" + nw.id); await page.click("[role=tab]:has-text('Команда')"); await shot("b07-team-agency", true);
const ov = await (await fetch(B + "/api/companies/" + nw.id, { headers: { "x-user-id": uid("Денис") } })).json();
if (ov.missions[0]) { await go("/missions/" + ov.missions[0].id); await shot("b08-mission-agency", true); }
// Приглашение
const inv = await (await fetch(B + `/api/companies/${nw.id}/invites`, { method: "POST", headers: { "x-user-id": uid("Кира"), "content-type": "application/json" }, body: JSON.stringify({ email: `new${Date.now()}@northwind.example`, display_name: "Sara Nilsson (Backend Engineer)", timezone: "Europe/Stockholm" }) })).json();
await page.goto(B + "/" + inv.invite_link); await page.reload(); await page.waitForTimeout(700); await shot("b09-invite", true);
console.log("errors:", JSON.stringify(errs));
await browser.close();
