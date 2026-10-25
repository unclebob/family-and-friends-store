export const CODE_TTL_MS = 20 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const EMAIL_SEND_LIMIT = 5;
export const IP_SEND_LIMIT = 20;
export const IP_CODE_LIMIT = 30;
export const RATE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_PHOTO_BYTES = 2_000_000;

export function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

export function timestampCT(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const at = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${at.year}-${at.month}-${at.day}T${at.hour}:${at.minute}:${at.second}`;
}
