import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { appendAcceptLog, appendEmail, appendFriend, loadHome, parseGrants, parseList } from "./lists.mjs";

test("lists ignore comments and blank lines", () => {
  assert.deepEqual(parseList("# note\n Ada@Example.com \n\n"), ["ada@example.com"]);
  assert.deepEqual(parseGrants("bea@example.com: [jewelry, aviation]\ncara@example.com: []\n"), {
    "bea@example.com": ["jewelry", "aviation"],
    "cara@example.com": [],
  });
  assert.deepEqual(parseGrants("default: [aviation, electronics, knick-knacks]\nbea@example.com: [jewelry]\n"), {
    default: ["aviation", "electronics", "knick-knacks"],
    "bea@example.com": ["jewelry"],
  });
});

test("appendEmail writes a friend once", () => {
  assert.equal(appendEmail("", "Cara@Example.com"), "cara@example.com\n");
  assert.equal(appendEmail("cara@example.com\n", "cara@example.com"), "cara@example.com\n");
});

test("accept log is appended once and quotes commas", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ffstore-"));
  const entry = {
    log_id: 7,
    timestamp_ct: "2026-10-20T12:00:00",
    item_id: 3,
    title: "Pin, brass",
    topic: "jewelry",
    winner_email: "bea@example.com",
    winner_name: "Bea Friend",
    winner_group: "friend",
    accepted_by: "admin@example.com",
  };
  assert.equal(await appendAcceptLog(home, entry), true);
  assert.equal(await appendAcceptLog(home, entry), false);
  const csv = await readFile(path.join(home, "accept-log.csv"), "utf8");
  assert.match(csv, /"Pin, brass"/);
  assert.equal(csv.trim().split("\n").length, 2);
});

test("accept log retry after a lost id file does not write a second line", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ffstore-"));
  const entry = {
    log_id: 9,
    timestamp_ct: "2026-10-20T12:00:00",
    item_id: 4,
    title: "Brooch",
    topic: "jewelry",
    winner_email: "ada@example.com",
    winner_name: "Ada Family",
    winner_group: "family",
    accepted_by: "admin@example.com",
  };
  assert.equal(await appendAcceptLog(home, entry), true);
  await unlink(path.join(home, "accept-log.ids"));
  assert.equal(await appendAcceptLog(home, entry), false);
  const csv = await readFile(path.join(home, "accept-log.csv"), "utf8");
  assert.equal(csv.trim().split("\n").length, 2);
  assert.equal(await appendAcceptLog(home, entry), false);
  assert.equal(await readFile(path.join(home, "accept-log.csv"), "utf8"), csv);
  assert.equal(await readFile(path.join(home, "accept-log.ids"), "utf8"), "9\n");
});

test("loadHome reads the four list files", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ffstore-"));
  await writeFile(path.join(home, "admins.txt"), "admin@example.com\n");
  await writeFile(path.join(home, "family.txt"), "# kin\nada@example.com\n");
  await appendFriend(home, "bea@example.com");
  await writeFile(path.join(home, "grants.yaml"), "bea@example.com: [jewelry]\n");
  const lists = await loadHome(home);
  assert.deepEqual(lists.admins, ["admin@example.com"]);
  assert.deepEqual(lists.family, ["ada@example.com"]);
  assert.deepEqual(lists.friends, ["bea@example.com"]);
  assert.deepEqual(lists.grants["bea@example.com"], ["jewelry"]);
});

test("accept log records whether the winner wished now or someday, defaulting to now", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ffstore-"));
  const base = {
    timestamp_ct: "2026-10-20T12:00:00",
    item_id: 3,
    title: "Pin",
    topic: "jewelry",
    winner_email: "ada@example.com",
    winner_name: "Ada",
    winner_group: "family",
    accepted_by: "admin@example.com",
  };
  await appendAcceptLog(home, { ...base, log_id: 1, winner_wish: "someday" });
  await appendAcceptLog(home, { ...base, log_id: 2 });
  const lines = (await readFile(path.join(home, "accept-log.csv"), "utf8")).trim().split("\n");
  assert.equal(lines[0], "timestamp_ct,item_id,title,topic,winner_email,winner_name,winner_group,accepted_by,winner_wish");
  assert.equal(lines[1].split(",").at(-1), "someday");
  assert.equal(lines[2].split(",").at(-1), "now");
});

test("loadHome reads phones.txt, or none when it is missing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ffstore-phones-"));
  assert.deepEqual((await loadHome(home)).phones, []);
  await writeFile(path.join(home, "phones.txt"), "ada@example.com: 312-555-0100\n");
  assert.deepEqual((await loadHome(home)).phones, [{ email: "ada@example.com", phone: "3125550100" }]);
});
