import { DurableObject } from "cloudflare:workers";
import type { AcceptLog } from "./log";
import { resolvePerson, type Card, type Lists } from "./resolve";
import { normalizeEmail } from "./auth";
import { isDev } from "./env-name";
import { emailForPhone, parsePhones, type PhoneEntry } from "./phone";
import { secretsMatch } from "./secret";
import type { Group } from "./visibility";

export type LookupResult =
  | { ok: true; name: string; firstName: string; group: Group; topics: "all" | string[] }
  | { ok: false; reason: "not_contact" | "error" | "merit_offline" };

export type PhoneResult = { ok: true; email: string } | { ok: false; reason: "none" | "merit_offline" };

export type FakeMerit = {
  admins: string[];
  family: string[];
  friends: string[];
  grants: Record<string, string[]>;
  contacts: Record<string, string>;
  carddavError?: boolean;
  phones?: PhoneEntry[];
  deliveries: AcceptLog[];
};

// phones is the text of a phones.txt.
type FakeInput = Omit<FakeMerit, "deliveries" | "carddavError" | "phones"> & { carddavError?: boolean; phones?: string };

function secretText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFake(value: unknown): value is FakeMerit {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.admins) &&
    Array.isArray(value.family) &&
    Array.isArray(value.friends) &&
    isRecord(value.grants) &&
    isRecord(value.contacts) &&
    Array.isArray(value.deliveries)
  );
}

function parseMessage(message: string | ArrayBuffer): Record<string, unknown> | null {
  const text = typeof message === "string" ? message : new TextDecoder().decode(message);
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function authed(ws: WebSocket): boolean {
  const value: unknown = ws.deserializeAttachment();
  return isRecord(value) && value.authed === true;
}

function cardFor(fake: FakeMerit, email: string): Card {
  const name = fake.contacts[email.trim().toLowerCase()];
  if (typeof name === "string") return { name };
  if (fake.carddavError) return "error";
  return null;
}

function asLookup(reply: Record<string, unknown> | null): LookupResult {
  if (!reply) return { ok: false, reason: "error" };
  return lookupFrom(reply);
}

function lookupFrom(reply: Record<string, unknown>): LookupResult {
  const success = successLookup(reply);
  if (success) return success;
  return failureLookup(reply);
}

function successLookup(reply: Record<string, unknown>): LookupResult | null {
  if (!namedOk(reply)) return null;
  return groupedLookup(reply, reply.name, reply.firstName);
}

function namedOk(reply: Record<string, unknown>): reply is Record<string, unknown> & { name: string; firstName: string } {
  if (reply.ok !== true) return false;
  return bothStrings(reply.name, reply.firstName);
}

function bothStrings(name: unknown, firstName: unknown): name is string {
  if (typeof name !== "string") return false;
  return typeof firstName === "string";
}

function groupedLookup(
  reply: Record<string, unknown>,
  name: string,
  firstName: string,
): LookupResult | null {
  const group = lookupGroup(reply.group);
  if (!group) return null;
  return topicsLookup(reply, name, firstName, group);
}

function lookupGroup(value: unknown): Group | null {
  return oneOf(value, ["admin", "family", "friend"] as const);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (!allowed.includes(value as T)) return null;
  return value as T;
}

function topicsLookup(reply: Record<string, unknown>, name: string, firstName: string, group: Group): LookupResult | null {
  const topics = topicList(reply.topics);
  if (!topics) return null;
  return { ok: true, name, firstName, group, topics };
}

function topicList(value: unknown): "all" | string[] | null {
  if (value === "all") return "all";
  return stringList(value);
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return stringsOrNull(value);
}

function stringsOrNull(value: unknown[]): string[] | null {
  if (!value.every((topic) => typeof topic === "string")) return null;
  return value;
}

function failureLookup(reply: Record<string, unknown>): LookupResult {
  const reason = failedReason(reply);
  if (!reason) return { ok: false, reason: "error" };
  return { ok: false, reason };
}

function failedReason(reply: Record<string, unknown>): "not_contact" | "error" | null {
  if (reply.ok !== false) return null;
  return knownReason(reply.reason);
}

function knownReason(reason: unknown): "not_contact" | "error" | null {
  return oneOf(reason, ["not_contact", "error"] as const);
}

function phoneFrom(reply: Record<string, unknown> | null): PhoneResult {
  const email = reply?.ok === true ? normalizeEmail(reply.email) : null;
  return foundEmail(email);
}

function foundEmail(email: string | null): PhoneResult {
  if (!email) return { ok: false, reason: "none" };
  return { ok: true, email };
}

function familyFrom(reply: Record<string, unknown> | null): { ok: true; family: string[] } | { ok: false } {
  if (reply?.ok !== true) return { ok: false };
  const family = stringList(reply.family);
  if (!family) return { ok: false };
  return { ok: true, family };
}

// An unset Worker secret refuses every socket, even one that sends an empty secret.
export function meritSecretAllowed(given: string, configured: string): boolean {
  if (!configured) return false;
  return secretsMatch(given, configured);
}

// One Durable Object holds the single outbound socket from Merit.
export class MeritLink extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, done INTEGER NOT NULL, body TEXT)",
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const msg = parseMessage(message);
    if (!msg) return;
    await this.routeMessage(ws, msg);
  }

  private async routeMessage(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    if (msg.op === "auth") return this.authenticate(ws, msg);
    return this.afterAuth(ws, msg);
  }

  private authenticate(ws: WebSocket, msg: Record<string, unknown>): void {
    if (!this.allowed(secretText(msg.secret))) return this.deny(ws);
    this.replaceSockets(ws);
    ws.serializeAttachment({ authed: true });
    ws.send(JSON.stringify({ op: "auth_ok" }));
  }

  private allowed(secret: string): boolean {
    return meritSecretAllowed(secret, this.env.MERIT_SECRET);
  }

  private deny(ws: WebSocket): void {
    ws.close(1008, "unauthorized");
  }

  private replaceSockets(ws: WebSocket): void {
    for (const existing of this.ctx.getWebSockets()) this.closeOther(existing, ws);
  }

  private closeOther(existing: WebSocket, ws: WebSocket): void {
    if (existing !== ws) existing.close(4000, "replaced");
  }

  private afterAuth(ws: WebSocket, msg: Record<string, unknown>): void {
    if (!authed(ws)) return this.deny(ws);
    this.authedMessage(ws, msg);
  }

  private authedMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    if (msg.op === "heartbeat") return this.heartbeat(ws);
    this.storeReply(msg);
  }

  private heartbeat(ws: WebSocket): void {
    ws.send(JSON.stringify({ op: "heartbeat", ok: true }));
  }

  private storeReply(msg: Record<string, unknown>): void {
    if (typeof msg.id !== "string") return;
    this.ctx.storage.sql.exec("UPDATE pending SET done = 1, body = ? WHERE id = ?", JSON.stringify(msg), msg.id);
  }

  async setFake(input: FakeInput): Promise<void> {
    if (!isDev(this.env)) throw new Error("fake merit is only available in dev");
    this.writeFake({
      admins: input.admins,
      family: input.family,
      friends: input.friends,
      grants: input.grants,
      contacts: input.contacts,
      carddavError: input.carddavError === true,
      phones: parsePhones(input.phones ?? ""),
      deliveries: [],
    });
  }

  async clearFake(): Promise<void> {
    if (!isDev(this.env)) throw new Error("fake merit is only available in dev");
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'fake'");
  }

  async getFake(): Promise<FakeMerit | null> {
    return this.readFake();
  }

  async lookup(email: string, timeoutMs = 8000): Promise<LookupResult> {
    const fake = this.readFake();
    if (fake) return this.lookupFake(fake, email);
    const ws = this.liveSocket();
    if (!ws) return { ok: false, reason: "merit_offline" };
    const reply = await this.roundTrip(ws, { op: "lookup", email }, timeoutMs);
    return asLookup(reply);
  }

  async logAccept(payload: AcceptLog, timeoutMs = 8000): Promise<{ ok: boolean }> {
    const fake = this.readFake();
    if (fake) {
      fake.deliveries.push(payload);
      this.writeFake(fake);
      return { ok: true };
    }
    const ws = this.liveSocket();
    if (!ws) return { ok: false };
    const reply = await this.roundTrip(ws, { op: "log_accept", ...payload }, timeoutMs);
    return { ok: reply?.ok === true };
  }

  // The family list lives on Merit; it is fetched only at send time and never stored here.
  async familyList(timeoutMs = 8000): Promise<{ ok: true; family: string[] } | { ok: false }> {
    const fake = this.readFake();
    if (fake) return { ok: true, family: fake.family };
    const ws = this.liveSocket();
    if (!ws) return { ok: false };
    return familyFrom(await this.roundTrip(ws, { op: "family_list" }, timeoutMs));
  }

  // Merit keeps the phone numbers; the Worker learns only the one email a number belongs to.
  async phoneEmail(phone: string, timeoutMs = 8000): Promise<PhoneResult> {
    const fake = this.readFake();
    if (fake) return foundEmail(emailForPhone(fake.phones ?? [], phone));
    const ws = this.liveSocket();
    if (!ws) return { ok: false, reason: "merit_offline" };
    return phoneFrom(await this.roundTrip(ws, { op: "phone_email", phone }, timeoutMs));
  }

  private lookupFake(fake: FakeMerit, email: string): LookupResult {
    const lists: Lists = {
      admins: fake.admins,
      family: fake.family,
      friends: fake.friends,
      grants: fake.grants,
    };
    const { result, lists: next } = resolvePerson(email, lists, cardFor(fake, email));
    this.writeFake({ ...fake, ...next, contacts: fake.contacts, deliveries: fake.deliveries });
    if (!result.ok) return result;
    return {
      ok: true,
      name: result.name,
      firstName: result.firstName,
      group: result.group,
      topics: result.topics,
    };
  }

  private liveSocket(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      if (authed(ws)) return ws;
    }
    return null;
  }

  private async roundTrip(
    ws: WebSocket,
    fields: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO pending (id, done, body) VALUES (?, 0, NULL)", id);
    ws.send(JSON.stringify({ ...fields, id }));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(20);
      // This DO is the only writer, and the row was inserted above, so exactly one row is there.
      const { body } = this.ctx.storage.sql
        .exec<{ body: string | null }>("SELECT body FROM pending WHERE id = ?", id)
        .one();
      if (body) {
        this.ctx.storage.sql.exec("DELETE FROM pending WHERE id = ?", id);
        const parsed: unknown = JSON.parse(body);
        return isRecord(parsed) ? parsed : null;
      }
    }
    this.ctx.storage.sql.exec("DELETE FROM pending WHERE id = ?", id);
    return null;
  }

  private readFake(): FakeMerit | null {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'fake'")
      .toArray();
    if (!rows[0]) return null;
    try {
      const parsed: unknown = JSON.parse(rows[0].value);
      return isFake(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeFake(fake: FakeMerit): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('fake', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(fake),
    );
  }
}
