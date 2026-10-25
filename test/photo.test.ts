import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { authed, FIRST_ADMIN, installMerit, login, origin, topicByName } from "./helpers";

beforeEach(async () => {
  await installMerit();
});

const BYTES = [1, 2, 3, 4];

async function photographedItem(admin: string, type = "image/jpeg") {
  const topicId = (await topicByName(admin, "Jewelry")).id;
  const created = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
    method: "POST",
    headers: authed(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ topicId, title: "Brass pin", description: "", priceCents: null }),
  });
  const itemId = ((await created.json()) as { id: number }).id;
  const form = new FormData();
  form.set("photo", new File([new Uint8Array(BYTES)], "pin", { type }));
  const uploaded = await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/photos`, {
    method: "POST",
    headers: authed(admin),
    body: form,
  });
  const photoId = ((await uploaded.json()) as { id: number }).id;
  return { itemId, photoId };
}

async function photo(photoId: number, cookie?: string): Promise<Response> {
  const headers = cookie ? authed(cookie) : undefined;
  return exports.default.fetch(`${origin("family")}/photo/${photoId}`, { headers });
}

describe("photo access", () => {
  it("serves an open item's photo to family with its bytes and private caching", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const family = await login("family", "ada@example.com");
    const { photoId } = await photographedItem(admin);
    const response = await photo(photoId, family);
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(BYTES);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
  });

  it("hides every photo from someone who is signed out", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const { photoId } = await photographedItem(admin);
    expect((await photo(photoId)).status).toBe(404);
  });

  it("returns 404 for a photo that does not exist", async () => {
    const family = await login("family", "ada@example.com");
    expect((await photo(9999, family)).status).toBe(404);
  });

  it("hides an accepted item's photo from family but still shows it to an admin", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const family = await login("family", "ada@example.com");
    const { itemId, photoId } = await photographedItem(admin);
    await env.DB.prepare("UPDATE items SET status = 'accepted' WHERE id = ?").bind(itemId).run();
    expect((await photo(photoId, family)).status).toBe(404);
    expect((await photo(photoId, admin)).status).toBe(200);
  });

  it("serves a PNG with its own content type", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const { photoId } = await photographedItem(admin, "image/png");
    expect((await photo(photoId, admin)).headers.get("content-type")).toBe("image/png");
  });

  it("serves a stored photo that has no recorded type as JPEG", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const { photoId } = await photographedItem(admin);
    const row = await env.DB.prepare("SELECT r2_key FROM photos WHERE id = ?").bind(photoId).first<{ r2_key: string }>();
    await env.PHOTOS.put(row!.r2_key, new Uint8Array(BYTES));
    const response = await photo(photoId, admin);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });
});
