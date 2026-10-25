// Phone sign-in: a US number written any common way, kept as its ten digits.
// The Worker, the fake Merit and the Merit agent all use these, so a number means the same thing everywhere.

export type PhoneEntry = { email: string; phone: string };

export function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^[\d\s()+.-]+$/.test(value)) return null;
  return tenDigits(value.replace(/\D/g, ""));
}

function tenDigits(digits: string): string | null {
  if (/^\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return digits.slice(1);
  return null;
}

// phones.txt on Merit: one person per line, "email: phone, phone". # starts a comment.
export function parsePhones(text: string): PhoneEntry[] {
  return text.split("\n").flatMap(phoneLine);
}

function phoneLine(raw: string): PhoneEntry[] {
  const match = raw.trim().match(/^([^#:\s]+@[^#:\s]+)\s*:(.*)$/);
  if (!match) return [];
  const email = match[1].toLowerCase();
  return match[2].split(",").flatMap((part) => entryFor(email, normalizePhone(part.trim())));
}

function entryFor(email: string, phone: string | null): PhoneEntry[] {
  if (!phone) return [];
  return [{ email, phone }];
}

// One email or nothing: a number on two people matches no one.
export function emailForPhone(entries: PhoneEntry[], phone: string): string | null {
  const emails = new Set(entries.filter((entry) => entry.phone === phone).map((entry) => entry.email));
  if (emails.size !== 1) return null;
  return [...emails][0];
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}
