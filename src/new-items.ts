import { FIRST_ADMIN } from "./dev-fixture";
import { sendToEach } from "./fanout";
import { DOMAIN } from "./hosts";
import { sendLetter, type Letter } from "./mail";
import { signedPhotoUrl } from "./photo-link";
import { nowIso } from "./time";
import { previousCtDay, reportRecipients } from "./wish-report";

type Candidate = { id: number; title: string; description: string; status: string; topic_name: string; photo_id: number | null };
type Entry = Candidate & { photoUrl: string | null };

const SHORT = 200;

// Tells family about items added before today (Central time) that they have
// not been told about yet. Anything not sent stays queued for the next run.
export async function sendNewItemsMail(env: Env, now = Date.now()): Promise<number> {
  const day = previousCtDay(now);
  const candidates = await unannounced(env.DB, day.toIso);
  if (candidates.length === 0) return 0;
  const open = candidates.filter((item) => item.status === "open");
  if (open.length > 0) await mailFamily(env, day.label, await withPhotos(env, open, now), now);
  await markAnnounced(env.DB, candidates, nowIso(now));
  return open.length;
}

async function unannounced(db: D1Database, before: string): Promise<Candidate[]> {
  const result = await db
    .prepare(
      `SELECT i.id, i.title, i.description, i.status, t.name AS topic_name,
              (SELECT p.id FROM photos p WHERE p.item_id = i.id ORDER BY p.sort_order, p.id LIMIT 1) AS photo_id
       FROM items i JOIN topics t ON t.id = i.topic_id
       WHERE i.announced_at IS NULL AND i.created_at < ?
       ORDER BY i.created_at, i.id`,
    )
    .bind(before)
    .all<Candidate>();
  return result.results;
}

async function withPhotos(env: Env, items: Candidate[], now: number): Promise<Entry[]> {
  return Promise.all(items.map(async (item) => ({ ...item, photoUrl: await photoFor(env, item.photo_id, now) })));
}

async function photoFor(env: Env, photoId: number | null, now: number): Promise<string | null> {
  if (photoId == null) return null;
  return signedPhotoUrl(env, photoId, now);
}

async function mailFamily(env: Env, label: string, items: Entry[], now: number): Promise<void> {
  const family = await env.MERIT.getByName("merit").familyList();
  const tag = `New-items mail for ${label}`;
  if (!family.ok) throw new Error(`${tag} waits: Merit is unavailable.`);
  const letter = newItemsLetter(items, env.FAMILY_REPLY_TO);
  const recipients = uniqueAddresses([...family.family, ...reportRecipients(env.REPORT_TO)]);
  await sendToEach(tag, recipients, (recipient) => sendLetter(env, recipient, "new-items", letter, nowIso(now)));
}

// Family from Merit, then the admins from REPORT_TO (the wish report's list).
// Someone on both gets one copy; the first spelling of an address is kept.
export function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.filter((address) => firstSighting(seen, address.toLowerCase()));
}

function firstSighting(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

async function markAnnounced(db: D1Database, items: Candidate[], stamp: string): Promise<void> {
  await db.batch(items.map((item) => db.prepare("UPDATE items SET announced_at = ? WHERE id = ?").bind(stamp, item.id)));
}

// Family never sees prices, so this letter is built without them.
export function newItemsLetter(items: Entry[], replyTo: string): Letter {
  const subject = `New on the family site: ${items.length} ${items.length === 1 ? "item" : "items"}`;
  return { subject, text: letterText(items), html: letterHtml(items), replyTo };
}

const CLOSING = `If you'd rather not get these, reply to this email and let ${FIRST_ADMIN.shortName} know.`;

function letterText(items: Entry[]): string {
  const blocks = items.map((item) => [`${item.title} (${item.topic_name})`, ...shortLines(item.description), itemLink(item.id)].join("\n"));
  return ["New on the family site:", "", blocks.join("\n\n"), "", CLOSING].join("\n");
}

function shortLines(description: string): string[] {
  const short = shortened(description);
  return short ? [short] : [];
}

export function shortened(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (text.length <= SHORT) return text;
  const cut = text.slice(0, SHORT);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

function itemLink(id: number): string {
  return `https://family.${DOMAIN}/#item-${id}`;
}

function letterHtml(items: Entry[]): string {
  const blocks = items.map(itemHtml).join("\n");
  return `<!doctype html><html><body style="font-family:sans-serif">\n<h1>New on the family site</h1>\n${blocks}\n<p>${escapeHtml(CLOSING)}</p>\n</body></html>`;
}

function itemHtml(item: Entry): string {
  const link = escapeHtml(itemLink(item.id));
  const photo = item.photoUrl ? `<p><a href="${link}"><img src="${escapeHtml(item.photoUrl)}" alt="" width="300"></a></p>` : "";
  const short = shortened(item.description);
  const description = short ? `<p>${escapeHtml(short)}</p>` : "";
  return `<h2><a href="${link}">${escapeHtml(item.title)}</a></h2>\n<p>${escapeHtml(item.topic_name)}</p>\n${photo}${description}`;
}

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
