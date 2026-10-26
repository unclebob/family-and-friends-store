import { HttpError, json } from "./http";
import { timestampCT } from "./time";

export type WishRow = {
  id: number;
  name: string;
  email: string;
  itemId: number;
  itemTitle: string;
  itemStatus: string;
  topicName: string;
  status: string;
  cancelledBy: string | null;
  kind: string;
  createdAt: string;
  acceptedAt: string | null;
};

type StoredRow = {
  id: number;
  name: string;
  email: string;
  item_id: number;
  title: string;
  item_status: string;
  topic_name: string;
  status: string;
  cancelled_by: string | null;
  kind: string;
  created_at: string;
  accepted_at: string | null;
};

const STATUSES = ["active", "accepted", "staged", "delivered", "declined", "withdrawn"];
const WISH_STATUS = "CASE WHEN w.status = 'accepted' AND i.status IN ('staged', 'delivered') THEN i.status ELSE w.status END";
// Column names are fixed here, never taken from the request.
const ORDERS: Record<string, string> = {
  created: "w.created_at DESC, w.id DESC",
  wisher: "w.name, w.created_at DESC, w.id DESC",
  item: "i.title, w.created_at DESC, w.id DESC",
  status: `${WISH_STATUS}, w.created_at DESC, w.id DESC`,
};

export async function wishesGet(env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/admin/wishes") return json({ wishes: await listWishes(env.DB, url) });
  if (url.pathname === "/api/admin/wishes.csv") return csvResponse(await listWishes(env.DB, url));
  return null;
}

async function listWishes(db: D1Database, url: URL): Promise<WishRow[]> {
  const status = statusFilter(url.searchParams.get("status"));
  const order = sortOrder(url.searchParams.get("sort"));
  const result = await db
    .prepare(
      `SELECT w.id, w.name, w.email, w.item_id, i.title, i.status AS item_status, t.name AS topic_name,
              ${WISH_STATUS} AS status, w.cancelled_by, w.kind, w.created_at,
              CASE WHEN w.status = 'accepted' THEN i.accepted_at END AS accepted_at
       FROM wishes w JOIN items i ON i.id = w.item_id JOIN topics t ON t.id = i.topic_id
       WHERE ? = '' OR ${WISH_STATUS} = ?
       ORDER BY ${order}`,
    )
    .bind(status, status)
    .all<StoredRow>();
  return result.results.map(wishRow);
}

function statusFilter(value: string | null): string {
  if (!value) return "";
  if (STATUSES.includes(value)) return value;
  throw new HttpError(400, "Unknown status.");
}

function sortOrder(value: string | null): string {
  const order = ORDERS[value || "created"];
  if (order) return order;
  throw new HttpError(400, "Unknown sort.");
}

function wishRow(row: StoredRow): WishRow {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    itemId: row.item_id,
    itemTitle: row.title,
    itemStatus: row.item_status,
    topicName: row.topic_name,
    status: row.status,
    cancelledBy: row.cancelled_by,
    kind: row.kind,
    createdAt: centralTime(row.created_at),
    acceptedAt: row.accepted_at ? centralTime(row.accepted_at) : null,
  };
}

// A withdrawn wish an admin cancelled reads differently from one the wisher withdrew.
export function statusLabel(status: string, cancelledBy: string | null): string {
  if (cancelledBy) return "cancelled by admins";
  return status;
}

function centralTime(iso: string): string {
  return timestampCT(Date.parse(iso));
}

function csvResponse(rows: WishRow[]): Response {
  const lines = [["wisher", "email", "item", "topic", "status", "kind", "created_ct", "accepted_ct"].join(",")];
  for (const row of rows) {
    lines.push([row.name, row.email, row.itemTitle, row.topicName, statusLabel(row.status, row.cancelledBy), row.kind, row.createdAt, row.acceptedAt].map(csvField).join(","));
  }
  return new Response(lines.map((line) => `${line}\r\n`).join(""), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="wishes.csv"' },
  });
}

// Quotes a field only when it needs it, and stops a spreadsheet from reading
// a leading = + - @ as a formula.
export function csvField(value: string | null): string {
  const text = defused(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function defused(text: string): string {
  if (/^[=+\-@]/.test(text)) return `'${text}`;
  return text;
}
