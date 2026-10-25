import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { DEV_MERIT } from "../src/dev-fixture";
import { sendNewItemsMail } from "../src/new-items";
import { authed, DOMAIN, FIRST_ADMIN, login, namedEnv, origin, recordFetch, SECOND_ADMIN, topicByName, withFetch, type CapturedMail } from "./helpers";

// 8:00 AM CDT on 2026-10-21, when the new-items cron fires in summer time.
const cronCdt = Date.parse("2026-10-21T13:00:00Z");
let admin = "";

async function useFamily(family: string[]): Promise<void> {
  await env.MERIT.getByName("merit").setFake({ ...DEV_MERIT, family });
}

beforeEach(async () => {
  await useFamily(["ada@example.com", "cy@example.com"]);
  admin = await login("family", FIRST_ADMIN.email);
});

async function addItem(title: string, createdIso: string, extra: { topic?: string; description?: string; priceCents?: number | null } = {}) {
  const topicId = (await topicByName(admin, extra.topic ?? "Jewelry")).id;
  const created = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
    method: "POST",
    headers: authed(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ topicId, title, description: extra.description ?? "", priceCents: extra.priceCents ?? 1995 }),
  });
  const id = ((await created.json()) as { id: number }).id;
  await env.DB.prepare("UPDATE items SET created_at = ? WHERE id = ?").bind(createdIso, id).run();
  return id;
}

async function addPhoto(itemId: number): Promise<number> {
  const form = new FormData();
  form.set("photo", new File([new Uint8Array([1, 2, 3])], "p", { type: "image/jpeg" }));
  const uploaded = await exports.default.fetch(`${origin("family")}/api/admin/items/${itemId}/photos`, {
    method: "POST",
    headers: authed(admin),
    body: form,
  });
  return ((await uploaded.json()) as { id: number }).id;
}

type Sent = { recipient: string; subject: string; text: string; html: string };

async function outbox(): Promise<Sent[]> {
  const rows = await env.DB.prepare("SELECT recipient, payload FROM outbox WHERE template = 'new-items' ORDER BY id").all<{
    recipient: string;
    payload: string;
  }>();
  return rows.results.map((row) => ({ recipient: row.recipient, ...(JSON.parse(row.payload) as Omit<Sent, "recipient">) }));
}

describe("new items mail to family", () => {
  it("mails each family member separately about items added before today, Central time", async () => {
    const pin = await addItem("Brass pin", "2026-10-20T05:00:00.000Z", { description: "A small pin." });
    const lamp = await addItem("Lamp", "2026-10-21T04:59:59.000Z", { topic: "Furniture" });
    await addItem("Too new", "2026-10-21T05:00:00.000Z"); // midnight CDT today: tomorrow's mail
    expect(await sendNewItemsMail(env, cronCdt)).toBe(2);
    const mail = await outbox();
    expect(mail.map((m) => m.recipient)).toEqual(["ada@example.com", "cy@example.com", FIRST_ADMIN.email, SECOND_ADMIN.email]);
    expect(mail[0].subject).toBe("New on the family site: 2 items");
    expect(mail[0].text).toBe(mail[1].text);
    expect(mail[0].text).toBe(
      [
        "New on the family site:",
        "",
        "Brass pin (Jewelry)",
        "A small pin.",
        `https://family.${DOMAIN}/#item-${pin}`,
        "",
        "Lamp (Furniture)",
        `https://family.${DOMAIN}/#item-${lamp}`,
        "",
        `If you'd rather not get these, reply to this email and let ${FIRST_ADMIN.shortName} know.`,
      ].join("\n"),
    );
  });

  it("uses the Central day in winter time too", async () => {
    await addItem("Quilt", "2026-12-15T05:59:59.000Z"); // 11:59 PM CST on the 14th
    await addItem("Too new", "2026-12-15T06:00:00.000Z");
    expect(await sendNewItemsMail(env, Date.parse("2026-12-15T14:00:00Z"))).toBe(1);
    expect((await outbox())[0].subject).toBe("New on the family site: 1 item");
  });

  it("never shows a price, in text or HTML", async () => {
    await addItem("Brass pin", "2026-10-20T12:00:00.000Z", { priceCents: 1995 });
    await sendNewItemsMail(env, cronCdt);
    const [first] = await outbox();
    for (const body of [first.text, first.html]) {
      expect(body).not.toContain("19.95");
      expect(body).not.toContain("1995");
      expect(body).not.toContain("$");
      expect(body.toLowerCase()).not.toContain("price");
    }
  });

  it("escapes item text in the HTML and shortens a long description", async () => {
    const long = `${"word ".repeat(60)}end`;
    await addItem("<b>Pin</b> & co", "2026-10-20T12:00:00.000Z", { description: long });
    await sendNewItemsMail(env, cronCdt);
    const [first] = await outbox();
    expect(first.html).toContain("&lt;b&gt;Pin&lt;/b&gt; &amp; co");
    expect(first.html).not.toContain("<b>Pin");
    const shortLine = first.text.split("\n")[3];
    expect(shortLine.length).toBeLessThanOrEqual(201);
    expect(shortLine.endsWith("word…")).toBe(true);
  });

  it("links the first photo with a signed URL that works without signing in", async () => {
    const pin = await addItem("Brass pin", "2026-10-20T12:00:00.000Z");
    const photoId = await addPhoto(pin);
    await addPhoto(pin);
    await sendNewItemsMail(env, cronCdt);
    const [first] = await outbox();
    const src = first.html.match(/<img src="([^"]+)"/)?.[1] ?? "";
    expect(src).toMatch(new RegExp(`^https://family\\.${DOMAIN.replaceAll(".", "\\.")}/photo/${photoId}/email\\?exp=\\d+&amp;sig=[0-9a-f]{64}$`));
    const url = src.replaceAll("&amp;", "&");
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("sends nothing and asks Merit nothing on a day with no new items", async () => {
    await env.MERIT.getByName("merit").clearFake(); // Merit offline would throw if asked
    expect(await sendNewItemsMail(env, cronCdt)).toBe(0);
    expect(await outbox()).toEqual([]);
  });

  it("announces each item once and leaves out items that are no longer open", async () => {
    const pin = await addItem("Brass pin", "2026-10-20T12:00:00.000Z");
    const gone = await addItem("Gone", "2026-10-20T13:00:00.000Z");
    await env.DB.prepare("UPDATE items SET status = 'accepted' WHERE id = ?").bind(gone).run();
    expect(await sendNewItemsMail(env, cronCdt)).toBe(1);
    expect((await outbox())[0].text).not.toContain("Gone");
    expect(await sendNewItemsMail(env, cronCdt + 24 * 3600_000)).toBe(0);
    expect(await outbox()).toHaveLength(4); // two family members and two admins, once
    expect(pin).toBeGreaterThan(0);
  });

  it("ignores items that were already announced, as the migration marks existing items", async () => {
    const pin = await addItem("Old", "2026-10-20T12:00:00.000Z");
    await env.DB.prepare("UPDATE items SET announced_at = created_at WHERE id = ?").bind(pin).run();
    expect(await sendNewItemsMail(env, cronCdt)).toBe(0);
  });

  it("when Merit is unavailable, sends nothing, fails the run, and tries again next time", async () => {
    await addItem("Brass pin", "2026-10-20T12:00:00.000Z");
    await env.MERIT.getByName("merit").clearFake();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendNewItemsMail(env, cronCdt)).rejects.toThrow("New-items mail for 2026-10-20 waits: Merit is unavailable.");
    logged.mockRestore();
    expect(await outbox()).toEqual([]);
    await useFamily(["ada@example.com"]);
    expect(await sendNewItemsMail(env, cronCdt + 24 * 3600_000)).toBe(1);
    expect((await outbox()).map((m) => m.recipient)).toEqual(["ada@example.com", FIRST_ADMIN.email, SECOND_ADMIN.email]);
  });

  it("with no one on the family list or REPORT_TO, sends nothing and keeps the items for later", async () => {
    await addItem("Brass pin", "2026-10-20T12:00:00.000Z");
    await useFamily([]);
    await expect(sendNewItemsMail({ ...env, REPORT_TO: "" } as unknown as Env, cronCdt)).rejects.toThrow("reached no one");
    await useFamily(["ada@example.com"]);
    expect(await sendNewItemsMail(env, cronCdt)).toBe(1);
  });

  it("also mails the admins from REPORT_TO, the same list as the wish report", async () => {
    await addItem("Brass pin", "2026-10-20T12:00:00.000Z");
    await useFamily([]);
    expect(await sendNewItemsMail(env, cronCdt)).toBe(1);
    expect((await outbox()).map((m) => m.recipient)).toEqual([FIRST_ADMIN.email, SECOND_ADMIN.email]);
  });

  it("sends one copy to someone on both lists, matching addresses without regard to case", async () => {
    await addItem("Brass pin", "2026-10-20T12:00:00.000Z");
    const upperSecond = SECOND_ADMIN.email.toUpperCase();
    await useFamily(["ada@example.com", upperSecond, "ADA@example.com"]);
    const both = { ...env, REPORT_TO: ` ${FIRST_ADMIN.email} , ${SECOND_ADMIN.email},Ada@Example.com` } as unknown as Env;
    expect(await sendNewItemsMail(both, cronCdt)).toBe(1);
    expect((await outbox()).map((m) => m.recipient)).toEqual(["ada@example.com", upperSecond, FIRST_ADMIN.email]);
  });

  it("in production, one refused address does not stop the others, and each refusal is logged", async () => {
    await addItem("Brass pin", "2026-10-20T12:00:00.000Z");
    const sent: CapturedMail[] = [];
    const record = recordFetch(sent);
    const refuseFirst: typeof fetch = async (input, init) => {
      const response = await record(input, init);
      return sent.length === 1 ? new Response("no", { status: 500 }) : response;
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const count = await withFetch(refuseFirst, () => sendNewItemsMail(namedEnv("production"), cronCdt));
    const lines = logged.mock.calls.map((call) => call.join(" "));
    logged.mockRestore();
    expect(count).toBe(1);
    const bodies = sent.map((call) => JSON.parse(call.body) as { to: string[]; html: string; text: string; reply_to: string });
    expect(bodies.map((b) => b.to)).toEqual([["ada@example.com"], ["cy@example.com"], [FIRST_ADMIN.email], [SECOND_ADMIN.email]]);
    expect(bodies[1].html).toContain("Brass pin");
    expect(bodies[1].reply_to).toBe(env.FAMILY_REPLY_TO);
    expect(lines).toEqual(["New-items mail for 2026-10-20 was not sent to ada@example.com: The message was not sent."]);
  });

  it("in production, sends sequentially and retries 429 responses before giving up", async () => {
    await addItem("Brass pin", "2026-10-20T12:00:00.000Z");
    const sent: CapturedMail[] = [];
    const record = recordFetch(sent);
    let inFlight = 0;
    let maxInFlight = 0;
    const attempts = new Map<string, number>();
    const rateLimited: typeof fetch = async (input, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const response = await record(input, init);
      const to = (JSON.parse(sent[sent.length - 1].body) as { to: string[] }).to[0];
      const count = (attempts.get(to) ?? 0) + 1;
      attempts.set(to, count);
      inFlight -= 1;
      if (to === "ada@example.com" && count <= 3) {
        return new Response("slow down", { status: 429, headers: { "retry-after-ms": "0" } });
      }
      if (to === "cy@example.com") {
        return new Response("slow down", { status: 429, headers: { "retry-after-ms": "0" } });
      }
      return response;
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const count = await withFetch(rateLimited, () => sendNewItemsMail(namedEnv("production"), cronCdt));
    const lines = logged.mock.calls.map((call) => call.join(" "));
    logged.mockRestore();
    expect(count).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(attempts.get("ada@example.com")).toBe(4);
    expect(attempts.get("cy@example.com")).toBe(4);
    expect(attempts.get(FIRST_ADMIN.email)).toBe(1);
    expect(attempts.get(SECOND_ADMIN.email)).toBe(1);
    expect(lines).toEqual(["New-items mail for 2026-10-20 was not sent to cy@example.com: The message was not sent."]);
  });

  it("in production, keeps the items for the next run when every address is refused", async () => {
    await addItem("Brass pin", "2026-10-20T12:00:00.000Z");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const refuse: typeof fetch = async () => new Response("no", { status: 500 });
    await expect(withFetch(refuse, () => sendNewItemsMail(namedEnv("production"), cronCdt))).rejects.toThrow(
      "New-items mail for 2026-10-20 reached no one (4 failed).",
    );
    logged.mockRestore();
    expect(await sendNewItemsMail(env, cronCdt)).toBe(1);
  });

  it("runs from the 8 AM cron, and the 7 AM cron sends only the wish report", async () => {
    await addItem("Brass pin", "2026-10-20T12:00:00.000Z");
    const run = async (cron: string, at: number) => {
      const waits: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
      await worker.scheduled({ scheduledTime: at, cron, noRetry() {} } as ScheduledController, env, ctx);
      await Promise.all(waits);
    };
    await run("0 12 * * *", Date.parse("2026-10-21T12:00:00Z"));
    expect(await outbox()).toEqual([]);
    await run("0 13 * * *", cronCdt);
    expect(await outbox()).toHaveLength(4);
  });

  it("lets an admin send pending new-items mail on demand", async () => {
    await addItem("Brass pin", "2026-10-20T12:00:00.000Z");
    const response = await exports.default.fetch(`${origin("family")}/api/admin/new-items/send`, {
      method: "POST",
      headers: authed(admin),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: 1 });
    expect(await outbox()).toHaveLength(4);
  });
});
