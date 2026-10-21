import { describe, it, expect } from "vitest";
import { WebhookMailer, mailerFromEnv } from "../src/services/notify";

describe("Slack-вебхук уведомлений", () => {
  it("payload содержит заголовок и рабочую ссылку в поле text (совместимо со Slack)", () => {
    const w = new WebhookMailer("https://hooks.slack.com/x", "https://orbita.unyly.org");
    const p = w.payload({ to: "u@x", subject: "Ошибка публикации", link: "#/accounts/1" });
    expect(p.text).toContain("Ошибка публикации");
    expect(p.text).toContain("https://orbita.unyly.org/#/accounts/1");
    expect(p.link).toBe("https://orbita.unyly.org/#/accounts/1");
  });
  it("send отправляет на URL, бросает на не-2xx", async () => {
    let called: any = null;
    const okFetch = (async (url: string, init: any) => { called = { url, body: JSON.parse(init.body) }; return { ok: true } as any; });
    const w = new WebhookMailer("https://hooks.slack.com/x", "", okFetch as any);
    await w.send({ to: "u@x", subject: "Привет", link: null });
    expect(called.url).toContain("hooks.slack.com");
    expect(called.body.text).toBe("Привет");
    const badFetch = (async () => ({ ok: false, status: 500 } as any));
    const w2 = new WebhookMailer("https://x", "", badFetch as any);
    await expect(w2.send({ to: "u", subject: "x" })).rejects.toThrow(/Webhook 500/);
  });
  it("mailerFromEnv выбирает Slack-вебхук при SLACK_WEBHOOK_URL", () => {
    expect(mailerFromEnv({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/y" } as any).name).toBe("webhook");
    expect(mailerFromEnv({} as any).name).toBe("console");
  });
});
