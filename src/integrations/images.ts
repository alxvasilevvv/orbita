import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * Генерация изображений: портрет сотрудника по его фотографиям и визуалы к постам.
 * ARA (arahub.io) подключается по HTTP; пути и модели задаются в окружении. Демо-провайдер рисует PNG локально.
 */
export interface ImageRequest {
  purpose: "portrait" | "banner" | "post_image";
  prompt: string;
  /** Фото самого сотрудника: только для портрета, только по его согласию. */
  references?: { data: Buffer; mime: string }[];
  size: { width: number; height: number };
  seed: string;
}
export interface ImageResult { data: Buffer; mime: string; model: string; costUsd: number | null }
export interface ImageProvider { name: string; generate(r: ImageRequest): Promise<ImageResult> }

/* ---------- Демо: детерминированный PNG ---------- */
function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Градиент в фирменных цветах с кругом-силуэтом для портрета. */
export function renderPng(w: number, h: number, seed: string, portrait: boolean): Buffer {
  const hash = createHash("sha256").update(seed).digest();
  const c1 = [hash[0], hash[1], hash[2]], c2 = [hash[3] >> 1, hash[4] >> 1, 120 + (hash[5] >> 2)];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const cx = w / 2, cy = h * 0.42, r = Math.min(w, h) * 0.22;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h);
      let px = [0, 1, 2].map((i) => Math.round(c1[i] * (1 - t) + c2[i] * t));
      if (portrait) {
        const head = (x - cx) ** 2 + (y - cy) ** 2 < r * r;
        const body = y > cy + r * 0.9 && Math.abs(x - cx) < r * 1.7 - (y - cy - r) * 0.1;
        if (head || body) px = px.map((v) => Math.min(255, v + 70));
      }
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = px[0]; raw[o + 1] = px[1]; raw[o + 2] = px[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export class DemoImageProvider implements ImageProvider {
  name = "demo";
  async generate(r: ImageRequest): Promise<ImageResult> {
    const scale = Math.min(1, 640 / Math.max(r.size.width, r.size.height));
    return { data: renderPng(Math.round(r.size.width * scale), Math.round(r.size.height * scale), `${r.seed}:${r.prompt}`, r.purpose === "portrait"), mime: "image/png", model: "demo-gradient-v1", costUsd: 0 };
  }
}

/* ---------- ARA (arahub.io) ---------- */
/**
 * Контракт: POST {base}{ARA_GENERATE_PATH} → { id, status, url?, cost_usd? }; пока status не completed,
 * GET {base}{ARA_STATUS_PATH}/{id}. Готовый файл скачивается по url. Модель портрета сохраняет лицо с референсов.
 */
export class AraImageProvider implements ImageProvider {
  name = "ara";
  constructor(private o: { baseUrl: string; apiKey: string; generatePath: string; statusPath: string; portraitModel: string; imageModel: string; pollMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch }) {}
  async generate(r: ImageRequest): Promise<ImageResult> {
    const f = this.o.fetchImpl ?? fetch;
    const model = r.purpose === "post_image" ? this.o.imageModel : this.o.portraitModel;
    const headers = { Authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json" };
    const start = await f(`${this.o.baseUrl}${this.o.generatePath}`, {
      method: "POST", headers,
      body: JSON.stringify({ model, prompt: r.prompt, width: r.size.width, height: r.size.height,
        reference_images: (r.references ?? []).map((x) => `data:${x.mime};base64,${x.data.toString("base64")}`) }),
    });
    if (!start.ok) throw new Error(`ARA вернул ${start.status}`);
    let job: any = await start.json();
    const deadline = Date.now() + (this.o.timeoutMs ?? 180_000);
    while (job.status !== "completed" && job.status !== "Completed") {
      if (job.status === "failed" || Date.now() > deadline) throw new Error(`ARA: генерация не завершилась (${job.status ?? "timeout"})`);
      await new Promise((res) => setTimeout(res, this.o.pollMs ?? 3000));
      const s = await f(`${this.o.baseUrl}${this.o.statusPath}/${encodeURIComponent(job.id)}`, { headers });
      if (!s.ok) throw new Error(`ARA статус ${s.status}`);
      job = await s.json();
    }
    const url = job.url ?? job.result_url ?? job.images?.[0]?.url;
    if (!url || !/^https:\/\//.test(url)) throw new Error("ARA не вернул ссылку на результат");
    const file = await f(url);
    if (!file.ok) throw new Error(`Не удалось скачать результат ARA: ${file.status}`);
    const data = Buffer.from(await file.arrayBuffer());
    return { data, mime: file.headers.get("content-type")?.split(";")[0] ?? "image/png", model, costUsd: job.cost_usd != null ? Number(job.cost_usd) : null };
  }
}

export function imageProviderFromEnv(env = process.env): ImageProvider {
  if (env.IMAGE_PROVIDER === "ara" && env.ARA_API_URL && env.ARA_API_KEY) {
    return new AraImageProvider({
      baseUrl: env.ARA_API_URL.replace(/\/$/, ""), apiKey: env.ARA_API_KEY,
      generatePath: env.ARA_GENERATE_PATH ?? "/v1/generations", statusPath: env.ARA_STATUS_PATH ?? "/v1/generations",
      portraitModel: env.ARA_PORTRAIT_MODEL ?? "nano-banana-pro", imageModel: env.ARA_IMAGE_MODEL ?? "nano-banana",
    });
  }
  return new DemoImageProvider();
}
