import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { asJson, authed, FIRST_ADMIN, installMerit, login, origin, SECOND_ADMIN, topicByName } from "./helpers";

beforeEach(async () => {
  await installMerit();
});

const topics = [
  { slug: "aviation", name: "Aviation", sort_order: 1 },
  { slug: "electronics", name: "Electronics", sort_order: 2 },
  { slug: "jewelry", name: "Jewelry", sort_order: 3 },
  { slug: "furniture", name: "Furniture", sort_order: 4 },
  { slug: "knick-knacks", name: "Knick-Knacks", sort_order: 5 },
  { slug: "miscellaneous", name: "Miscellaneous", sort_order: 6 },
  { slug: "antiques", name: "Antiques", sort_order: 7 },
  { slug: "valuables", name: "Valuables", sort_order: 8 },
];

async function rerunTopicSeed(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((file) => file.name.includes("0002"));
  if (!migration) throw new Error("missing topic migration");
  await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));
}

describe("catalog seed", () => {
  it("loads the eight topics from the migration, then adds the two samples once", async () => {
    const merit = await asJson(await exports.default.fetch(`${origin("family")}/dev/merit`, { method: "POST" }));
    expect(merit).toEqual({
      ok: true,
      people: [
        `${FIRST_ADMIN.email} and ${SECOND_ADMIN.email} are admins`,
        "ada@example.com is family",
        "bea@example.com is a friend with the jewelry topic",
        "cara@example.com is a contact who becomes a friend on the Friends side",
      ],
    });
    const family = await login("family", "ada@example.com");
    const admin = await login("family", FIRST_ADMIN.email);
    const before = await asJson(
      await exports.default.fetch(`${origin("family")}/api/topics`, { headers: authed(family) }),
    );
    expect(before.topics).toEqual(topics.map(({ slug, name, sort_order }) => ({ id: sort_order, slug, name, available: 0 })));
    const stored = await asJson(
      await exports.default.fetch(`${origin("family")}/api/admin/topics`, { headers: authed(admin) }),
    );
    expect(stored.topics).toMatchObject(topics);

    const missed = await exports.default.fetch(`${origin("family")}/dev/seed`);
    expect(missed.status).toBe(404);

    const first = await asJson(await exports.default.fetch(`${origin("family")}/dev/seed`, { method: "POST" }));
    expect(first).toMatchObject({ ok: true, seeded: true });
    const aviation = await asJson(
      await exports.default.fetch(`${origin("family")}/api/items?topic=aviation`, { headers: authed(family) }),
    );
    const jewelry = await asJson(
      await exports.default.fetch(`${origin("family")}/api/items?topic=jewelry`, { headers: authed(family) }),
    );
    expect(JSON.stringify(aviation)).toContain("Pilot logbook");
    expect(JSON.stringify(jewelry)).toContain("Grandmother's brooch");
    expect(JSON.stringify(aviation)).not.toContain("price");

    const second = await asJson(await exports.default.fetch(`${origin("family")}/dev/seed`, { method: "POST" }));
    expect(second).toMatchObject({ ok: true, seeded: false });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    expect(count?.n).toBe(2);
    const again = await asJson(
      await exports.default.fetch(`${origin("family")}/api/topics`, { headers: authed(family) }),
    );
    expect(again.topics).toEqual(
      topics.map(({ slug, name, sort_order }) => ({ id: sort_order, slug, name, available: slug === "aviation" || slug === "jewelry" ? 1 : 0 })),
    );
  });

  it("does not add the samples when one item already exists", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const jewelry = await topicByName(admin, "Jewelry");
    const created = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ topicId: jewelry.id, title: "One pin", description: "Just one.", priceCents: 100 }),
    });
    expect(created.status).toBe(201);
    const seeded = await asJson(await exports.default.fetch(`${origin("family")}/dev/seed`, { method: "POST" }));
    expect(seeded).toMatchObject({ ok: true, seeded: false });
    const family = await login("family", "ada@example.com");
    const aviation = JSON.stringify(
      await (await exports.default.fetch(`${origin("family")}/api/items?topic=aviation`, { headers: authed(family) })).json(),
    );
    const jewelryItems = JSON.stringify(
      await (await exports.default.fetch(`${origin("family")}/api/items?topic=jewelry`, { headers: authed(family) })).json(),
    );
    expect(aviation).not.toContain("Pilot logbook");
    expect(jewelryItems).not.toContain("Grandmother's brooch");
    expect(jewelryItems).toContain("One pin");
  });

  it("keeps the eight topics when the seed migration runs again", async () => {
    await env.DB.prepare("UPDATE topics SET name = 'Nope', sort_order = 99 WHERE slug = 'valuables'").run();
    await rerunTopicSeed();
    const rows = await env.DB.prepare("SELECT slug, name, sort_order FROM topics ORDER BY sort_order").all();
    expect(rows.results).toEqual(topics);
  });

  it("renames an existing memorabilia topic to miscellaneous in migration 0010", async () => {
    await env.DB.prepare("UPDATE topics SET slug = 'memorabilia', name = 'Memorabilia' WHERE sort_order = 6").run();
    const migration = env.TEST_MIGRATIONS.find((file) => file.name.includes("0010"));
    expect(migration).toBeDefined();
    await env.DB.batch(migration!.queries.map((query) => env.DB.prepare(query)));
    const row = await env.DB.prepare("SELECT slug, name, sort_order FROM topics WHERE sort_order = 6").first();
    expect(row).toEqual({ slug: "miscellaneous", name: "Miscellaneous", sort_order: 6 });
  });
});
