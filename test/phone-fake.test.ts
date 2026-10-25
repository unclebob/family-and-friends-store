import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEV_MERIT } from "../src/dev-fixture";

describe("fake Merit phone numbers", () => {
  it("answers from its phones list in dev, and matches no one without one", async () => {
    const link = env.MERIT.getByName("merit");
    await link.setFake({ ...DEV_MERIT, phones: "ada@example.com: 312-555-0100\n" });
    expect(await link.phoneEmail("3125550100")).toEqual({ ok: true, email: "ada@example.com" });
    expect(await link.phoneEmail("3125550199")).toEqual({ ok: false, reason: "none" });
    await link.setFake(DEV_MERIT);
    expect(await link.phoneEmail("3125550100")).toEqual({ ok: false, reason: "none" });
  });
});
