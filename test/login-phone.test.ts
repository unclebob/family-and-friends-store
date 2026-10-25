import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEV_MERIT, FIRST_ADMIN } from "../src/dev-fixture";
import { maskEmail } from "../src/phone";
import { origin } from "./helpers";

const PHONES =
  `ada@example.com: (312) 555-0100\nbea@example.com: 312 555 0111, 312 555 0130\ncara@example.com: 312 555 0111\n${FIRST_ADMIN.email}: 312 555 0120\n`;
const NEUTRAL = { ok: false, message: "We couldn't sign you in with that address." };

beforeEach(async () => {
  await env.MERIT.getByName("merit").setFake({ ...DEV_MERIT, phones: PHONES });
});

async function post(host: "family" | "friends", path: string, body: unknown, cookie?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  return exports.default.fetch(`${origin(host)}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

type Started = { ok: boolean; masked?: string; pending?: string; devCode?: string; message?: string };

async function start(email: string, host: "family" | "friends" = "family"): Promise<{ status: number; text: string; body: Started }> {
  const response = await post(host, "/login/email", { email });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Started };
}

async function buckets(): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT bucket FROM rate_limits ORDER BY bucket").all<{ bucket: string }>();
  return rows.results.map((row) => row.bucket);
}

describe("sign in with a phone number", () => {
  it("mails the code to the number's email, shows it masked, and signs in with the pending id", async () => {
    const started = await start("+1 (312) 555-0100");
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ ok: true, masked: "a•••@example.com" });
    expect(started.body.pending).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.text).not.toContain("ada@example.com");
    const mailed = await env.DB.prepare("SELECT recipient, payload FROM outbox WHERE template = 'login-code'").first<{ recipient: string; payload: string }>();
    expect(mailed?.recipient).toBe("ada@example.com");
    expect(mailed?.payload).toContain(started.body.devCode);

    const done = await post("family", "/login/code", { pending: started.body.pending, code: started.body.devCode });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, firstName: "Ada" });
    const cookie = done.headers.get("set-cookie")!.split(";")[0];
    const me = await exports.default.fetch(`${origin("family")}/api/me`, { headers: { cookie } });
    expect(await me.json()).toMatchObject({ email: "ada@example.com", group: "family" });
  });

  it("answers an unknown or shared number exactly as it answers an unknown email", async () => {
    const unknownEmail = await start("nobody@example.com");
    for (const phone of ["312-555-0199", "312-555-0111"]) {
      const started = await start(phone);
      expect(started.status).toBe(unknownEmail.status);
      expect(started.body).toEqual(unknownEmail.body);
    }
    expect(unknownEmail.body).toEqual(NEUTRAL);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM login_codes").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("is for family and admins: an admin's number gets a code, a friend's gets the neutral answer", async () => {
    const admin = await start("312-555-0120");
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ ok: true, masked: maskEmail(FIRST_ADMIN.email) });
    const mailed = await env.DB.prepare("SELECT recipient FROM outbox WHERE template = 'login-code'").all<{ recipient: string }>();
    expect(mailed.results.map((row) => row.recipient)).toEqual([FIRST_ADMIN.email]);
    const done = await post("family", "/login/code", { pending: admin.body.pending, code: admin.body.devCode });
    expect(done.status).toBe(200);

    const unknownEmail = await start("nobody@example.com");
    const friend = await start("312-555-0130");
    expect(friend.status).toBe(unknownEmail.status);
    expect(friend.body).toEqual(unknownEmail.body);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM login_codes").first<{ n: number }>()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("refuses a number that is not a phone number with the neutral message", async () => {
    const started = await start("555-0100");
    expect(started.status).toBe(401);
    expect(started.body).toEqual(NEUTRAL);
  });

  it("says sign-in is unavailable when Merit is offline", async () => {
    await env.MERIT.getByName("merit").clearFake();
    const started = await start("312-555-0100");
    expect(started.status).toBe(503);
    expect(started.body.message).toBe("Sign-in is temporarily unavailable, please try again later.");
  });

  it("counts a phone start against both the number and its email", async () => {
    await start("312-555-0100");
    expect((await buckets()).filter((bucket) => !bucket.startsWith("ip-"))).toEqual(["email:ada@example.com", "phone:3125550100"]);
    for (let n = 0; n < 4; n += 1) await start("ada@example.com");
    const limited = await start("312-555-0100");
    expect(limited.status).toBe(429);
  });

  it("limits a number that matches no one, too", async () => {
    for (let n = 0; n < 5; n += 1) expect((await start("312-555-0199")).status).toBe(401);
    expect((await start("312-555-0199")).status).toBe(429);
  });

  it("refuses a pending id that is unknown, from the other host, or replaced by a newer start", async () => {
    const started = await start("312-555-0100");
    const code = started.body.devCode;
    expect((await post("family", "/login/code", { pending: "not-a-real-id", code })).status).toBe(401);
    expect((await post("friends", "/login/code", { pending: started.body.pending, code })).status).toBe(401);
    const again = await start("ada@example.com");
    const stale = await post("family", "/login/code", { pending: started.body.pending, code: again.body.devCode });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ ok: false, message: "That code doesn't work. Request a new one." });
    expect((await post("family", "/login/code", { email: "ada@example.com", code: again.body.devCode })).status).toBe(200);
  });

  it("still starts an email sign-in without a pending id or a masked address", async () => {
    const started = await start("ada@example.com");
    expect(started.body.ok).toBe(true);
    expect(started.body.pending).toBeUndefined();
    expect(started.body.masked).toBeUndefined();
  });
});
