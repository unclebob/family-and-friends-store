import { describe, expect, it } from "vitest";
import { emailForPhone, maskEmail, normalizePhone, parsePhones } from "../src/phone";

describe("phone numbers", () => {
  it("keeps the ten digits of a US number however it is written", () => {
    expect(normalizePhone("(312) 555-0100")).toBe("3125550100");
    expect(normalizePhone("+1 312.555.0100")).toBe("3125550100");
    expect(normalizePhone("1-312-555-0100")).toBe("3125550100");
    expect(normalizePhone("3125550100")).toBe("3125550100");
  });

  it("refuses anything that is not a US number", () => {
    expect(normalizePhone("555-0100")).toBeNull();
    expect(normalizePhone("2-312-555-0100")).toBeNull();
    expect(normalizePhone("+44 20 7946 0958")).toBeNull();
    expect(normalizePhone("ada@example.com")).toBeNull();
    expect(normalizePhone("312555010x")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(42)).toBeNull();
  });

  it("reads phones.txt as email: phone, phone and skips comments and bad numbers", () => {
    const text = "# who has which phone\n Ada@Example.com : (312) 555-0100, +1 312 555 0101\n\nbea@example.com: 12\nnot a line\n";
    expect(parsePhones(text)).toEqual([
      { email: "ada@example.com", phone: "3125550100" },
      { email: "ada@example.com", phone: "3125550101" },
    ]);
  });

  it("finds the one email for a number, and nothing when none or two share it", () => {
    const phones = parsePhones("ada@example.com: 312 555 0100\nbea@example.com: 312 555 0101\ncy@example.com: 312 555 0101\nada@example.com: 312 555 0100\n");
    expect(emailForPhone(phones, "3125550100")).toBe("ada@example.com");
    expect(emailForPhone(phones, "3125550101")).toBeNull();
    expect(emailForPhone(phones, "3125550199")).toBeNull();
  });

  it("masks an email down to its first letter and domain", () => {
    expect(maskEmail("person@example.org")).toBe("p•••@example.org");
    expect(maskEmail("a@b.org")).toBe("a•••@b.org");
  });
});
