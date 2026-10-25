import { hashCode, secretsMatch, sixDigitCode } from "./secret";
import {
  CODE_TTL_MS,
  EMAIL_SEND_LIMIT,
  IP_CODE_LIMIT,
  IP_SEND_LIMIT,
  MAX_CODE_ATTEMPTS,
  RATE_WINDOW_MS,
  SESSION_TTL_MS,
} from "./time";
import { isGroup, type Host, type Session } from "./visibility";

type CodeRow = {
  code_hash: string;
  expires_at: number;
  attempts: number;
  used: number;
};

export function sessionCookie(id: string): string {
  return `ff_session=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearSessionCookie(): string {
  return "ff_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.trim().indexOf("=");
    if (eq === -1) continue;
    if (part.trim().slice(0, eq) === name) return part.trim().slice(eq + 1);
  }
  return null;
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-test-ip") ?? "local";
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export async function rateLimited(db: D1Database, bucket: string, limit: number, now: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT window_start, count FROM rate_limits WHERE bucket = ?")
    .bind(bucket)
    .first<{ window_start: number; count: number }>();
  if (!row || now - row.window_start >= RATE_WINDOW_MS) {
    await db
      .prepare(
        `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = 1`,
      )
      .bind(bucket, now)
      .run();
    return false;
  }
  if (row.count >= limit) return true;
  await db.prepare("UPDATE rate_limits SET count = count + 1 WHERE bucket = ?").bind(bucket).run();
  return false;
}

export async function limitedEmailPost(db: D1Database, email: string, ip: string, now: number): Promise<boolean> {
  if (await limitedEmail(db, email, now)) return true;
  return rateLimited(db, `ip-email:${ip}`, IP_SEND_LIMIT, now);
}

export function limitedEmail(db: D1Database, email: string, now: number): Promise<boolean> {
  return rateLimited(db, `email:${email}`, EMAIL_SEND_LIMIT, now);
}

// A phone start counts against the number here, and against its email once Merit names it.
export async function limitedPhonePost(db: D1Database, phone: string, ip: string, now: number): Promise<boolean> {
  if (await rateLimited(db, `phone:${phone}`, EMAIL_SEND_LIMIT, now)) return true;
  return rateLimited(db, `ip-email:${ip}`, IP_SEND_LIMIT, now);
}

export async function limitedCodePost(db: D1Database, ip: string, now: number): Promise<boolean> {
  return rateLimited(db, `ip-code:${ip}`, IP_CODE_LIMIT, now);
}

function encodeTopics(topics: Session["topics"]): string {
  return topics === "all" ? "all" : JSON.stringify(topics);
}

function decodeTopics(raw: string): Session["topics"] {
  if (raw === "all") return "all";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((slug) => typeof slug === "string")) return parsed;
  } catch {
    return [];
  }
  return [];
}

export async function readSession(db: D1Database, request: Request, host: Host, now = Date.now()): Promise<Session | null> {
  const id = readCookie(request.headers.get("cookie"), "ff_session");
  if (!id) return null;
  const row = await db
    .prepare(
      "SELECT email, name, first_name, grp, topics_json, host, expires_at FROM sessions WHERE id = ?",
    )
    .bind(id)
    .first<{
      email: string;
      name: string;
      first_name: string;
      grp: string;
      topics_json: string;
      host: string;
      expires_at: number;
    }>();
  if (!row || row.expires_at < now || row.host !== host || !isGroup(row.grp)) return null;
  return {
    email: row.email,
    name: row.name,
    firstName: row.first_name,
    group: row.grp,
    topics: decodeTopics(row.topics_json),
    host,
  };
}

export async function issueCode(
  db: D1Database,
  email: string,
  host: Host,
  pepper: string,
  now = Date.now(),
  pendingId: string | null = null,
): Promise<string> {
  const code = sixDigitCode();
  const codeHash = await hashCode(code, pepper);
  await db
    .prepare(
      `INSERT INTO login_codes (email, host, code_hash, expires_at, attempts, used, pending_id)
       VALUES (?, ?, ?, ?, 0, 0, ?)
       ON CONFLICT(email, host) DO UPDATE SET
         code_hash = excluded.code_hash,
         expires_at = excluded.expires_at,
         attempts = 0,
         used = 0,
         pending_id = excluded.pending_id`,
    )
    .bind(email, host, codeHash, now + CODE_TTL_MS, pendingId)
    .run();
  return code;
}

export async function pendingEmail(db: D1Database, pendingId: string, host: Host): Promise<string | null> {
  const row = await db
    .prepare("SELECT email FROM login_codes WHERE pending_id = ? AND host = ?")
    .bind(pendingId, host)
    .first<{ email: string }>();
  return row?.email ?? null;
}

export async function redeemCode(
  db: D1Database,
  email: string,
  host: Host,
  code: string,
  pepper: string,
  person: { name: string; firstName: string; group: Session["group"]; topics: Session["topics"] },
  now = Date.now(),
): Promise<{ ok: true; sessionId: string; firstName: string } | { ok: false; used?: true }> {
  const row = await db
    .prepare("SELECT code_hash, expires_at, attempts, used FROM login_codes WHERE email = ? AND host = ?")
    .bind(email, host)
    .first<CodeRow>();
  // The claim below checks used, expiry and attempts in one place.
  if (!row) return { ok: false };

  const codeHash = await hashCode(code, pepper);
  if (!secretsMatch(codeHash, row.code_hash)) {
    await db
      .prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ? AND host = ?")
      .bind(email, host)
      .run();
    return { ok: false };
  }
  if (row.used) return { ok: false, used: true };

  const claimed = await db
    .prepare(
      `UPDATE login_codes SET used = 1
       WHERE email = ? AND host = ? AND used = 0 AND attempts < ? AND expires_at >= ? AND code_hash = ?`,
    )
    .bind(email, host, MAX_CODE_ATTEMPTS, now, row.code_hash)
    .run();
  if (claimed.meta.changes !== 1) return { ok: false };
  const sessionId = await createSession(db, email, host, person, now);
  return { ok: true, sessionId, firstName: person.firstName };
}

export async function createSession(
  db: D1Database,
  email: string,
  host: Host,
  person: { name: string; firstName: string; group: Session["group"]; topics: Session["topics"] },
  now = Date.now(),
): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO sessions (id, email, name, first_name, grp, topics_json, host, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      sessionId,
      email,
      person.name,
      person.firstName,
      person.group,
      encodeTopics(person.topics),
      host,
      now + SESSION_TTL_MS,
    )
    .run();
  return sessionId;
}

export async function deleteSession(db: D1Database, request: Request): Promise<void> {
  const id = readCookie(request.headers.get("cookie"), "ff_session");
  if (!id) return;
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}
