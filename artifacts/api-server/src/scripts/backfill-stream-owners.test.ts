import { describe, it, expect } from "vitest";
import {
  buildHandleIndex,
  resolveStreams,
  type SellerHandleEntry,
  type StreamHandleEntry,
} from "./backfill-stream-owners";

describe("backfill-stream-owners pure helpers", () => {
  describe("buildHandleIndex", () => {
    it("indexes a seller under both storeHandle and storeName", () => {
      const sellers: SellerHandleEntry[] = [
        {
          userId: "user_1",
          application: { storeHandle: "lagoslooks", storeName: "Lagos Looks" },
        },
      ];
      const idx = buildHandleIndex(sellers);
      expect(idx.get("lagoslooks")).toEqual(new Set(["user_1"]));
      expect(idx.get("Lagos Looks")).toEqual(new Set(["user_1"]));
    });

    it("ignores sellers with no application JSON", () => {
      const sellers: SellerHandleEntry[] = [
        { userId: "user_1", application: null },
      ];
      const idx = buildHandleIndex(sellers);
      expect(idx.size).toBe(0);
    });

    it("collapses multiple sellers sharing a handle into a single Set entry", () => {
      const sellers: SellerHandleEntry[] = [
        { userId: "user_1", application: { storeHandle: "shared" } },
        { userId: "user_2", application: { storeHandle: "shared" } },
      ];
      const idx = buildHandleIndex(sellers);
      expect(idx.get("shared")).toEqual(new Set(["user_1", "user_2"]));
    });

    it("skips empty / placeholder handles so the literal 'seller' fallback is never indexed", () => {
      const sellers: SellerHandleEntry[] = [
        { userId: "user_a", application: { storeHandle: "", storeName: "" } },
        { userId: "user_b", application: { storeHandle: "seller" } },
        { userId: "user_c", application: { storeName: "seller" } },
      ];
      const idx = buildHandleIndex(sellers);
      expect(idx.size).toBe(0);
    });

    it("trims whitespace before indexing so a profile saved with stray spaces still matches", () => {
      const sellers: SellerHandleEntry[] = [
        { userId: "user_1", application: { storeHandle: "  lagoslooks  " } },
      ];
      const idx = buildHandleIndex(sellers);
      expect(idx.get("lagoslooks")).toEqual(new Set(["user_1"]));
    });
  });

  describe("resolveStreams", () => {
    const idx = buildHandleIndex([
      { userId: "user_1", application: { storeHandle: "lagoslooks" } },
      { userId: "user_2", application: { storeHandle: "kano-textiles", storeName: "Kano Textiles" } },
      { userId: "user_3", application: { storeHandle: "duplicate" } },
      { userId: "user_4", application: { storeHandle: "duplicate" } },
    ]);

    it("resolves a stream whose hostName matches exactly one seller", () => {
      const streams: StreamHandleEntry[] = [
        { id: "str_1", hostName: "lagoslooks" },
        { id: "str_2", hostName: "Kano Textiles" },
      ];
      const result = resolveStreams(streams, idx);
      expect(result.resolved.get("str_1")).toBe("user_1");
      expect(result.resolved.get("str_2")).toBe("user_2");
      expect(result.ambiguous).toEqual([]);
      expect(result.unmatched).toEqual([]);
      expect(result.generic).toEqual([]);
    });

    it("buckets a stream whose hostName matches multiple sellers as ambiguous", () => {
      const streams: StreamHandleEntry[] = [{ id: "str_1", hostName: "duplicate" }];
      const result = resolveStreams(streams, idx);
      expect(result.resolved.size).toBe(0);
      expect(result.ambiguous).toEqual(["str_1"]);
    });

    it("buckets a stream whose hostName matches zero sellers as unmatched", () => {
      const streams: StreamHandleEntry[] = [{ id: "str_1", hostName: "ghost-store" }];
      const result = resolveStreams(streams, idx);
      expect(result.resolved.size).toBe(0);
      expect(result.unmatched).toEqual(["str_1"]);
    });

    it("buckets the literal 'seller' fallback and the empty hostName as generic, never matching them to a real seller", () => {
      const streams: StreamHandleEntry[] = [
        { id: "str_a", hostName: "seller" },
        { id: "str_b", hostName: "" },
        { id: "str_c", hostName: "   " },
      ];
      const result = resolveStreams(streams, idx);
      expect(result.resolved.size).toBe(0);
      expect(result.generic.sort()).toEqual(["str_a", "str_b", "str_c"]);
    });

    it("handles a mixed batch and reports each bucket separately", () => {
      const streams: StreamHandleEntry[] = [
        { id: "ok", hostName: "lagoslooks" },
        { id: "amb", hostName: "duplicate" },
        { id: "miss", hostName: "ghost-store" },
        { id: "gen", hostName: "seller" },
      ];
      const result = resolveStreams(streams, idx);
      expect([...result.resolved.entries()]).toEqual([["ok", "user_1"]]);
      expect(result.ambiguous).toEqual(["amb"]);
      expect(result.unmatched).toEqual(["miss"]);
      expect(result.generic).toEqual(["gen"]);
    });
  });
});
