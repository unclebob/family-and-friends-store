import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushMeritLog } from "../src/accept";
import { handle } from "../src/handle";
import {
  asJson,
  authed,
  FIRST_ADMIN,
  installMerit,
  login,
  namedEnv,
  origin,
  recordFetch,
  SECOND_ADMIN,
  topicByName,
  withFetch,
  type CapturedMail,
} from "./helpers";

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
  const wish = async (host: "family" | "friends", cookie: string, wished: boolean) => {
    const response = await exports.default.fetch(`${origin(host)}/api/items/${itemId}/wish`, {
      method: "POST",
      headers: authed(cookie, { "content-type": "application/json" }),
      body: JSON.stringify({ wished }),
    });
    return response;
  };
  await wish("family", ada, true);
  await wish("friends", bea, true);
  const sue = await login("family", SECOND_ADMIN.email);
  await wish("family", sue, true);
  await wish("family", sue, false);
  const rows = await env.DB.prepare("SELECT id, email, status FROM wishes WHERE item_id = ?").bind(itemId).all<{
    id: number;
    email: string;
    status: string;
  }>();
  const idOf = (email: string) => rows.results.find((row) => row.email === email)?.id ?? 0;
  return { admin, ada, bea, itemId, wish, idOf };
}

async function outbox() {
  return env.DB.prepare("SELECT recipient, template, payload FROM outbox WHERE template != 'login-code' ORDER BY id").all<{
    recipient: string;
    template: string;
    payload: string;
  }>();
}

describe("accept", () => {
  it("mails the winner and only the other active wishers, with no winner or price in the apology", async () => {
    const { admin, itemId, idOf } = await scene();
    const response = await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/accept`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ wishId: idOf("bea@example.com") }),
    });
    expect(await asJson(response)).toMatchObject({ ok: true, apologies: 1, mail: "outbox" });
    const mail = await outbox();
    const apologies = mail.results.filter((row) => row.template === "apology");
    const winners = mail.results.filter((row) => row.template === "its-yours");
    expect(apologies.map((row) => row.recipient)).toEqual(["ada@example.com"]);
    expect(winners.map((row) => row.recipient)).toEqual(["bea@example.com"]);
    const apology = apologies[0]?.payload ?? "";
    expect(apology).toContain("Brass pin");
    expect(apology).not.toContain("Bea");
    expect(apology.toLowerCase()).not.toContain("price");
    expect(apology).not.toContain("19.95");
    expect(apology).not.toContain("1995");
    expect(winners[0]?.payload).toContain("$19.95");
    const gone = await exports.default.fetch(`${origin("friends")}/api/items/${itemId}`, {
      headers: authed(await login("friends", "bea@example.com")),
    });
    expect(gone.status).toBe(404);
  });

  it("fails an uncheck after accept and keeps the row accepted", async () => {
    const { admin, bea, itemId, wish, idOf } = await scene();
    await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/accept`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ wishId: idOf("bea@example.com") }),
    });
    const unwish = await wish("friends", bea, false);
    expect(unwish.status).toBe(404);
    const row = await env.DB.prepare("SELECT status FROM wishes WHERE email = 'bea@example.com'").first<{ status: string }>();
    expect(row?.status).toBe("accepted");
  });

  it("leaves accept and uncheck in a consistent state", async () => {
    const { admin, bea, itemId, wish, idOf } = await scene();
    await Promise.all([
      exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/accept`, {
        method: "POST",
        headers: authed(admin, { "content-type": "application/json" }),
        body: JSON.stringify({ wishId: idOf("bea@example.com") }),
      }),
      wish("friends", bea, false),
    ]);
    const item = await env.DB.prepare("SELECT status, assigned_to FROM items WHERE id = ?").bind(itemId).first<{
      status: string;
      assigned_to: string | null;
    }>();
    const row = await env.DB.prepare("SELECT status FROM wishes WHERE email = 'bea@example.com'").first<{ status: string }>();
    if (item?.status === "accepted") {
      expect(row?.status).toBe("accepted");
      expect(item.assigned_to).toBe("bea@example.com");
    } else {
      expect(item?.status).toBe("open");
      expect(row?.status).toBe("withdrawn");
      expect(item?.assigned_to).toBeNull();
    }
  });

  it("shows the wish kind to admins and lets them accept a someday wish", async () => {
    const { admin, ada, itemId, idOf } = await scene();
    await exports.default.fetch(`${origin("family")}/api/items/${itemId}/wish`, {
      method: "POST",
      headers: authed(ada, { "content-type": "application/json" }),
      body: JSON.stringify({ wished: true, kind: "someday" }),
    });
    const listed = (await (await exports.default.fetch(`${origin("family")}/api/admin/items`, { headers: authed(admin) })).json()) as {
      items: { id: number; wishes: { email: string; kind: string }[] }[];
    };
    const wishes = listed.items.find((row) => row.id === itemId)?.wishes ?? [];
    expect(wishes.map((w) => [w.email, w.kind])).toEqual([
      ["ada@example.com", "someday"],
      ["bea@example.com", "now"],
    ]);
    const response = await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/accept`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ wishId: idOf("ada@example.com") }),
    });
    expect(response.status).toBe(200);
    const fake = await env.MERIT.getByName("merit").getFake();
    expect(fake?.deliveries[0]).toMatchObject({ winner_email: "ada@example.com", winner_wish: "someday" });
  });

  it("delivers the accept log once, after Merit comes back", async () => {
    const { admin, itemId, idOf } = await scene();
    await env.MERIT.getByName("merit").clearFake();
    const response = await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/accept`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ wishId: idOf("bea@example.com") }),
    });
    expect(response.status).toBe(200);
    const waiting = await env.DB.prepare("SELECT acked FROM pending_merit_log").first<{ acked: number }>();
    expect(waiting?.acked).toBe(0);
    await installMerit();
    expect(await flushMeritLog(env)).toBe(1);
    expect(await flushMeritLog(env)).toBe(0);
    const fake = await env.MERIT.getByName("merit").getFake();
    expect(fake?.deliveries).toHaveLength(1);
    expect(fake?.deliveries[0]).toMatchObject({
      title: "Brass pin",
      winner_email: "bea@example.com",
      winner_name: "Bea Friend",
      winner_wish: "now",
      accepted_by: FIRST_ADMIN.email,
    });
    const acked = await env.DB.prepare("SELECT acked FROM pending_merit_log").first<{ acked: number }>();
    expect(acked?.acked).toBe(1);
  });

  it("sends the winner and the apology through Resend in production", async () => {
    const { admin, itemId, idOf } = await scene();
    const before = await outbox();
    const sent: CapturedMail[] = [];
    const response = await withFetch(recordFetch(sent), () =>
      handle(
        new Request(`${origin("family")}/api/admin/items/${itemId}/accept`, {
          method: "POST",
          headers: authed(admin, { "content-type": "application/json" }),
          body: JSON.stringify({ wishId: idOf("bea@example.com") }),
        }),
        namedEnv("production"),
      ),
    );
    expect(await asJson(response)).toMatchObject({ ok: true, apologies: 1, mail: "email" });
    expect(sent.map((call) => call.url)).toEqual(["https://api.resend.com/emails", "https://api.resend.com/emails"]);
    const bodies = sent.map((call) => JSON.parse(call.body) as { to: string[]; subject: string; text: string });
    expect(bodies.map((body) => body.to)).toEqual([["bea@example.com"], ["ada@example.com"]]);
    expect(bodies[0]?.subject).toBe("It's yours: Brass pin");
    expect(bodies[0]?.text).toContain("$19.95");
    expect(bodies[1]?.subject).toBe("About Brass pin");
    expect(bodies[1]?.text).not.toContain("Bea");
    expect(bodies[1]?.text.toLowerCase()).not.toContain("price");
    expect(bodies[1]?.text).not.toContain("19.95");
    const mail = await outbox();
    expect(mail.results).toEqual(before.results);
  });

  it("accepts only one of two wishes accepted at the same moment and answers the other 409", async () => {
    const { admin, itemId, idOf } = await scene();
    const accept = (email: string) =>
      exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/accept`, {
        method: "POST",
        headers: authed(admin, { "content-type": "application/json" }),
        body: JSON.stringify({ wishId: idOf(email) }),
      });
    const replies = await Promise.all([accept("ada@example.com"), accept("bea@example.com")]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const accepted = await env.DB.prepare("SELECT COUNT(*) AS n FROM wishes WHERE status = 'accepted'").first<{ n: number }>();
    expect(accepted?.n).toBe(1);
  });

  it("links the item's photo in the apology", async () => {
    const { admin, itemId, idOf } = await scene();
    const form = new FormData();
    form.set("photo", new File([new Uint8Array([1, 2, 3])], "pin.jpg", { type: "image/jpeg" }));
    const uploaded = await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/photos`, {
      method: "POST",
      headers: authed(admin),
      body: form,
    });
    const photoId = ((await uploaded.json()) as { id: number }).id;
    await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/accept`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ wishId: idOf("bea@example.com") }),
    });
    const apology = (await outbox()).results.find((row) => row.template === "apology");
    expect(apology?.payload).toContain(`/photo/${photoId}`);
  });

  for (const unreadable of ["null", "5", "{not json"]) {
    it(`skips and logs an unreadable Merit log entry (${unreadable}) so later entries still go out`, async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const insert = env.DB.prepare("INSERT INTO pending_merit_log (payload, created_at) VALUES (?, '2026-10-21T14:00:00Z')");
      const bad = await insert.bind(unreadable).run();
      await insert.bind(JSON.stringify({ log_id: 2, title: "Later" })).run();
      expect(await flushMeritLog(env)).toBe(1);
      const lines = errors.mock.calls.map((call) => call.join(" "));
      errors.mockRestore();
      const left = await env.DB.prepare("SELECT payload, acked FROM pending_merit_log ORDER BY id").all<{ payload: string; acked: number }>();
      expect(left.results).toEqual([{ payload: JSON.stringify({ log_id: 2, title: "Later" }), acked: 1 }]);
      expect((await env.MERIT.getByName("merit").getFake())?.deliveries).toEqual([{ log_id: 2, title: "Later" }]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`pending_merit_log id ${bad.meta.last_row_id}`);
      expect(lines[0]).toContain("2026-10-21T14:00:00Z");
      expect(lines[0]).toContain(unreadable);
    });
  }
  it("refuses a withdrawn wish with 409 and sends no mail", async () => {
    const { admin, itemId, idOf } = await scene();
    const response = await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/accept`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ wishId: idOf(SECOND_ADMIN.email) }),
    });
    expect(response.status).toBe(409);
    expect((await outbox()).results).toEqual([]);
    const item = await env.DB.prepare("SELECT status FROM items WHERE id = ?").bind(itemId).first<{ status: string }>();
    expect(item?.status).toBe("open");
  });

  it("refuses a second accept on an item that is already accepted", async () => {
    const { admin, itemId, idOf } = await scene();
    const accept = (email: string) =>
      exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/accept`, {
        method: "POST",
        headers: authed(admin, { "content-type": "application/json" }),
        body: JSON.stringify({ wishId: idOf(email) }),
      });
    expect((await accept("bea@example.com")).status).toBe(200);
    expect((await accept("ada@example.com")).status).toBe(409);
  });

  it("returns 404 for a wish that is not on the item", async () => {
    const { admin, itemId } = await scene();
    const response = await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/accept`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ wishId: 9999 }),
    });
    expect(response.status).toBe(404);
    const item = await env.DB.prepare("SELECT status FROM items WHERE id = ?").bind(itemId).first<{ status: string }>();
    expect(item?.status).toBe("open");
  });
});
