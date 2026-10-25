import type { Group } from "./visibility";

export type Lists = {
  admins: string[];
  family: string[];
  friends: string[];
  grants: Record<string, string[]>;
};

export type Card = { name: string } | null | "error";

export type ResolveResult =
  | { ok: true; name: string; firstName: string; group: Group; topics: "all" | string[] }
  | { ok: false; reason: "not_contact" | "error" };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeList(emails: string[]): string[] {
  return emails.map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0);
}

function fallbackName(email: string): { name: string; firstName: string } {
  const handle = email.split("@")[0] || email;
  return { name: handle, firstName: handle };
}

function cardField(value: string): string {
  return value.trim().replace(/(?:&#13;)+$/g, "").trim();
}

function nameFromCard(card: Card, email: string): { name: string; firstName: string } {
  if (card && card !== "error") {
    const name = cardField(card.name);
    if (name) {
      const firstName = name.split(/\s+/)[0] || fallbackName(email).firstName;
      return { name, firstName };
    }
  }
  return fallbackName(email);
}

function copyLists(lists: Lists): Lists {
  return {
    admins: normalizeList(lists.admins),
    family: normalizeList(lists.family),
    friends: normalizeList(lists.friends),
    grants: { ...lists.grants },
  };
}

function topicsFor(lists: Lists, email: string): string[] {
  return uniqueTopics(topicList(lists.grants.default), topicList(lists.grants[email]));
}

function topicList(granted: string[] | undefined): string[] {
  if (!Array.isArray(granted)) return [];
  return [...granted];
}

function uniqueTopics(base: string[], extra: string[]): string[] {
  return [...new Set([...base, ...extra])];
}

type Resolved = { result: ResolveResult; lists: Lists };

// Merit's resolution order, followed exactly. The role depends only on the
// email, never on which host asked. The returned lists include a friend who
// was just appended. Callers persist that list.
export function resolvePerson(rawEmail: string, source: Lists, card: Card): Resolved {
  const email = normalizeEmail(rawEmail);
  const lists = copyLists(source);
  const group = listedGroup(email, lists);
  if (group) return accepted(lists, card, email, group, groupTopics(group, lists, email));
  return fromContact(email, lists, card);
}

// The order is admins, then family, then friends: the first list that has the email wins.
function listedGroup(email: string, lists: Lists): Group | null {
  if (lists.admins.includes(email)) return "admin";
  if (lists.family.includes(email)) return "family";
  if (lists.friends.includes(email)) return "friend";
  return null;
}

function groupTopics(group: Group, lists: Lists, email: string): "all" | string[] {
  if (group === "friend") return topicsFor(lists, email);
  return "all";
}

function accepted(
  lists: Lists,
  card: Card,
  email: string,
  group: Group,
  topics: "all" | string[],
): Resolved {
  const { name, firstName } = nameFromCard(card, email);
  return { result: { ok: true, name, firstName, group, topics }, lists };
}

function fromContact(email: string, lists: Lists, card: Card): Resolved {
  const refused = refuseContact(lists, card);
  if (refused) return refused;
  lists.friends = [...lists.friends, email];
  return accepted(lists, card, email, "friend", topicsFor(lists, email));
}

function refuseContact(lists: Lists, card: Card): Resolved | null {
  if (card === "error") return { result: { ok: false, reason: "error" }, lists };
  if (!card) return { result: { ok: false, reason: "not_contact" }, lists };
  return null;
}
