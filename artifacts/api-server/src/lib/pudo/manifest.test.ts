import { describe, it, expect } from "vitest";
import { contentHashOf, csvCell } from "./manifest";

describe("manifest pure helpers", () => {
  describe("csvCell", () => {
    it("renders plain values verbatim", () => {
      expect(csvCell("hello")).toBe("hello");
      expect(csvCell("ord_123")).toBe("ord_123");
    });

    it("coerces null and undefined to empty string", () => {
      expect(csvCell(null)).toBe("");
      expect(csvCell(undefined)).toBe("");
    });

    it("escapes commas by quoting", () => {
      expect(csvCell("Lagos, Nigeria")).toBe('"Lagos, Nigeria"');
    });

    it("escapes embedded double-quotes by doubling them", () => {
      expect(csvCell('Smith "Big Mike" Doe')).toBe('"Smith ""Big Mike"" Doe"');
    });

    it("escapes embedded newlines (real PUDO addresses sometimes contain them)", () => {
      expect(csvCell("123 Main\nFlat 4")).toBe('"123 Main\nFlat 4"');
    });
  });

  describe("contentHashOf", () => {
    it("returns a stable 16-char hex prefix of sha256", () => {
      const a = contentHashOf("hello");
      expect(a).toMatch(/^[0-9a-f]{16}$/);
      expect(contentHashOf("hello")).toBe(a);
    });

    it("differs when the bytes differ", () => {
      // Even a one-byte change must flip the hash, otherwise the
      // dedupe in delivery.ts would let two distinct manifests
      // collide and a partner would silently see stale data.
      expect(contentHashOf("hello\n")).not.toBe(contentHashOf("hello"));
      expect(contentHashOf("a,b,c")).not.toBe(contentHashOf("a,b,d"));
    });

    it("is order-sensitive (row reordering must change the hash)", () => {
      const csv1 = "header\nrow_a\nrow_b\n";
      const csv2 = "header\nrow_b\nrow_a\n";
      // This is exactly what makes the deterministic sort in
      // buildManifestCsv mandatory — without it, two rebuilds
      // milliseconds apart could shuffle rows and defeat dedupe.
      expect(contentHashOf(csv1)).not.toBe(contentHashOf(csv2));
    });
  });
});
