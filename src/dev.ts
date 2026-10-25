import { flushMeritLog } from "./accept";
import { DEV_MERIT, FIRST_ADMIN, SECOND_ADMIN } from "./dev-fixture";
import { isDev } from "./env-name";
import { json, orElse, valueOr } from "./http";

export async function devRoute(request: Request, env: Env): Promise<Response | null> {
  if (!isDev(env)) return null;
  return runDev(request, env);
}

async function runDev(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  return orElse(await meritOrSeed(request, env, url), () => flushOrOutbox(request, env, url));
}

async function meritOrSeed(request: Request, env: Env, url: URL): Promise<Response | null> {
  return orElse(await postMerit(request, env, url), () => postSeed(request, env, url));
}

async function flushOrOutbox(request: Request, env: Env, url: URL): Promise<Response | null> {
  return orElse(await postFlush(request, env, url), () => getOutbox(request, env, url));
}

async function postMerit(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!isMethod(request, url, "POST", "/dev/merit")) return null;
  await env.MERIT.getByName("merit").setFake(DEV_MERIT);
  return json({
    ok: true,
    people: [
      `${FIRST_ADMIN.email} and ${SECOND_ADMIN.email} are admins`,
      "ada@example.com is family",
      "bea@example.com is a friend with the jewelry topic",
      "cara@example.com is a contact who becomes a friend on the Friends side",
    ],
  });
}

async function postSeed(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!isMethod(request, url, "POST", "/dev/seed")) return null;
  return seedIfEmpty(env);
}

async function seedIfEmpty(env: Env): Promise<Response> {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
  if (hasRows(existing)) return json({ ok: true, seeded: false });
  return seedSamples(env);
}

function hasRows(row: { n: number } | null): boolean {
  return isCount(row) && row.n > 0;
}

function isCount(row: { n: number } | null): row is { n: number } {
  return row != null;
}

async function seedSamples(env: Env): Promise<Response> {
  const jewelry = await env.DB.prepare("SELECT id FROM topics WHERE slug = 'jewelry'").first<{ id: number }>();
  const aviation = await env.DB.prepare("SELECT id FROM topics WHERE slug = 'aviation'").first<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO items (topic_id, title, description, price_cents, status) VALUES (?, 'Grandmother''s brooch', 'A small brooch with a blue stone.', 4500, 'open')",
    ).bind(valueOr(jewelry, null, (row) => row.id)),
    env.DB.prepare(
      "INSERT INTO items (topic_id, title, description, price_cents, status) VALUES (?, 'Pilot logbook', 'The logbook from the Cessna years.', 12000, 'open')",
    ).bind(valueOr(aviation, null, (row) => row.id)),
  ]);
  return json({ ok: true, seeded: true });
}

async function postFlush(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!isMethod(request, url, "POST", "/dev/flush")) return null;
  return json({ ok: true, delivered: await flushMeritLog(env) });
}

async function getOutbox(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!isMethod(request, url, "GET", "/dev/outbox")) return null;
  const rows = await env.DB.prepare("SELECT id, recipient, template, payload, created_at FROM outbox ORDER BY id").all();
  return json({ messages: rows.results });
}

function isMethod(request: Request, url: URL, method: string, path: string): boolean {
  if (request.method !== method) return false;
  return url.pathname === path;
}
