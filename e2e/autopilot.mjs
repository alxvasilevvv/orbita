import { chromium } from "playwright";
const B = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.env.SHOTS ?? "./e2e/shots";
const users = await (await fetch(B + "/api/dev/users")).json();
const uid = (f) => users.find((u) => u.display_name.includes(f)).id;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("response", (r) => { if (r.status() >= 500) errs.push(`${r.status()} ${r.url()}`); });
const as = async (f) => { await page.goto(B + "/"); await page.waitForTimeout(500); await page.evaluate((i) => { localStorage.setItem("uid", i); localStorage.setItem("locale", "ru"); }, uid(f)); };
const shot = async (n, full = true) => { await page.waitForTimeout(900); await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: full }); };
const go = async (h) => { await page.goto(B + "/#" + h); await page.reload(); await page.waitForTimeout(700); };

// Сотрудник с готовым агентом: рабочий кабинет (посты, стратегия, управление)
await as("Lena"); await go("/me/agent"); await shot("ap01-agent-home");
await as("Raj"); await go("/me/agent"); await shot("ap02-agent-posts");
// Лиды и сообщения
await as("Anna"); await go("/me/outreach"); await shot("ap03-outreach");
// Онбординг-мастер: Omar ещё не прошёл оплату
await as("Omar"); await go("/me/agent"); await shot("ap04-onboarding");
// Руководитель: вкладка «Автопилот» с проверкой постов, стратегией и подписками
await as("Кира"); await go("/");
await page.click("[role=tab]:has-text('Автопилот')").catch(() => {});
await shot("ap05-company-autopilot");
console.log("errors:", JSON.stringify(errs));
if (errs.length) process.exitCode = 1;
await browser.close();
