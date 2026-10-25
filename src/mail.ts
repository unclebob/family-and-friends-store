import { FIRST_ADMIN, SECOND_ADMIN } from "./dev-fixture";
import { isDev } from "./env-name";
import type { Group } from "./visibility";

export type MailTemplate = "its-yours" | "apology" | "login-code" | "wish-report" | "new-items" | "wish-cancelled";

// Prices are never negative: centsField rejects them where they enter.
export function formatCents(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const remainder = (cents % 100).toString().padStart(2, "0");
  return `$${dollars}.${remainder}`;
}

// Price is included only for a friend. The apology builder cannot see a
// winner or a price, so those cannot leak into that message.
export function winnerText(item: { title: string; priceCents: number | null }, group: Group): string {
  const lines = ["It's yours!", "", `${item.title} is yours.`];
  if (group === "friend" && item.priceCents != null) {
    lines.push(`The price is ${formatCents(item.priceCents)}.`);
  }
  lines.push("", `${FIRST_ADMIN.shortName} or ${SECOND_ADMIN.shortName} will be in touch about handing it over.`);
  return lines.join("\n");
}

export function apologyText(item: { title: string; photoUrl: string | null }): string {
  const lines = [
    `${item.title} has gone to someone else.`,
    "We're sorry it won't be coming to you.",
  ];
  if (item.photoUrl) lines.push("", `Photo: ${item.photoUrl}`);
  lines.push("", "Please keep browsing the other items.");
  return lines.join("\n");
}

// Built from the title alone, so no price can reach it.
export function cancelledText(title: string): string {
  return [
    `${FIRST_ADMIN.shortName} and ${SECOND_ADMIN.shortName} have cancelled your wish for ${title}.`,
    "We're sorry if that's a disappointment. If you'd like to know why, just reply to this email.",
    "",
    "Please keep browsing the other items.",
  ].join("\n");
}

export type Letter = { subject: string; text: string; html?: string; replyTo?: string };

export async function sendMail(
  env: Env,
  recipient: string,
  template: MailTemplate,
  subject: string,
  text: string,
  nowIso: string,
): Promise<void> {
  await sendLetter(env, recipient, template, { subject, text }, nowIso);
}

// A letter may carry an HTML version and a reply-to address.
export async function sendLetter(env: Env, recipient: string, template: MailTemplate, letter: Letter, nowIso: string): Promise<void> {
  if (isDev(env)) return recordLetter(env.DB, recipient, template, letter, nowIso);
  await deliverResend(env, recipient, letter);
}

const MAX_ATTEMPTS = 4;

async function deliverResend(env: Env, recipient: string, letter: Letter): Promise<void> {
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    const response = await postResend(env, recipient, letter);
    if (response.ok) return;
    if (response.status !== 429) throw new Error("The message was not sent.");
    await waitBeforeRetry(response);
  }
  const last = await postResend(env, recipient, letter);
  if (!last.ok) throw new Error("The message was not sent.");
}

async function postResend(env: Env, recipient: string, letter: Letter): Promise<Response> {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [recipient],
      subject: letter.subject,
      text: letter.text,
      html: letter.html,
      reply_to: letter.replyTo,
    }),
  });
}

async function waitBeforeRetry(response: Response): Promise<void> {
  const ms = Number(response.headers.get("retry-after-ms") ?? "1000");
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordLetter(db: D1Database, recipient: string, template: MailTemplate, letter: Letter, nowIso: string): Promise<void> {
  await db
    .prepare("INSERT INTO outbox (recipient, template, payload, created_at) VALUES (?, ?, ?, ?)")
    .bind(recipient, template, JSON.stringify({ subject: letter.subject, text: letter.text, html: letter.html }), nowIso)
    .run();
}
