export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

export function notFound(): Response {
  return json({ error: "Not found" }, 404);
}

export function matchedId(path: string, pattern: RegExp): number | null {
  const match = path.match(pattern);
  if (!match) return null;
  return Number(match[1]);
}

export function valueOr<T, R>(row: T | null | undefined, fallback: R, read: (row: T) => R): R {
  if (row == null) return fallback;
  return read(row);
}

export async function orElse<T>(found: T | null, next: () => Promise<T>): Promise<T> {
  if (found) return found;
  return next();
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 100_000) throw new HttpError(413, "That request is too large.");
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, "Send JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Send JSON.");
  return value as Record<string, unknown>;
}

export function textField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  return text;
}

export function descriptionField(value: unknown): string | null {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > 5000) return null;
  return value.trim();
}

export function centsField(value: unknown): number | null | "bad" {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000_000) return "bad";
  return value;
}

export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "topic";
}
