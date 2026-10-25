import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { previousCtDay, reportRecipients, sendWishReport } from "../src/wish-report";
import { setWish } from "../src/wish";
import type { Session } from "../src/visibility";
import { authed, DOMAIN, FIRST_ADMIN, installMerit, login, namedEnv, origin, recordFetch, SECOND_ADMIN, topicByName, withFetch, type CapturedMail } from "./helpers";
import { vi } from "vitest";
import { exports } from "cloudflare:workers";

const ada: Session = { email: "ada@example.com", name: "Ada Family", firstName: "Ada", group: "family", topics: "all", host: "family" };
const fran: Session = { email: "fran@example.com", name: "Fran Friend", firstName: "Fran", group: "friend", topics: "all", host: "friends" };

// 2026-10-21 07:00 CDT, when the cron fires in summer time.
const cronCdt = Date.parse("2026-10-21T12:00:00Z");

beforeEach(async () => {
  await installMerit();
});

async function newItem(title: string, topic = "Jewelry"): Promise<number> {
  const admin = await login("family", FIRST_ADMIN.email);
  const topicId = (await topicByName(admin, topic)).id;
  const created = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
    method: "POST",
    headers: authed(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ topicId, title, description: "", priceCents: null }),
  });
  return ((await created.json()) as { id: number }).id;
}

async function reports() {
  const rows = await env.DB.prepare("SELECT recipient, payload FROM outbox WHERE template = 'wish-report' ORDER BY id").all<{
    recipient: string;
    payload: string;
  }>();
  return rows.results.map((row) => ({ recipient: row.recipient, ...(JSON.parse(row.payload) as { subject: string; text: string }) }));
}

describe("previous Central day", () => {
  it("spans the Central calendar day before, in summer and winter time", () => {
    expect(previousCtDay(cronCdt)).toEqual({ label: "2026-10-20", fromIso: "2026-10-20T05:00:00.000Z", toIso: "2026-10-21T05:00:00.000Z" });
    expect(previousCtDay(Date.parse("2026-12-15T12:00:00Z"))).toEqual({
      label: "2026-12-14", fromIso: "2026-12-14T06:00:00.000Z", toIso: "2026-12-15T06:00:00.000Z",
    });
  });

  it("covers the 25-hour day when summer time ends and the 23-hour day when it starts", () => {
    expect(previousCtDay(Date.parse("2026-11-02T12:00:00Z"))).toEqual({
      label: "2026-11-01", fromIso: "2026-11-01T05:00:00.000Z", toIso: "2026-11-02T06:00:00.000Z",
    });
    expect(previousCtDay(Date.parse("2027-03-15T12:00:00Z"))).toEqual({
      label: "2027-03-14", fromIso: "2027-03-14T06:00:00.000Z", toIso: "2027-03-15T05:00:00.000Z",
    });
  });

  it("uses the Central date, not the UTC date, just after UTC midnight", () => {
    expect(previousCtDay(Date.parse("2026-10-21T02:00:00Z")).label).toBe("2026-10-19");
  });
});

describe("report recipients", () => {
  it("come from the REPORT_TO setting, trimmed, blanks dropped", () => {
    expect(reportRecipients(" a@x.com, b@y.com ,,")).toEqual(["a@x.com", "b@y.com"]);
    expect(reportRecipients(undefined)).toEqual([]);
  });

  it("are both admins in the deployed config", () => {
    expect(reportRecipients(env.REPORT_TO)).toEqual([FIRST_ADMIN.email, SECOND_ADMIN.email]);
  });
});

describe("daily wish report", () => {
  it("mails each admin the wishes made in the previous Central day, with who, item, link, topic and status", async () => {
    const pin = await newItem("Brass pin");
    const lamp = await newItem("Lamp", "Furniture");
    await setWish(env.DB, ada, pin, true, Date.parse("2026-10-20T04:59:59Z")); // 23:59:59 CDT on the 19th
    await setWish(env.DB, fran, pin, true, Date.parse("2026-10-20T05:00:00Z")); // midnight CDT, the 20th
    await setWish(env.DB, ada, lamp, true, Date.parse("2026-10-20T20:00:00Z"), "someday");
    await setWish(env.DB, ada, lamp, false, Date.parse("2026-10-20T21:00:00Z"));
    await setWish(env.DB, fran, lamp, true, Date.parse("2026-10-21T05:00:00Z")); // the 21st: not yet

    expect(await sendWishReport(env, cronCdt)).toBe(2);

    const mail = await reports();
    expect(mail.map((m) => m.recipient)).toEqual([FIRST_ADMIN.email, SECOND_ADMIN.email]);
    expect(mail[0].subject).toBe("2 new wishes on 2026-10-20");
    expect(mail[0].text).toBe(mail[1].text);
    expect(mail[0].text).toBe(
      [
        "New wishes on 2026-10-20 (Central time):",
        "",
        `Fran Friend <fran@example.com> wants Brass pin (Jewelry), active, now`,
        `https://family.${DOMAIN}/admin#item-${pin}`,
        "",
        `Ada Family <ada@example.com> wants Lamp (Furniture), withdrawn, someday`,
        `https://family.${DOMAIN}/admin#item-${lamp}`,
      ].join("\n"),
    );
  });

  it("says 1 new wish in the singular", async () => {
    const pin = await newItem("Brass pin");
    await setWish(env.DB, ada, pin, true, Date.parse("2026-10-20T15:00:00Z"));
    await sendWishReport(env, cronCdt);
    expect((await reports())[0].subject).toBe("1 new wish on 2026-10-20");
  });

  it("sends nothing on a day with no new wishes", async () => {
    const pin = await newItem("Brass pin");
    await setWish(env.DB, ada, pin, true, Date.parse("2026-10-19T15:00:00Z"));
    expect(await sendWishReport(env, cronCdt)).toBe(0);
    expect(await reports()).toEqual([]);
  });

  it("counts a wish made again after a withdrawal as new, but not a repeated tick", async () => {
    const pin = await newItem("Brass pin");
    const lamp = await newItem("Lamp");
    await setWish(env.DB, ada, pin, true, Date.parse("2026-10-18T15:00:00Z"));
    await setWish(env.DB, ada, pin, false, Date.parse("2026-10-19T15:00:00Z"));
    await setWish(env.DB, ada, pin, true, Date.parse("2026-10-20T15:00:00Z"));
    await setWish(env.DB, fran, lamp, true, Date.parse("2026-10-18T15:00:00Z"));
    await setWish(env.DB, fran, lamp, true, Date.parse("2026-10-20T16:00:00Z"));
    await sendWishReport(env, cronCdt);
    const [first] = await reports();
    expect(first.subject).toBe("1 new wish on 2026-10-20");
    expect(first.text).toContain("Ada Family");
  });

  it("runs from the Worker's scheduled handler at the scheduled time", async () => {
    const pin = await newItem("Brass pin");
    await setWish(env.DB, ada, pin, true, Date.parse("2026-10-20T15:00:00Z"));
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    await worker.scheduled({ scheduledTime: cronCdt, cron: "0 12 * * *", noRetry() {} } as ScheduledController, env, ctx);
    await Promise.all(waits);
    expect((await reports()).map((m) => m.recipient)).toHaveLength(2);
  });

  it("in production, mails each admin separately, so one refusal does not stop the other, and logs it", async () => {
    const pin = await newItem("Brass pin");
    await setWish(env.DB, ada, pin, true, Date.parse("2026-10-20T15:00:00Z"));
    const sent: CapturedMail[] = [];
    const record = recordFetch(sent);
    const refuseFirst: typeof fetch = async (input, init) => {
      const response = await record(input, init);
      if (sent.length === 1) return new Response("no", { status: 500 });
      return response;
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const count = await withFetch(refuseFirst, () => sendWishReport(namedEnv("production"), cronCdt));
    const lines = logged.mock.calls.map((call) => call.join(" "));
    logged.mockRestore();
    expect(count).toBe(1);
    expect(sent.map((call) => (JSON.parse(call.body) as { to: string[] }).to)).toEqual([[FIRST_ADMIN.email], [SECOND_ADMIN.email]]);
    expect(lines).toEqual([`Wish report for 2026-10-20 was not sent to ${FIRST_ADMIN.email}: The message was not sent.`]);
    expect(lines.join(" ")).not.toContain(env.RESEND_API_KEY);
  });

  it("fails the run when no admin could be mailed", async () => {
    const pin = await newItem("Brass pin");
    await setWish(env.DB, ada, pin, true, Date.parse("2026-10-20T15:00:00Z"));
    const refuse: typeof fetch = async () => new Response("no", { status: 500 });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = withFetch(refuse, () => sendWishReport(namedEnv("production"), cronCdt));
    await expect(run).rejects.toThrow("Wish report for 2026-10-20 reached no one (2 failed).");
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });

  it("surfaces that failure from the scheduled handler", async () => {
    const pin = await newItem("Brass pin");
    await setWish(env.DB, ada, pin, true, Date.parse("2026-10-20T15:00:00Z"));
    const refuse: typeof fetch = async () => new Response("no", { status: 500 });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const run = withFetch(refuse, async () => {
      await worker.scheduled({ scheduledTime: cronCdt, cron: "0 12 * * *", noRetry() {} } as ScheduledController, namedEnv("production"), ctx);
      await Promise.all(waits);
    });
    await expect(run).rejects.toThrow("reached no one");
    logged.mockRestore();
  });
});
