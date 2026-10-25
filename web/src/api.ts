export async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(path, { ...init, headers: jsonHeaders(init) });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

function jsonHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  if (needsJson(init, headers)) headers.set("content-type", "application/json");
  return headers;
}

function needsJson(init: RequestInit, headers: Headers): boolean {
  if (!init.body) return false;
  return jsonBody(init.body, headers);
}

function jsonBody(body: BodyInit, headers: Headers): boolean {
  if (body instanceof FormData) return false;
  return !headers.has("content-type");
}

export function orValue<T>(value: T | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  return value;
}

export function textOr(value: string | null | undefined, fallback: string): string {
  return orValue(value, fallback);
}

export function listOrEmpty<T>(value: T[] | null | undefined): T[] {
  return orValue(value, new Array<T>());
}

export function firstField<T, R>(list: T[], fallback: R, read: (item: T) => R): R {
  const first = list[0];
  if (!first) return fallback;
  return read(first);
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function shrinkPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = fittedCanvas(bitmap);
  const ctx = canvas.getContext("2d");
  drawOrThrow(ctx, bitmap, canvas);
  bitmap.close();
  return shrinkUntil(canvas, 0.85);
}

function fittedCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const size = fittedSize(bitmap.width, bitmap.height);
  canvas.width = size.width;
  canvas.height = size.height;
  return canvas;
}

function fittedSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 1600 / Math.max(width, height));
  return { width: atLeastOne(width, scale), height: atLeastOne(height, scale) };
}

function atLeastOne(length: number, scale: number): number {
  return Math.max(1, Math.round(length * scale));
}

function drawOrThrow(ctx: CanvasRenderingContext2D | null, bitmap: ImageBitmap, canvas: HTMLCanvasElement): void {
  if (!ctx) throw new Error("This browser cannot resize the photo.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
}

async function shrinkUntil(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  const blob = await blobAt(canvas, quality);
  if (stopShrinking(blob, quality)) return requireBlob(blob);
  return shrinkUntil(canvas, quality - 0.1);
}

function stopShrinking(blob: Blob | null, quality: number): boolean {
  if (blob == null) return true;
  return fits(blob, quality);
}

function fits(blob: Blob, quality: number): boolean {
  if (blob.size <= 300_000) return true;
  return quality <= 0.5;
}

function requireBlob(blob: Blob | null): Blob {
  if (blob == null) throw new Error("The photo could not be prepared.");
  return blob;
}

function blobAt(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}
