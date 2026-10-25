import { statusLabel } from "./all-wishes";
import { DOMAIN } from "./hosts";
import { sendToEach } from "./fanout";
import { sendMail } from "./mail";
import { nowIso, timestampCT } from "./time";

export type CtDay = { label: string; fromIso: string; toIso: string };
type ReportRow = { item_id: number; name: string; email: string; title: string; topic_name: string; status: string; cancelled_by: string | null; kind: string };

const HOUR_MS = 60 * 60 * 1000;

// The Central calendar day before `now`, as a UTC half-open range.
export function previousCtDay(now: number): CtDay {
  const today = timestampCT(now).slice(0, 10);
  const label = dayBefore(today);
  return { label, fromIso: nowIso(ctMidnight(label)), toIso: nowIso(ctMidnight(today)) };
}

function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 24 * HOUR_MS).toISOString().slice(0, 10);
}

// Central midnight is 05:00 UTC in summer time and 06:00 UTC in winter time.
function ctMidnight(day: string): number {
  const summer = Date.parse(`${day}T05:00:00Z`);
  if (timestampCT(summer).endsWith("T00:00:00")) return summer;
  return summer + HOUR_MS;
}

export function reportRecipients(setting: string | undefined): string[] {
  return (setting ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
}

export async function sendWishReport(env: Env, now = Date.now()): Promise<number> {
  const day = previousCtDay(now);
  const rows = await wishesIn(env.DB, day);
  if (rows.length === 0) return 0;
  const subject = `${countText(rows.length)} on ${day.label}`;
  const text = reportText(day.label, rows);
  await sendToEach(`Wish report for ${day.label}`, reportRecipients(env.REPORT_TO), (recipient) =>
    sendMail(env, recipient, "wish-report", subject, text, nowIso(now)),
  );
  return rows.length;
}

async function wishesIn(db: D1Database, day: CtDay): Promise<ReportRow[]> {
  const result = await db
    .prepare(
      `SELECT w.item_id, w.name, w.email, i.title, t.name AS topic_name, w.status, w.cancelled_by, w.kind
       FROM wishes w JOIN items i ON i.id = w.item_id JOIN topics t ON t.id = i.topic_id
       WHERE w.created_at >= ? AND w.created_at < ?
       ORDER BY w.created_at, w.id`,
    )
    .bind(day.fromIso, day.toIso)
    .all<ReportRow>();
  return result.results;
}

function countText(count: number): string {
  return `${count} new ${wishWord(count)}`;
}

function wishWord(count: number): string {
  return count === 1 ? "wish" : "wishes";
}

function reportText(label: string, rows: ReportRow[]): string {
  const entries = rows.map(
    (row) =>
      `${row.name} <${row.email}> wants ${row.title} (${row.topic_name}), ${statusLabel(row.status, row.cancelled_by)}, ${row.kind}\n` +
      `https://family.${DOMAIN}/admin#item-${row.item_id}`,
  );
  return [`New wishes on ${label} (Central time):`, "", entries.join("\n\n")].join("\n");
}
