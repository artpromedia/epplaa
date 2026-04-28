import { describe, it, expect } from "vitest";
import { __test__ } from "./apiRateLimit";

describe("InMemoryStore bucket exhaustion", () => {
  it("admits up to max within window then 429s", () => {
    const store = new __test__.InMemoryStore();
    const now = Date.now();
    const out: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      out.push(store.bump("k", now + i, 1000, 3).allowed);
    }
    expect(out).toEqual([true, true, true, false, false]);
  });

  it("releases a slot once a hit slides out of the window", () => {
    const store = new __test__.InMemoryStore();
    const t0 = 1_000_000;
    expect(store.bump("k", t0, 1000, 1).allowed).toBe(true);
    expect(store.bump("k", t0 + 100, 1000, 1).allowed).toBe(false);
    // Move the clock past the window edge so the prior hit is dropped.
    expect(store.bump("k", t0 + 1500, 1000, 1).allowed).toBe(true);
  });

  it("returns a sane Retry-After hint when full", () => {
    const store = new __test__.InMemoryStore();
    const t0 = 2_000_000;
    store.bump("k", t0, 1000, 1);
    const r = store.bump("k", t0 + 200, 1000, 1);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(800);
    expect(r.retryAfterMs).toBeLessThanOrEqual(1000);
  });
});
