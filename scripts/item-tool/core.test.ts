import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, test } from "vitest";
import { run, sqlText, type Backend, type Photos } from "./core.ts";

let db: DatabaseSync;
let puts: { key: string; file: string; type: string }[];
let out: string[];

const backend: Backend = {
  async sql(query) {
    const statement = db.prepare(query);
    if (/^\s*(SELECT|INSERT[\s\S]*RETURNING)/i.test(query)) return statement.all() as Record<string, unknown>[];
    statement.run();
    return [];
  },
  async put(key, file, type) {
    puts.push({ key, file, type });
  },
};

const photos: Photos = {
  async prepare(path) {
    if (path.endsWith(".txt")) throw new Error(`${path} is not a JPEG, PNG, WebP, or HEIC photo.`);
    return { file: `${path}.jpg`, type: "image/jpeg" };
  },
};

const deps = () => ({ backend, photos, now: () => "2026-10-21T21:00:00.000Z", uuid: () => "u1", print: (line: string) => out.push(line) });

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const name of readdirSync("migrations").sort()) db.exec(readFileSync(`migrations/${name}`, "utf8"));
  puts = [];
  out = [];
});

const item = (id: number) => db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Record<string, unknown>;

test("topics lists each slug and name", async () => {
  await run(["topics"], deps());
  expect(out).toContain("aviation\tAviation");
  expect(out).toHaveLength(8);
});

test("add creates an open item the daily email will pick up, with its photos in R2", async () => {
  await run(["add", "--topic", "aviation", "--title", " Logbook ", "--description", "Pilot's 1978 logbook", "--price", "12.5", "--photo", "/a.heic", "--photo", "/b.png"], deps());
  const row = item(1);
  expect(row).toMatchObject({ title: "Logbook", description: "Pilot's 1978 logbook", price_cents: 1250, status: "open", created_at: "2026-10-21T21:00:00.000Z", announced_at: null });
  expect(puts).toEqual([
    { key: "photos/1/u1", file: "/a.heic.jpg", type: "image/jpeg" },
    { key: "photos/1/u1", file: "/b.png.jpg", type: "image/jpeg" },
  ]);
  expect(db.prepare("SELECT item_id, r2_key, sort_order FROM photos").all()).toEqual([
    { item_id: 1, r2_key: "photos/1/u1", sort_order: 0 },
    { item_id: 1, r2_key: "photos/1/u1", sort_order: 0 },
  ]);
  expect(out.join("\n")).toContain("Added item 1");
});

test("add with no price stores none", async () => {
  await run(["add", "--topic", "aviation", "--title", "Wings", "--photo", "/a.jpg"], deps());
  expect(item(1)).toMatchObject({ price_cents: null, description: "" });
});

test.each([
  [["add", "--topic", "nope", "--title", "X", "--photo", "/a.jpg"], /No topic "nope"/],
  [["add", "--topic", "aviation", "--photo", "/a.jpg"], /needs a title/],
  [["add", "--topic", "aviation", "--title", "x".repeat(201), "--photo", "/a.jpg"], /needs a title/],
  [["add", "--topic", "aviation", "--title", "X"], /at least one --photo/],
  [["add", "--topic", "aviation", "--title", "X", "--description", "Yours for $40", "--photo", "/a.jpg"], /--price/],
  [["add", "--topic", "aviation", "--title", "X", "--description", "asking 40 dollars", "--photo", "/a.jpg"], /--price/],
  [["add", "--topic", "aviation", "--title", "X", "--description", "d".repeat(5001), "--photo", "/a.jpg"], /5000/],
  [["add", "--topic", "aviation", "--title", "X", "--price", "-1", "--photo", "/a.jpg"], /--price/],
  [["add", "--topic", "aviation", "--title", "X", "--price", "ten", "--photo", "/a.jpg"], /--price/],
  [["add", "--topic", "aviation", "--title", "X", "--photo", "/notes.txt"], /not a JPEG/],
  [["add", "--topic", "aviation", "--title", "X", "--colour", "red", "--photo", "/a.jpg"], /Unknown option --colour/],
  [["add", "--topic", "aviation", "--title", "--photo", "/a.jpg"], /--title needs a value/],
])("add refuses %j and writes nothing", async (args, message) => {
  await expect(run(args, deps())).rejects.toThrow(message);
  expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
  expect(puts).toEqual([]);
});

test("list shows items, optionally in one topic, with prices for admins", async () => {
  await run(["add", "--topic", "aviation", "--title", "Logbook", "--price", "3", "--photo", "/a.jpg"], deps());
  await run(["add", "--topic", "jewelry", "--title", "Ring", "--photo", "/a.jpg"], deps());
  out = [];
  await run(["list"], deps());
  expect(out).toEqual(["1\taviation\topen\t$3.00\t1 photo\tLogbook", "2\tjewelry\topen\t-\t1 photo\tRing"]);
  out = [];
  await run(["list", "--topic", "jewelry"], deps());
  expect(out).toEqual(["2\tjewelry\topen\t-\t1 photo\tRing"]);
  await expect(run(["list", "--topic", "nope"], deps())).rejects.toThrow(/No topic "nope"/);
});

test("show prints one item; a missing one is not found", async () => {
  await run(["add", "--topic", "aviation", "--title", "Logbook", "--description", "Old", "--photo", "/a.jpg"], deps());
  out = [];
  await run(["show", "1"], deps());
  expect(out).toEqual(["Item 1: Logbook", "Topic: Aviation (aviation)", "Status: open", "Price: -", "Photos: 1 (ids 1)", "Added: 2026-10-21T21:00:00.000Z, not yet in the new-items email", "Description: Old"]);
  await expect(run(["show", "9"], deps())).rejects.toThrow(/No item 9/);
  await expect(run(["show", "x"], deps())).rejects.toThrow(/item id/);
});

test("photo-add adds one photo to an item", async () => {
  await run(["add", "--topic", "aviation", "--title", "Logbook", "--photo", "/a.jpg"], deps());
  await run(["photo-add", "1", "/c.jpg"], deps());
  expect(db.prepare("SELECT COUNT(*) AS n FROM photos WHERE item_id = 1").get()).toEqual({ n: 2 });
  await expect(run(["photo-add", "9", "/d.jpg"], deps())).rejects.toThrow(/No item 9/);
  await expect(run(["photo-add", "1"], deps())).rejects.toThrow(/photo path/);
});

test("edit changes only the fields given, with the same rules", async () => {
  await run(["add", "--topic", "aviation", "--title", "Logbook", "--description", "Old", "--price", "3", "--photo", "/a.jpg"], deps());
  await run(["edit", "1", "--title", "Log book"], deps());
  expect(item(1)).toMatchObject({ title: "Log book", description: "Old", price_cents: 300 });
  await run(["edit", "1", "--description", "New", "--price", ""], deps());
  expect(item(1)).toMatchObject({ title: "Log book", description: "New", price_cents: null });
  await expect(run(["edit", "1", "--description", "now $5"], deps())).rejects.toThrow(/--price/);
  await expect(run(["edit", "1"], deps())).rejects.toThrow(/Nothing to change/);
  await expect(run(["edit", "1", "--topic", "jewelry"], deps())).rejects.toThrow(/Unknown option --topic/);
  await expect(run(["edit", "7", "--title", "Y"], deps())).rejects.toThrow(/No item 7/);
});

test("there is no delete, and unknown commands print the usage", async () => {
  await expect(run(["delete", "1"], deps())).rejects.toThrow(/Usage/);
  await expect(run([], deps())).rejects.toThrow(/Usage/);
});

test("sqlText quotes for SQLite and refuses NUL", () => {
  expect(sqlText("Ada's")).toBe("'Ada''s'");
  expect(() => sqlText("a\u0000b")).toThrow();
});
