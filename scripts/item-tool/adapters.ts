// The outside world for ffstore-item: wrangler for D1 and R2, and macOS sips
// for photos. Each takes an Exec so tests can see the exact commands.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { MAX_PHOTO_BYTES } from "../../src/time.ts";
import type { Backend, Photos, Row } from "./core.ts";

export type Exec = (cmd: string, args: string[]) => Promise<string>;

export function realExec(cwd: string): Exec {
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd, maxBuffer: 50_000_000 }, (err, stdout, stderr) => (err ? reject(new Error(`${cmd} failed: ${(stderr + stdout).trim() || err.message}`)) : resolve(stdout)));
    });
}

export function wranglerBackend(exec: Exec, live: boolean): Backend {
  const where = live ? "--remote" : "--local";
  return {
    async sql(query) {
      return d1Rows(await exec("npx", ["wrangler", "d1", "execute", "ffstore", where, "--json", "--command", query]));
    },
    async put(key, file, type) {
      await exec("npx", ["wrangler", "r2", "object", "put", `ffstore-photos/${key}`, "--file", file, "--content-type", type, where]);
    },
  };
}

function d1Rows(stdout: string): Row[] {
  const [answer] = JSON.parse(stdout) as { success?: boolean; results?: Row[] }[];
  if (!answer?.success || !Array.isArray(answer.results)) throw new Error(`D1 did not answer as expected: ${stdout.slice(0, 300)}`);
  return answer.results;
}

const HEIC_BRANDS = ["heic", "heix", "hevc", "heif", "mif1", "msf1"];

export function imageKind(head: Buffer): "jpeg" | "png" | "webp" | "heic" | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (head.toString("latin1", 4, 8) === "ftyp" && HEIC_BRANDS.includes(head.toString("latin1", 8, 12))) return "heic";
  return null;
}

const LONGEST = 1600;

// The admin page shrinks in the browser before uploading: longest side 1600,
// JPEG from quality 0.85 down by 0.1 until it is 300 KB or quality reaches 0.5.
export function makePhotos(exec: Exec, scratch: string): Photos {
  return {
    async prepare(path) {
      checkImage(path);
      const out = join(scratch, `${basename(path)}.${Date.now()}.jpg`);
      const resize = (await longestSide(exec, path)) > LONGEST ? ["-Z", String(LONGEST)] : [];
      await shrink(exec, path, out, resize, 85);
      return { file: out, type: "image/jpeg" };
    },
  };
}

function checkImage(path: string): void {
  if (!existsSync(path)) throw new Error(`No file at ${path}.`);
  if (!imageKind(readFileSync(path).subarray(0, 16))) throw new Error(`${path} is not a JPEG, PNG, WebP, or HEIC photo.`);
}

async function longestSide(exec: Exec, path: string): Promise<number> {
  const text = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  const sides = [...text.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1]));
  return Math.max(0, ...sides);
}

async function shrink(exec: Exec, path: string, out: string, resize: string[], quality: number): Promise<void> {
  await exec("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), ...resize, path, "--out", out]);
  const size = statSync(out).size;
  if (size > 300_000 && quality > 50) return shrink(exec, path, out, resize, quality - 10);
  if (size > MAX_PHOTO_BYTES) throw new Error(`${path} is too large even after shrinking.`);
}
