import { isDev } from "./env-name";
import { json, notFound } from "./http";
import { cancelledText, sendLetter } from "./mail";
import { nowIso } from "./time";

type WishRow = { status: string; cancelled_by: string | null; email: string; title: string };

// An admin cancels an active wish on an open item. The wish becomes 'withdrawn'
// with cancelled_by set, and the wisher gets a short note. Cancelling it again is a no-op.
export async function cancelWish(env: Env, adminEmail: string, wishId: number, now = Date.now()): Promise<Response> {
  const wish = await loadWish(env.DB, wishId);
  if (!wish) return notFound();
  if (wish.cancelled_by) return json({ ok: true, already: true });
  return cancelLoaded(env, adminEmail, wishId, wish, nowIso(now));
}

async function loadWish(db: D1Database, id: number): Promise<WishRow | null> {
  return db
    .prepare("SELECT w.status, w.cancelled_by, w.email, i.title FROM wishes w JOIN items i ON i.id = w.item_id WHERE w.id = ?")
    .bind(id)
    .first<WishRow>();
}

async function cancelLoaded(env: Env, adminEmail: string, wishId: number, wish: WishRow, stamp: string): Promise<Response> {
  // The status checks live in the UPDATE so a wish that changed meanwhile is left alone.
  const result = await env.DB.prepare(
    `UPDATE wishes SET status = 'withdrawn', cancelled_by = ?, updated_at = ?
     WHERE id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM items WHERE id = wishes.item_id AND status = 'open')`,
  )
    .bind(adminEmail, stamp, wishId)
    .run();
  if (result.meta.changes !== 1) return json({ error: "That wish can no longer be cancelled." }, 409);
  await mailSafely(env, wish, stamp);
  return json({ ok: true, mail: isDev(env) ? "outbox" : "email" });
}

async function mailSafely(env: Env, wish: WishRow, stamp: string): Promise<void> {
  const letter = { subject: `About your wish: ${wish.title}`, text: cancelledText(wish.title), replyTo: env.FAMILY_REPLY_TO };
  try {
    await sendLetter(env, wish.email, "wish-cancelled", letter, stamp);
  } catch (error) {
    console.error("cancel mail failed", error);
  }
}
