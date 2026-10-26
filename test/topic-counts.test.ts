import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { asJson, authed, FIRST_ADMIN, installMerit, login, origin, topicByName } from "./helpers";

beforeEach(async () => {
  await installMerit();
});

async function item(admin: string, topicId: number, title: string): Promise<number> {
  const response = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
    method: "POST",
    headers: authed(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ topicId, title, description: "Test item.", priceCents: 500 }),
  });
  return ((await response.json()) as { id: number }).id;
}

type Counted = { slug: string; name: string; available: number };

async function topics(host: "family" | "friends", cookie: string): Promise<Counted[]> {
  const body = await asJson(await exports.default.fetch(`${origin(host)}/api/topics`, { headers: authed(cookie) }));
  return body.topics as Counted[];
}

async function listed(host: "family" | "friends", cookie: string, slug: string): Promise<number> {
  const body = await asJson(await exports.default.fetch(`${origin(host)}/api/items?topic=${slug}`, { headers: authed(cookie) }));
  return (body.items as unknown[]).length;
}

describe("topic counts", () => {
  it("counts each topic's open items the viewer can see, the same items the list shows", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const family = await login("family", "ada@example.com");
    const friend = await login("friends", "bea@example.com");
    const jewelry = await topicByName(admin, "Jewelry");
    const aviation = await topicByName(admin, "Aviation");
    await item(admin, jewelry.id, "Pin");
    const accepted = await item(admin, jewelry.id, "Ring");
    const staged = await item(admin, jewelry.id, "Chain");
    const delivered = await item(admin, jewelry.id, "Watch");
    await item(admin, aviation.id, "Logbook");
    await env.DB.prepare("UPDATE items SET status = 'accepted' WHERE id = ?").bind(accepted).run();
    await env.DB.prepare("UPDATE items SET status = 'staged' WHERE id = ?").bind(staged).run();
    await env.DB.prepare("UPDATE items SET status = 'delivered' WHERE id = ?").bind(delivered).run();

    const forFamily = await topics("family", family);
    const count = (list: Counted[], slug: string) => list.find((topic) => topic.slug === slug)?.available;
    expect(count(forFamily, jewelry.slug)).toBe(1);
    expect(count(forFamily, aviation.slug)).toBe(1);
    expect(forFamily.filter((topic) => topic.slug !== jewelry.slug && topic.slug !== aviation.slug).every((topic) => topic.available === 0)).toBe(true);
    for (const topic of forFamily) expect(topic.available).toBe(await listed("family", family, topic.slug));

    const forFriend = await topics("friends", friend);
    expect(forFriend).toEqual([{ id: jewelry.id, slug: jewelry.slug, name: "Jewelry", available: 1 }]);
    expect(await listed("friends", friend, jewelry.slug)).toBe(1);
  });
});
