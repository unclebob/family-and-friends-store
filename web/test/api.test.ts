import { afterEach, expect, test, vi } from "vitest";
import { api, firstField, listOrEmpty, money, orValue, shrinkPhoto, textOr } from "../src/api";
import { fakeServer } from "./fake-server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("api sends the path as given, with no host query, and returns status and body", async () => {
  const server = fakeServer({ "GET /api/me": { status: 401, body: { error: "signed out" } } });
  expect(await api("/api/me")).toEqual({ status: 401, body: { error: "signed out" } });
  expect(server.calls.map((call) => call.path)).toEqual(["/api/me"]);
});

test("api marks a string body as JSON", async () => {
  const server = fakeServer({ "POST /x": {} });
  await api("/x", { method: "POST", body: JSON.stringify({ a: 1 }) });
  expect(server.calls[0].headers.get("content-type")).toBe("application/json");
  expect(server.calls[0].body).toEqual({ a: 1 });
});

test("api leaves the content type alone with no body, a form, or a type already set", async () => {
  const server = fakeServer({ "POST /x": {}, "GET /x": {} });
  await api("/x");
  await api("/x", { method: "POST", body: new FormData() });
  await api("/x", { method: "POST", body: "plain", headers: { "content-type": "text/plain" } });
  expect(server.calls.map((call) => call.headers.get("content-type"))).toEqual([null, null, "text/plain"]);
});

test("fallback helpers replace only null and undefined", () => {
  expect(orValue(null, 7)).toBe(7);
  expect(orValue(undefined, 7)).toBe(7);
  expect(orValue(0, 7)).toBe(0);
  expect(textOr("", "x")).toBe("");
  expect(textOr(null, "x")).toBe("x");
  expect(listOrEmpty(undefined)).toEqual([]);
  expect(listOrEmpty([1])).toEqual([1]);
});

test("firstField reads the first item or gives the fallback", () => {
  expect(firstField([{ n: 1 }, { n: 2 }], 0, (item) => item.n)).toBe(1);
  expect(firstField<{ n: number }, number>([], 0, (item) => item.n)).toBe(0);
});

test("money shows dollars and cents", () => {
  expect(money(1234)).toBe("$12.34");
  expect(money(5)).toBe("$0.05");
});

type Drawn = { width: number; height: number; qualities: number[]; closed: boolean };

function fakeImages(width: number, height: number, sizes: (number | null)[], context = true): Drawn {
  const drawn: Drawn = { width: 0, height: 0, qualities: [], closed: false };
  const bitmap = { width, height, close: () => { drawn.closed = true; } };
  vi.stubGlobal("createImageBitmap", async () => bitmap);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    if (!context) return null;
    const canvas = this;
    return { drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => {
      drawn.width = w;
      drawn.height = h;
      expect([w, h]).toEqual([canvas.width, canvas.height]);
    } } as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done, type, quality) => {
    expect(type).toBe("image/jpeg");
    drawn.qualities.push(Number(quality));
    const size = sizes[Math.min(drawn.qualities.length - 1, sizes.length - 1)];
    done(size == null ? null : new Blob([new Uint8Array(size)]));
  });
  return drawn;
}

const photo = () => new File(["x"], "p.png");

test("shrinkPhoto scales the long side down to 1600 and stops at the first small enough JPEG", async () => {
  const drawn = fakeImages(3200, 1000, [400_000, 300_000]);
  const blob = await shrinkPhoto(photo());
  expect([drawn.width, drawn.height]).toEqual([1600, 500]);
  expect(drawn.qualities.map((q) => q.toFixed(2))).toEqual(["0.85", "0.75"]);
  expect(blob.size).toBe(300_000);
  expect(drawn.closed).toBe(true);
});

test("shrinkPhoto never enlarges and keeps at least one pixel", async () => {
  const drawn = fakeImages(1, 4000, [10]);
  await shrinkPhoto(photo());
  expect([drawn.width, drawn.height]).toEqual([1, 1600]);
  const small = fakeImages(800, 600, [10]);
  await shrinkPhoto(photo());
  expect([small.width, small.height]).toEqual([800, 600]);
});

test("shrinkPhoto gives up lowering quality at 0.5", async () => {
  const drawn = fakeImages(100, 100, [900_000]);
  const blob = await shrinkPhoto(photo());
  expect(drawn.qualities.map((q) => q.toFixed(2))).toEqual(["0.85", "0.75", "0.65", "0.55", "0.45"]);
  expect(blob.size).toBe(900_000);
});

test("shrinkPhoto explains when the browser cannot draw or encode", async () => {
  fakeImages(100, 100, [10], false);
  await expect(shrinkPhoto(photo())).rejects.toThrow("This browser cannot resize the photo.");
  fakeImages(100, 100, [null]);
  await expect(shrinkPhoto(photo())).rejects.toThrow("The photo could not be prepared.");
});
