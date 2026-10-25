import { vi } from "vitest";

export type Reply = { status?: number; body?: unknown };
export type Route = Reply | ((body: unknown) => Reply | Promise<Reply>);
export type Call = { method: string; path: string; body: unknown; headers: Headers };

// A stand-in for the Worker: answers "METHOD /path" with canned JSON and
// records every request the page makes.
export function fakeServer(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = readBody(init.body);
    calls.push({ method, path: input, body, headers: new Headers(init.headers) });
    const route = routes[`${method} ${input}`];
    if (!route) return jsonResponse(404, { error: "no route" });
    const reply = typeof route === "function" ? await route(body) : route;
    return jsonResponse(reply.status ?? 200, reply.body ?? {});
  });
  vi.stubGlobal("fetch", fetch);
  return {
    calls,
    routes,
    sent: (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path),
  };
}

function readBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
