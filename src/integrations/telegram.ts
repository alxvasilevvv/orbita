/**
 * Telegram Bot API: уведомления сотруднику и решения одним касанием.
 * Кнопки несут подпись HMAC (core/autopilot.signCallback), вебхук проверяет секретный заголовок.
 */
export interface TgButton { text: string; data?: string; url?: string }
export interface TelegramClient {
  readonly enabled: boolean;
  readonly botUsername: string | null;
  send(chatId: string, text: string, buttons: TgButton[][]): Promise<void>;
  answer(callbackId: string, text: string): Promise<void>;
}

export class HttpTelegramClient implements TelegramClient {
  enabled = true;
  constructor(private token: string, public botUsername: string | null, private fetchImpl: typeof fetch = fetch) {}
  private async call(method: string, body: unknown) {
    const r = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Telegram ${method}: ${r.status}`);
  }
  async send(chatId: string, text: string, buttons: TgButton[][]) {
    await this.call("sendMessage", {
      chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true,
      reply_markup: buttons.length ? { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))) } : undefined,
    });
  }
  async answer(callbackId: string, text: string) { await this.call("answerCallbackQuery", { callback_query_id: callbackId, text: text.slice(0, 190) }); }
}

/** Для демо и тестов: сообщения складываются в память. */
export class MemoryTelegramClient implements TelegramClient {
  enabled = true;
  botUsername = "agency_demo_bot";
  sent: { chatId: string; text: string; buttons: TgButton[][] }[] = [];
  answers: { id: string; text: string }[] = [];
  async send(chatId: string, text: string, buttons: TgButton[][]) { this.sent.push({ chatId, text, buttons }); }
  async answer(id: string, text: string) { this.answers.push({ id, text }); }
}

export function telegramFromEnv(env = process.env): TelegramClient {
  if (env.TELEGRAM_BOT_TOKEN) return new HttpTelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_BOT_USERNAME ?? null);
  return new MemoryTelegramClient();
}
