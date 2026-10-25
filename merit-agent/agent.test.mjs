import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import siteConfig from "../site.config.json" with { type: "json" };
import { createAgent, keychainSecret, startupConfig } from "./agent.mjs";

const { wsUrl, linkKeychainService } = siteConfig.merit;

// testdata/fake-carddav.sh stands in for carddav.py: it prints the scene's reply.json and counts its runs.
const command = fileURLToPath(new URL("./testdata/fake-carddav.sh", import.meta.url));
async function scene({ cardReply = '{"name":"Cara Stone"}', now = () => 1_800_000_000_000 } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "ffstore-agent-"));
  await writeFile(path.join(home, "admins.txt"), "admin@example.com\n");
  await writeFile(path.join(home, "family.txt"), "ada@example.com\n");
  await writeFile(path.join(home, "friends.txt"), "bea@example.com\n");
  await writeFile(path.join(home, "grants.yaml"), "default: [aviation]\nbea@example.com: [jewelry]\n");
  await writeFile(path.join(home, "reply.json"), cardReply);
  process.env.FAKE_CARD_DIR = home;
  const sent = [];
  const agent = createAgent({ home, send: (text) => sent.push(JSON.parse(text)), carddavCommand: command, now });
  const runs = async () => (await readFile(path.join(home, "runs"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  const file = (name) => readFile(path.join(home, name), "utf8");
  return { home, agent, sent, runs, file };
}

test("answers a family lookup with the card's name and logs the outcome", async () => {
  const { agent, sent, file } = await scene({ cardReply: '{"name":"Ada Lovelace"}' });
  await agent.handle({ op: "lookup", id: "1", email: " Ada@Example.com " });
  assert.deepEqual(sent, [{ id: "1", ok: true, name: "Ada Lovelace", firstName: "Ada", group: "family", topics: "all" }]);
  assert.equal(await file("agent.log"), "2027-01-15T08:00:00.000Z ada@example.com family\n");
});

test("adds a matching contact to friends.txt once and gives the default topics", async () => {
  const { agent, sent, file } = await scene();
  await agent.handle({ op: "lookup", id: "1", email: "cara@example.com" });
  await agent.handle({ op: "lookup", id: "2", email: "cara@example.com" });
  assert.deepEqual(sent[0], { id: "1", ok: true, name: "Cara Stone", firstName: "Cara", group: "friend", topics: ["aviation"] });
  assert.equal(sent[1].ok, true);
  assert.equal(await file("friends.txt"), "bea@example.com\ncara@example.com\n");
});

test("does not touch friends.txt for someone already listed", async () => {
  const { agent, sent, file } = await scene();
  await agent.handle({ op: "lookup", id: "1", email: "bea@example.com" });
  assert.deepEqual(sent[0].topics, ["aviation", "jewelry"]);
  assert.equal(await file("friends.txt"), "bea@example.com\n");
});

test("answers not_contact for an address with no card, and logs it", async () => {
  const { agent, sent, file } = await scene({ cardReply: '{"name":null}' });
  await agent.handle({ op: "lookup", id: "1", email: "nobody@example.com" });
  assert.deepEqual(sent, [{ id: "1", ok: false, reason: "not_contact" }]);
  assert.match(await file("agent.log"), /nobody@example.com not_contact\n$/);
  assert.equal(await file("friends.txt"), "bea@example.com\n");
});

test("treats a missing email as no contact", async () => {
  const { agent, sent } = await scene({ cardReply: "{}" });
  await agent.handle({ op: "lookup", id: "1" });
  assert.deepEqual(sent, [{ id: "1", ok: false, reason: "not_contact" }]);
});

for (const [label, cardReply] of [
  ["a CardDAV error", '{"error":"lookup"}'],
  ["output that is not JSON", "Traceback (most recent call last)"],
  ["no output at all", ""],
]) {
  test(`answers error for ${label} and asks CardDAV again next time`, async () => {
    const { agent, sent, runs } = await scene({ cardReply });
    await agent.handle({ op: "lookup", id: "1", email: "cara@example.com" });
    await agent.handle({ op: "lookup", id: "2", email: "cara@example.com" });
    assert.deepEqual(sent[0], { id: "1", ok: false, reason: "error" });
    assert.equal(await runs(), 2);
  });
}

test("answers error when the CardDAV command cannot start", async () => {
  const { home, sent } = await scene();
  const agent = createAgent({ home, send: (text) => sent.push(JSON.parse(text)), carddavCommand: path.join(home, "missing") });
  await agent.handle({ op: "lookup", id: "1", email: "cara@example.com" });
  assert.deepEqual(sent, [{ id: "1", ok: false, reason: "error" }]);
});

test("answers error and logs it when the lists cannot be read", async () => {
  const { home, sent, file } = await scene();
  const broken = createAgent({ home: path.join(home, "reply.json"), send: (text) => sent.push(JSON.parse(text)) });
  await broken.handle({ op: "lookup", id: "1", email: "ada@example.com" });
  assert.deepEqual(sent, [{ id: "1", ok: false, reason: "error" }]);
  await assert.rejects(file("reply.json/agent.log"));
});

test("reuses a card for 10 minutes, then asks CardDAV again", async () => {
  let clock = 1_800_000_000_000;
  const { agent, runs } = await scene({ now: () => clock });
  await agent.handle({ op: "lookup", id: "1", email: "cara@example.com" });
  clock += 10 * 60 * 1000 - 1;
  await agent.handle({ op: "lookup", id: "2", email: "cara@example.com" });
  assert.equal(await runs(), 1);
  clock += 1;
  await agent.handle({ op: "lookup", id: "3", email: "cara@example.com" });
  assert.equal(await runs(), 2);
});

test("writes an accept log line and answers ok, then answers ok:false when it cannot write", async () => {
  const { home, agent, sent, file } = await scene();
  const entry = {
    op: "log_accept",
    id: "9",
    log_id: 1,
    timestamp_ct: "2026-10-20T12:00:00",
    item_id: 1,
    title: "Brass pin",
    topic: "jewelry",
    winner_email: "ada@example.com",
    winner_name: "Ada Family",
    winner_group: "family",
    accepted_by: "admin@example.com",
  };
  await agent.handle(entry);
  assert.deepEqual(sent, [{ id: "9", ok: true }]);
  assert.match(await file("accept-log.csv"), /Brass pin/);
  const broken = createAgent({ home: path.join(home, "reply.json"), send: (text) => sent.push(JSON.parse(text)) });
  await broken.handle({ ...entry, id: "10" });
  assert.deepEqual(sent[1], { id: "10", ok: false });
});

test("ignores a message it does not know", async () => {
  const { agent, sent } = await scene();
  await agent.handle({ op: "heartbeat", ok: true });
  assert.deepEqual(sent, []);
});

test("starts from FFSTORE_HOME and MERIT_SECRET, defaulting to the production socket", () => {
  const keychain = () => assert.fail("the Keychain is not read when MERIT_SECRET is set");
  assert.deepEqual(startupConfig({ FFSTORE_HOME: "/h", MERIT_SECRET: "s" }, keychain), {
    home: "/h",
    secret: "s",
    url: wsUrl,
    carddavCommand: undefined,
  });
  assert.equal(startupConfig({ FFSTORE_HOME: "/h", MERIT_SECRET: "s", MERIT_URL: "ws://127.0.0.1:8787/merit/ws" }, keychain).url, "ws://127.0.0.1:8787/merit/ws");
  assert.equal(startupConfig({ FFSTORE_HOME: "/h", MERIT_SECRET: "s", CARDDAV_CMD: "/bin/card" }, keychain).carddavCommand, "/bin/card");
});

test("falls back to the configured Keychain item for the secret", () => {
  const asked = [];
  const keychain = (service) => {
    asked.push(service);
    return "from-keychain";
  };
  assert.equal(startupConfig({ FFSTORE_HOME: "/h" }, keychain).secret, "from-keychain");
  assert.deepEqual(asked, [linkKeychainService]);
});

test("refuses to start without a home or without any secret", () => {
  assert.equal(startupConfig({ MERIT_SECRET: "s" }, () => "k"), null);
  assert.equal(startupConfig({ FFSTORE_HOME: "/h" }, () => ""), null);
});

test("treats an empty MERIT_URL as unset", () => {
  assert.equal(startupConfig({ FFSTORE_HOME: "/h", MERIT_SECRET: "s", MERIT_URL: "" }).url, wsUrl);
});

test("reads the Keychain item with security, and gives nothing when it is missing", () => {
  const calls = [];
  const found = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: " from-keychain\n" };
  };
  assert.equal(keychainSecret(linkKeychainService, found), "from-keychain");
  assert.deepEqual(calls, [["security", "find-generic-password", "-s", linkKeychainService, "-w"]]);
  assert.equal(keychainSecret(linkKeychainService, () => ({ status: 44, stdout: "partial" })), "");
});

test("exits 1 with a clear message when started without FFSTORE_HOME", () => {
  const agentPath = fileURLToPath(new URL("./agent.mjs", import.meta.url));
  const env = { PATH: process.env.PATH, MERIT_SECRET: "test-only" };
  const run = spawnSync(process.execPath, ["--experimental-strip-types", agentPath], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 1);
  assert.equal(
    run.stderr.trim(),
    `Set FFSTORE_HOME, and set MERIT_SECRET or the Keychain item ${linkKeychainService}. This agent does not default to ~/ffstore.`,
  );
});

test("answers family_list with the family addresses only, and logs nothing per person", async () => {
  const { agent, sent, home } = await scene();
  await writeFile(path.join(home, "family.txt"), "# Family\nAda@Example.com\n\ncy@example.com\n");
  await agent.handle({ op: "family_list", id: "7" });
  assert.deepEqual(sent, [{ id: "7", ok: true, family: ["ada@example.com", "cy@example.com"] }]);
  assert.equal(await readFile(path.join(home, "agent.log"), "utf8").catch(() => ""), "");
});

test("answers family_list with ok false when the lists cannot be read", async () => {
  const { home } = await scene();
  const sent = [];
  const broken = createAgent({ home: path.join(home, "reply.json"), send: (text) => sent.push(JSON.parse(text)) });
  await broken.handle({ op: "family_list", id: "8" });
  assert.deepEqual(sent, [{ id: "8", ok: false }]);
});

test("answers a phone number with the one email it belongs to, and logs only the last four digits", async () => {
  const { home, agent, sent, file } = await scene();
  await writeFile(path.join(home, "phones.txt"), "# phones\nada@example.com: (312) 555-0100\n");
  await agent.handle({ op: "phone_email", id: "p1", phone: "+1 312 555 0100" });
  assert.deepEqual(sent, [{ id: "p1", ok: true, email: "ada@example.com" }]);
  const log = await file("agent.log");
  assert.match(log, / phone:…0100 found\n$/);
  assert.doesNotMatch(log, /3125550100|ada@example\.com/);
});

test("answers an unknown, shared or bad phone number with nothing", async () => {
  const { home, agent, sent } = await scene();
  await writeFile(path.join(home, "phones.txt"), "bea@example.com: 312 555 0101\ncy@example.com: 312 555 0101\n");
  await agent.handle({ op: "phone_email", id: "p2", phone: "3125550101" });
  await agent.handle({ op: "phone_email", id: "p3", phone: "3125550199" });
  await agent.handle({ op: "phone_email", id: "p4", phone: "12" });
  await agent.handle({ op: "phone_email", id: "p5" });
  assert.deepEqual(sent, [
    { id: "p2", ok: false },
    { id: "p3", ok: false },
    { id: "p4", ok: false },
    { id: "p5", ok: false },
  ]);
});

test("a phone lookup with no phones.txt matches no one", async () => {
  const { agent, sent } = await scene();
  await agent.handle({ op: "phone_email", id: "p6", phone: "3125550100" });
  assert.deepEqual(sent, [{ id: "p6", ok: false }]);
});

test("a phones.txt that cannot be read matches no one instead of failing", async () => {
  const { home, agent, sent } = await scene();
  await mkdir(path.join(home, "phones.txt"));
  await agent.handle({ op: "phone_email", id: "p7", phone: "3125550100" });
  assert.deepEqual(sent, [{ id: "p7", ok: false }]);
});
