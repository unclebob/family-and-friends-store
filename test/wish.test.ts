import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { setWish } from "../src/wish";
import { authed, FIRST_ADMIN, installMerit, login, origin, topicByName } from "./helpers";

beforeEach(async () => {
  await installMerit();
});

async function openItem(): Promise<number> {
  const admin = await login("family", FIRST_ADMIN.email);
  const topicId = (await topicByName(admin, "Jewelry")).id;
  const created = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
    method: "POST",
    headers: authed(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ topicId, title: "Brass pin", description: "", priceCents: null }),
  });
  return ((await created.json()) as { id: number }).id;
}

async function wish(cookie: string, itemId: number, wished: boolean, kind?: unknown, host: "family" | "friends" = "family"): Promise<Response> {
  return exports.default.fetch(`${origin(host)}/api/items/${itemId}/wish`, {
    method: "POST",
    headers: authed(cookie, { "content-type": "application/json" }),
    body: JSON.stringify({ wished, kind }),
  });
}

async function stored(email = "ada@example.com") {
  return env.DB.prepare("SELECT status, kind, created_at FROM wishes WHERE email = ?").bind(email).first<{ status: string; kind: string; created_at: string }>();
}

async function wishStatus(): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM wishes WHERE email = 'ada@example.com'").first<{ status: string }>();
  return row?.status;
}

const ada = { email: "ada@example.com", name: "Ada Family", firstName: "Ada", group: "family" as const, topics: "all" as const, host: "family" as const };

describe("wishes", () => {
  it("answers a wish with wished true and a withdrawal with wished false", async () => {
    const family = await login("family", "ada@example.com");
    const itemId = await openItem();
    const on = await wish(family, itemId, true);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ wished: true, kind: "now" });
    expect(await wishStatus()).toBe("active");
    const off = await wish(family, itemId, false);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ wished: false });
    expect(await wishStatus()).toBe("withdrawn");
  });

  it("returns 404 for a wish on an item that does not exist", async () => {
    const family = await login("family", "ada@example.com");
    expect((await wish(family, 9999, true)).status).toBe(404);
  });

  it("refuses to re-open a wish that was already accepted", async () => {
    const itemId = await openItem();
    expect(await setWish(env.DB, ada, itemId, true)).toEqual({ status: 200, wished: true, kind: "now" });
    await env.DB.prepare("UPDATE wishes SET status = 'accepted' WHERE email = 'ada@example.com'").run();
    expect(await setWish(env.DB, ada, itemId, true)).toEqual({ status: 409 });
    expect(await wishStatus()).toBe("accepted");
  });

  it("lets family wish for an item now or someday, and switch between them without a new wish date", async () => {
    const family = await login("family", "ada@example.com");
    const itemId = await openItem();
    expect(await (await wish(family, itemId, true, "someday")).json()).toEqual({ wished: true, kind: "someday" });
    const first = await stored();
    expect(first).toMatchObject({ status: "active", kind: "someday" });
    expect(await (await wish(family, itemId, true, "now")).json()).toEqual({ wished: true, kind: "now" });
    const switched = await stored();
    expect(switched).toMatchObject({ status: "active", kind: "now", created_at: first?.created_at });
    await wish(family, itemId, false);
    expect(await stored()).toMatchObject({ status: "withdrawn" });
  });

  it("keeps friends to plain wishes: no kind or now is fine, someday is refused", async () => {
    const friend = await login("friends", "bea@example.com");
    const admin = await login("family", FIRST_ADMIN.email);
    const topicId = (await topicByName(admin, "Jewelry")).id;
    const created = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ topicId, title: "Ring", description: "", priceCents: null }),
    });
    const itemId = ((await created.json()) as { id: number }).id;
    const refused = await wish(friend, itemId, true, "someday", "friends");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Friends can only wish for an item now." });
    expect(await stored("bea@example.com")).toBeNull();
    expect(await (await wish(friend, itemId, true, undefined, "friends")).json()).toEqual({ wished: true, kind: "now" });
    expect(await (await wish(friend, itemId, true, "now", "friends")).json()).toEqual({ wished: true, kind: "now" });
  });

  it("refuses an unknown kind", async () => {
    const family = await login("family", "ada@example.com");
    const itemId = await openItem();
    const response = await wish(family, itemId, true, "later");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Kind must be now or someday." });
  });
});
