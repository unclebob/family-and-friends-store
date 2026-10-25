// Merit opens this socket outbound. Nothing on Merit listens.
// Local run: FFSTORE_HOME=/path MERIT_SECRET=... MERIT_URL=ws://127.0.0.1:8787/merit/ws node --experimental-strip-types merit-agent/agent.mjs
// The default socket is production. See merit-agent/INSTALL.md. FFSTORE_HOME is required so a casual run cannot write ~/ffstore.
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import siteConfig from "../site.config.json" with { type: "json" };
import { resolvePerson } from "../src/resolve.ts";
import { emailForPhone, normalizePhone } from "../src/phone.ts";
import { appendAcceptLog, appendFriend, loadHome } from "./lists.mjs";
import { keepLink } from "./link.mjs";

const CARD_TTL_MS = 10 * 60 * 1000;

// options: home, send(text), and optionally carddavCommand and now.
// handle(msg) answers one message from the Worker and resolves once the reply is sent.
export function createAgent(options) {
  const agent = { now: Date.now, cache: new Map(), ...options };
  return { handle: (msg) => routeAgent(agent, msg) };
}

function routeAgent(agent, msg) {
  if (msg.op === "lookup") return answerLookup(agent, msg);
  if (msg.op === "log_accept") return answerLog(agent, msg);
  if (msg.op === "family_list") return answerFamily(agent, msg);
  if (msg.op === "phone_email") return answerPhone(agent, msg);
  return Promise.resolve();
}

// The family list stays on Merit; the Worker asks for it only when it mails family.
async function answerFamily(agent, msg) {
  try {
    const lists = await loadHome(agent.home);
    reply(agent, { id: msg.id, ok: true, family: lists.family });
  } catch {
    reply(agent, { id: msg.id, ok: false });
  }
}

// A phone number comes back as the one email it belongs to, or nothing. The log keeps only its last four digits.
async function answerPhone(agent, msg) {
  const phone = normalizePhone(msg.phone);
  const email = await phoneOwner(agent, phone);
  await logLine(agent, `phone:…${String(phone).slice(-4)}`, email ? "found" : "none");
  reply(agent, email ? { id: msg.id, ok: true, email } : { id: msg.id, ok: false });
}

async function phoneOwner(agent, phone) {
  if (!phone) return null;
  const lists = await loadHome(agent.home).catch(() => ({ phones: [] }));
  return emailForPhone(lists.phones, phone);
}

async function answerLookup(agent, msg) {
  const email = emailOf(msg);
  try {
    await replyLookup(agent, msg, email);
  } catch {
    await logLine(agent, email, "error");
    reply(agent, { id: msg.id, ok: false, reason: "error" });
  }
}

function emailOf(msg) {
  if (msg.email == null) return "";
  return String(msg.email).trim().toLowerCase();
}

async function replyLookup(agent, msg, email) {
  const lists = await loadHome(agent.home);
  const card = await carddav(agent, email);
  const resolved = resolvePerson(email, lists, card);
  if (addedFriend(email, lists, resolved)) await appendFriend(agent.home, email);
  await logLine(agent, email, outcome(resolved.result));
  reply(agent, lookupBody(msg, resolved.result));
}

function addedFriend(email, lists, resolved) {
  if (!resolved.result.ok) return false;
  if (!resolved.lists.friends.includes(email)) return false;
  return !lists.friends.includes(email);
}

function outcome(result) {
  if (result.ok) return result.group;
  return result.reason;
}

function lookupBody(msg, result) {
  if (!result.ok) return { id: msg.id, ok: false, reason: result.reason };
  const { name, firstName, group, topics } = result;
  return { id: msg.id, ok: true, name, firstName, group, topics };
}

async function answerLog(agent, msg) {
  try {
    await appendAcceptLog(agent.home, msg);
    reply(agent, { id: msg.id, ok: true });
  } catch {
    reply(agent, { id: msg.id, ok: false });
  }
}

function reply(agent, body) {
  agent.send(JSON.stringify(body));
}

async function logLine(agent, email, result) {
  const line = `${new Date(agent.now()).toISOString()} ${email} ${result}\n`;
  await appendFile(path.join(agent.home, "agent.log"), line).catch(() => {});
}

function carddav(agent, email) {
  const hit = agent.cache.get(email);
  if (hit && agent.now() - hit.at < CARD_TTL_MS) return Promise.resolve(hit.card);
  return new Promise((resolve) => spawnCard(agent, email, resolve));
}

function spawnCard(agent, email, resolve) {
  const child = spawnCarddav(agent, email);
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.on("error", () => resolve("error"));
  child.on("close", () => resolve(closedCard(agent, out, email)));
}

function spawnCarddav(agent, email) {
  if (agent.carddavCommand) return spawn(agent.carddavCommand, [email], { shell: false });
  return spawn("python3", [path.join(path.dirname(fileURLToPath(import.meta.url)), "carddav.py"), email]);
}

// A card is { name }, null for no contact, or "error". Only a good answer is cached.
function closedCard(agent, out, email) {
  try {
    const card = cardFrom(JSON.parse(out));
    if (card !== "error") agent.cache.set(email, { at: agent.now(), card });
    return card;
  } catch {
    return "error";
  }
}

function cardFrom(parsed) {
  if (parsed.error) return "error";
  if (parsed.name) return { name: parsed.name };
  return null;
}

const DEFAULT_URL = siteConfig.merit.wsUrl;
const LINK_KEYCHAIN = siteConfig.merit.linkKeychainService;

// Reads the startup settings once. Returns null when FFSTORE_HOME or the secret is missing.
export function startupConfig(env, keychain = keychainSecret) {
  const config = {
    home: env.FFSTORE_HOME,
    secret: env.MERIT_SECRET || keychain(LINK_KEYCHAIN),
    url: env.MERIT_URL || DEFAULT_URL,
    carddavCommand: env.CARDDAV_CMD,
  };
  if (!config.home || !config.secret) return null;
  return config;
}

export function keychainSecret(service, run = spawnSync) {
  const found = run("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8" });
  if (found.status !== 0) return "";
  return found.stdout.trim();
}

function main() {
  const config = startupConfig(process.env);
  if (!config) {
    console.error(`Set FFSTORE_HOME, and set MERIT_SECRET or the Keychain item ${LINK_KEYCHAIN}. This agent does not default to ~/ffstore.`);
    process.exit(1);
  }
  const link = keepLink({
    open: () => new WebSocket(config.url),
    onOpen: (socket) => socket.send(JSON.stringify({ op: "auth", secret: config.secret })),
    onMessage: (event) => void agent.handle(JSON.parse(String(event.data))),
  });
  const agent = createAgent({ home: config.home, send: link.send, carddavCommand: config.carddavCommand });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
