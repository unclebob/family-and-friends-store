import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function listen(ws: WebSocket, onMessage: (msg: Record<string, unknown>) => void): void {
  ws.addEventListener("message", (event) => {
    onMessage(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
}

async function connect(): Promise<WebSocket> {
  const response = await env.MERIT.getByName("merit").fetch("https://example.com/merit/ws", {
    headers: { Upgrade: "websocket" },
  });
  const ws = response.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  return ws;
}

describe("Merit socket", () => {
  it("is offline until a socket authenticates", async () => {
    const offline = await env.MERIT.getByName("merit").lookup("ada@example.com", 200);
    expect(offline).toEqual({ ok: false, reason: "merit_offline" });
    const ws = await connect();
    const ignored = await env.MERIT.getByName("merit").lookup("ada@example.com", 200);
    expect(ignored.ok).toBe(false);
    if (ignored.ok) throw new Error("expected merit_offline");
    expect(ignored.reason).toBe("merit_offline");
    ws.close();
  });

  it("answers a lookup and a log line over the socket", async () => {
    const ws = await connect();
    const seen: Record<string, unknown>[] = [];
    const authed = new Promise<void>((resolve) => {
      listen(ws, (msg) => {
        seen.push(msg);
        if (msg.op === "auth_ok") resolve();
        if (msg.op === "lookup") {
          ws.send(JSON.stringify({ id: msg.id, ok: true, name: "Ada Family", firstName: "Ada", group: "family", topics: "all" }));
        }
        if (msg.op === "log_accept") ws.send(JSON.stringify({ id: msg.id, ok: true }));
      });
    });
    ws.send(JSON.stringify({ op: "auth", secret: "dev-merit-secret" }));
    await authed;
    const lookup = await env.MERIT.getByName("merit").lookup("ada@example.com", 2000);
    expect(lookup).toMatchObject({ ok: true, firstName: "Ada", group: "family" });
    const logged = await env.MERIT.getByName("merit").logAccept({
      log_id: 1,
      timestamp_ct: "2026-10-20T12:00:00",
      item_id: 1,
      title: "Brass pin",
      topic: "jewelry",
      winner_email: "ada@example.com",
      winner_name: "Ada Family",
      winner_group: "family",
      accepted_by: "admin@example.com",
      winner_wish: "now",
    });
    expect(logged).toEqual({ ok: true });
    expect(seen.some((msg) => msg.op === "log_accept" && msg.title === "Brass pin")).toBe(true);
    ws.close();
  });

  it("waits for a slow reply instead of giving up on the first check", async () => {
    const ws = await signedInSocket((msg) => {
      if (msg.op === "lookup") {
        setTimeout(() => ws.send(JSON.stringify({ id: msg.id, ok: true, name: "Ada Family", firstName: "Ada", group: "family", topics: "all" })), 150);
      }
    });
    const lookup = await env.MERIT.getByName("merit").lookup("ada@example.com", 2000);
    expect(lookup).toMatchObject({ ok: true, firstName: "Ada" });
    ws.close();
  });

  it("reports a log line as not delivered when Merit never answers", async () => {
    const ws = await signedInSocket(() => {});
    const logged = await env.MERIT.getByName("merit").logAccept(LOG_LINE, 100);
    expect(logged).toEqual({ ok: false });
    ws.close();
  });

  it("asks Merit for the family list and accepts only a list of addresses", async () => {
    const link = env.MERIT.getByName("merit");
    expect(await link.familyList(200)).toEqual({ ok: false });
    let answer: Record<string, unknown> = { ok: true, family: ["ada@example.com", "cy@example.com"] };
    const ws = await signedInSocket((msg) => {
      if (msg.op === "family_list") ws.send(JSON.stringify({ id: msg.id, ...answer }));
    });
    expect(await link.familyList(2000)).toEqual({ ok: true, family: ["ada@example.com", "cy@example.com"] });
    for (const bad of [{ ok: true, family: ["ada@example.com", 7] }, { ok: true, family: "ada@example.com" }, { ok: false }]) {
      answer = bad;
      expect(await link.familyList(2000)).toEqual({ ok: false });
    }
    ws.close();
  });

  it("asks Merit whose phone number it is and accepts only one plain address", async () => {
    const link = env.MERIT.getByName("merit");
    expect(await link.phoneEmail("3125550100", 200)).toEqual({ ok: false, reason: "merit_offline" });
    const asked: unknown[] = [];
    let answer: Record<string, unknown> = { ok: true, email: " Ada@Example.com " };
    const ws = await signedInSocket((msg) => {
      if (msg.op !== "phone_email") return;
      asked.push(msg.phone);
      ws.send(JSON.stringify({ id: msg.id, ...answer }));
    });
    expect(await link.phoneEmail("3125550100", 2000)).toEqual({ ok: true, email: "ada@example.com" });
    expect(asked).toEqual(["3125550100"]);
    for (const bad of [{ ok: true, email: 7 }, { ok: true, email: "not an address" }, { ok: true }, { ok: false }]) {
      answer = bad;
      expect(await link.phoneEmail("3125550100", 2000)).toEqual({ ok: false, reason: "none" });
    }
    ws.close();
  });
});

const LOG_LINE = {
  log_id: 1,
  timestamp_ct: "2026-10-20T12:00:00",
  item_id: 1,
  title: "Brass pin",
  topic: "jewelry",
  winner_email: "ada@example.com",
  winner_name: "Ada Family",
  winner_group: "family" as const,
  accepted_by: "admin@example.com",
  winner_wish: "now" as const,
};

async function signedInSocket(onMessage: (msg: Record<string, unknown>) => void): Promise<WebSocket> {
  const ws = await connect();
  const authed = new Promise<void>((resolve) => {
    listen(ws, (msg) => {
      if (msg.op === "auth_ok") resolve();
      onMessage(msg);
    });
  });
  ws.send(JSON.stringify({ op: "auth", secret: "dev-merit-secret" }));
  await authed;
  return ws;
}
