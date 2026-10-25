import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const agentDir = path.dirname(fileURLToPath(import.meta.url));

function carddav(script) {
  const result = spawnSync("python3", ["-c", script], { cwd: agentDir, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

test("vCard fields drop a trailing carriage return before compare or display", () => {
  const body = carddav(`
import json, carddav
report = "\\nFN:Bea Friend&#13;\\nEMAIL;TYPE=INTERNET:bea@example.com&#13;\\n"
print(json.dumps({
  "name": carddav.clean_vcard("Bea Friend&#13;\\r"),
  "email": carddav.clean_vcard("Bea@Example.com&#13;").lower(),
  "matched": carddav.matched_name(report, "bea@example.com"),
  "queried": carddav.matched_name(report, "bea@example.com&#13;"),
  "other": carddav.matched_name("\\nFN:Other Person&#13;\\nEMAIL:other@example.com&#13;\\n", "bea@example.com"),
  "prefix": carddav.matched_name("\\nFN:Nope\\nEMAIL:bea@example.com.evil&#13;\\n", "bea@example.com"),
  "fn_only": carddav.matched_name("\\nFN:Bea Friend&#13;\\n", "bea@example.com"),
  "query": carddav.addressbook_query("Bea@Example.com&#13;"),
}))
`);
  assert.equal(body.name, "Bea Friend");
  assert.equal(body.email, "bea@example.com");
  assert.equal(body.matched, "Bea Friend");
  assert.equal(body.queried, "Bea Friend");
  assert.equal(body.other, null);
  assert.equal(body.prefix, null);
  assert.equal(body.fn_only, "Bea Friend");
  assert.match(body.query, /match-type="starts-with"/);
  assert.match(body.query, /bea@example.com/);
  assert.doesNotMatch(body.query, /&#13;/);
});
