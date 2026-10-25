import { isDev } from "./env-name";
import { wishesGet } from "./all-wishes";
import { acceptWish } from "./accept";
import { cancelWish } from "./cancel-wish";
import { centsField, descriptionField, HttpError, json, matchedId, notFound, orElse, slugify, textField, valueOr } from "./http";
import { listTopics, loadAdminItems, loadItem } from "./items";
import { sendNewItemsMail } from "./new-items";
import { MAX_PHOTO_BYTES, nowIso } from "./time";
import type { Session } from "./visibility";
import type { ItemRecord } from "./items";

function adminView(item: ItemRecord) {
  return {
    id: item.id,
    topicId: item.topicId,
    topic: item.topicSlug,
    topicName: item.topicName,
    title: item.title,
    description: item.description,
    priceCents: item.priceCents,
    status: item.status,
    assignedTo: item.assignedTo,
    acceptedBy: item.acceptedBy,
    photos: item.photos.map((photo) => ({ id: photo.id, url: `/photo/${photo.id}` })),
    wishes: item.wishes
      .filter((wish) => wish.status !== "withdrawn")
      .map((wish) => ({ id: wish.id, email: wish.email, name: wish.name, group: wish.grp, status: wish.status, kind: wish.kind })),
  };
}

async function uniqueSlug(db: D1Database, name: string): Promise<string> {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  while (await db.prepare("SELECT id FROM topics WHERE slug = ?").bind(slug).first()) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

export async function adminRoute(request: Request, env: Env, session: Session): Promise<Response> {
  const path = new URL(request.url).pathname;
  const listed = await listRoutes(request, env, path);
  if (listed) return listed;
  return writeRoutes(request, env, session, path);
}

async function listRoutes(request: Request, env: Env, path: string): Promise<Response | null> {
  if (request.method !== "GET") return null;
  return orElse(await wishesGet(env, new URL(request.url)), () => listGet(env, path));
}

async function listGet(env: Env, path: string): Promise<Response | null> {
  if (path === "/api/admin/items") return itemList(env);
  return topicList(env, path);
}

async function itemList(env: Env): Promise<Response> {
  const items = await loadAdminItems(env.DB);
  return json({ items: items.map(adminView) });
}

async function topicList(env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/admin/topics") return null;
  return json({ topics: await listTopics(env.DB) });
}

async function writeRoutes(request: Request, env: Env, session: Session, path: string): Promise<Response> {
  const cancelled = await cancelRoute(request, env, session, path);
  if (cancelled) return cancelled;
  const created = await createRoutes(request, env, path);
  if (created) return created;
  return recordRoutes(request, env, session, path);
}

async function cancelRoute(request: Request, env: Env, session: Session, path: string): Promise<Response | null> {
  return postRouteId(request, path, /^\/api\/admin\/wishes\/(\d+)\/cancel$/, (id) => cancelWish(env, session.email, id));
}

async function createRoutes(request: Request, env: Env, path: string): Promise<Response | null> {
  if (request.method !== "POST") return null;
  return createPost(request, env, path);
}

async function createPost(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/api/admin/topics") return createTopic(request, env);
  if (path === "/api/admin/new-items/send") return json({ sent: await sendNewItemsMail(env) });
  return createItemRoute(request, env, path);
}

async function createItemRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/admin/items") return null;
  return createItem(request, env);
}

async function recordRoutes(request: Request, env: Env, session: Session, path: string): Promise<Response> {
  return orElse(await topicRoute(request, env, path), () => itemRoutes(request, env, session, path));
}

async function topicRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  return routeId(path, /^\/api\/admin\/topics\/(\d+)$/, (id) => topicWrite(request, env, id));
}

async function topicWrite(request: Request, env: Env, id: number): Promise<Response | null> {
  if (request.method === "PATCH") return renameTopic(request, env, id);
  return deleteTopicRoute(request, env, id);
}

async function deleteTopicRoute(request: Request, env: Env, id: number): Promise<Response | null> {
  if (request.method !== "DELETE") return null;
  return deleteTopic(env, id);
}

async function itemRoutes(request: Request, env: Env, session: Session, path: string): Promise<Response> {
  return orElse(await oneItemRoute(request, env, path), () => photoOrAccept(request, env, session, path));
}

async function oneItemRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  return routeId(path, /^\/api\/admin\/items\/(\d+)$/, (id) => itemWrite(request, env, id));
}

async function itemWrite(request: Request, env: Env, id: number): Promise<Response | null> {
  if (request.method !== "PATCH") return null;
  return patchItem(env, id, asRecord(await readJson(request)));
}

async function photoOrAccept(request: Request, env: Env, session: Session, path: string): Promise<Response> {
  return orElse(await photoPost(request, env, path), () => acceptOrDelete(request, env, session, path));
}

async function photoPost(request: Request, env: Env, path: string): Promise<Response | null> {
  return postRouteId(request, path, /^\/api\/admin\/items\/(\d+)\/photos$/, (id) => uploadPhoto(request, env, id));
}

async function acceptOrDelete(request: Request, env: Env, session: Session, path: string): Promise<Response> {
  return orElse(await acceptRoute(request, env, session, path), () => statusOrDelete(request, env, path));
}

async function acceptRoute(request: Request, env: Env, session: Session, path: string): Promise<Response | null> {
  return postRouteId(request, path, /^\/api\/admin\/items\/(\d+)\/accept$/, (id) => acceptItem(request, env, session, id));
}

async function statusOrDelete(request: Request, env: Env, path: string): Promise<Response> {
  return orElse(await statusRoute(request, env, path), () => deletePhotoRoute(request, env, path));
}

async function statusRoute(request: Request, env: Env, path: string): Promise<Response | null> {
  return postRouteId(request, path, /^\/api\/admin\/items\/(\d+)\/status$/, (id) => setItemStatus(request, env, id));
}

async function deletePhotoRoute(request: Request, env: Env, path: string): Promise<Response> {
  const id = matchedId(path, /^\/api\/admin\/photos\/(\d+)$/);
  if (!id) return notFound();
  return deletePhotoPost(request, env, id);
}

async function deletePhotoPost(request: Request, env: Env, id: number): Promise<Response> {
  if (request.method !== "DELETE") return notFound();
  return deletePhoto(env, id);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function postRouteId(
  request: Request,
  path: string,
  pattern: RegExp,
  write: (id: number) => Promise<Response | null>,
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  return routeId(path, pattern, write);
}

async function routeId(path: string, pattern: RegExp, write: (id: number) => Promise<Response | null>): Promise<Response | null> {
  const id = matchedId(path, pattern);
  if (!id) return null;
  return write(id);
}

function written(result: D1Result): Response {
  if (result.meta.changes !== 1) return notFound();
  return json({ ok: true });
}

async function createTopic(request: Request, env: Env): Promise<Response> {
  const name = textField(asRecord(await readJson(request)).name, 200);
  if (!name) throw new HttpError(400, "A topic needs a name.");
  return insertTopic(env, name);
}

async function insertTopic(env: Env, name: string): Promise<Response> {
  const slug = await uniqueSlug(env.DB, name);
  const order = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM topics").first<{ next: number }>();
  const inserted = await env.DB.prepare("INSERT INTO topics (slug, name, sort_order) VALUES (?, ?, ?)").bind(slug, name, valueOr(order, 1, (row) => row.next)).run();
  return json({ id: inserted.meta.last_row_id, slug, name }, 201);
}

async function renameTopic(request: Request, env: Env, id: number): Promise<Response> {
  const name = textField(asRecord(await readJson(request)).name, 200);
  if (!name) throw new HttpError(400, "A topic needs a name.");
  return updateTopicName(env, id, name);
}

async function updateTopicName(env: Env, id: number, name: string): Promise<Response> {
  return written(await env.DB.prepare("UPDATE topics SET name = ? WHERE id = ?").bind(name, id).run());
}

async function deleteTopic(env: Env, id: number): Promise<Response> {
  if (await topicHasItems(env, id)) return json({ error: "That topic still has items." }, 409);
  return removeTopic(env, id);
}

async function topicHasItems(env: Env, id: number): Promise<boolean> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE topic_id = ?").bind(id).first<{ n: number }>();
  return valueOr(count, false, (row) => row.n > 0);
}

async function removeTopic(env: Env, id: number): Promise<Response> {
  return written(await env.DB.prepare("DELETE FROM topics WHERE id = ?").bind(id).run());
}

type ItemFields = { topicId: number; title: string; description: string; price: number | null };

async function createItem(request: Request, env: Env): Promise<Response> {
  const fields = itemFields(asRecord(await readJson(request)));
  if (!fields) throw new HttpError(400, "Check the item fields.");
  return insertItem(env, fields);
}

function itemFields(record: Record<string, unknown>): ItemFields | null {
  const topicId = numberField(record.topicId);
  if (!topicId) return null;
  return titledItem(record, topicId);
}

function titledItem(record: Record<string, unknown>, topicId: number): ItemFields | null {
  const title = textField(record.title, 200);
  if (!title) return null;
  return describedItem(record, topicId, title);
}

function describedItem(record: Record<string, unknown>, topicId: number, title: string): ItemFields | null {
  const description = descriptionField(record.description);
  if (description == null) return null;
  return pricedItem(record, topicId, title, description);
}

function pricedItem(
  record: Record<string, unknown>,
  topicId: number,
  title: string,
  description: string,
): ItemFields | null {
  const price = centsField(record.priceCents);
  if (price === "bad") return null;
  return { topicId, title, description, price };
}

async function insertItem(env: Env, fields: ItemFields): Promise<Response> {
  const topic = await env.DB.prepare("SELECT id FROM topics WHERE id = ?").bind(fields.topicId).first();
  if (!topic) return notFound();
  return storeItem(env, fields);
}

async function storeItem(env: Env, fields: ItemFields): Promise<Response> {
  const inserted = await env.DB.prepare(
    "INSERT INTO items (topic_id, title, description, price_cents, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
  )
    .bind(fields.topicId, fields.title, fields.description, fields.price, nowIso())
    .run();
  return json({ id: inserted.meta.last_row_id }, 201);
}

const DELIVERY_STATUSES = ["accepted", "staged", "delivered"];

function deliveryStatus(value: unknown): string {
  if (DELIVERY_STATUSES.includes(value as string)) return value as string;
  throw new HttpError(400, "Unknown status.");
}

async function setItemStatus(request: Request, env: Env, id: number): Promise<Response> {
  const status = deliveryStatus(asRecord(await readJson(request)).status);
  const row = await env.DB.prepare("SELECT id FROM items WHERE id = ?").bind(id).first();
  if (!row) return notFound();
  return writeItemStatus(env, id, status);
}

async function writeItemStatus(env: Env, id: number, status: string): Promise<Response> {
  const result = await env.DB.prepare(
    "UPDATE items SET status = ? WHERE id = ? AND status IN ('accepted', 'staged', 'delivered')",
  )
    .bind(status, id)
    .run();
  if (result.meta.changes !== 1) return json({ error: "That item has not been accepted." }, 409);
  return json({ ok: true, status });
}

async function acceptItem(request: Request, env: Env, session: Session, itemId: number): Promise<Response> {
  const wishId = numberField(asRecord(await readJson(request)).wishId);
  if (!wishId) throw new HttpError(400, "Say which wish to accept.");
  return finishAccept(env, session.email, itemId, wishId);
}

async function finishAccept(env: Env, email: string, itemId: number, wishId: number): Promise<Response> {
  const result = await acceptWish(env, email, itemId, wishId);
  if (!result.ok) return acceptFailure(result.status);
  return json({ ok: true, apologies: result.apologies, mail: mailPlace(env) });
}

// Says where the accept notes went, decided the same way sendMail decides.
function mailPlace(env: Env): "outbox" | "email" {
  if (isDev(env)) return "outbox";
  return "email";
}

function acceptFailure(status: 404 | 409): Response {
  if (status === 404) return notFound();
  return json({ error: "That wish can no longer be accepted." }, 409);
}

type PatchFields = { title: string; description: string; price: number | null; topicId: number };

async function patchItem(env: Env, id: number, record: Record<string, unknown>): Promise<Response> {
  const current = await loadItem(env.DB, id);
  if (!current) return notFound();
  return patchOpen(env, current, record);
}

async function patchOpen(env: Env, current: ItemRecord, record: Record<string, unknown>): Promise<Response> {
  const fields = patchFields(current, record);
  if (!fields) throw new HttpError(400, "Check the item fields.");
  return savePatch(env, current.id, fields);
}

function patchFields(current: ItemRecord, record: Record<string, unknown>): PatchFields | null {
  const title = nextTitle(current, record);
  if (!title) return null;
  return patchDescription(current, record, title);
}

function nextTitle(current: ItemRecord, record: Record<string, unknown>): string | null {
  if (record.title == null) return current.title;
  return textField(record.title, 200);
}

function patchDescription(current: ItemRecord, record: Record<string, unknown>, title: string): PatchFields | null {
  const description = nextDescription(current, record);
  if (description == null) return null;
  return patchPrice(current, record, title, description);
}

function nextDescription(current: ItemRecord, record: Record<string, unknown>): string | null {
  if (record.description == null) return current.description;
  return descriptionField(record.description);
}

function patchPrice(current: ItemRecord, record: Record<string, unknown>, title: string, description: string): PatchFields | null {
  const price = nextPrice(current, record);
  if (price === "bad") return null;
  return patchTopic(current, record, title, description, price);
}

function nextPrice(current: ItemRecord, record: Record<string, unknown>): number | null | "bad" {
  if (!Object.prototype.hasOwnProperty.call(record, "priceCents")) return current.priceCents;
  return centsField(record.priceCents);
}

function patchTopic(
  current: ItemRecord,
  record: Record<string, unknown>,
  title: string,
  description: string,
  price: number | null,
): PatchFields | null {
  const topicId = nextTopic(current, record);
  if (!topicId) return null;
  return { title, description, price, topicId };
}

function nextTopic(current: ItemRecord, record: Record<string, unknown>): number | null {
  if (record.topicId == null) return current.topicId;
  return numberField(record.topicId);
}

async function savePatch(env: Env, id: number, fields: PatchFields): Promise<Response> {
  const topic = await env.DB.prepare("SELECT id FROM topics WHERE id = ?").bind(fields.topicId).first();
  if (!topic) return notFound();
  return writePatch(env, id, fields);
}

async function writePatch(env: Env, id: number, fields: PatchFields): Promise<Response> {
  await env.DB.prepare("UPDATE items SET topic_id = ?, title = ?, description = ?, price_cents = ? WHERE id = ?")
    .bind(fields.topicId, fields.title, fields.description, fields.price, id)
    .run();
  return json({ ok: true });
}

async function uploadPhoto(request: Request, env: Env, itemId: number): Promise<Response> {
  if (tooLong(request)) return json({ error: "Photo is too large." }, 413);
  return uploadBody(request, env, itemId);
}

function tooLong(request: Request): boolean {
  return headerLength(request) > MAX_PHOTO_BYTES;
}

function headerLength(request: Request): number {
  return Number(request.headers.get("content-length"));
}

async function uploadBody(request: Request, env: Env, itemId: number): Promise<Response> {
  const item = await loadItem(env.DB, itemId);
  if (!item) return notFound();
  return uploadFile(request, env, item.id);
}

async function uploadFile(request: Request, env: Env, itemId: number): Promise<Response> {
  const form = await request.formData();
  const file = form.get("photo");
  if (!(file instanceof File)) throw new HttpError(400, "Choose a photo.");
  return storePhoto(env, itemId, file);
}

async function storePhoto(env: Env, itemId: number, file: File): Promise<Response> {
  if (file.size > MAX_PHOTO_BYTES) return json({ error: "Photo is too large." }, 413);
  return storeTyped(env, itemId, file);
}

async function storeTyped(env: Env, itemId: number, file: File): Promise<Response> {
  const type = imageType(file);
  if (!type) throw new HttpError(400, "Use a JPEG, PNG, or WebP.");
  return putPhoto(env, itemId, file, type);
}

function imageType(file: File): string | null {
  const type = fileType(file);
  if (allowedImage(type)) return type;
  return null;
}

function fileType(file: File): string {
  if (file.type) return file.type;
  return "image/jpeg";
}

const PHOTO_TYPES: Record<string, true> = { "image/jpeg": true, "image/png": true, "image/webp": true };

function allowedImage(type: string): boolean {
  return PHOTO_TYPES[type] === true;
}

async function putPhoto(env: Env, itemId: number, file: File, type: string): Promise<Response> {
  const key = `photos/${itemId}/${crypto.randomUUID()}`;
  await env.PHOTOS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: type } });
  const inserted = await env.DB.prepare("INSERT INTO photos (item_id, r2_key, sort_order) VALUES (?, ?, 0)").bind(itemId, key).run();
  const id = inserted.meta.last_row_id;
  return json({ id, url: `/photo/${id}` }, 201);
}

async function deletePhoto(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare("SELECT r2_key FROM photos WHERE id = ?").bind(id).first<{ r2_key: string }>();
  if (!row) return notFound();
  await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
  await env.PHOTOS.delete(row.r2_key);
  return json({ ok: true });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function numberField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}
