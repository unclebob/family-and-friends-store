import { describe, expect, it } from "vitest";
import { handle } from "../src/handle";
import { DOMAIN, namedEnv } from "./helpers";

const HSTS = "max-age=31536000";

describe("https only", () => {
  it("sends a plain GET on a real host to the same URL on https, for good", async () => {
    const response = await handle(new Request(`http://family.${DOMAIN}/any/path?q=1`), namedEnv("production"));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`https://family.${DOMAIN}/any/path?q=1`);
  });

  it("answers HEAD the same way as GET", async () => {
    const response = await handle(new Request(`http://friends.${DOMAIN}/`, { method: "HEAD" }), namedEnv("production"));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`https://friends.${DOMAIN}/`);
  });

  it("keeps the method and body of a POST by using 308", async () => {
    const request = new Request(`http://friends.${DOMAIN}/login/code?x=2`, { method: "POST", body: "{}" });
    const response = await handle(request, namedEnv("production"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`https://friends.${DOMAIN}/login/code?x=2`);
  });

  it("serves https on a real host as before, and tells the browser to stay on https", async () => {
    const response = await handle(new Request(`https://family.${DOMAIN}/api/config`), namedEnv("production"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ host: "family", env: "production" });
    expect(response.headers.get("strict-transport-security")).toBe(HSTS);
  });

  it("leaves local dev on http alone", async () => {
    const response = await handle(new Request("http://127.0.0.1:8787/api/config"), namedEnv("dev"));
    expect(response.status).toBe(200);
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("does not redirect a real hostname in dev", async () => {
    const response = await handle(new Request(`http://family.${DOMAIN}/api/config`), namedEnv("dev"));
    expect(response.status).toBe(200);
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("still refuses an unknown host, on http too", async () => {
    const response = await handle(new Request("http://evil.example/"), namedEnv("production"));
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
});
