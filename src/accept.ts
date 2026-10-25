import { loadItem, type ItemRecord, type StoredWish } from "./items";
import type { AcceptLog } from "./log";
import { apologyText, sendMail, winnerText } from "./mail";
import { nowIso, timestampCT } from "./time";
import { isGroup, type Group } from "./visibility";

type QueuedLog = { id: number; payload: string; created_at: string };

// Sends queued accept-log lines to Merit in order. An unreadable line is logged and dropped so it
// cannot hold up the ones behind it; a line Merit does not acknowledge stops the run for a retry.
export async function flushMeritLog(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id, payload, created_at FROM pending_merit_log WHERE acked = 0 ORDER BY id",
  ).all<QueuedLog>();
  let delivered = 0;
  for (const row of rows.results) {
    const payload = readQueued(row);
    if (!payload) {
      await skipQueued(env, row);
      continue;
    }
    if (!(await deliver(env, row, payload))) break;
    delivered += 1;
  }
  return delivered;
}

function readQueued(row: QueuedLog): AcceptLog | null {
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === "object") return parsed as AcceptLog;
    return null;
  } catch {
    return null;
  }
}

async function skipQueued(env: Env, row: QueuedLog): Promise<void> {
  console.error(
    `Skipping unreadable pending_merit_log id ${row.id} queued ${row.created_at}: ${row.payload.slice(0, 200)}`,
  );
  await env.DB.prepare("DELETE FROM pending_merit_log WHERE id = ?").bind(row.id).run();
}

async function deliver(env: Env, row: QueuedLog, payload: AcceptLog): Promise<boolean> {
  const result = await env.MERIT.getByName("merit").logAccept(payload);
  if (!result.ok) return false;
  await env.DB.prepare("UPDATE pending_merit_log SET acked = 1 WHERE id = ? AND acked = 0").bind(row.id).run();
  return true;
}

type AcceptResult = { ok: true; apologies: number } | { ok: false; status: 404 | 409 };

export async function acceptWish(
  env: Env,
  adminEmail: string,
  itemId: number,
  wishId: number,
  now = Date.now(),
): Promise<AcceptResult> {
  const item = await loadItem(env.DB, itemId);
  if (!item) return { ok: false, status: 404 };
  return acceptKept(env, adminEmail, item, wishId, now);
}

async function acceptKept(
  env: Env,
  adminEmail: string,
  item: ItemRecord,
  wishId: number,
  now: number,
): Promise<AcceptResult> {
  const wish = item.wishes.find((candidate) => candidate.id === wishId);
  if (!wish) return { ok: false, status: 404 };
  return commitAccept(env, adminEmail, item, wish, now);
}

async function commitAccept(
  env: Env,
  adminEmail: string,
  item: ItemRecord,
  wish: StoredWish,
  now: number,
): Promise<AcceptResult> {
  const stamp = nowIso(now);
  // The item update only applies to an open item and an active wish, so this one check covers both.
  const [itemUpdate, , remaining] = await env.DB.batch(acceptStatements(env, adminEmail, item, wish, stamp));
  if (itemUpdate.meta.changes !== 1) return { ok: false, status: 409 };
  const others = remaining.results as { email: string; name: string; grp: string }[];
  await writeAcceptLog(env, adminEmail, item, wish, stamp, now);
  await flushMeritLog(env);
  await sendAcceptMailSafely(env, item, wish, others, stamp);
  return { ok: true, apologies: others.length };
}

function acceptStatements(env: Env, adminEmail: string, item: ItemRecord, wish: StoredWish, stamp: string) {
  return [
    env.DB.prepare(
      `UPDATE items SET status = 'accepted', assigned_to = ?, accepted_by = ?, accepted_at = ?
       WHERE id = ? AND status = 'open' AND EXISTS (
         SELECT 1 FROM wishes WHERE id = ? AND item_id = ? AND status = 'active'
       )`,
    ).bind(wish.email, adminEmail, stamp, item.id, wish.id, item.id),
    env.DB.prepare(
      `UPDATE wishes SET status = 'accepted', updated_at = ?
       WHERE id = ? AND status = 'active' AND EXISTS (
         SELECT 1 FROM items WHERE id = ? AND status = 'accepted' AND assigned_to = ?
       )`,
    ).bind(stamp, wish.id, item.id, wish.email),
    env.DB.prepare("SELECT email, name, grp FROM wishes WHERE item_id = ? AND status = 'active'").bind(item.id),
  ];
}

async function sendAcceptMail(
  env: Env,
  item: ItemRecord,
  wish: StoredWish,
  others: { email: string }[],
  stamp: string,
): Promise<void> {
  const group = winnerGroup(wish.grp);
  const photoUrl = firstPhoto(item);
  const winnerBody = winnerText({ title: item.title, priceCents: item.priceCents }, group);
  const apologyBody = apologyText({ title: item.title, photoUrl });
  await sendMail(env, wish.email, "its-yours", `It's yours: ${item.title}`, winnerBody, stamp);
  await sendApologies(env, item.title, others, apologyBody, stamp);
}

async function sendApologies(
  env: Env,
  title: string,
  others: { email: string }[],
  apologyBody: string,
  stamp: string,
): Promise<void> {
  for (const other of others) await sendMail(env, other.email, "apology", `About ${title}`, apologyBody, stamp);
}

function firstPhoto(item: ItemRecord): string | null {
  const photo = item.photos[0];
  if (!photo) return null;
  return `/photo/${photo.id}`;
}

function winnerGroup(grp: string): Group {
  if (isGroup(grp)) return grp;
  return "family";
}

async function writeAcceptLog(
  env: Env,
  adminEmail: string,
  item: ItemRecord,
  wish: StoredWish,
  stamp: string,
  now: number,
): Promise<void> {
  const inserted = await env.DB.prepare(
    "INSERT INTO pending_merit_log (payload, created_at, acked) VALUES ('{}', ?, 0)",
  )
    .bind(stamp)
    .run();
  const payload: AcceptLog = {
    log_id: inserted.meta.last_row_id,
    timestamp_ct: timestampCT(now),
    item_id: item.id,
    title: item.title,
    topic: item.topicSlug,
    winner_email: wish.email,
    winner_name: wish.name,
    winner_group: winnerGroup(wish.grp),
    accepted_by: adminEmail,
    winner_wish: wish.kind,
  };
  await env.DB.prepare("UPDATE pending_merit_log SET payload = ? WHERE id = ?")
    .bind(JSON.stringify(payload), payload.log_id)
    .run();
}

async function sendAcceptMailSafely(
  env: Env,
  item: ItemRecord,
  wish: StoredWish,
  others: Parameters<typeof sendAcceptMail>[3],
  stamp: string,
): Promise<void> {
  try {
    await sendAcceptMail(env, item, wish, others, stamp);
  } catch (error) {
    console.error("accept mail failed", item.id, error);
  }
}
