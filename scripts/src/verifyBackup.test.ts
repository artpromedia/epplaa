import { describe, it, expect } from "vitest";
import { evaluateLiveCounts, parseLiveCountsManifest } from "./verifyBackup";

describe("evaluateLiveCounts", () => {
  it("returns no violations when restored exactly matches live", () => {
    const expected = new Map([
      ["audit_events", 1000],
      ["orders", 500],
    ]);
    const restored = new Map([
      ["audit_events", 1000],
      ["orders", 500],
    ]);
    expect(evaluateLiveCounts(expected, restored, 0.99)).toEqual([]);
  });

  it("returns no violations when restored is within the ratio", () => {
    const expected = new Map([["audit_events", 1000]]);
    const restored = new Map([["audit_events", 995]]);
    expect(evaluateLiveCounts(expected, restored, 0.99)).toEqual([]);
  });

  it("flags a table where restored is below the ratio", () => {
    const expected = new Map([["audit_events", 1000]]);
    const restored = new Map([["audit_events", 980]]);
    const v = evaluateLiveCounts(expected, restored, 0.99);
    expect(v).toEqual([
      { table: "audit_events", expected: 1000, restored: 980, ratio: 0.98 },
    ]);
  });

  it("treats a missing restored count as zero (catches silent table-skip)", () => {
    const expected = new Map([["audit_events", 1000]]);
    const restored = new Map<string, number>();
    const v = evaluateLiveCounts(expected, restored, 0.99);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ table: "audit_events", expected: 1000, restored: 0 });
    expect(v[0]?.ratio).toBe(0);
  });

  it("treats a live count of zero as always satisfied", () => {
    const expected = new Map([["empty_lookup", 0]]);
    const restored = new Map([["empty_lookup", 0]]);
    expect(evaluateLiveCounts(expected, restored, 0.99)).toEqual([]);
  });

  it("treats a live count of zero as satisfied even when restored is also missing", () => {
    const expected = new Map([["empty_lookup", 0]]);
    const restored = new Map<string, number>();
    expect(evaluateLiveCounts(expected, restored, 0.99)).toEqual([]);
  });

  it("flags multiple violations across tables and ignores extra restored tables", () => {
    const expected = new Map([
      ["a", 100],
      ["b", 200],
      ["c", 300],
    ]);
    const restored = new Map([
      ["a", 100],
      ["b", 50],
      ["c", 290],
      ["d", 9999], // not in expected -> ignored
    ]);
    const v = evaluateLiveCounts(expected, restored, 0.99);
    expect(v.map((x) => x.table).sort()).toEqual(["b", "c"]);
  });

  it("respects a looser ratio threshold", () => {
    const expected = new Map([["audit_events", 1000]]);
    const restored = new Map([["audit_events", 800]]);
    expect(evaluateLiveCounts(expected, restored, 0.75)).toEqual([]);
    expect(evaluateLiveCounts(expected, restored, 0.85)).toHaveLength(1);
  });
});

describe("parseLiveCountsManifest", () => {
  it("parses a valid flat object manifest", () => {
    const m = parseLiveCountsManifest(`{"audit_events": 1234567, "orders": 56}`);
    expect(m.get("audit_events")).toBe(1234567);
    expect(m.get("orders")).toBe(56);
    expect(m.size).toBe(2);
  });

  it("accepts a zero count (a genuinely empty live table is operator-declared)", () => {
    const m = parseLiveCountsManifest(`{"empty_lookup": 0}`);
    expect(m.get("empty_lookup")).toBe(0);
  });

  it("rejects an array root", () => {
    expect(() => parseLiveCountsManifest(`[1, 2, 3]`)).toThrow(
      /JSON object mapping table name -> row count/,
    );
  });

  it("rejects a numeric root", () => {
    expect(() => parseLiveCountsManifest(`123`)).toThrow();
  });

  it("rejects a null root", () => {
    expect(() => parseLiveCountsManifest(`null`)).toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => parseLiveCountsManifest(`not json`)).toThrow(/not valid JSON/);
  });

  it("rejects fractional counts", () => {
    expect(() => parseLiveCountsManifest(`{"a": 1.5}`)).toThrow(/non-negative integer/);
  });

  it("rejects string counts", () => {
    expect(() => parseLiveCountsManifest(`{"a": "10"}`)).toThrow(/non-negative integer/);
  });

  it("rejects negative counts", () => {
    expect(() => parseLiveCountsManifest(`{"a": -1}`)).toThrow(/non-negative integer/);
  });

  it("rejects null entry values", () => {
    expect(() => parseLiveCountsManifest(`{"a": null}`)).toThrow(/non-negative integer/);
  });
});
