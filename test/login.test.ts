import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { installMerit, login, origin, SECOND_ADMIN } from "./helpers";

beforeEach(async () => {
  await installMerit();
});

async function post(host: "family" | "friends", path: string, body: unknown, cookie?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  return exports.default.fetch(`${origin(host)}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("login", () => {
  it("stores a hashed code that lasts 20 minutes, works once, and is bound to the host", async () => {
    const started = await post("family", "/login/email", { email: "Ada@Example.com" });
    const sent = (await started.json()) as { devCode: string };
    const row = await env.DB.prepare("SELECT code_hash, expires_at, host FROM login_codes").first<{
      code_hash: string;
      expires_at: number;
      host: string;
    }>();
    expect(row?.host).toBe("family");
    expect(row?.code_hash).not.toBe(sent.devCode);
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.expires_at).toBeGreaterThan(Date.now() + 19 * 60 * 1000);
    expect(row!.expires_at).toBeLessThan(Date.now() + 21 * 60 * 1000);
    const mailed = await env.DB.prepare("SELECT payload FROM outbox WHERE template = 'login-code'").first<{
      payload: string;
    }>();
    expect(mailed?.payload).toContain(sent.devCode);

    const wrongHost = await post("friends", "/login/code", { email: "ada@example.com", code: sent.devCode });
    expect(wrongHost.status).toBe(401);

    const signed = await post("family", "/login/code", { email: "ada@example.com", code: sent.devCode });
    expect(signed.status).toBe(200);
    const welcome = (await signed.json()) as { firstName: string };
    expect(welcome.firstName).toBe("Ada");
    const again = await post("family", "/login/code", { email: "ada@example.com", code: sent.devCode });
    expect(again.status).toBe(401);
  });

  it("locks a code after 5 misses, and accepts the 5th try when it is right", async () => {
    const started = await post("family", "/login/email", { email: "ada@example.com" });
    const { devCode } = (await started.json()) as { devCode: string };
    for (let n = 0; n < 5; n += 1) {
      const miss = await post("family", "/login/code", { email: "ada@example.com", code: "000000" });
      expect(miss.status).toBe(401);
    }
    const locked = await post("family", "/login/code", { email: "ada@example.com", code: devCode });
    expect(locked.status).toBe(401);

    const fresh = await post("family", "/login/email", { email: SECOND_ADMIN.email });
    const second = (await fresh.json()) as { devCode: string };
    for (let n = 0; n < 4; n += 1) {
      await post("family", "/login/code", { email: SECOND_ADMIN.email, code: "111111" });
    }
    const ok = await post("family", "/login/code", { email: SECOND_ADMIN.email, code: second.devCode });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { firstName: string }).toMatchObject({ firstName: SECOND_ADMIN.name.split(" ")[0] });
  });

  it("rejects an expired code", async () => {
    const started = await post("family", "/login/email", { email: "ada@example.com" });
    const { devCode } = (await started.json()) as { devCode: string };
    await env.DB.prepare("UPDATE login_codes SET expires_at = ?").bind(Date.now() - 1000).run();
    const expired = await post("family", "/login/code", { email: "ada@example.com", code: devCode });
    expect(expired.status).toBe(401);
  });

  it("signs in by email alone, whichever host is used", async () => {
    for (const host of ["family", "friends"] as const) {
      for (const [email, group] of [["ada@example.com", "family"], ["bea@example.com", "friend"]] as const) {
        const cookie = await login(host, email);
        const me = await exports.default.fetch(`${origin(host)}/api/me`, { headers: { cookie } });
        expect(await me.json()).toMatchObject({ group, host });
      }
    }
  });

  it("uses one neutral message for an unknown address and a CardDAV error", async () => {
    const unknown = await post("family", "/login/email", { email: "nobody@example.com" });
    expect(await unknown.json()).toEqual({ ok: false, message: "We couldn't sign you in with that address." });
    await installMerit(true);
    const broken = await post("friends", "/login/email", { email: "nobody@example.com" });
    expect(await broken.json()).toEqual({ ok: false, message: "We couldn't sign you in with that address." });
  });

  it("says sign-in is unavailable when Merit has no socket", async () => {
    await env.MERIT.getByName("merit").clearFake();
    const response = await post("family", "/login/email", { email: "ada@example.com" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      message: "Sign-in is temporarily unavailable, please try again later.",
    });
  });

  it("adds a matching contact to the friends list from either host", async () => {
    const added = await post("family", "/login/email", { email: "cara@example.com" });
    expect((await added.json()) as { ok: boolean }).toMatchObject({ ok: true });
    const after = await env.MERIT.getByName("merit").getFake();
    expect(after?.friends).toContain("cara@example.com");
  });

  it("binds the session to the host and welcomes the person", async () => {
    const cookie = await login("family", "ada@example.com");
    const me = await exports.default.fetch(`${origin("family")}/api/me`, { headers: { cookie } });
    expect(await me.json()).toMatchObject({ firstName: "Ada", group: "family", host: "family" });
    const other = await exports.default.fetch(`${origin("friends")}/api/me`, { headers: { cookie } });
    expect(other.status).toBe(401);
  });

  it("rate limits repeated code requests", async () => {
    for (let n = 0; n < 5; n += 1) {
      const response = await post("family", "/login/email", { email: "ada@example.com" });
      expect(response.status).toBe(200);
    }
    const limited = await post("family", "/login/email", { email: "ada@example.com" });
    expect(limited.status).toBe(429);
  });

  it("logs off: answers ok, clears the cookie, and ends the session", async () => {
    const cookie = await login("family", "ada@example.com");
    const out = await post("family", "/logout", {}, cookie);
    expect(await out.json()).toEqual({ ok: true });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    const me = await exports.default.fetch(`${origin("family")}/api/me`, { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  it("logs off cleanly when there is no session", async () => {
    const out = await post("family", "/logout", {});
    expect(await out.json()).toEqual({ ok: true });
  });
});
