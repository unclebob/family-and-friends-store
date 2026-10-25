import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { acceptWish } from "../src/accept";
import { csvField } from "../src/all-wishes";
import { setWish } from "../src/wish";
import type { Session } from "../src/visibility";
import { authed, FIRST_ADMIN, installMerit, login, origin, topicByName } from "./helpers";

const ada: Session = { email: "ada@example.com", name: "Ada Family", firstName: "Ada", group: "family", topics: "all", host: "family" };
const fran: Session = { email: "fran@example.com", name: "Fran Friend", firstName: "Fran", group: "friend", topics: "all", host: "friends" };
const bea: Session = { email: "bea@example.com", name: "=Bea, \"B\"", firstName: "Bea", group: "family", topics: "all", host: "family" };

let admin = "";
let pin = 0;
let lamp = 0;

beforeEach(async () => {
  await installMerit();
  admin = await login("family", FIRST_ADMIN.email);
  pin = await newItem("Brass pin", "Jewelry");
  lamp = await newItem("Lamp", "Furniture");
  await setWish(env.DB, ada, pin, true, Date.parse("2026-10-20T15:00:00Z"));
  await setWish(env.DB, fran, pin, true, Date.parse("2026-10-20T16:00:00Z"));
  await setWish(env.DB, fran, lamp, true, Date.parse("2026-07-01T17:30:00Z"));
  await setWish(env.DB, fran, lamp, false, Date.parse("2026-07-02T17:30:00Z"));
  await setWish(env.DB, bea, lamp, true, Date.parse("2026-10-19T12:00:00Z"), "someday");
  await env.DB.prepare("UPDATE items SET status = 'accepted', accepted_at = ? WHERE id = ?").bind("2026-10-21T01:02:03.000Z", pin).run();
  await env.DB.prepare("UPDATE wishes SET status = 'accepted' WHERE item_id = ? AND email = ?").bind(pin, ada.email).run();
});

async function newItem(title: string, topic: string): Promise<number> {
  const topicId = (await topicByName(admin, topic)).id;
  const created = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
    method: "POST",
    headers: authed(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ topicId, title, description: "", priceCents: null }),
  });
  return ((await created.json()) as { id: number }).id;
}

type Row = { name: string; email: string; itemId: number; itemTitle: string; topicName: string; status: string; kind: string; createdAt: string; acceptedAt: string | null };

async function list(query = "", cookie = admin): Promise<{ status: number; wishes: Row[] }> {
  const response = await exports.default.fetch(`${origin("family")}/api/admin/wishes${query}`, { headers: authed(cookie) });
  const body = (await response.json()) as { wishes: Row[] };
  return { status: response.status, wishes: body.wishes };
}

describe("all wishes", () => {
  it("lists every wish, newest first, with Central times and the accepted time", async () => {
    const { status, wishes } = await list();
    expect(status).toBe(200);
    expect(wishes.map((w) => [w.name, w.itemTitle, w.status, w.kind])).toEqual([
      ["Fran Friend", "Brass pin", "active", "now"],
      ["Ada Family", "Brass pin", "accepted", "now"],
      ['=Bea, "B"', "Lamp", "active", "someday"],
      ["Fran Friend", "Lamp", "withdrawn", "now"],
    ]);
    expect(wishes[1]).toMatchObject({
      email: "ada@example.com",
      itemId: pin,
      topicName: "Jewelry",
      createdAt: "2026-10-20T10:00:00",
      acceptedAt: "2026-10-20T20:02:03",
    });
    expect(wishes[0].acceptedAt).toBeNull();
    expect(wishes[3].createdAt).toBe("2026-07-01T12:30:00");
  });

  it("filters by status", async () => {
    for (const status of ["active", "accepted", "withdrawn"]) {
      const { wishes } = await list(`?status=${status}`);
      expect(wishes.length).toBeGreaterThan(0);
      expect(wishes.every((w) => w.status === status)).toBe(true);
    }
    expect((await list("?status=active")).wishes).toHaveLength(2);
  });

  it("sorts by wisher, item, or status", async () => {
    expect((await list("?sort=wisher")).wishes.map((w) => w.name)).toEqual(['=Bea, "B"', "Ada Family", "Fran Friend", "Fran Friend"]);
    expect((await list("?sort=item")).wishes.map((w) => w.itemTitle)).toEqual(["Brass pin", "Brass pin", "Lamp", "Lamp"]);
    expect((await list("?sort=status")).wishes.map((w) => w.status)).toEqual(["accepted", "active", "active", "withdrawn"]);
  });

  it("refuses an unknown status or sort", async () => {
    expect((await list("?status=lost")).status).toBe(400);
    expect((await list("?sort=price")).status).toBe(400);
  });

  it("is for admins only", async () => {
    const family = await login("family", "ada@example.com");
    expect((await exports.default.fetch(`${origin("family")}/api/admin/wishes`, { headers: authed(family) })).status).toBe(403);
    expect((await exports.default.fetch(`${origin("family")}/api/admin/wishes.csv`, { headers: authed(family) })).status).toBe(403);
    expect((await exports.default.fetch(`${origin("family")}/api/admin/wishes.csv`)).status).toBe(401);
  });

  it("downloads the same list as CSV, filtered and sorted, safe for spreadsheets", async () => {
    const response = await exports.default.fetch(`${origin("family")}/api/admin/wishes.csv?status=active&sort=wisher`, { headers: authed(admin) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="wishes.csv"');
    expect((await response.text()).split("\r\n")).toEqual([
      "wisher,email,item,topic,status,kind,created_ct,accepted_ct",
      `"'=Bea, ""B""",bea@example.com,Lamp,Furniture,active,someday,2026-10-19T07:00:00,`,
      "Fran Friend,fran@example.com,Brass pin,Jewelry,active,now,2026-10-20T11:00:00,",
      "",
    ]);
  });

  it("quotes CSV fields only when needed and defuses formulas", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(null)).toBe("");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    for (const lead of ["=", "+", "-", "@"]) expect(csvField(`${lead}1`)).toBe(`'${lead}1`);
  });

  it("shows a real accept with its accepted time", async () => {
    const other = await newItem("Mug", "Jewelry");
    await setWish(env.DB, ada, other, true, Date.parse("2026-10-20T15:00:00Z"));
    const row = await env.DB.prepare("SELECT id FROM wishes WHERE item_id = ?").bind(other).first<{ id: number }>();
    await acceptWish(env, FIRST_ADMIN.email, other, row!.id, Date.parse("2026-10-21T14:00:00Z"));
    const mug = (await list("?status=accepted")).wishes.find((w) => w.itemTitle === "Mug");
    expect(mug?.acceptedAt).toBe("2026-10-21T09:00:00");
  });

  it("moves an accepted wish through staged and delivered, and filters each separately", async () => {
    const mug = await newItem("Mug", "Jewelry");
    const vase = await newItem("Vase", "Furniture");
    await setWish(env.DB, ada, mug, true, Date.parse("2026-10-20T17:00:00Z"));
    await setWish(env.DB, fran, mug, true, Date.parse("2026-10-20T18:00:00Z"));
    await setWish(env.DB, bea, vase, true, Date.parse("2026-10-20T19:00:00Z"));
    await env.DB.prepare("UPDATE items SET status = 'staged', accepted_at = ? WHERE id = ?").bind("2026-10-21T02:00:00.000Z", mug).run();
    await env.DB.prepare("UPDATE wishes SET status = 'accepted' WHERE item_id = ? AND email = ?").bind(mug, ada.email).run();
    await env.DB.prepare("UPDATE items SET status = 'delivered', accepted_at = ? WHERE id = ?").bind("2026-10-21T03:00:00.000Z", vase).run();
    await env.DB.prepare("UPDATE wishes SET status = 'accepted' WHERE item_id = ? AND email = ?").bind(vase, bea.email).run();

    const accepted = await list("?status=accepted");
    expect(accepted.wishes.map((w) => [w.name, w.itemTitle, w.status])).toEqual([["Ada Family", "Brass pin", "accepted"]]);

    const staged = await list("?status=staged");
    expect(staged.wishes.map((w) => [w.name, w.itemTitle, w.status, w.acceptedAt])).toEqual([
      ["Ada Family", "Mug", "staged", "2026-10-20T21:00:00"],
    ]);

    const delivered = await list("?status=delivered");
    expect(delivered.wishes.map((w) => [w.name, w.itemTitle, w.status, w.acceptedAt])).toEqual([
      ['=Bea, "B"', "Vase", "delivered", "2026-10-20T22:00:00"],
    ]);

    const active = await list("?status=active");
    expect(active.wishes.map((w) => [w.name, w.itemTitle, w.status])).toEqual([
      ["Fran Friend", "Mug", "active"],
      ["Fran Friend", "Brass pin", "active"],
      ['=Bea, "B"', "Lamp", "active"],
    ]);
  });

  it("lets an admin move an accepted item between accepted, staged, and delivered", async () => {
    const setStatus = (id: number, status: unknown, method = "POST") =>
      exports.default.fetch(`${origin("family")}/api/admin/items/${id}/status`, {
        method,
        headers: authed(admin, { "content-type": "application/json" }),
        body: method === "POST" ? JSON.stringify({ status }) : undefined,
      });

    for (const next of ["staged", "delivered", "staged", "accepted"] as const) {
      const res = await setStatus(pin, next);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, status: next });
      expect((await list(`?status=${next}`)).wishes.map((w) => w.itemId)).toEqual([pin]);
      const items = (await (await exports.default.fetch(`${origin("family")}/api/admin/items`, { headers: authed(admin) })).json()) as {
        items: { id: number; status: string }[];
      };
      expect(items.items.find((i) => i.id === pin)?.status).toBe(next);
    }

    const openRes = await setStatus(lamp, "staged");
    expect(openRes.status).toBe(409);
    expect(await openRes.json()).toEqual({ error: "That item has not been accepted." });

    expect((await exports.default.fetch(`${origin("family")}/api/admin/items/${lamp}`, { method: "DELETE", headers: authed(admin) })).status).toBe(404);
    await expect(env.DB.prepare("UPDATE items SET status = 'removed' WHERE id = ?").bind(lamp).run()).rejects.toThrow(/CHECK constraint failed/);
    expect((await setStatus(99999, "staged")).status).toBe(404);
    expect((await setStatus(pin, "staged", "GET")).status).toBe(404);

    for (const bad of ["open", "removed", "lost", null]) {
      expect((await setStatus(pin, bad)).status).toBe(400);
    }
  });
});
