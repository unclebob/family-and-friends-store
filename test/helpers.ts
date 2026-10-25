import { env, exports } from "cloudflare:workers";
import { DEV_MERIT, FIRST_ADMIN, SECOND_ADMIN } from "../src/dev-fixture";
import { DOMAIN } from "../src/hosts";
import type { Host } from "../src/visibility";

export { DOMAIN, FIRST_ADMIN, SECOND_ADMIN };

export function origin(host: Host): string {
  return `https://${host}.${DOMAIN}`;
}

export async function installMerit(carddavError = false): Promise<void> {
  await env.MERIT.getByName("merit").setFake({ ...DEV_MERIT, carddavError });
}

export async function login(host: Host, email: string): Promise<string> {
  const started = await exports.default.fetch(`${origin(host)}/login/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = (await started.json()) as { devCode?: string; message?: string };
  if (!body.devCode) throw new Error(`no code: ${started.status} ${JSON.stringify(body)}`);
  const done = await exports.default.fetch(`${origin(host)}/login/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code: body.devCode }),
  });
  if (done.status !== 200) throw new Error(await done.text());
  const cookie = done.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("missing session cookie");
  return cookie;
}

export function authed(cookie: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("cookie", cookie);
  return headers;
}

export async function asJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

export async function topicByName(cookie: string, name: string): Promise<{ id: number; slug: string }> {
  const listed = await exports.default.fetch(`${origin("family")}/api/admin/topics`, { headers: authed(cookie) });
  const body = (await listed.json()) as { topics: { id: number; slug: string; name: string }[] };
  const found = body.topics.find((row) => row.name === name);
  if (found) return { id: found.id, slug: found.slug };
  return createNamedTopic(cookie, name);
}

async function createNamedTopic(cookie: string, name: string): Promise<{ id: number; slug: string }> {
  const created = await exports.default.fetch(`${origin("family")}/api/admin/topics`, {
    method: "POST",
    headers: authed(cookie, { "content-type": "application/json" }),
    body: JSON.stringify({ name }),
  });
  if (created.status !== 201) throw new Error(await created.text());
  return (await created.json()) as { id: number; slug: string };
}

// The worker under test receives this env. ENV is the only binding that changes.
export function namedEnv(name: string): Env {
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === "ENV") return name;
      return Reflect.get(target, prop, receiver);
    },
  }) as Env;
}

export type CapturedMail = { url: string; method: string; authorization: string | null; body: string };

export function recordFetch(sent: CapturedMail[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    sent.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    });
    return new Response("{}", { status: 200 });
  };
}

export async function withFetch<T>(replacement: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}
