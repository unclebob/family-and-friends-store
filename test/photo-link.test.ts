import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { signedPhotoUrl } from "../src/photo-link";
import { authed, FIRST_ADMIN, installMerit, login, origin, topicByName } from "./helpers";

let admin = "";
let itemId = 0;
let photoId = 0;
const now = Date.parse("2026-10-21T13:00:00Z");

beforeEach(async () => {
  await installMerit();
  admin = await login("family", FIRST_ADMIN.email);
  const topicId = (await topicByName(admin, "Jewelry")).id;
  const created = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
    method: "POST",
    headers: authed(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ topicId, title: "Brass pin", description: "", priceCents: null }),
  });
  itemId = ((await created.json()) as { id: number }).id;
  const form = new FormData();
  form.set("photo", new File([new Uint8Array([9, 8])], "p", { type: "image/png" }));
  const uploaded = await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/photos`, { method: "POST", headers: authed(admin), body: form });
  photoId = ((await uploaded.json()) as { id: number }).id;
});

const fetchAt = (url: string) => exports.default.fetch(url);

describe("signed photo links for email", () => {
  it("serve the photo with no session until they expire 30 days later", async () => {
    const url = (await signedPhotoUrl(env, photoId, Date.now()))!;
    expect(url).toMatch(/\/photo\/\d+\/email\?exp=\d+&sig=[0-9a-f]{64}$/);
    const exp = Number(new URL(url).searchParams.get("exp"));
    expect(exp).toBe(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
    const response = await fetchAt(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([9, 8]);
  });

  it("refuse a changed signature, a signature for another photo, or missing parts", async () => {
    const url = new URL((await signedPhotoUrl(env, photoId, Date.now()))!);
    const sig = url.searchParams.get("sig")!;
    const flipped = new URL(url);
    flipped.searchParams.set("sig", (sig[0] === "0" ? "1" : "0") + sig.slice(1));
    expect((await fetchAt(flipped.toString())).status).toBe(404);
    const other = new URL(url);
    other.pathname = `/photo/${photoId + 1}/email`;
    expect((await fetchAt(other.toString())).status).toBe(404);
    const later = new URL(url);
    later.searchParams.set("exp", String(Number(url.searchParams.get("exp")) + 1));
    expect((await fetchAt(later.toString())).status).toBe(404);
    expect((await fetchAt(`${origin("family")}/photo/${photoId}/email`)).status).toBe(404);
    expect((await fetchAt(`${origin("family")}/photo/${photoId}/email?exp=abc&sig=${sig}`)).status).toBe(404);
  });

  it("refuse an expired link", async () => {
    const old = (await signedPhotoUrl(env, photoId, Date.now() - 31 * 24 * 3600_000))!;
    expect((await fetchAt(old)).status).toBe(404);
  });

  it("stop working once the item is no longer open", async () => {
    const url = (await signedPhotoUrl(env, photoId, now))!;
    await env.DB.prepare("UPDATE items SET status = 'accepted' WHERE id = ?").bind(itemId).run();
    expect((await fetchAt(url)).status).toBe(404);
  });

  it("are not made, and are not accepted, when no signing key is configured", async () => {
    const keyless = { ...env, PHOTO_LINK_KEY: "" } as Env;
    expect(await signedPhotoUrl(keyless, photoId, now)).toBeNull();
    const { handle } = await import("../src/handle");
    const url = (await signedPhotoUrl(env, photoId, Date.now()))!;
    expect((await handle(new Request(url), keyless)).status).toBe(404);
  });
});
