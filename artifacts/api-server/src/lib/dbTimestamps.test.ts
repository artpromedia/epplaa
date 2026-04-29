import { describe, it, expect } from "vitest";
import { toDateOrNull } from "./dbTimestamps";

describe("toDateOrNull", () => {
  it("returns null for null and undefined", () => {
    expect(toDateOrNull(null)).toBeNull();
    expect(toDateOrNull(undefined)).toBeNull();
  });

  it("passes a Date instance through unchanged", () => {
    const d = new Date("2026-04-29T02:24:19.178Z");
    const out = toDateOrNull(d);
    expect(out).toBe(d);
  });

  it("parses an ISO string", () => {
    const out = toDateOrNull("2026-04-29T02:24:19.178Z");
    expect(out).toBeInstanceOf(Date);
    expect(out?.toISOString()).toBe("2026-04-29T02:24:19.178Z");
  });

  it("parses the raw pg TIMESTAMPTZ string shape", () => {
    // Exactly the shape `db.execute(sql`...`)` returns for a TIMESTAMPTZ
    // column — this is the case that was 500ing on /mfa/status before
    // the helper existed.
    const raw = "2026-04-29 02:24:19.178034+00";
    const out = toDateOrNull(raw);
    expect(out).toBeInstanceOf(Date);
    expect(out?.toISOString()).toBe("2026-04-29T02:24:19.178Z");
  });

  it("returns null for an unparseable string instead of throwing", () => {
    expect(toDateOrNull("not a date at all")).toBeNull();
  });

  it("survives the .toISOString() call the route layer makes", () => {
    // Regression guard: this is the exact pattern routes/mfa.ts uses.
    const raw = "2026-04-29 02:24:19.178034+00";
    const normalised = toDateOrNull(raw);
    expect(() => normalised?.toISOString()).not.toThrow();
  });
});
