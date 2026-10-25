import { describe, expect, it } from "vitest";
import { centsField, slugify } from "../src/http";
import { apologyText, formatCents, winnerText } from "../src/mail";
import { meritSecretAllowed } from "../src/merit-link";
import { resolvePerson } from "../src/resolve";
import { serializeMemberItem, type RawItem } from "../src/serializer";
import { timestampCT } from "../src/time";
import { canSeeOtherWishers, canSeePrice, canSeeTopic, type Session } from "../src/visibility";

const lists = {
  admins: ["admin@example.com"],
  family: ["ada@example.com"],
  friends: ["bea@example.com"],
  grants: { "bea@example.com": ["jewelry"] },
};

function session(group: Session["group"], topics: Session["topics"] = "all"): Session {
  return { email: "person@example.com", name: "Person", firstName: "Person", group, topics, host: "family" };
}

const item: RawItem = {
  id: 1,
  topicSlug: "jewelry",
  title: "Brass pin",
  description: "A small brass pin.",
  priceCents: 1995,
  status: "open",
  photos: [{ id: 4 }],
  wishes: [
    { email: "ada@example.com", name: "Ada Family", status: "active", kind: "someday" },
    { email: "bea@example.com", name: "Bea Friend", status: "active", kind: "now" },
    { email: "sue@example.com", name: "Sue Family", status: "withdrawn", kind: "now" },
  ],
};

describe("visibility", () => {
  it("lets admins and family see every topic, and friends only their grants", () => {
    expect(canSeeTopic(session("admin"), "aviation")).toBe(true);
    expect(canSeeTopic(session("family"), "aviation")).toBe(true);
    expect(canSeeTopic(session("friend", ["jewelry"]), "jewelry")).toBe(true);
    expect(canSeeTopic(session("friend", ["jewelry"]), "aviation")).toBe(false);
    expect(canSeeTopic(session("friend", []), "jewelry")).toBe(false);
  });

  it("checks admin before family for prices", () => {
    expect(canSeePrice(session("admin"))).toBe(true);
    expect(canSeePrice(session("family"))).toBe(false);
    expect(canSeePrice(session("friend"))).toBe(true);
  });

  it("hides other wishers from friends", () => {
    expect(canSeeOtherWishers(session("admin"))).toBe(true);
    expect(canSeeOtherWishers(session("family"))).toBe(true);
    expect(canSeeOtherWishers(session("friend"))).toBe(false);
  });
});

describe("serializer", () => {
  it("strips price and keeps other wishers for family", () => {
    const view = serializeMemberItem({ ...session("family"), email: "ada@example.com" }, item);
    expect(view).not.toHaveProperty("priceCents");
    expect(JSON.stringify(view)).not.toContain("price");
    expect(JSON.stringify(view)).not.toContain("1995");
    expect(view?.alsoWantedBy).toEqual([{ name: "Bea Friend", kind: "now" }]);
    expect(view?.wishKind).toBe("someday");
    expect(view).not.toHaveProperty("othersWishing");
    expect(view?.photos[0]?.url).toBe("/photo/4");
    expect(JSON.stringify(view)).not.toContain("r2");
  });

  it("shows price to a friend and only how many others wish, never who", () => {
    const view = serializeMemberItem(
      { ...session("friend", ["jewelry"]), email: "bea@example.com", host: "friends" },
      item,
    );
    expect(view?.priceCents).toBe(1995);
    expect(view).not.toHaveProperty("alsoWantedBy");
    expect(view?.othersWishing).toBe(1);
    expect(view?.wishKind).toBe("now");
    expect(JSON.stringify(view)).not.toContain("someday");
    expect(JSON.stringify(view)).not.toContain("Ada");
    expect(JSON.stringify(view)).not.toContain("@example.com");
  });

  it("tells a friend zero when nobody else wishes, counting only active wishes", () => {
    const lonely = { ...item, wishes: [{ email: "sue@example.com", name: "Sue Family", status: "withdrawn" as const, kind: "now" as const }] };
    const view = serializeMemberItem({ ...session("friend", ["jewelry"]), email: "bea@example.com" }, lonely);
    expect(view?.othersWishing).toBe(0);
  });

  it("gives no wish kind to someone who has not wished", () => {
    expect(serializeMemberItem(session("family"), item)).not.toHaveProperty("wishKind");
  });

  it("marks an item wished only for the viewer's own active wish", () => {
    const viewer = (email: string) => ({ ...session("family"), email });
    expect(serializeMemberItem(viewer("ada@example.com"), item)?.wished).toBe(true);
    expect(serializeMemberItem(viewer("sue@example.com"), item)?.wished).toBe(false);
    expect(serializeMemberItem(viewer("nobody@example.com"), item)?.wished).toBe(false);
  });

  it("returns null for a hidden item, or a closed item unless the viewer is an admin", () => {
    const friend = session("friend", ["jewelry"]);
    expect(serializeMemberItem(friend, { ...item, topicSlug: "aviation" })).toBeNull();
    for (const status of ["accepted", "staged", "delivered"] as const) {
      expect(serializeMemberItem(session("family"), { ...item, status })).toBeNull();
      expect(serializeMemberItem(friend, { ...item, status })).toBeNull();
    }
    for (const status of ["open", "accepted", "staged", "delivered"] as const) {
      expect(serializeMemberItem(session("admin"), { ...item, status })?.status).toBe(status);
    }
    expect(serializeMemberItem(session("admin"), item)).not.toHaveProperty("acceptedFor");
    const acceptedItem: RawItem = {
      ...item,
      status: "delivered",
      wishes: [{ email: "ada@example.com", name: "Ada Family", status: "accepted", kind: "now" }],
    };
    expect(serializeMemberItem(session("admin"), acceptedItem)?.acceptedFor).toBe("Ada Family");
    expect(serializeMemberItem(session("family"), item)).not.toHaveProperty("status");
    expect(serializeMemberItem(session("family"), item)).not.toHaveProperty("acceptedFor");
    expect(serializeMemberItem(friend, item)).not.toHaveProperty("status");
    expect(serializeMemberItem(friend, item)).not.toHaveProperty("acceptedFor");
  });
});

describe("mail text", () => {
  it("mentions a price only on a friend's winner note", () => {
    expect(winnerText({ title: "Brass pin", priceCents: 1995 }, "friend")).toContain("$19.95");
    expect(winnerText({ title: "Brass pin", priceCents: 1995 }, "family")).not.toContain("price");
    expect(winnerText({ title: "Brass pin", priceCents: 1995 }, "admin")).not.toContain("19.95");
    expect(formatCents(1995)).toBe("$19.95");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
  });

  it("builds an apology with no place for a winner or a price", () => {
    const text = apologyText({ title: "Brass pin", photoUrl: "/photo/4" });
    expect(text).toContain("Brass pin");
    expect(text).toContain("/photo/4");
    expect(text.toLowerCase()).not.toContain("price");
  });
});

describe("topic slugs", () => {
  it("lowercases and dashes a name, and falls back to topic when nothing is left", () => {
    expect(slugify("  Knick-Knacks & Things! ")).toBe("knick-knacks-things");
    expect(slugify("!!!")).toBe("topic");
  });
});

describe("price field", () => {
  it("accepts whole cents from 0 to $1,000,000 and treats blank as no price", () => {
    expect(centsField(0)).toBe(0);
    expect(centsField(1995)).toBe(1995);
    expect(centsField(100_000_000)).toBe(100_000_000);
    expect(centsField(null)).toBeNull();
    expect(centsField("")).toBeNull();
  });

  it("rejects a negative, fractional, too large, or non-number price", () => {
    for (const bad of [-1, 19.95, 100_000_001, "1995", true]) expect(centsField(bad)).toBe("bad");
  });
});

describe("accept log time", () => {
  it("writes Central time as a plain local timestamp", () => {
    expect(timestampCT(Date.UTC(2026, 9, 20, 17, 5, 9))).toBe("2026-10-20T12:05:09");
    expect(timestampCT(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("2026-01-01T21:04:05");
  });
});

describe("Merit secret", () => {
  it("accepts only the configured secret, and nothing when none is configured", () => {
    expect(meritSecretAllowed("s3cret", "s3cret")).toBe(true);
    expect(meritSecretAllowed("guess", "s3cret")).toBe(false);
    expect(meritSecretAllowed("", "")).toBe(false);
    expect(meritSecretAllowed("anything", "")).toBe(false);
  });
});

describe("Merit resolution", () => {
  it("treats an admin as admin", () => {
    const { result } = resolvePerson("Admin@Example.com", lists, { name: "Pat Admin" });
    expect(result).toMatchObject({ ok: true, group: "admin", topics: "all", firstName: "Pat" });
  });

  it("makes a family address family without touching the friends list", () => {
    const { result, lists: next } = resolvePerson("ada@example.com", lists, { name: "Ada Family" });
    expect(result).toMatchObject({ ok: true, group: "family", topics: "all" });
    expect(next.friends).toEqual(lists.friends);
  });

  it("makes a friends-list address a friend", () => {
    const { result } = resolvePerson("bea@example.com", lists, null);
    expect(result).toMatchObject({ ok: true, group: "friend" });
  });

  it("ignores a blank list line and keeps a one-letter entry", () => {
    const blank = { ...lists, friends: ["bea@example.com", "   "] };
    const kept = resolvePerson("bea@example.com", blank, null);
    expect(kept.lists.friends).toEqual(["bea@example.com"]);
    expect(resolvePerson("   ", blank, null).result).toEqual({ ok: false, reason: "not_contact" });
    const short = { ...lists, friends: ["b"] };
    const one = resolvePerson("b", short, null);
    expect(one.result).toMatchObject({ ok: true, group: "friend" });
    expect(one.lists.friends).toEqual(["b"]);
  });

  it("gives a friend only the granted topics", () => {
    const granted = resolvePerson("bea@example.com", lists, { name: "Bea Friend" });
    expect(granted.result).toMatchObject({ ok: true, topics: ["jewelry"], firstName: "Bea" });
    const empty = resolvePerson("bea@example.com", { ...lists, grants: {} }, null);
    expect(empty.result).toMatchObject({ ok: true, topics: [] });
  });

  it("adds the default topics to every friend, including one just appended", () => {
    const grants = {
      default: ["aviation", "electronics", "knick-knacks"],
      "bea@example.com": ["jewelry", "aviation"],
      "no-extra@example.com": [],
    };
    const withDefault = { ...lists, friends: [...lists.friends, "no-extra@example.com"], grants };
    const bea = resolvePerson("bea@example.com", withDefault, { name: "Bea Friend" });
    expect(bea.result).toMatchObject({
      ok: true,
      topics: ["aviation", "electronics", "knick-knacks", "jewelry"],
    });
    const onlyDefault = resolvePerson("no-extra@example.com", withDefault, null);
    expect(onlyDefault.result).toMatchObject({
      ok: true,
      topics: ["aviation", "electronics", "knick-knacks"],
    });
    const added = resolvePerson("cara@example.com", withDefault, { name: "Cara Stone" });
    expect(added.result).toMatchObject({
      ok: true,
      group: "friend",
      topics: ["aviation", "electronics", "knick-knacks"],
    });
    expect(added.lists.friends).toContain("cara@example.com");
  });

  it("drops a trailing carriage return from the contact name", () => {
    const entity = resolvePerson("bea@example.com", lists, { name: "Bea Friend&#13;" });
    expect(entity.result).toMatchObject({ ok: true, name: "Bea Friend", firstName: "Bea" });
    const blank = resolvePerson("bea@example.com", lists, { name: "&#13;" });
    expect(blank.result).toMatchObject({ ok: true, name: "bea", firstName: "bea" });
  });

  it("appends a matching contact as a friend", () => {
    const { result, lists: next } = resolvePerson("cara@example.com", lists, { name: "Cara Stone" });
    expect(result).toMatchObject({ ok: true, group: "friend", topics: [], firstName: "Cara" });
    expect(next.friends).toContain("cara@example.com");
  });

  it("returns not_contact, and error when CardDAV fails", () => {
    expect(resolvePerson("nope@example.com", lists, null).result).toEqual({
      ok: false,
      reason: "not_contact",
    });
    expect(resolvePerson("nope@example.com", lists, "error").result).toEqual({ ok: false, reason: "error" });
  });

  it("lets an admin in when the card lookup fails", () => {
    const { result } = resolvePerson("admin@example.com", lists, "error");
    expect(result).toMatchObject({ ok: true, group: "admin", firstName: "admin" });
  });

  it("prefers family over friends when the address is on both lists", () => {
    const both = { ...lists, friends: [...lists.friends, "ada@example.com"] };
    const { result } = resolvePerson("ada@example.com", both, { name: "Ada Family" });
    expect(result).toMatchObject({ ok: true, group: "family", topics: "all" });
  });

  it("prefers admin when the address is on more than one list", () => {
    const both = { ...lists, family: ["admin@example.com"] };
    const { result } = resolvePerson("admin@example.com", both, { name: "Pat Admin" });
    expect(result).toMatchObject({ ok: true, group: "admin" });
  });
});

describe("admin wish data on member items", () => {
  const withIds: RawItem = { ...item, wishes: item.wishes.map((wish, n) => ({ ...wish, id: 31 + n })) };

  it("gives an admin every active wish with its id, the admin's own included", () => {
    const view = serializeMemberItem({ ...session("admin"), email: "ada@example.com" }, withIds);
    expect(view?.activeWishes).toEqual([
      { id: 31, name: "Ada Family", kind: "someday" },
      { id: 32, name: "Bea Friend", kind: "now" },
    ]);
  });

  it("never gives family or friends the wish list", () => {
    expect(serializeMemberItem(session("family"), withIds)).not.toHaveProperty("activeWishes");
    expect(serializeMemberItem(session("friend", ["jewelry"]), withIds)).not.toHaveProperty("activeWishes");
  });
});
