import { describe, it, expect } from "vitest";
import { redactString, redactJson } from "../lib/redaction.js";

describe("redactString", () => {
  it("redacts emails", () => {
    expect(redactString("contact me at jane.doe@example.com please")).toBe(
      "contact me at [REDACTED:email] please",
    );
  });

  it("redacts Nigerian phone numbers in both E.164 and local form", () => {
    expect(redactString("Call +2348012345678 or 08012345678")).toBe(
      "Call [REDACTED:phone] or [REDACTED:phone]",
    );
  });

  it("redacts 11-digit identifiers (BVN/NIN)", () => {
    expect(redactString("BVN: 12345678901")).toBe("[REDACTED:account]");
    // Bare 11-digit number (no account/BVN/NIN prefix): caught by ID11_RE.
    expect(redactString("id 12345678901 here")).toBe(
      "id [REDACTED:id11] here",
    );
  });

  it("redacts a Luhn-valid PAN but leaves a non-PAN long digit run", () => {
    // 4111 1111 1111 1111 is a well-known Luhn-valid Visa test PAN.
    expect(redactString("card 4111 1111 1111 1111 ok")).toBe("card [REDACTED:pan] ok");
    // 16 digits that fail Luhn — leave as-is (could be a tracking number).
    expect(redactString("ref 1234567890123456 ok")).toBe(
      "ref 1234567890123456 ok",
    );
  });

  it("redacts only account-prefixed 10-digit Nigerian bank numbers", () => {
    expect(redactString("account 0123456789")).toBe(
      "[REDACTED:account]",
    );
    // Bare 10-digit number (e.g. order-id-ish): not redacted.
    expect(redactString("order 0123456789")).toBe("order 0123456789");
  });

  it("returns empty string unchanged", () => {
    expect(redactString("")).toBe("");
  });
});

describe("redactJson", () => {
  it("walks nested objects and arrays", () => {
    const input = {
      buyer: { email: "a@b.com", phone: "+2348012345678" },
      items: [{ note: "BVN 12345678901" }, "free@form.com"],
      total: 1000,
    };
    const out = redactJson(input);
    expect(out).toEqual({
      buyer: { email: "[REDACTED:email]", phone: "[REDACTED:phone]" },
      items: [{ note: "[REDACTED:account]" }, "[REDACTED:email]"],
      total: 1000,
    });
    // Original is not mutated.
    expect(input.buyer.email).toBe("a@b.com");
  });

  it("handles cycles without infinite recursion", () => {
    const a: Record<string, unknown> = { name: "x@y.com" };
    a.self = a;
    const out = redactJson(a) as Record<string, unknown>;
    expect(out.name).toBe("[REDACTED:email]");
    expect(out.self).toBe("[REDACTED:cycle]");
  });

  it("preserves non-string scalars", () => {
    const out = redactJson({ n: 42, b: true, nu: null });
    expect(out).toEqual({ n: 42, b: true, nu: null });
  });
});
