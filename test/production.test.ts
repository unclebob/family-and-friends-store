import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/handle";
import { asJson, FIRST_ADMIN, installMerit, namedEnv, origin, recordFetch, type CapturedMail, withFetch } from "./helpers";

beforeEach(async () => {
  await installMerit();
});

function loginRequest(): Request {
  return new Request(`${origin("family")}/login/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: FIRST_ADMIN.email }),
  });
}

async function loginMail(sent: CapturedMail[]): Promise<Response> {
  return withFetch(recordFetch(sent), () => handle(loginRequest(), namedEnv("production")));
}

describe("production gates", () => {
  it("returns 404 for /dev routes unless ENV is dev", async () => {
    const blocked = await handle(new Request(`${origin("family")}/dev/seed`, { method: "POST" }), namedEnv("production"));
    expect(blocked.status).toBe(404);
    const outbox = await handle(new Request(`${origin("family")}/dev/outbox`), namedEnv("production"));
    expect(outbox.status).toBe(404);
    const allowed = await asJson(
      await handle(new Request(`${origin("family")}/dev/seed`, { method: "POST" }), namedEnv("dev")),
    );
    expect(allowed).toMatchObject({ ok: true, seeded: true });
  });

  it("sends the login code through Resend and leaves it out of the response", async () => {
    const sent: CapturedMail[] = [];
    const response = await loginMail(sent);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toMatch(/\d{6}/);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.resend.com/emails");
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.authorization).toBe("Bearer test-resend-key");
    const payload = JSON.parse(sent[0]?.body ?? "{}") as { from: string; to: string[]; subject: string; text: string };
    expect(payload.from).toBe(env.MAIL_FROM);
    expect(payload.to).toEqual([FIRST_ADMIN.email]);
    expect(payload.subject).toBe("Your sign-in code");
    expect(payload.text).toMatch(/Your sign-in code is \d{6}/);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("does not return the login code when Resend refuses the message", async () => {
    const refuse: typeof fetch = async () => new Response("nope", { status: 500 });
    const response = await withFetch(refuse, () => handle(loginRequest(), namedEnv("production")));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("sign-in code");
    expect(text).not.toMatch(/\d{6}/);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});
