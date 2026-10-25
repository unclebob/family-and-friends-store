// The ffstore-item commands. They write the same rows the admin routes in
// src/admin.ts write, checked by the same field rules from src/http.ts.
import { centsField, descriptionField, textField } from "../../src/http.ts";

export type Row = Record<string, unknown>;
export type Backend = { sql(query: string): Promise<Row[]>; put(key: string, file: string, type: string): Promise<void> };
export type Photos = { prepare(path: string): Promise<{ file: string; type: string }> };
export type Deps = { backend: Backend; photos: Photos; now: () => string; uuid: () => string; print: (line: string) => void };

export const USAGE = `Usage:
  ffstore-item topics
  ffstore-item add --topic <slug> --title <text> [--description <text>] [--price <dollars>] --photo <path> [--photo <path> ...]
  ffstore-item list [--topic <slug>]
  ffstore-item show <id>
  ffstore-item photo-add <id> <path>
  ffstore-item edit <id> [--title <text>] [--description <text>] [--price <dollars or "">]`;

type Args = { positional: string[]; options: Map<string, string[]> };
type Command = { options: string[]; run: (args: Args, deps: Deps) => Promise<void> };

const COMMANDS: Record<string, Command> = {
  topics: { options: [], run: (_args, deps) => topics(deps) },
  add: { options: ["topic", "title", "description", "price", "photo"], run: add },
  list: { options: ["topic"], run: list },
  show: { options: [], run: show },
  "photo-add": { options: [], run: photoAdd },
  edit: { options: ["title", "description", "price"], run: edit },
};

export async function run(argv: string[], deps: Deps): Promise<void> {
  const command = Object.hasOwn(COMMANDS, String(argv[0])) ? COMMANDS[argv[0]] : null;
  if (!command) throw new Error(USAGE);
  await command.run(parseArgs(argv.slice(1), command.options), deps);
}

export function parseArgs(argv: string[], allowed: string[]): Args {
  const args: Args = { positional: [], options: new Map() };
  for (let i = 0; i < argv.length; i += 1) i = takeArg(argv, i, allowed, args);
  return args;
}

function takeArg(argv: string[], i: number, allowed: string[], args: Args): number {
  if (!argv[i].startsWith("--")) {
    args.positional.push(argv[i]);
    return i;
  }
  const name = optionName(argv[i], allowed);
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
  args.options.set(name, [...(args.options.get(name) ?? []), value]);
  return i + 1;
}

function optionName(flag: string, allowed: string[]): string {
  const name = flag.slice(2);
  if (!allowed.includes(name)) throw new Error(`Unknown option ${flag}.\n${USAGE}`);
  return name;
}

function option(args: Args, name: string): string | undefined {
  return args.options.get(name)?.at(-1);
}

// SQLite strings have no backslash escapes, so doubling quotes is the whole job.
export function sqlText(value: string): string {
  if (value.includes("\u0000")) throw new Error("Text cannot contain a NUL character.");
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlValue(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return sqlText(value);
}

async function topics(deps: Deps): Promise<void> {
  const rows = await deps.backend.sql("SELECT slug, name FROM topics ORDER BY sort_order, name");
  for (const row of rows) deps.print(`${row.slug}\t${row.name}`);
}

async function topicId(deps: Deps, slug: string): Promise<number> {
  const [row] = await deps.backend.sql(`SELECT id FROM topics WHERE slug = ${sqlText(slug)}`);
  if (!row) throw new Error(`No topic "${slug}". Run "ffstore-item topics" to see them.`);
  return Number(row.id);
}

export function title(value: string | undefined): string {
  const text = textField(value, 200);
  if (!text) throw new Error("An item needs a title of 1 to 200 characters.");
  return text;
}

const PRICE_TALK = /[$€£¢]|\b\d+(\.\d+)?\s*(dollars?|bucks|usd)\b|\b(price|priced|asking|obo)\b/i;

// Family never sees prices, but they do see descriptions.
export function description(value: string | undefined): string {
  const text = descriptionField(value);
  if (text == null) throw new Error("A description can be at most 5000 characters.");
  if (PRICE_TALK.test(text)) throw new Error("The description mentions a price. Family would see it; put the price only in --price.");
  return text;
}

export function price(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const cents = /^\d+(\.\d{1,2})?$/.test(value.trim()) ? centsField(Math.round(Number(value) * 100)) : "bad";
  if (cents === "bad") throw new Error("--price is dollars, like 40 or 12.50, or \"\" for no price.");
  return cents;
}

async function add(args: Args, deps: Deps): Promise<void> {
  const topic = await topicId(deps, option(args, "topic") ?? "");
  const fields = { title: title(option(args, "title")), description: description(option(args, "description")), price: price(option(args, "price")) };
  const prepared = await preparePhotos(deps, args.options.get("photo") ?? []);
  const [row] = await deps.backend.sql(
    `INSERT INTO items (topic_id, title, description, price_cents, status, created_at) VALUES (${topic}, ${sqlText(fields.title)}, ${sqlText(fields.description)}, ${sqlValue(fields.price)}, 'open', ${sqlText(deps.now())}) RETURNING id`,
  );
  const id = Number(row.id);
  for (const photo of prepared) await storePhoto(deps, id, photo);
  deps.print(`Added item ${id} with ${prepared.length} ${plural(prepared.length, "photo")}.`);
}

async function preparePhotos(deps: Deps, paths: string[]): Promise<{ file: string; type: string }[]> {
  if (paths.length === 0) throw new Error("Give at least one --photo.");
  const prepared = [];
  for (const path of paths) prepared.push(await deps.photos.prepare(path));
  return prepared;
}

// R2 first, like the admin route, so a photo row never points at nothing.
async function storePhoto(deps: Deps, itemId: number, photo: { file: string; type: string }): Promise<void> {
  const key = `photos/${itemId}/${deps.uuid()}`;
  await deps.backend.put(key, photo.file, photo.type);
  await deps.backend.sql(`INSERT INTO photos (item_id, r2_key, sort_order) VALUES (${itemId}, ${sqlText(key)}, 0)`);
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

const ITEM_SELECT = `SELECT i.id, i.title, i.description, i.price_cents, i.status, i.created_at, i.announced_at, t.slug, t.name AS topic_name,
  (SELECT group_concat(p.id) FROM photos p WHERE p.item_id = i.id) AS photo_ids
  FROM items i JOIN topics t ON t.id = i.topic_id`;

async function list(args: Args, deps: Deps): Promise<void> {
  const slug = option(args, "topic");
  const where = slug === undefined ? "" : ` WHERE i.topic_id = ${await topicId(deps, slug)}`;
  const rows = await deps.backend.sql(`${ITEM_SELECT}${where} ORDER BY t.sort_order, i.id`);
  for (const row of rows) deps.print([row.id, row.slug, row.status, money(row), photoCount(row), row.title].join("\t"));
}

function money(row: Row): string {
  return row.price_cents == null ? "-" : `$${(Number(row.price_cents) / 100).toFixed(2)}`;
}

function photoIds(row: Row): string[] {
  return row.photo_ids ? String(row.photo_ids).split(",") : [];
}

function photoCount(row: Row): string {
  const n = photoIds(row).length;
  return `${n} ${plural(n, "photo")}`;
}

function itemId(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) throw new Error("Give an item id, like 12.");
  return Number(value);
}

async function liveItem(deps: Deps, id: number): Promise<Row> {
  const [row] = await deps.backend.sql(`${ITEM_SELECT} WHERE i.id = ${id}`);
  if (!row) throw new Error(`No item ${id}.`);
  return row;
}

async function show(args: Args, deps: Deps): Promise<void> {
  const row = await liveItem(deps, itemId(args.positional[0]));
  const announced = row.announced_at ? `in the new-items email at ${row.announced_at}` : "not yet in the new-items email";
  deps.print(`Item ${row.id}: ${row.title}`);
  deps.print(`Topic: ${row.topic_name} (${row.slug})`);
  deps.print(`Status: ${row.status}`);
  deps.print(`Price: ${money(row)}`);
  deps.print(`Photos: ${photoIds(row).length} (ids ${photoIds(row).join(", ") || "none"})`);
  deps.print(`Added: ${row.created_at}, ${announced}`);
  deps.print(`Description: ${row.description}`);
}

async function photoAdd(args: Args, deps: Deps): Promise<void> {
  const id = itemId(args.positional[0]);
  if (!args.positional[1]) throw new Error("Give a photo path.");
  await liveItem(deps, id);
  await storePhoto(deps, id, await deps.photos.prepare(args.positional[1]));
  deps.print(`Added a photo to item ${id}.`);
}

async function edit(args: Args, deps: Deps): Promise<void> {
  const id = itemId(args.positional[0]);
  const sets = editSets(args);
  if (sets.length === 0) throw new Error("Nothing to change. Give --title, --description, or --price.");
  await liveItem(deps, id);
  await deps.backend.sql(`UPDATE items SET ${sets.join(", ")} WHERE id = ${id}`);
  deps.print(`Updated item ${id}.`);
}

function editSets(args: Args): string[] {
  const sets = [];
  if (args.options.has("title")) sets.push(`title = ${sqlText(title(option(args, "title")))}`);
  if (args.options.has("description")) sets.push(`description = ${sqlText(description(option(args, "description")))}`);
  if (args.options.has("price")) sets.push(`price_cents = ${sqlValue(price(option(args, "price")))}`);
  return sets;
}
