// TEMPORARY test bypass, remove with src/test-login.ts.
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { postEmail } from "../src/login";
import { testLogin } from "../src/test-login";
import { authed, FIRST_ADMIN, installMerit, login, origin, topicByName } from "./helpers";

beforeEach(async () => {
  await installMerit();
});

const on = { ...env, TEST_LOGINS: "on" } as unknown as Env;

function noMerit(): Env {
  const MERIT = { getByName: () => { throw new Error("Merit must not be called"); } };
  return { ...on, MERIT } as unknown as Env;
}

function emailPost(email: string): Request {
  return new Request(`${origin("friends")}/login/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("TEMPORARY test bypass", () => {
  it("matches only the two exact test domains, never admin, and only when on", () => {
    expect(testLogin("Pat@FamilyTest", on)).toEqual({ email: "pat@familytest", name: "pat", group: "family" });
    expect(testLogin(" sam@friendtest ", on)).toEqual({ email: "sam@friendtest", name: "sam", group: "friend" });
    for (const email of ["pat@familytest.com", "pat@admintest", "@familytest", "a b@friendtest", "pat@x.familytest"]) {
      expect(testLogin(email, on)).toBeNull();
    }
    expect(testLogin("pat@familytest", env)).toBeNull();
    expect(testLogin("pat@familytest", { ...env, TEST_LOGINS: "true" } as unknown as Env)).toBeNull();
  });

  it("signs a tester in straight away with no Merit call and no code", async () => {
    for (const [email, group, name] of [["Pat@familytest", "family", "pat"], ["sam@friendtest", "friend", "sam"]]) {
      const response = await postEmail(emailPost(email), noMerit(), "friends");
      expect(await response.json()).toEqual({ ok: true, signedIn: true, firstName: name });
      const cookie = response.headers.get("set-cookie")!.split(";")[0];
      const me = await exports.default.fetch(`${origin("friends")}/api/me`, { headers: { cookie } });
      expect(await me.json()).toMatchObject({ firstName: name, group, host: "friends" });
    }
    expect(await count("login_codes")).toBe(0);
    expect(await count("outbox")).toBe(0);
  });

  it("lets a friend tester see items in every topic, as promised for testers", async () => {
    const admin = await login("family", FIRST_ADMIN.email);
    const topicId = (await topicByName(admin, "Aviation")).id;
    const created = await exports.default.fetch(`${origin("family")}/api/admin/items`, {
      method: "POST",
      headers: authed(admin, { "content-type": "application/json" }),
      body: JSON.stringify({ topicId, title: "Pilot logbook", description: "", priceCents: 1200 }),
    });
    const itemId = ((await created.json()) as { id: number }).id;
    const signedIn = await postEmail(emailPost("sam@friendtest"), noMerit(), "friends");
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const seen = await exports.default.fetch(`${origin("friends")}/api/items/${itemId}`, { headers: authed(cookie) });
    expect(seen.status).toBe(200);
    expect(await seen.json()).toMatchObject({ item: { title: "Pilot logbook", priceCents: 1200 } });
  });

  it("treats test addresses as invalid when off", async () => {
    for (const email of ["pat@familytest", "sam@friendtest"]) {
      const response = await exports.default.fetch(emailPost(email));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false, message: "We couldn't sign you in with that address." });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(await count("login_codes")).toBe(0);
  });
});
