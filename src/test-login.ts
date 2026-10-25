// TEMPORARY test bypass, remove: <name>@familytest signs in as family and
// <name>@friendtest as friend, with no code and no Merit lookup. Only when the
// Worker var TEST_LOGINS is "on". Never grants admin.

export type TestPerson = { email: string; name: string; group: "family" | "friend" };

export function testLogin(value: unknown, env: Env): TestPerson | null {
  if (String(env.TEST_LOGINS) !== "on" || typeof value !== "string") return null;
  const match = /^([^\s@]+)@(familytest|friendtest)$/.exec(value.trim().toLowerCase());
  if (!match) return null;
  return { email: match[0], name: match[1], group: match[2] === "familytest" ? "family" : "friend" };
}
