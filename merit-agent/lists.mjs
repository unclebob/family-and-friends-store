import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { parsePhones } from "../src/phone.ts";

export function parseList(text) {
  return text
    .split(/\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(keptLine);
}

function keptLine(line) {
  if (!line) return false;
  return !line.startsWith("#");
}

export function parseGrants(text) {
  const grants = {};
  for (const raw of text.split(/\n/)) assignGrant(grants, grantLine(raw));
  return grants;
}

function assignGrant(grants, grant) {
  if (!grant) return;
  grants[grant.email] = grant.topics;
}

function grantLine(raw) {
  const line = raw.trim();
  if (skipped(line)) return null;
  return matchedGrant(line);
}

function skipped(line) {
  if (!line) return true;
  return line.startsWith("#");
}

function matchedGrant(line) {
  const match = line.match(/^([^:#]+):\s*\[(.*)\]\s*$/);
  if (!match) return null;
  return { email: match[1].trim().toLowerCase(), topics: grantTopics(match[2].trim()) };
}

function grantTopics(body) {
  if (!body) return [];
  return body.split(",").map(grantTopic).filter(Boolean);
}

function grantTopic(part) {
  return part.trim().replace(/^['"]|['"]$/g, "");
}

function withNewline(text) {
  if (text.length === 0) return text;
  return ended(text);
}

function ended(text) {
  if (text.endsWith("\n")) return text;
  return `${text}\n`;
}

export function appendEmail(text, email) {
  const normalized = email.trim().toLowerCase();
  if (parseList(text).includes(normalized)) return withNewline(text);
  return `${withNewline(text)}${normalized}\n`;
}

export function csvRow(fields) {
  return fields.map(csvField).join(",");
}

function csvField(field) {
  const text = String(blankable(field));
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function blankable(field) {
  if (field == null) return "";
  return field;
}

async function readOrEmpty(file) {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    return missingFile(err);
  }
}

function missingFile(err) {
  if (isMissing(err)) return "";
  throw err;
}

function isMissing(err) {
  if (!err) return false;
  return err.code === "ENOENT";
}

export async function loadHome(home) {
  const [admins, family, friends, grants, phones] = await Promise.all([
    readOrEmpty(path.join(home, "admins.txt")),
    readOrEmpty(path.join(home, "family.txt")),
    readOrEmpty(path.join(home, "friends.txt")),
    readOrEmpty(path.join(home, "grants.yaml")),
    readOrEmpty(path.join(home, "phones.txt")),
  ]);
  return {
    admins: parseList(admins),
    family: parseList(family),
    friends: parseList(friends),
    grants: parseGrants(grants),
    phones: parsePhones(phones),
  };
}

export async function appendFriend(home, email) {
  const file = path.join(home, "friends.txt");
  const next = appendEmail(await readOrEmpty(file), email);
  await mkdir(home, { recursive: true });
  await writeFile(file, next);
}

const HEADER = "timestamp_ct,item_id,title,topic,winner_email,winner_name,winner_group,accepted_by,winner_wish";

export async function appendAcceptLog(home, entry) {
  await mkdir(home, { recursive: true });
  const id = String(entry.log_id);
  if (await alreadyLogged(home, id)) return false;
  return writeAcceptRow(home, entry, id);
}

async function alreadyLogged(home, id) {
  const seen = new Set(parseList(await readOrEmpty(path.join(home, "accept-log.ids"))));
  if (seen.has(id)) return true;
  return false;
}

async function writeAcceptRow(home, entry, id) {
  const logFile = path.join(home, "accept-log.csv");
  const line = csvRow(logFields(entry));
  if (await loggedLine(logFile, line)) return rememberRow(home, id);
  await ensureHeader(logFile, await readOrEmpty(logFile));
  await appendFile(logFile, `${line}\n`);
  await remember(home, id);
  return true;
}

async function loggedLine(logFile, line) {
  const text = await readOrEmpty(logFile);
  return text.split("\n").includes(line);
}

async function rememberRow(home, id) {
  await remember(home, id);
  return false;
}

async function remember(home, id) {
  await appendFile(path.join(home, "accept-log.ids"), `${id}\n`);
}

function logFields(entry) {
  return [
    entry.timestamp_ct,
    entry.item_id,
    entry.title,
    entry.topic,
    entry.winner_email,
    entry.winner_name,
    entry.winner_group,
    entry.accepted_by,
    entry.winner_wish ?? "now",
  ];
}

async function ensureHeader(logFile, existing) {
  if (!existing) await writeFile(logFile, `${HEADER}\n`);
}
