import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { issueCode, rateLimited, redeemCode } from "../src/auth";
import { CODE_TTL_MS, MAX_CODE_ATTEMPTS, RATE_WINDOW_MS } from "../src/time";
import { installMerit, origin } from "./helpers";

beforeEach(async () => {
  await installMerit();
});

const PEPPER = "test-pepper";
const ADA = { name: "Ada Family", firstName: "Ada", group: "family" as const, topics: "all" as const };
const T0 = 1_800_000_000_000;

async function redeem(code: string, now: number) {
  return redeemCode(env.DB, "ada@example.com", "family", code, PEPPER, ADA, now);
}

async function issued(): Promise<string> {
  return issueCode(env.DB, "ada@example.com", "family", PEPPER, T0);
}

function wrong(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

describe("sign-in codes", () => {
  it("still works at the last moment of its 20 minutes", async () => {
    const code = await issued();
    expect(await redeem(code, T0 + CODE_TTL_MS)).toMatchObject({ ok: true, firstName: "Ada" });
  });

  it("stops working one moment after 20 minutes", async () => {
    const code = await issued();
    expect(await redeem(code, T0 + CODE_TTL_MS + 1)).toEqual({ ok: false });
  });

  it("refuses the right code once the miss limit is reached", async () => {
    const code = await issued();
    for (let n = 0; n < MAX_CODE_ATTEMPTS; n += 1) expect(await redeem(wrong(code), T0)).toEqual({ ok: false });
    expect(await redeem(code, T0)).toEqual({ ok: false });
  });

  it("works only once even when the same code is sent twice at the same moment", async () => {
    const code = await issued();
    const results = await Promise.all([redeem(code, T0), redeem(code, T0)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(1);
  });

  it("tells a used code apart from a wrong one", async () => {
    const code = await issued();
    expect(await redeem(code, T0)).toMatchObject({ ok: true });
    expect(await redeem(code, T0)).toEqual({ ok: false, used: true });
    expect(await redeem(wrong(code), T0)).toEqual({ ok: false });
  });

  it("answers the same code twice with 200, then 401 saying it was used", async () => {
    const send = (body: unknown) =>
      exports.default.fetch(`${origin("family")}/login/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const started = await exports.default.fetch(`${origin("family")}/login/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com" }),
    });
    const { devCode } = (await started.json()) as { devCode: string };
    const first = await send({ email: "ada@example.com", code: devCode });
    expect(first.status).toBe(200);
    const second = await send({ email: "ada@example.com", code: devCode });
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual({ ok: false, message: "That code was already used. If you're not signed in, request a new one." });
    const third = await send({ email: "ada@example.com", code: wrong(devCode) });
    expect(third.status).toBe(401);
    expect(await third.json()).toEqual({ ok: false, message: "That code doesn't work. Request a new one." });
  });

  it("answers a good code with ok and the first name", async () => {
    const started = await exports.default.fetch(`${origin("family")}/login/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com" }),
    });
    const { devCode } = (await started.json()) as { devCode: string };
    const done = await exports.default.fetch(`${origin("family")}/login/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", code: devCode }),
    });
    expect(await done.json()).toEqual({ ok: true, firstName: "Ada" });
  });
});

describe("rate limits", () => {
  it("blocks past the limit inside one window and starts over exactly when the window ends", async () => {
    expect(await rateLimited(env.DB, "test", 2, T0)).toBe(false);
    expect(await rateLimited(env.DB, "test", 2, T0 + 1)).toBe(false);
    expect(await rateLimited(env.DB, "test", 2, T0 + RATE_WINDOW_MS - 1)).toBe(true);
    expect(await rateLimited(env.DB, "test", 2, T0 + RATE_WINDOW_MS)).toBe(false);
  });
});
