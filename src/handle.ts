import { readSession } from "./auth";
import { adminRoute } from "./admin";
import { devRoute } from "./dev";
import { requestHost } from "./hosts";
import { HttpError, json, matchedId, notFound } from "./http";
import { postCode, postEmail, postLogout } from "./login";
import { getItem, getItems, getMe, getTopics, postWish, requireSession } from "./member";
import { getEmailPhoto, getPhoto } from "./photo";
import type { Host, Session } from "./visibility";

type Ctx = { request: Request; env: Env; path: string; host: Host };
type Step = (ctx: Ctx) => Promise<Response | null>;

const steps: Step[] = [meritSocket, devEntry, configEntry, loginEntry, emailPhotoEntry, photoEntry, adminEntry, memberEntry];

export async function handle(request: Request, env: Env): Promise<Response> {
  return withHsts(request, env, await guarded(request, env));
}

async function guarded(request: Request, env: Env): Promise<Response> {
  try {
    return await dispatch(request, env);
  } catch (err) {
    return failed(err);
  }
}

// Real hosts only: local dev and tests run on plain http.
function realHost(request: Request, env: Env): boolean {
  return `${env.ENV}` !== "dev" && requestHost(request, `${env.ENV}`) !== null;
}

function toHttps(request: Request): Response {
  const url = new URL(request.url);
  url.protocol = "https:";
  // 301 for GET and HEAD; 308 for the rest so a POST keeps its method and body.
  const status = ["GET", "HEAD"].includes(request.method) ? 301 : 308;
  return new Response(null, { status, headers: { location: url.toString() } });
}

function withHsts(request: Request, env: Env, response: Response): Response {
  if (response.webSocket || !realHost(request, env)) return response;
  const sealed = new Response(response.body, response);
  sealed.headers.set("strict-transport-security", "max-age=31536000");
  return sealed;
}

function failed(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  return serverError(err);
}

function serverError(err: unknown): Response {
  console.error(JSON.stringify({ event: "error", message: errorText(err) }));
  return json({ error: "Something went wrong." }, 500);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "error";
}

async function dispatch(request: Request, env: Env): Promise<Response> {
  const host = requestHost(request, `${env.ENV}`);
  if (!host) return notFound();
  if (realHost(request, env) && new URL(request.url).protocol === "http:") return toHttps(request);
  const ctx = { request, env, path: new URL(request.url).pathname, host };
  for (const step of steps) {
    const response = await step(ctx);
    if (response) return response;
  }
  return env.ASSETS.fetch(request);
}

async function meritSocket(ctx: Ctx): Promise<Response | null> {
  if (ctx.path !== "/merit/ws") return null;
  return ctx.env.MERIT.getByName("merit").fetch(ctx.request);
}

async function devEntry(ctx: Ctx): Promise<Response | null> {
  if (!ctx.path.startsWith("/dev/")) return null;
  return devResult(ctx);
}

async function devResult(ctx: Ctx): Promise<Response> {
  const dev = await devRoute(ctx.request, ctx.env);
  if (dev) return dev;
  return notFound();
}

async function configEntry(ctx: Ctx): Promise<Response | null> {
  if (!isGet(ctx, "/api/config")) return null;
  return json({ host: ctx.host, env: ctx.env.ENV });
}

async function loginEntry(ctx: Ctx): Promise<Response | null> {
  if (ctx.request.method !== "POST") return null;
  return loginPost(ctx);
}

async function loginPost(ctx: Ctx): Promise<Response | null> {
  if (ctx.path === "/login/email") return postEmail(ctx.request, ctx.env, ctx.host);
  return loginCode(ctx);
}

async function loginCode(ctx: Ctx): Promise<Response | null> {
  if (ctx.path === "/login/code") return postCode(ctx.request, ctx.env, ctx.host);
  return logoutPost(ctx);
}

async function logoutPost(ctx: Ctx): Promise<Response | null> {
  if (ctx.path !== "/logout") return null;
  return postLogout(ctx.request, ctx.env);
}

async function emailPhotoEntry(ctx: Ctx): Promise<Response | null> {
  if (ctx.request.method !== "GET") return null;
  const id = matchedId(ctx.path, /^\/photo\/(\d+)\/email$/);
  if (!id) return null;
  return getEmailPhoto(ctx.env, id, new URL(ctx.request.url));
}

async function photoEntry(ctx: Ctx): Promise<Response | null> {
  const id = photoId(ctx);
  if (!id) return null;
  return getPhoto(ctx.env, await readSession(ctx.env.DB, ctx.request, ctx.host), id);
}

function photoId(ctx: Ctx): number | null {
  if (ctx.request.method !== "GET") return null;
  return matchedId(ctx.path, /^\/photo\/(\d+)$/);
}

async function adminEntry(ctx: Ctx): Promise<Response | null> {
  if (!ctx.path.startsWith("/api/admin")) return null;
  return adminGuard(ctx);
}

async function adminGuard(ctx: Ctx): Promise<Response> {
  const session = await readSession(ctx.env.DB, ctx.request, ctx.host);
  if (!session) throw new HttpError(401, "Sign in.");
  return adminOnly(ctx, session);
}

async function adminOnly(ctx: Ctx, session: Session): Promise<Response> {
  if (session.group !== "admin") return json({ error: "Not allowed." }, 403);
  return adminRoute(ctx.request, ctx.env, session);
}

async function memberEntry(ctx: Ctx): Promise<Response | null> {
  if (!ctx.path.startsWith("/api/")) return null;
  return memberRoute(ctx);
}

async function memberRoute(ctx: Ctx): Promise<Response> {
  const session = await requireSession(ctx.request, ctx.env, ctx.host);
  const routed = await memberGet(ctx, session);
  if (routed) return routed;
  return notFound();
}

async function memberGet(ctx: Ctx, session: Session): Promise<Response | null> {
  const simple = simpleMember(ctx, session);
  if (simple) return simple;
  return itemMember(ctx, session);
}

function simpleMember(ctx: Ctx, session: Session): Response | Promise<Response> | null {
  if (ctx.request.method !== "GET") return null;
  return simpleGet(ctx, session);
}

function simpleGet(ctx: Ctx, session: Session): Response | Promise<Response> | null {
  if (ctx.path === "/api/me") return getMe(session);
  return topicGet(ctx, session);
}

function topicGet(ctx: Ctx, session: Session): Response | Promise<Response> | null {
  if (ctx.path === "/api/topics") return getTopics(ctx.env, session);
  return itemList(ctx, session);
}

function itemList(ctx: Ctx, session: Session): Response | Promise<Response> | null {
  if (ctx.path !== "/api/items") return null;
  return getItems(ctx.request, ctx.env, session);
}

async function itemMember(ctx: Ctx, session: Session): Promise<Response | null> {
  const id = matchedId(ctx.path, /^\/api\/items\/(\d+)$/);
  if (id) return oneItem(ctx, session, id);
  return wishMember(ctx, session);
}

async function oneItem(ctx: Ctx, session: Session, id: number): Promise<Response | null> {
  if (ctx.request.method !== "GET") return null;
  return getItem(ctx.env, session, id);
}

async function wishMember(ctx: Ctx, session: Session): Promise<Response | null> {
  const id = matchedId(ctx.path, /^\/api\/items\/(\d+)\/wish$/);
  if (!id) return null;
  return wishPost(ctx, session, id);
}

async function wishPost(ctx: Ctx, session: Session, id: number): Promise<Response | null> {
  if (ctx.request.method !== "POST") return null;
  return postWish(ctx.request, ctx.env, session, id);
}

function isGet(ctx: Ctx, path: string): boolean {
  if (ctx.request.method !== "GET") return false;
  return ctx.path === path;
}

