import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../src/handle";
import { requestHost } from "../src/hosts";
import { asJson, DOMAIN, namedEnv, origin } from "./helpers";

const family = `${origin("family")}/api/config`;

describe("request host", () => {
  it("accepts only the two real hostnames outside dev", () => {
    expect(requestHost(new Request(`https://family.${DOMAIN}/`), "production")).toBe("family");
    expect(requestHost(new Request(`https://FRIENDS.${DOMAIN}/`), "production")).toBe("friends");
    expect(requestHost(new Request("https://friends.evil.com/"), "production")).toBeNull();
    expect(requestHost(new Request("https://evil.example/"), "production")).toBeNull();
    expect(requestHost(new Request("http://127.0.0.1:8787/"), "production")).toBeNull();
    expect(requestHost(new Request(`${family}?host=friends`), "production")).toBe("family");
    expect(requestHost(new Request(family, { headers: { "x-ff-host": "friends" } }), "production")).toBe("family");
  });

  it("in dev, uses the real hostname or falls back to family, and ignores overrides", () => {
    expect(requestHost(new Request(`https://friends.${DOMAIN}/`), "dev")).toBe("friends");
    expect(requestHost(new Request(`${family}?host=friends`), "dev")).toBe("family");
    expect(requestHost(new Request(family, { headers: { "x-ff-host": "friends" } }), "dev")).toBe("family");
    expect(requestHost(new Request("http://127.0.0.1:8787/api/config?host=friends"), "dev")).toBe("family");
    expect(requestHost(new Request("https://evil.example/"), "dev")).toBe("family");
  });

  it("rejects an unknown production hostname and ignores a host override", async () => {
    const unknown = await handle(new Request("https://evil.example/api/config"), namedEnv("production"));
    expect(unknown.status).toBe(404);
    const local = await handle(new Request("http://127.0.0.1:8787/api/config"), namedEnv("production"));
    expect(local.status).toBe(404);
    const overridden = await asJson(await handle(new Request(`${family}?host=friends`), namedEnv("production")));
    expect(overridden).toMatchObject({ host: "family", env: "production" });
    const header = await asJson(
      await handle(new Request(family, { headers: { "x-ff-host": "friends" } }), namedEnv("production")),
    );
    expect(header).toMatchObject({ host: "family" });
  });

  it("ignores host overrides on the dev worker entry", async () => {
    const query = await asJson(await exports.default.fetch(`${family}?host=friends`));
    expect(query).toMatchObject({ host: "family", env: "dev" });
    const header = await asJson(await exports.default.fetch(family, { headers: { "x-ff-host": "friends" } }));
    expect(header).toMatchObject({ host: "family" });
    const loopback = await asJson(await exports.default.fetch("http://127.0.0.1:8787/api/config"));
    expect(loopback).toMatchObject({ host: "family" });
  });
});
