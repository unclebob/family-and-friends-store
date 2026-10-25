import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { imageKind, makePhotos, realExec, wranglerBackend, type Exec } from "./adapters.ts";

const dir = mkdtempSync(join(tmpdir(), "ffitem-"));
const file = (name: string, bytes: number[], pad = 0) => {
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([Buffer.from(bytes), Buffer.alloc(pad)]));
  return path;
};

test.each([
  ["jpeg", [0xff, 0xd8, 0xff, 0xe0]],
  ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["webp", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]],
  ["heic", [0, 0, 0, 24, ...Buffer.from("ftypheic")]],
  ["heic", [0, 0, 0, 24, ...Buffer.from("ftypmif1")]],
])("recognises %s by its first bytes", (kind, bytes) => {
  expect(imageKind(Buffer.from([...bytes, 0, 0, 0, 0]))).toBe(kind);
});

test("anything else is not an image, whatever its name", () => {
  expect(imageKind(Buffer.from("hello there, not a photo"))).toBeNull();
  expect(imageKind(Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom")]))).toBeNull();
});

test("photos are shrunk to 1600px JPEG, stepping quality down from 0.85 like the browser", async () => {
  const calls: string[][] = [];
  const sizes = [900_000, 500_000, 250_000];
  const exec: Exec = async (cmd, args) => {
    if (args[0] === "-g") return "/a.png\n  pixelWidth: 3000\n  pixelHeight: 2000\n";
    calls.push([cmd, ...args]);
    writeFileSync(args.at(-1)!, Buffer.alloc(sizes.shift()!));
    return "";
  };
  const photo = await makePhotos(exec, dir).prepare(file("a.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(photo.type).toBe("image/jpeg");
  expect(calls.map((c) => c[6])).toEqual(["85", "75", "65"]);
  expect(calls[0].slice(0, 9)).toEqual(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", "1600"]);
});

test("a small photo is not blown up, quality stops at 0.5, and a result over 2 MB is refused", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    if (args[0] === "-g") return "  pixelWidth: 800\n  pixelHeight: 600\n";
    calls.push([cmd, ...args]);
    writeFileSync(args.at(-1)!, Buffer.alloc(2_000_001));
    return "";
  };
  await expect(makePhotos(exec, dir).prepare(file("b.jpg", [0xff, 0xd8, 0xff, 0xe0]))).rejects.toThrow(/too large/);
  expect(calls.map((c) => c[6])).toEqual(["85", "75", "65", "55", "45"]);
  expect(calls[0]).not.toContain("-Z");
});

test("a non-image or missing file is refused before anything runs", async () => {
  const exec: Exec = async () => {
    throw new Error("should not run");
  };
  await expect(makePhotos(exec, dir).prepare(file("c.jpg", [...Buffer.from("text")]))).rejects.toThrow(/not a JPEG, PNG, WebP, or HEIC/);
  await expect(makePhotos(exec, dir).prepare(join(dir, "missing.jpg"))).rejects.toThrow(/No file/);
});

test("the backend runs wrangler against the local copy unless told live", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return JSON.stringify([{ results: [{ id: 4 }], success: true }]);
  };
  const local = wranglerBackend(exec, false);
  expect(await local.sql("SELECT 1")).toEqual([{ id: 4 }]);
  await local.put("photos/4/u", "/x.jpg", "image/jpeg");
  await wranglerBackend(exec, true).sql("SELECT 2");
  expect(calls).toEqual([
    ["npx", "wrangler", "d1", "execute", "ffstore", "--local", "--json", "--command", "SELECT 1"],
    ["npx", "wrangler", "r2", "object", "put", "ffstore-photos/photos/4/u", "--file", "/x.jpg", "--content-type", "image/jpeg", "--local"],
    ["npx", "wrangler", "d1", "execute", "ffstore", "--remote", "--json", "--command", "SELECT 2"],
  ]);
});

test("a wrangler answer that is not a successful result is an error", async () => {
  const exec: Exec = async () => JSON.stringify([{ success: false }]);
  await expect(wranglerBackend(exec, false).sql("SELECT 1")).rejects.toThrow(/D1/);
});

test("realExec runs in the given folder and reports what a failing command said", async () => {
  const exec = realExec(dir);
  expect(await exec("node", ["-e", "process.stdout.write(process.cwd())"])).toContain("ffitem-");
  await expect(exec("node", ["-e", "console.log('out text'); console.error('err text'); process.exit(3)"])).rejects.toThrow(/node failed: err text\nout text/);
  await expect(exec("node", ["-e", "process.exit(2)"])).rejects.toThrow(/node failed: Command failed/);
});
