// Accept, Cancel wish, status changes, and Move to topic, shared by the admin
// page, the All wishes list, and an admin's view of the browsing page.
import { api, textOr } from "./api";

type Say = (message: string) => void;
type Reload = () => Promise<void>;
type Mail = "outbox" | "email" | undefined;
export type DeliveryStatus = "accepted" | "staged" | "delivered";
type Reply = { ok?: boolean; already?: boolean; error?: string; mail?: Mail };

export async function acceptWish(itemId: number, wishId: number, prompt: string, say: Say, reload: Reload): Promise<void> {
  if (!confirm(prompt)) return;
  const result = await api<Reply>(`/api/admin/items/${itemId}/accept`, { method: "POST", body: JSON.stringify({ wishId }) });
  say(acceptNote(result.body));
  await reload();
}

export async function cancelWish(wish: { id: number; name: string }, title: string, say: Say, reload: Reload): Promise<void> {
  if (!confirm(`Cancel ${wish.name}'s wish for ${title}? ${wish.name} will get a short email saying the wish was cancelled.`)) return;
  const result = await api<Reply>(`/api/admin/wishes/${wish.id}/cancel`, { method: "POST" });
  say(cancelNote(result.body, wish.name));
  await reload();
}

export async function setItemStatus(itemId: number, status: DeliveryStatus, say: Say, reload: Reload): Promise<void> {
  await sendItemWrite(`/api/admin/items/${itemId}/status`, "POST", { status }, `Marked ${status}.`, "Status change failed.", say, reload);
}

export async function moveItem(itemId: number, topicId: number, say: Say, reload: Reload): Promise<void> {
  await sendItemWrite(`/api/admin/items/${itemId}`, "PATCH", { topicId }, "Item moved.", "Move failed.", say, reload);
}

async function sendItemWrite(
  path: string,
  method: "POST" | "PATCH",
  payload: Record<string, unknown>,
  ok: string,
  fallback: string,
  say: Say,
  reload: Reload,
): Promise<void> {
  const result = await api<Reply>(path, { method, body: JSON.stringify(payload) });
  say(replyNote(result.body, ok, fallback));
  await reload();
}

function replyNote(body: Reply, ok: string, fallback: string): string {
  if (body.ok) return ok;
  return textOr(body.error, fallback);
}

function acceptNote(body: Reply): string {
  if (body.ok) return mailNote(body.mail, "Accepted. The notes are in the local mailbox.", "Accepted. The notes were emailed.");
  return textOr(body.error, "Accept failed.");
}

function cancelNote(body: Reply, name: string): string {
  if (body.already) return "That wish was already cancelled.";
  if (body.ok) return mailNote(body.mail, "Wish cancelled. The note is in the local mailbox.", `Wish cancelled. ${name} was emailed.`);
  return textOr(body.error, "Cancel failed.");
}

// Only the dev server keeps mail in the local mailbox; anything else was emailed.
function mailNote(mail: Mail, local: string, emailed: string): string {
  if (mail === "outbox") return local;
  return emailed;
}
