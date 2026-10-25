import { expect, test } from "vitest";
import { main } from "./cli.ts";

test("local is the default; --live first switches to the live database and bucket", async () => {
  const seen: { live: boolean; argv: string[] }[] = [];
  const errors: string[] = [];
  const go = (live: boolean) => ({ run: async (argv: string[]) => void seen.push({ live, argv }) });
  expect(await main(["topics"], go, (m) => errors.push(m))).toBe(0);
  expect(await main(["--live", "list"], go, (m) => errors.push(m))).toBe(0);
  expect(seen).toEqual([{ live: false, argv: ["topics"] }, { live: true, argv: ["list"] }]);
  const failing = () => ({ run: async () => { throw new Error("No item 9."); } });
  expect(await main(["show", "9"], failing, (m) => errors.push(m))).toBe(1);
  expect(errors).toEqual(["No item 9."]);
});
