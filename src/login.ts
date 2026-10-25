import {
  clearSessionCookie,
  clientIp,
  deleteSession,
  issueCode,
  limitedCodePost,
  limitedEmail,
  limitedEmailPost,
  limitedPhonePost,
  normalizeEmail,
  pendingEmail,
  createSession,
  redeemCode,
  sessionCookie,
} from "./auth";
import { isDev } from "./env-name";
import { HttpError, json, readBody } from "./http";
import { sendMail } from "./mail";
import { maskEmail, normalizePhone } from "./phone";
import { nowIso } from "./time";
import { testLogin, type TestPerson } from "./test-login";
import type { Host } from "./visibility";

const NEUTRAL = "We couldn't sign you in with that address.";
const OFFLINE = "Sign-in is temporarily unavailable, please try again later.";
const BAD_CODE = "That code doesn't work. Request a new one.";
const USED_CODE = "That code was already used. If you're not signed in, request a new one.";
const LIMITED = "Too many attempts. Please wait and try again.";

export async function postEmail(request: Request, env: Env, host: Host): Promise<Response> {
  const record = await readLogin(request);
  const tester = testLogin(record.email, env); // TEMPORARY test bypass
  if (tester) return signInTester(env, host, tester); // TEMPORARY test bypass
  const phone = normalizePhone(record.email);
  if (phone) return startPhone(request, env, host, phone);
  const email = normalizeEmail(record.email);
  const now = Date.now();
  if (!email) return json({ ok: false, message: NEUTRAL }, 401);
  if (await limitedEmailPost(env.DB, email, clientIp(request), now)) return json({ ok: false, message: LIMITED }, 429);
  const lookup = await env.MERIT.getByName("merit").lookup(email);
  if (!lookup.ok) return lookupFailure(lookup.reason);
  return sendCode(env, host, email, now, null);
}

// Anyone can type a number, so a miss looks like an unknown email and a hit shows the email masked.
async function startPhone(request: Request, env: Env, host: Host, phone: string): Promise<Response> {
  const now = Date.now();
  if (await limitedPhonePost(env.DB, phone, clientIp(request), now)) return json({ ok: false, message: LIMITED }, 429);
  const found = await env.MERIT.getByName("merit").phoneEmail(phone);
  if (!found.ok) return lookupFailure(found.reason === "merit_offline" ? "merit_offline" : "not_contact");
  if (await limitedEmail(env.DB, found.email, now)) return json({ ok: false, message: LIMITED }, 429);
  const lookup = await env.MERIT.getByName("merit").lookup(found.email);
  if (!lookup.ok) return lookupFailure(lookup.reason);
  // Phone sign-in is for family and admins; a friend looks like an unknown number.
  if (lookup.group === "friend") return lookupFailure("not_contact");
  return sendCode(env, host, found.email, now, crypto.randomUUID());
}

async function sendCode(env: Env, host: Host, email: string, now: number, pendingId: string | null): Promise<Response> {

  const code = await issueCode(env.DB, email, host, env.CODE_PEPPER, now, pendingId);
  await sendMail(
    env,
    email,
    "login-code",
    "Your sign-in code",
    `Your sign-in code is ${code}. It expires in 20 minutes and works only once.`,
    nowIso(now),
  );
  const response: { ok: true; devCode?: string; masked?: string; pending?: string } = { ok: true };
  if (pendingId) Object.assign(response, { masked: maskEmail(email), pending: pendingId });
  if (isDev(env)) response.devCode = code;
  return json(response);
}

// TEMPORARY test bypass, remove: session straight away, family or friend only.
async function signInTester(env: Env, host: Host, tester: TestPerson) {
  const person = { name: tester.name, firstName: tester.name, group: tester.group, topics: "all" as const };
  const sessionId = await createSession(env.DB, tester.email, host, person);
  const headers = new Headers();
  headers.set("set-cookie", sessionCookie(sessionId));
  return json({ ok: true, signedIn: true, firstName: tester.name }, 200, headers);
}

export async function postCode(request: Request, env: Env, host: Host): Promise<Response> {
  const record = await readLogin(request);
  const attempt = codeAttempt({ ...record, email: await attemptEmail(env.DB, record, host) });
  const now = Date.now();
  if (!attempt) return json({ ok: false, message: BAD_CODE }, 401);
  if (await limitedCodePost(env.DB, clientIp(request), now)) return json({ ok: false, message: LIMITED }, 429);

  const lookup = await env.MERIT.getByName("merit").lookup(attempt.email);
  if (!lookup.ok) return lookupFailure(lookup.reason);
  return redeemed(await redeemCode(env.DB, attempt.email, host, attempt.code, env.CODE_PEPPER, lookup, now));
}

// A phone start sends back its pending id instead of the email.
async function attemptEmail(db: D1Database, record: Record<string, unknown>, host: Host): Promise<unknown> {
  if (typeof record.pending !== "string") return record.email;
  return pendingEmail(db, record.pending, host);
}

function codeAttempt(record: Record<string, unknown>): { email: string; code: string } | null {
  const email = normalizeEmail(record.email);
  const code = typeof record.code === "string" ? record.code.trim() : "";
  if (!email || !/^\d{6}$/.test(code)) return null;
  return { email, code };
}

function redeemed(result: Awaited<ReturnType<typeof redeemCode>>): Response {
  if (!result.ok) return json({ ok: false, message: result.used ? USED_CODE : BAD_CODE }, 401);
  const headers = new Headers();
  headers.set("set-cookie", sessionCookie(result.sessionId));
  return json({ ok: true, firstName: result.firstName }, 200, headers);
}

function lookupFailure(reason: "not_contact" | "error" | "merit_offline"): Response {
  return json(failure(reason), reason === "merit_offline" ? 503 : 401);
}

export async function postLogout(request: Request, env: Env): Promise<Response> {
  await deleteSession(env.DB, request);
  const headers = new Headers();
  headers.set("set-cookie", clearSessionCookie());
  return json({ ok: true }, 200, headers);
}

async function readLogin(request: Request): Promise<Record<string, unknown>> {
  try {
    return await readBody(request);
  } catch (err) {
    return emptyOnHttp(err);
  }
}

function emptyOnHttp(err: unknown): Record<string, unknown> {
  if (err instanceof HttpError) return {};
  throw err;
}

function failure(reason: "not_contact" | "error" | "merit_offline") {
  if (reason === "merit_offline") return { ok: false, message: OFFLINE };
  return { ok: false, message: NEUTRAL };
}
