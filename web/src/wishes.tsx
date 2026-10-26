import { useEffect, useState } from "preact/hooks";
import { api, listOrEmpty } from "./api";
import { Note } from "./note";
import { StatusButtons } from "./status-buttons";
import { acceptWish, cancelWish } from "./wish-actions";

type WishRow = {
  id: number;
  name: string;
  email: string;
  itemId: number;
  itemTitle: string;
  itemStatus?: string;
  topicName: string;
  status: string;
  cancelledBy?: string | null;
  kind: string;
  createdAt: string;
  acceptedAt: string | null;
};

const STATUSES = [["", "All"], ["active", "Active"], ["accepted", "Accepted"], ["staged", "Staged"], ["delivered", "Delivered"], ["declined", "Declined"], ["withdrawn", "Withdrawn"]];
const SORTS = [["created", "Newest"], ["wisher", "Wisher"], ["item", "Item"], ["status", "Status"]];

export function AllWishes() {
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("created");
  const [wishes, setWishes] = useState<WishRow[] | null>(null);
  const [message, setMessage] = useState("");
  const query = `?status=${encodeURIComponent(status)}&sort=${encodeURIComponent(sort)}`;
  useEffect(() => {
    void loadWishes(query, setWishes);
  }, [query]);
  return (
    <section>
      <h2>All wishes</h2>
      <p className="tabs">
        <Choice label="Status" value={status} choices={STATUSES} onChange={setStatus} />
        <Choice label="Sort by" value={sort} choices={SORTS} onChange={setSort} />
        <a href={`/api/admin/wishes.csv${query}`} download="wishes.csv">Download CSV</a>
      </p>
      <Note text={message} className="note" />
      <WishTable wishes={wishes} say={setMessage} reload={() => loadWishes(query, setWishes)} />
    </section>
  );
}

async function loadWishes(query: string, setWishes: (wishes: WishRow[]) => void): Promise<void> {
  const result = await api<{ wishes?: WishRow[] }>(`/api/admin/wishes${query}`);
  setWishes(listOrEmpty(result.body.wishes));
}

function Choice({ label, value, choices, onChange }: {
  label: string;
  value: string;
  choices: string[][];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {choices.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
    </label>
  );
}

function WishTable({ wishes, say, reload }: { wishes: WishRow[] | null; say: (message: string) => void; reload: () => Promise<void> }) {
  if (wishes == null) return <p>Loading…</p>;
  if (wishes.length === 0) return <p className="muted">No wishes match.</p>;
  return (
    <table>
      <thead>
        <tr><th>Wisher</th><th>Email</th><th>Item</th><th>Topic</th><th>Status</th><th>Kind</th><th>Wished (CT)</th><th>Accepted (CT)</th><th></th></tr>
      </thead>
      <tbody>
        {wishes.map((wish) => (
          <tr key={wish.id}>
            <td>{wish.name}</td>
            <td>{wish.email}</td>
            <td><a href={`/admin#item-${wish.itemId}`}>{wish.itemTitle}</a></td>
            <td>{wish.topicName}</td>
            <td>{statusText(wish)}</td>
            <td>{wish.kind}</td>
            <td>{shortTime(wish.createdAt)}</td>
            <td>{shortTime(wish.acceptedAt)}</td>
            <td><WishButtons wish={wish} say={say} reload={reload} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// An active wish on an open item can be accepted or cancelled; an accepted
// wish moves through staged and delivered.
function WishButtons({ wish, say, reload }: { wish: WishRow; say: (message: string) => void; reload: () => Promise<void> }) {
  if (!openWish(wish)) return <StatusButtons itemId={wish.itemId} status={wish.status} say={say} reload={reload} />;
  const prompt = `Accept ${wish.itemTitle} for ${wish.name}? Anyone else who wished for it will get an apology.`;
  return (
    <>
      <button type="button" onClick={() => void acceptWish(wish.itemId, wish.id, prompt, say, reload)}>Accept</button>
      <button className="quiet" type="button" onClick={() => void cancelWish(wish, wish.itemTitle, say, reload)}>Cancel wish</button>
    </>
  );
}

function openWish(wish: WishRow): boolean {
  if (wish.status !== "active") return false;
  return wish.itemStatus === "open";
}

// Matches the server's label in the CSV and the wish report.
function statusText(wish: WishRow): string {
  if (wish.cancelledBy) return "cancelled by admins";
  return wish.status;
}

function shortTime(stamp: string | null): string {
  if (!stamp) return "";
  return stamp.slice(0, 16).replace("T", " ");
}
