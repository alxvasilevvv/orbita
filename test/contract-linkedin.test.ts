import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LinkedInHttpAdapter, IntegrationError, escapeLittleText } from "../src/integrations/linkedin/adapter";

/** Контрактные тесты адаптера на записанных ответах. Живой LinkedIn не вызывается. */
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures/linkedin", `${name}.json`), "utf8"));
const respond = (f: any) => new Response(typeof f.body === "string" ? f.body : JSON.stringify(f.body), { status: f.status, headers: f.headers });
const req = { idempotencyKey: "k", authorUrn: "urn:li:person:abc", body: "Текст #тег (важно) @упоминание", accessToken: "token", apiVersion: "202608" };

afterEach(() => vi.unstubAllGlobals());

describe("контракт Posts API", () => {
  it("201: запрос по спецификации, идентификатор из x-restli-id", async () => {
    const f = vi.fn(async () => respond(fx("posts-201")));
    vi.stubGlobal("fetch", f);
    const r = await new LinkedInHttpAdapter().publishPost(req);
    expect(r.externalId).toBe("urn:li:share:7300000000000000000");
    const [url, init] = f.mock.calls[0] as any[];
    expect(url).toBe("https://api.linkedin.com/rest/posts");
    expect(init.headers["LinkedIn-Version"]).toBe("202608");
    expect(init.headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
    expect(init.headers.Authorization).toBe("Bearer token");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ author: "urn:li:person:abc", visibility: "PUBLIC", lifecycleState: "PUBLISHED", distribution: { feedDistribution: "MAIN_FEED" } });
    expect(body.commentary).toBe(escapeLittleText(req.body));
    expect(body.commentary).toContain("\\#");
    expect(body.content).toBeUndefined();
  });
  it("изображения: одно → content.media, несколько → content.multiImage", async () => {
    const f = vi.fn(async () => respond(fx("posts-201")));
    vi.stubGlobal("fetch", f);
    const a = new LinkedInHttpAdapter();
    await a.publishPost({ ...req, imageUrns: ["urn:li:image:1"], altTexts: ["Схема завода"] });
    expect(JSON.parse((f.mock.calls[0] as any[])[1].body).content).toEqual({ media: { id: "urn:li:image:1", altText: "Схема завода" } });
    await a.publishPost({ ...req, imageUrns: ["urn:li:image:1", "urn:li:image:2"] });
    expect(JSON.parse((f.mock.calls[1] as any[])[1].body).content).toEqual({ multiImage: { images: [{ id: "urn:li:image:1" }, { id: "urn:li:image:2" }] } });
  });
  it.each([
    ["posts-401", "auth"],
    ["posts-403", "permanent"],
    ["posts-429", "quota"],
    ["posts-500", "unknown_outcome"],
  ])("%s классифицируется как %s", async (name, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(fx(name))));
    const e = await new LinkedInHttpAdapter().publishPost(req).catch((x) => x);
    expect(e).toBeInstanceOf(IntegrationError);
    expect(e.kind).toBe(kind);
    if (kind === "quota") expect(e.retryAfterSec).toBe(120);
  });
  it("сетевой обрыв и 201 без идентификатора → неизвестный исход, не повтор", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect((await new LinkedInHttpAdapter().publishPost(req).catch((x) => x)).kind).toBe("unknown_outcome");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 201 })));
    expect((await new LinkedInHttpAdapter().publishPost(req).catch((x) => x)).code).toBe("missing_id");
  });
  it("таймаут прерывает запрос и даёт неизвестный исход", async () => {
    vi.stubGlobal("fetch", vi.fn((_u: string, init: any) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))));
    const e = await new LinkedInHttpAdapter("https://api.linkedin.com", 20).publishPost(req).catch((x) => x);
    expect(e.kind).toBe("unknown_outcome");
    expect(e.code).toBe("timeout");
  });
});

describe("контракт Images API", () => {
  it("initializeUpload → PUT бинарных данных → urn изображения", async () => {
    const f = vi.fn(async (url: string) => url.includes("initializeUpload") ? respond(fx("images-init")) : new Response("", { status: 201 }));
    vi.stubGlobal("fetch", f);
    const urn = await new LinkedInHttpAdapter().uploadImage({ authorUrn: "urn:li:person:abc", accessToken: "t", apiVersion: "202608", data: Buffer.from([1, 2, 3]), contentType: "image/png" });
    expect(urn).toBe("urn:li:image:C4E10AQFoyyAjHPMQuQ");
    const init = (f.mock.calls[0] as any[])[1];
    expect(JSON.parse(init.body)).toEqual({ initializeUploadRequest: { owner: "urn:li:person:abc" } });
    const [putUrl, put] = f.mock.calls[1] as any[];
    expect(putUrl).toContain("dms-uploads");
    expect(put.method).toBe("PUT");
  });
  it("ошибка инициализации 401 → требуется переподключение", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(fx("posts-401"))));
    const e = await new LinkedInHttpAdapter().uploadImage({ authorUrn: "u", accessToken: "t", apiVersion: "v", data: Buffer.from([1]), contentType: "image/png" }).catch((x) => x);
    expect(e.kind).toBe("auth");
  });
});
