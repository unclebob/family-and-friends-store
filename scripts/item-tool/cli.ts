// ffstore-item entry point. Local dev D1/R2 unless the first argument is --live.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makePhotos, realExec, wranglerBackend } from "./adapters.ts";
import { run } from "./core.ts";

type Runner = { run: (argv: string[]) => Promise<void> };

export async function main(argv: string[], runner: (live: boolean) => Runner, fail: (message: string) => void): Promise<number> {
  const live = argv[0] === "--live";
  try {
    await runner(live).run(live ? argv.slice(1) : argv);
    return 0;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function realRunner(live: boolean): Runner {
  const exec = realExec(join(dirname(fileURLToPath(import.meta.url)), "../.."));
  const deps = {
    backend: wranglerBackend(exec, live),
    photos: makePhotos(exec, mkdtempSync(join(tmpdir(), "ffstore-item-"))),
    now: () => new Date().toISOString(),
    uuid: randomUUID,
    print: (line: string) => console.log(line),
  };
  return { run: (argv) => run(argv, deps) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), realRunner, (message) => console.error(message));
}
