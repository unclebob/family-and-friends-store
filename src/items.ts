import type { ItemStatus, WishKind, WishStatus } from "./serializer";

export type StoredWish = {
  id: number;
  email: string;
  name: string;
  grp: string;
  status: WishStatus;
  kind: WishKind;
};

export type ItemRecord = {
  id: number;
  topicId: number;
  topicSlug: string;
  topicName: string;
  title: string;
  description: string;
  priceCents: number | null;
  status: ItemStatus;
  assignedTo: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  photos: { id: number }[];
  wishes: StoredWish[];
};

export type TopicRecord = {
  id: number;
  slug: string;
  name: string;
  sort_order: number;
};

type ItemSql = {
  id: number;
  topic_id: number;
  title: string;
  description: string;
  price_cents: number | null;
  status: string;
  assigned_to: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  slug: string;
  topic_name: string;
};

const SELECT = `
SELECT i.id, i.topic_id, i.title, i.description, i.price_cents, i.status,
       i.assigned_to, i.accepted_by, i.accepted_at, t.slug AS slug, t.name AS topic_name
FROM items i
JOIN topics t ON t.id = i.topic_id
`;

const ITEM_STATUSES: Record<string, ItemStatus> = {
  open: "open",
  accepted: "accepted",
  staged: "staged",
  delivered: "delivered",
};

function asStatus(value: string): ItemStatus {
  return ITEM_STATUSES[value] ?? "open";
}

const WISH_STATUSES: string[] = ["active", "withdrawn", "accepted", "declined"];

function asWishStatus(value: string): WishStatus | null {
  if (WISH_STATUSES.includes(value)) return value as WishStatus;
  return null;
}

function asKind(value: string): WishKind {
  return value === "someday" ? "someday" : "now";
}

function itemFrom(row: ItemSql): ItemRecord {
  return {
    id: row.id,
    topicId: row.topic_id,
    topicSlug: row.slug,
    topicName: row.topic_name,
    title: row.title,
    description: row.description,
    priceCents: row.price_cents,
    status: asStatus(row.status),
    assignedTo: row.assigned_to,
    acceptedBy: row.accepted_by,
    acceptedAt: row.accepted_at,
    photos: [],
    wishes: [],
  };
}

async function hydrate(db: D1Database, rows: ItemSql[]): Promise<ItemRecord[]> {
  const items = rows.map(itemFrom);
  if (items.length === 0) return items;
  await attachChildren(db, items);
  return items;
}

async function attachChildren(db: D1Database, items: ItemRecord[]): Promise<void> {
  const ids = items.map((item) => item.id);
  const marks = ids.map(() => "?").join(", ");
  const photos = await db
    .prepare(`SELECT id, item_id FROM photos WHERE item_id IN (${marks}) ORDER BY sort_order, id`)
    .bind(...ids)
    .all<{ id: number; item_id: number }>();
  const wishes = await db
    .prepare("SELECT id, item_id, email, name, grp, status, kind FROM wishes WHERE item_id IN (" + marks + ") ORDER BY id")
    .bind(...ids)
    .all<{ id: number; item_id: number; email: string; name: string; grp: string; status: string; kind: string }>();
  const byId = new Map(items.map((item) => [item.id, item]));
  attachPhotos(byId, photos.results);
  attachWishes(byId, wishes.results);
}

function attachPhotos(byId: Map<number, ItemRecord>, photos: { id: number; item_id: number }[]): void {
  for (const photo of photos) pushPhoto(byId, photo);
}

function pushPhoto(byId: Map<number, ItemRecord>, photo: { id: number; item_id: number }): void {
  const item = byId.get(photo.item_id);
  if (!item) return;
  item.photos.push({ id: photo.id });
}

function attachWishes(
  byId: Map<number, ItemRecord>,
  wishes: { id: number; item_id: number; email: string; name: string; grp: string; status: string; kind: string }[],
): void {
  for (const wish of wishes) pushWish(byId, wish);
}

function pushWish(
  byId: Map<number, ItemRecord>,
  wish: { id: number; item_id: number; email: string; name: string; grp: string; status: string; kind: string },
): void {
  const status = asWishStatus(wish.status);
  if (!status) return;
  pushNamedWish(byId, wish, status);
}

function pushNamedWish(
  byId: Map<number, ItemRecord>,
  wish: { id: number; item_id: number; email: string; name: string; grp: string; kind: string },
  status: WishStatus,
): void {
  const item = byId.get(wish.item_id);
  if (!item) return;
  item.wishes.push({ id: wish.id, email: wish.email, name: wish.name, grp: wish.grp, status, kind: asKind(wish.kind) });
}

async function allRows<T>(db: D1Database, sql: string, binds: unknown[] = []): Promise<T[]> {
  const statement = binds.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...binds);
  const result = await statement.all<T>();
  return result.results;
}

export async function loadItem(db: D1Database, id: number): Promise<ItemRecord | null> {
  const row = await db.prepare(`${SELECT} WHERE i.id = ?`).bind(id).first<ItemSql>();
  if (!row) return null;
  const [item] = await hydrate(db, [row]);
  return item;
}

export async function loadOpenItems(db: D1Database, slug?: string): Promise<ItemRecord[]> {
  if (slug) return openInTopic(db, slug);
  return openItems(db);
}

async function openInTopic(db: D1Database, slug: string): Promise<ItemRecord[]> {
  return hydrate(db, await allRows<ItemSql>(db, `${SELECT} WHERE i.status = 'open' AND t.slug = ? ORDER BY i.id`, [slug]));
}

async function openItems(db: D1Database): Promise<ItemRecord[]> {
  return hydrate(db, await allRows<ItemSql>(db, `${SELECT} WHERE i.status = 'open' ORDER BY t.sort_order, i.id`));
}

export async function loadAdminItems(db: D1Database, slug?: string): Promise<ItemRecord[]> {
  if (slug) return hydrate(db, await allRows<ItemSql>(db, `${SELECT} WHERE t.slug = ? ORDER BY i.id`, [slug]));
  return hydrate(db, await allRows<ItemSql>(db, `${SELECT} ORDER BY t.sort_order, i.id`));
}

export async function listTopics(db: D1Database): Promise<TopicRecord[]> {
  return allRows<TopicRecord>(db, "SELECT id, slug, name, sort_order FROM topics ORDER BY sort_order, name");
}

export async function topicBySlug(db: D1Database, slug: string): Promise<TopicRecord | null> {
  return db.prepare("SELECT id, slug, name, sort_order FROM topics WHERE slug = ?").bind(slug).first<TopicRecord>();
}
