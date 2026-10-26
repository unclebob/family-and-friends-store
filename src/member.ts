import type { WishKind } from "./serializer";
import { readSession } from "./auth";
import { HttpError, json, notFound } from "./http";
import { listTopics, loadAdminItems, loadItem, loadOpenItems, topicBySlug } from "./items";
import { serializeMemberItem, type RawItem } from "./serializer";
import { setWish } from "./wish";
import { canSeeTopic, type Session } from "./visibility";
import type { ItemRecord } from "./items";

function raw(item: ItemRecord): RawItem {
  return {
    id: item.id,
    topicSlug: item.topicSlug,
    title: item.title,
    description: item.description,
    priceCents: item.priceCents,
    status: item.status,
    photos: item.photos,
    wishes: item.wishes.map((wish) => ({ id: wish.id, email: wish.email, name: wish.name, status: wish.status, kind: wish.kind })),
  };
}

export async function getMe(session: Session): Promise<Response> {
  return json({
    email: session.email,
    name: session.name,
    firstName: session.firstName,
    group: session.group,
    topics: session.topics,
    host: session.host,
  });
}

// Each topic says how many items the viewer would see in it: the same items getItems lists.
export async function getTopics(env: Env, session: Session): Promise<Response> {
  const topics = await listTopics(env.DB);
  const available = countBy(visibleItems(session, await loadOpenItems(env.DB)).map((item) => item.topic));
  return json({
    topics: topics
      .filter((topic) => canSeeTopic(session, topic.slug))
      .map((topic) => ({ id: topic.id, slug: topic.slug, name: topic.name, available: available.get(topic.slug) ?? 0 })),
  });
}

function countBy(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function visibleItems(session: Session, items: ItemRecord[]) {
  return items.map((item) => serializeMemberItem(session, raw(item))).filter((item) => item !== null);
}

export async function getItems(request: Request, env: Env, session: Session): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("topic");
  if (slug) {
    const topic = await topicBySlug(env.DB, slug);
    if (!topic || !canSeeTopic(session, topic.slug)) return notFound();
  }
  return json({ items: visibleItems(session, await listedItems(env.DB, session, slug ?? undefined)) });
}

function listedItems(db: D1Database, session: Session, slug?: string): Promise<ItemRecord[]> {
  if (session.group === "admin") return loadAdminItems(db, slug);
  return loadOpenItems(db, slug);
}

export async function getItem(env: Env, session: Session, id: number): Promise<Response> {
  const item = await loadItem(env.DB, id);
  if (!item) return notFound();
  const view = serializeMemberItem(session, raw(item));
  if (!view) return notFound();
  return json({ item: view });
}

export async function postWish(request: Request, env: Env, session: Session, id: number): Promise<Response> {
  const body = await request.json().catch(() => null);
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!record || typeof record.wished !== "boolean") throw new HttpError(400, "Send wished true or false.");
  const result = await setWish(env.DB, session, id, record.wished, Date.now(), wishKind(record.kind, session));
  if (result.status === 404) return notFound();
  if (result.status === 409) return json({ error: "That wish is locked." }, 409);
  return json({ wished: result.wished, kind: result.kind });
}

// Family and admins may wish now or someday; friends only now.
function wishKind(value: unknown, session: Session): WishKind {
  if (value === undefined || value === "now") return "now";
  if (value !== "someday") throw new HttpError(400, "Kind must be now or someday.");
  if (session.group === "friend") throw new HttpError(400, "Friends can only wish for an item now.");
  return "someday";
}

export async function requireSession(request: Request, env: Env, host: Session["host"]): Promise<Session> {
  const session = await readSession(env.DB, request, host);
  if (!session) throw new HttpError(401, "Sign in.");
  return session;
}
