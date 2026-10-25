import { loadItem } from "./items";
import type { WishKind } from "./serializer";
import { nowIso } from "./time";

export type WishResult = { status: number; wished?: boolean; kind?: WishKind };
import { canSeeTopic, type Session } from "./visibility";

export async function setWish(
  db: D1Database,
  session: Session,
  itemId: number,
  wished: boolean,
  now = Date.now(),
  kind: WishKind = "now",
): Promise<WishResult> {
  const item = await loadItem(db, itemId);
  if (!visibleOpen(session, item)) return { status: 404 };
  if (wished) return activateWish(db, session, itemId, nowIso(now), kind);
  return withdrawWish(db, item, session.email, nowIso(now));
}

function visibleOpen(session: Session, item: Awaited<ReturnType<typeof loadItem>>): item is NonNullable<typeof item> {
  if (!item) return false;
  return openTopic(session, item);
}

function openTopic(session: Session, item: NonNullable<Awaited<ReturnType<typeof loadItem>>>): boolean {
  if (item.status !== "open") return false;
  return canSeeTopic(session, item.topicSlug);
}

async function activateWish(
  db: D1Database,
  session: Session,
  itemId: number,
  stamp: string,
  kind: WishKind,
): Promise<WishResult> {
  const result = await db
    .prepare(
      `INSERT INTO wishes (item_id, email, name, grp, status, updated_at, created_at, kind)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT(item_id, email) DO UPDATE SET
         created_at = CASE WHEN wishes.status = 'withdrawn' THEN excluded.created_at ELSE wishes.created_at END,
         status = 'active',
         kind = excluded.kind,
         name = excluded.name,
         grp = excluded.grp,
         updated_at = excluded.updated_at,
         cancelled_by = NULL
       WHERE wishes.status != 'accepted'`,
    )
    .bind(itemId, session.email, session.name, session.group, stamp, stamp, kind)
    .run();
  if (result.meta.changes !== 1) return { status: 409 };
  return { status: 200, wished: true, kind };
}

async function withdrawWish(
  db: D1Database,
  item: NonNullable<Awaited<ReturnType<typeof loadItem>>>,
  email: string,
  stamp: string,
): Promise<WishResult> {
  await db
    .prepare(
      `UPDATE wishes SET status = 'withdrawn', updated_at = ?
       WHERE item_id = ? AND email = ? AND status = 'active'
         AND EXISTS (SELECT 1 FROM items WHERE id = ? AND status = 'open')`,
    )
    .bind(stamp, item.id, email, item.id)
    .run();
  return { status: 200, wished: false };
}
