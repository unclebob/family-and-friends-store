import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { asJson, authed, FIRST_ADMIN, installMerit, login, origin, topicByName } from "./helpers";

beforeEach(async () => {
  await installMerit();
});

async function item(
  cookie: string,
  topicId: number,
  title: string,
  priceCents: number | null,
): Promise<number> {
  const response = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
    method: "POST",
    headers: authed(cookie, { "content-type": "application/json" }),
    body: JSON.stringify({ topicId, title, description: "A small brass pin.", priceCents }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

describe("catalog visibility", () => {
  it("keeps prices off every family response and shows them to admins and friends", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const family = await login("family", "ada@example.com");
    const friend = await login("friends", "bea@example.com");
    const jewelry = await topicByName(admin, "Jewelry");
    const pin = await item(admin, jewelry.id, "Brass pin", 1995);

    const familyBody = JSON.stringify(await (await exports.default.fetch(`${origin("family")}/api/items/${pin}`, { headers: authed(family) })).json());
    expect(familyBody).not.toContain("price");
    expect(familyBody).not.toContain("1995");
    expect(familyBody).not.toContain("19.95");

    const familyList = JSON.stringify(await (await exports.default.fetch(`${origin("family")}/api/items?topic=jewelry`, { headers: authed(family) })).json());
    expect(familyList).not.toContain("price");
    expect(familyList).not.toContain("1995");

    const adminItem = await asJson(await exports.default.fetch(`${origin("family")}/api/items/${pin}`, { headers: authed(admin) }));
    expect(JSON.stringify(adminItem)).toContain("1995");
    const friendItem = await asJson(await exports.default.fetch(`${origin("friends")}/api/items/${pin}`, { headers: authed(friend) }));
    expect(JSON.stringify(friendItem)).toContain("1995");
  });

  it("names other wishers to family and only counts them for a friend", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const family = await login("family", "ada@example.com");
    const friend = await login("friends", "bea@example.com");
    const jewelry = await topicByName(admin, "Jewelry");
    const pin = await item(admin, jewelry.id, "Brass pin", 1995);
    await exports.default.fetch(`${origin("family")}/api/items/${pin}/wish`, {
      method: "POST",
      headers: authed(family, { "content-type": "application/json" }),
      body: JSON.stringify({ wished: true }),
    });
    await exports.default.fetch(`${origin("friends")}/api/items/${pin}/wish`, {
      method: "POST",
      headers: authed(friend, { "content-type": "application/json" }),
      body: JSON.stringify({ wished: true }),
    });

    const familyView = await asJson(await exports.default.fetch(`${origin("family")}/api/items/${pin}`, { headers: authed(family) }));
    expect(JSON.stringify(familyView)).toContain("Bea Friend");
    const friendView = JSON.stringify(await (await exports.default.fetch(`${origin("friends")}/api/items/${pin}`, { headers: authed(friend) })).json());
    expect(friendView).not.toContain("Ada");
    expect(friendView).not.toContain("alsoWantedBy");
    expect(friendView).not.toContain("ada@example.com");
    expect(JSON.parse(friendView).item).toMatchObject({ othersWishing: 1 });
    expect(familyView.item).not.toHaveProperty("othersWishing");
  });

  it("returns 404 for a topic, item, or photo a friend was not granted", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const friend = await login("friends", "bea@example.com");
    const jewelry = await topicByName(admin, "Jewelry");
    const aviation = await topicByName(admin, "Aviation");
    const pin = await item(admin, jewelry.id, "Brass pin", 1995);
    const book = await item(admin, aviation.id, "Pilot logbook", 12000);
    const form = new FormData();
    form.set("photo", new File([new Uint8Array([1, 2, 3, 4])], "pin.jpg", { type: "image/jpeg" }));
    const uploaded = await exports.default.fetch(`${origin("family")}/api/admin/items/${book}/photos`, {
      method: "POST",
      headers: authed(admin),
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const photo = (await uploaded.json()) as { id: number; url: string };
    expect(photo.url).toBe(`/photo/${photo.id}`);

    const hiddenItem = await exports.default.fetch(`${origin("friends")}/api/items/${book}`, { headers: authed(friend) });
    const missingItem = await exports.default.fetch(`${origin("friends")}/api/items/9999`, { headers: authed(friend) });
    expect(hiddenItem.status).toBe(404);
    expect(await hiddenItem.json()).toEqual(await missingItem.json());
    const hiddenList = await exports.default.fetch(`${origin("friends")}/api/items?topic=aviation`, { headers: authed(friend) });
    expect(hiddenList.status).toBe(404);
    const hiddenPhoto = await exports.default.fetch(`${origin("friends")}/photo/${photo.id}`, { headers: authed(friend) });
    expect(hiddenPhoto.status).toBe(404);

    const allowed = await exports.default.fetch(`${origin("friends")}/api/items/${pin}`, { headers: authed(friend) });
    expect(allowed.status).toBe(200);
  });

  it("keeps a new topic invisible until the friend signs in again", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const friend = await login("friends", "bea@example.com");
    await topicByName(admin, "Jewelry");
    const aviation = await topicByName(admin, "Aviation");
    const book = await item(admin, aviation.id, "Pilot logbook", null);
    const before = await exports.default.fetch(`${origin("friends")}/api/items/${book}`, { headers: authed(friend) });
    expect(before.status).toBe(404);

    const fake = await env.MERIT.getByName("merit").getFake();
    await env.MERIT.getByName("merit").setFake({
      admins: fake!.admins,
      family: fake!.family,
      friends: fake!.friends,
      grants: { "bea@example.com": ["jewelry", "aviation"] },
      contacts: fake!.contacts,
    });
    const still = await exports.default.fetch(`${origin("friends")}/api/items/${book}`, { headers: authed(friend) });
    expect(still.status).toBe(404);
    const again = await login("friends", "bea@example.com");
    const after = await exports.default.fetch(`${origin("friends")}/api/items/${book}`, { headers: authed(again) });
    expect(after.status).toBe(200);
  });

  it("rejects non-admins from every admin route", async () => {
    const family = await login("family", "ada@example.com");
    const friend = await login("friends", "bea@example.com");
    for (const cookie of [family, friend]) {
      const host = cookie === friend ? "friends" : "family";
      const response = await exports.default.fetch(`${origin(host)}/api/admin/items`, { headers: authed(cookie) });
      expect(response.status).toBe(403);
      const missing = await exports.default.fetch(`${origin(host)}/api/admin/nope`, { headers: authed(cookie) });
      expect(missing.status).toBe(403);
    }
    const loggedOut = await exports.default.fetch(`${origin("family")}/api/admin/items`);
    expect(loggedOut.status).toBe(401);
  });

  it("rejects an oversized photo before storing it", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const jewelry = await topicByName(admin, "Jewelry");
    const pin = await item(admin, jewelry.id, "Brass pin", null);
    const form = new FormData();
    form.set("photo", new File([new Uint8Array(2_000_001)], "big.jpg", { type: "image/jpeg" }));
    const response = await exports.default.fetch(`${origin("family")}/api/admin/items/${pin}/photos`, {
      method: "POST",
      headers: authed(admin),
      body: form,
    });
    expect(response.status).toBe(413);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("hides accepted, staged, and delivered items from family and friends while keeping them in an admin's catalog list", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const family = await login("family", "ada@example.com");
    const friend = await login("friends", "bea@example.com");
    const jewelry = await topicByName(admin, "Jewelry");
    const open = await item(admin, jewelry.id, "Open pin", 500);
    const accepted = await item(admin, jewelry.id, "Accepted ring", 500);
    const staged = await item(admin, jewelry.id, "Staged brooch", 500);
    const delivered = await item(admin, jewelry.id, "Delivered watch", 500);
    await env.DB.prepare("UPDATE items SET status = 'accepted' WHERE id = ?").bind(accepted).run();
    await env.DB.prepare("UPDATE items SET status = 'staged' WHERE id = ?").bind(staged).run();
    await env.DB.prepare("UPDATE items SET status = 'delivered' WHERE id = ?").bind(delivered).run();

    for (const [host, cookie] of [["family", family], ["friends", friend]] as const) {
      const list = (await asJson(await exports.default.fetch(`${origin(host)}/api/items?topic=jewelry`, { headers: authed(cookie) }))).items as { id: number }[];
      expect(list.map((i) => i.id)).toEqual([open]);
      for (const closed of [accepted, staged, delivered]) {
        expect((await exports.default.fetch(`${origin(host)}/api/items/${closed}`, { headers: authed(cookie) })).status).toBe(404);
      }
    }

    const adminList = (await asJson(await exports.default.fetch(`${origin("family")}/api/items?topic=jewelry`, { headers: authed(admin) }))).items as {
      id: number;
      status: string;
    }[];
    expect(adminList.map((i) => [i.id, i.status])).toEqual([
      [open, "open"],
      [accepted, "accepted"],
      [staged, "staged"],
      [delivered, "delivered"],
    ]);
  });
});
