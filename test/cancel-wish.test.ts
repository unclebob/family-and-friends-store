import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/handle";
import { cancelledText } from "../src/mail";
import { sendWishReport } from "../src/wish-report";
import { asJson, authed, FIRST_ADMIN, installMerit, login, namedEnv, origin, recordFetch, SECOND_ADMIN, topicByName, withFetch, type CapturedMail } from "./helpers";

beforeEach(async () => {
  await installMerit();
});

async function scene() {
  const admin = await login("family", FIRST_ADMIN.email);
  const ada = await login("family", "ada@example.com");
  const bea = await login("friends", "bea@example.com");
  const topicId = (await topicByName(admin, "Jewelry")).id;
  const created = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
    method: "POST",
    headers: authed(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ topicId, title: "Brass pin", description: "A small brass pin.", priceCents: 1995 }),
  });
  const itemId = ((await created.json()) as { id: number }).id;
  const wish = (host: "family" | "friends", cookie: string, wished: boolean) =>
    exports.default.fetch(`${origin(host)}/api/items/${itemId}/wish`, {
      method: "POST",
      headers: authed(cookie, { "content-type": "application/json" }),
      body: JSON.stringify({ wished }),
    });
  await wish("family", ada, true);
  await wish("friends", bea, true);
  const sue = await login("family", SECOND_ADMIN.email);
  await wish("family", sue, true);
  await wish("family", sue, false);
  const idOf = async (email: string) =>
    (await env.DB.prepare("SELECT id FROM wishes WHERE item_id = ? AND email = ?").bind(itemId, email).first<{ id: number }>())?.id ?? 0;
  return { admin, ada, bea, itemId, wish, idOf };
}

const cancel = (cookie: string, wishId: number) =>
  exports.default.fetch(`${origin("family")}/api/admin/wishes/${wishId}/cancel`, { method: "POST", headers: authed(cookie) });

const row = (id: number) => env.DB.prepare("SELECT status, cancelled_by FROM wishes WHERE id = ?").bind(id).first();

const cancelMail = async () =>
  (await env.DB.prepare("SELECT recipient, payload FROM outbox WHERE template = 'wish-cancelled' ORDER BY id").all<{ recipient: string; payload: string }>()).results;

describe("an admin cancels a wish", () => {
  it("withdraws it, marks who cancelled it, and sends the wisher one kind note with no price", async () => {
    const { admin, ada, bea, itemId, idOf } = await scene();
    const adaWish = await idOf("ada@example.com");
    const response = await cancel(admin, adaWish);
    expect(response.status).toBe(200);
    expect(await asJson(response)).toEqual({ ok: true, mail: "outbox" });
    expect(await row(adaWish)).toEqual({ status: "withdrawn", cancelled_by: FIRST_ADMIN.email });
    const mail = await cancelMail();
    expect(mail.map((m) => m.recipient)).toEqual(["ada@example.com"]);
    const letter = JSON.parse(mail[0].payload) as { subject: string; text: string };
    expect(letter.subject).toBe("About your wish: Brass pin");
    expect(letter.text).toBe(cancelledText("Brass pin"));
    expect(letter.text).not.toMatch(/\$|19\.95|price/i);
    const adaView = await asJson(await exports.default.fetch(`${origin("family")}/api/items/${itemId}`, { headers: authed(ada) }));
    expect(adaView.item).toMatchObject({ wished: false });
    const beaView = await asJson(await exports.default.fetch(`${origin("friends")}/api/items/${itemId}`, { headers: authed(bea) }));
    expect(beaView.item).toMatchObject({ othersWishing: 0 });
  });

  it("is idempotent: a second cancel answers ok and sends nothing more", async () => {
    const { admin, idOf } = await scene();
    const adaWish = await idOf("ada@example.com");
    await cancel(admin, adaWish);
    const again = await cancel(admin, adaWish);
    expect(again.status).toBe(200);
    expect(await asJson(again)).toEqual({ ok: true, already: true });
    expect(await cancelMail()).toHaveLength(1);
  });

  it("refuses a wish the wisher withdrew, an accepted one, or one on an item no longer open, and sends nothing", async () => {
    const { admin, itemId, idOf } = await scene();
    expect((await cancel(admin, await idOf(SECOND_ADMIN.email))).status).toBe(409);
    await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/accept`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ wishId: await idOf("bea@example.com") }),
    });
    expect((await cancel(admin, await idOf("bea@example.com"))).status).toBe(409);
    const ada = await cancel(admin, await idOf("ada@example.com"));
    expect(ada.status).toBe(409);
    expect(await asJson(ada)).toEqual({ error: "That wish can no longer be cancelled." });
    expect(await row(await idOf("ada@example.com"))).toEqual({ status: "declined", cancelled_by: null });
    expect(await cancelMail()).toEqual([]);
  });

  it("is for admins only, and an unknown wish is not found", async () => {
    const { admin, ada, idOf } = await scene();
    expect((await cancel(ada, await idOf("ada@example.com"))).status).toBe(403);
    expect((await cancel(admin, 99999)).status).toBe(404);
    const get = await exports.default.fetch(`${origin("family")}/api/admin/wishes/1/cancel`, { headers: authed(admin) });
    expect(get.status).toBe(404);
    expect(await cancelMail()).toEqual([]);
  });

  it("lets the wisher wish again, which clears the cancel mark", async () => {
    const { admin, ada, wish, idOf } = await scene();
    const adaWish = await idOf("ada@example.com");
    await cancel(admin, adaWish);
    await wish("family", ada, true);
    expect(await row(adaWish)).toEqual({ status: "active", cancelled_by: null });
  });

  it("emails through Resend in production, and a failed send still cancels", async () => {
    const { admin, idOf } = await scene();
    const sent: CapturedMail[] = [];
    const post = (id: number) =>
      handle(new Request(`${origin("family")}/api/admin/wishes/${id}/cancel`, { method: "POST", headers: authed(admin) }), namedEnv("production"));
    const adaWish = await idOf("ada@example.com");
    const response = await withFetch(recordFetch(sent), () => post(adaWish));
    expect(sent.map((call) => call.url)).toEqual(["https://api.resend.com/emails"]);
    expect(await asJson(response)).toEqual({ ok: true, mail: "email" });
    const body = JSON.parse(sent.at(-1)?.body ?? "{}") as { to: string[]; subject: string; reply_to: string };
    expect(body.to).toEqual(["ada@example.com"]);
    expect(body.subject).toBe("About your wish: Brass pin");
    expect(body.reply_to).toBe(env.FAMILY_REPLY_TO);
    const failing = (async () => new Response("no", { status: 500 })) as typeof fetch;
    const bea = await idOf("bea@example.com");
    const failed = await withFetch(failing, () => post(bea));
    expect(await asJson(failed)).toEqual({ ok: true, mail: "email" });
    expect(await row(bea)).toMatchObject({ status: "withdrawn" });
  });

  it("shows as cancelled by admins in the admin wish list, its CSV, and the wish report", async () => {
    const { admin, idOf } = await scene();
    await cancel(admin, await idOf("ada@example.com"));
    const listed = (await asJson(await exports.default.fetch(`${origin("family")}/api/admin/wishes?status=withdrawn`, { headers: authed(admin) }))) as {
      wishes: { name: string; status: string; cancelledBy: string | null }[];
    };
    const all = (await asJson(await exports.default.fetch(`${origin("family")}/api/admin/wishes`, { headers: authed(admin) }))) as { wishes: { itemStatus: string }[] };
    expect(all.wishes.map((w) => w.itemStatus)).toEqual(["open", "open", "open"]);
    expect(listed.wishes.map((w) => [w.name, w.status, w.cancelledBy]).sort()).toEqual([
      ["Ada Family", "withdrawn", FIRST_ADMIN.email],
      [SECOND_ADMIN.name, "withdrawn", null],
    ].sort());
    const csv = await (await exports.default.fetch(`${origin("family")}/api/admin/wishes.csv`, { headers: authed(admin) })).text();
    expect(csv).toMatch(/^Ada Family,ada@example\.com,Brass pin,Jewelry,cancelled by admins,now,/m);
    expect(csv).toMatch(new RegExp(`^${SECOND_ADMIN.name},[^,]+,Brass pin,Jewelry,withdrawn,now,`, "m"));
    await sendWishReport(env, Date.now() + 24 * 60 * 60 * 1000);
    const report = await env.DB.prepare("SELECT payload FROM outbox WHERE template = 'wish-report' LIMIT 1").first<{ payload: string }>();
    const text = (JSON.parse(report?.payload ?? "{}") as { text: string }).text;
    expect(text).toContain("wants Brass pin (Jewelry), cancelled by admins, now");
    expect(text).toContain("wants Brass pin (Jewelry), withdrawn, now");
  });

  it("gives admins browsing the active wish ids, own included, and family and friends nothing new", async () => {
    const { admin, ada, bea, itemId, idOf } = await scene();
    await exports.default.fetch(`${origin("family")}/api/items/${itemId}/wish`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ wished: true }),
    });
    const view = async (host: "family" | "friends", cookie: string) =>
      (await asJson(await exports.default.fetch(`${origin(host)}/api/items?topic=jewelry`, { headers: authed(cookie) }))).items as Record<string, unknown>[];
    const [adminItem] = await view("family", admin);
    expect(adminItem.activeWishes).toEqual([
      { id: await idOf("ada@example.com"), name: "Ada Family", kind: "now" },
      { id: await idOf("bea@example.com"), name: "Bea Friend", kind: "now" },
      { id: await idOf(FIRST_ADMIN.email), name: FIRST_ADMIN.name, kind: "now" },
    ]);
    for (const [host, cookie] of [["family", ada], ["friends", bea]] as const) {
      for (const one of await view(host, cookie)) expect(one).not.toHaveProperty("activeWishes");
    }
  });
});
