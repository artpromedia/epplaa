import { describe, it, expect } from "vitest";
import {
  evaluateDrillSlos,
  evaluateLiveCounts,
  evaluateWeekOverWeekDrops,
  parseDrillProbeQueries,
  parseLiveCountsManifest,
  parseSha256Manifest,
  parseWeekOverWeekHistory,
} from "./verifyBackup";

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

describe("evaluateWeekOverWeekDrops", () => {
  it("returns no drops when current matches prior", () => {
    const prior = new Map([
      ["audit_events", 1000],
      ["orders", 500],
    ]);
    const current = new Map([
      ["audit_events", 1000],
      ["orders", 500],
    ]);
    expect(evaluateWeekOverWeekDrops(prior, current, 0.2)).toEqual([]);
  });

  it("returns no drops when current grew (one-directional check)", () => {
    const prior = new Map([["audit_events", 1000]]);
    const current = new Map([["audit_events", 1_000_000]]);
    expect(evaluateWeekOverWeekDrops(prior, current, 0.2)).toEqual([]);
  });

  it("returns no drops when the drop is exactly at the threshold", () => {
    // 20% drop = 800 from 1000. Threshold of 0.2 means "more than 20%
    // is bad", so exactly-20% should pass — this matches the comparison
    // operator (`> maxDropRatio`, not `>=`).
    const prior = new Map([["audit_events", 1000]]);
    const current = new Map([["audit_events", 800]]);
    expect(evaluateWeekOverWeekDrops(prior, current, 0.2)).toEqual([]);
  });

  it("flags a table where the drop exceeds the threshold", () => {
    const prior = new Map([["audit_events", 1000]]);
    const current = new Map([["audit_events", 700]]);
    const drops = evaluateWeekOverWeekDrops(prior, current, 0.2);
    expect(drops).toEqual([
      { table: "audit_events", prior: 1000, current: 700, dropRatio: 0.3 },
    ]);
  });

  it("treats a missing current count as a 100% drop (catches silent table-skip)", () => {
    const prior = new Map([["orders", 500]]);
    const current = new Map<string, number>();
    const drops = evaluateWeekOverWeekDrops(prior, current, 0.2);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ table: "orders", prior: 500, current: 0, dropRatio: 1 });
  });

  it("catches the motivating regression (orders 1.2M -> 5)", () => {
    const prior = new Map([["orders", 1_200_000]]);
    const current = new Map([["orders", 5]]);
    const drops = evaluateWeekOverWeekDrops(prior, current, 0.2);
    expect(drops).toHaveLength(1);
    expect(drops[0]?.table).toBe("orders");
    expect(drops[0]?.dropRatio).toBeGreaterThan(0.99);
  });

  it("skips tables whose prior count is zero (no meaningful baseline)", () => {
    const prior = new Map([["empty_lookup", 0]]);
    const current = new Map([["empty_lookup", 0]]);
    expect(evaluateWeekOverWeekDrops(prior, current, 0.2)).toEqual([]);
  });

  it("ignores tables present in current but absent from prior (no baseline yet)", () => {
    const prior = new Map<string, number>();
    const current = new Map([["audit_events", 1000]]);
    expect(evaluateWeekOverWeekDrops(prior, current, 0.2)).toEqual([]);
  });

  it("flags multiple violations across tables", () => {
    const prior = new Map([
      ["a", 1000],
      ["b", 200],
      ["c", 500],
    ]);
    const current = new Map([
      ["a", 1000], // unchanged -> ok
      ["b", 50], // 75% drop -> flagged
      ["c", 100], // 80% drop -> flagged
    ]);
    const drops = evaluateWeekOverWeekDrops(prior, current, 0.2);
    expect(drops.map((d) => d.table).sort()).toEqual(["b", "c"]);
  });

  it("respects a stricter threshold (zero tolerance)", () => {
    const prior = new Map([["audit_events", 1000]]);
    const current = new Map([["audit_events", 999]]);
    expect(evaluateWeekOverWeekDrops(prior, current, 0)).toHaveLength(1);
  });

  it("respects a looser threshold (90% drop allowed)", () => {
    const prior = new Map([["audit_events", 1000]]);
    const current = new Map([["audit_events", 100]]);
    expect(evaluateWeekOverWeekDrops(prior, current, 0.9)).toEqual([]);
    expect(evaluateWeekOverWeekDrops(prior, current, 0.85)).toHaveLength(1);
  });

  it("disables itself when threshold is 1 (any drop tolerated)", () => {
    const prior = new Map([["audit_events", 1000]]);
    const current = new Map([["audit_events", 0]]);
    expect(evaluateWeekOverWeekDrops(prior, current, 1)).toEqual([]);
  });
});

describe("parseWeekOverWeekHistory", () => {
  it("parses a valid versioned history file", () => {
    const json = JSON.stringify({
      version: 1,
      entries: [
        { timestamp: "2026-04-22T03:00:00.000Z", counts: { audit_events: 1000, orders: 500 } },
        { timestamp: "2026-04-29T03:00:00.000Z", counts: { audit_events: 1100, orders: 510 } },
      ],
    });
    const h = parseWeekOverWeekHistory(json);
    expect(h.version).toBe(1);
    expect(h.entries).toHaveLength(2);
    expect(h.entries[1]?.counts.orders).toBe(510);
  });

  it("parses an empty entries array", () => {
    const h = parseWeekOverWeekHistory(`{"version": 1, "entries": []}`);
    expect(h.entries).toEqual([]);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseWeekOverWeekHistory(`not json`)).toThrow(/not valid JSON/);
  });

  it("rejects an array root", () => {
    expect(() => parseWeekOverWeekHistory(`[]`)).toThrow(/object with .version, entries/);
  });

  it("rejects a null root", () => {
    expect(() => parseWeekOverWeekHistory(`null`)).toThrow(/object with .version, entries/);
  });

  it("rejects an unknown version (forward-compat)", () => {
    expect(() =>
      parseWeekOverWeekHistory(`{"version": 2, "entries": []}`),
    ).toThrow(/unknown version/);
  });

  it("rejects a missing entries field", () => {
    expect(() =>
      parseWeekOverWeekHistory(`{"version": 1}`),
    ).toThrow(/entries.* must be an array/);
  });

  it("rejects an entry that's not an object", () => {
    expect(() =>
      parseWeekOverWeekHistory(`{"version": 1, "entries": ["not-an-object"]}`),
    ).toThrow(/entry must be an object/);
  });

  it("rejects an entry with no timestamp", () => {
    expect(() =>
      parseWeekOverWeekHistory(
        `{"version": 1, "entries": [{"counts": {"a": 1}}]}`,
      ),
    ).toThrow(/timestamp/);
  });

  it("rejects an entry with an empty timestamp", () => {
    expect(() =>
      parseWeekOverWeekHistory(
        `{"version": 1, "entries": [{"timestamp": "", "counts": {"a": 1}}]}`,
      ),
    ).toThrow(/timestamp/);
  });

  it("rejects an entry with non-object counts", () => {
    expect(() =>
      parseWeekOverWeekHistory(
        `{"version": 1, "entries": [{"timestamp": "t", "counts": [1, 2]}]}`,
      ),
    ).toThrow(/counts.* must be an object/);
  });

  it("rejects fractional count values", () => {
    expect(() =>
      parseWeekOverWeekHistory(
        `{"version": 1, "entries": [{"timestamp": "t", "counts": {"a": 1.5}}]}`,
      ),
    ).toThrow(/non-negative integer/);
  });

  it("rejects negative count values", () => {
    expect(() =>
      parseWeekOverWeekHistory(
        `{"version": 1, "entries": [{"timestamp": "t", "counts": {"a": -1}}]}`,
      ),
    ).toThrow(/non-negative integer/);
  });

  it("rejects string count values", () => {
    expect(() =>
      parseWeekOverWeekHistory(
        `{"version": 1, "entries": [{"timestamp": "t", "counts": {"a": "1"}}]}`,
      ),
    ).toThrow(/non-negative integer/);
  });

  it("accepts a zero count (a genuinely empty table is operator-meaningful)", () => {
    const h = parseWeekOverWeekHistory(
      `{"version": 1, "entries": [{"timestamp": "t", "counts": {"a": 0}}]}`,
    );
    expect(h.entries[0]?.counts.a).toBe(0);
  });
});

describe("parseSha256Manifest", () => {
  const sha = "a".repeat(64);
  const sha2 = "b".repeat(64);

  it("parses a single sha256sum-format line and returns the matching digest", () => {
    expect(parseSha256Manifest(`${sha}  2026-04-29.dump\n`, "2026-04-29.dump")).toBe(sha);
  });

  it("accepts a binary-mode separator (` *<name>`)", () => {
    expect(parseSha256Manifest(`${sha} *2026-04-29.dump\n`, "2026-04-29.dump")).toBe(sha);
  });

  it("normalizes uppercase hex to lowercase so it matches createHash output", () => {
    const upper = "ABCDEF".repeat(10) + "1234"; // 64 chars
    expect(parseSha256Manifest(`${upper}  d.dump`, "d.dump")).toBe(upper.toLowerCase());
  });

  it("strips a directory prefix from the manifest's name column", () => {
    expect(parseSha256Manifest(`${sha}  ./backups/2026-04-29.dump`, "2026-04-29.dump")).toBe(sha);
  });

  it("picks the entry matching dumpBasename when several lines are present", () => {
    const manifest = [
      `${sha2}  2026-04-28.dump`,
      `${sha}  2026-04-29.dump`,
      `${"c".repeat(64)}  2026-04-30.dump`,
    ].join("\n");
    expect(parseSha256Manifest(manifest, "2026-04-29.dump")).toBe(sha);
  });

  it("ignores blank lines and comment lines", () => {
    const manifest = `# generated by pg_dump cron\n\n${sha}  2026-04-29.dump\n\n`;
    expect(parseSha256Manifest(manifest, "2026-04-29.dump")).toBe(sha);
  });

  it("falls back to a bare-digest line when no name-matching entry exists", () => {
    expect(parseSha256Manifest(`${sha}\n`, "2026-04-29.dump")).toBe(sha);
  });

  it("prefers the name-matching line over a bare-digest fallback", () => {
    const manifest = `${sha2}\n${sha}  2026-04-29.dump`;
    expect(parseSha256Manifest(manifest, "2026-04-29.dump")).toBe(sha);
  });

  it("throws when manifest is empty", () => {
    expect(() => parseSha256Manifest(``, "x.dump")).toThrow(/empty/);
  });

  it("throws when manifest is whitespace-only", () => {
    expect(() => parseSha256Manifest(`   \n\n  `, "x.dump")).toThrow(/empty/);
  });

  it("throws when no entry matches and there's no bare-digest fallback", () => {
    expect(() => parseSha256Manifest(`${sha}  other.dump`, "wanted.dump")).toThrow(
      /no entry for wanted\.dump/,
    );
  });

  it("throws when the matched digest is the wrong length", () => {
    const short = "a".repeat(40);
    expect(() => parseSha256Manifest(`${short}  d.dump`, "d.dump")).toThrow(/64-char hex/);
  });

  it("throws when the bare-digest fallback is the wrong length", () => {
    const short = "a".repeat(40);
    expect(() => parseSha256Manifest(`${short}\n`, "d.dump")).toThrow(/64-char hex/);
  });

  it("tolerates CRLF line endings", () => {
    expect(parseSha256Manifest(`${sha}  d.dump\r\n`, "d.dump")).toBe(sha);
  });
});

describe("parseDrillProbeQueries", () => {
  it("parses a minimal one-probe array", () => {
    const probes = parseDrillProbeQueries(
      `[{"name": "p1", "sql": "SELECT 1"}]`,
    );
    expect(probes).toEqual([{ name: "p1", sql: "SELECT 1" }]);
  });

  it("preserves expectMinRows when present", () => {
    const probes = parseDrillProbeQueries(
      `[{"name": "p1", "sql": "SELECT 1", "expectMinRows": 5}]`,
    );
    expect(probes[0]).toMatchObject({ name: "p1", expectMinRows: 5 });
  });

  it("accepts a trailing semicolon on the SQL body", () => {
    const probes = parseDrillProbeQueries(
      `[{"name": "p1", "sql": "SELECT 1;"}]`,
    );
    expect(probes[0]?.sql).toBe("SELECT 1;");
  });

  it("rejects multi-statement SQL bodies (semicolon then more text)", () => {
    expect(() =>
      parseDrillProbeQueries(`[{"name": "p1", "sql": "SELECT 1; DROP TABLE users"}]`),
    ).toThrow(/multi-statement/);
  });

  it("rejects an empty array silently — caller decides via the result list", () => {
    expect(parseDrillProbeQueries(`[]`)).toEqual([]);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseDrillProbeQueries(`{not json}`)).toThrow(/not valid JSON/);
  });

  it("rejects a JSON object (must be an array)", () => {
    expect(() => parseDrillProbeQueries(`{"name": "p1"}`)).toThrow(/JSON array/);
  });

  it("rejects an entry without a name", () => {
    expect(() => parseDrillProbeQueries(`[{"sql": "SELECT 1"}]`)).toThrow(
      /missing a 'name'/,
    );
  });

  it("rejects an entry with an empty name", () => {
    expect(() =>
      parseDrillProbeQueries(`[{"name": "", "sql": "SELECT 1"}]`),
    ).toThrow(/missing a 'name'/);
  });

  it("rejects duplicate probe names (would corrupt the report attribution)", () => {
    expect(() =>
      parseDrillProbeQueries(
        `[{"name": "p", "sql": "SELECT 1"}, {"name": "p", "sql": "SELECT 2"}]`,
      ),
    ).toThrow(/duplicate name 'p'/);
  });

  it("rejects an entry without a sql field", () => {
    expect(() => parseDrillProbeQueries(`[{"name": "p1"}]`)).toThrow(
      /missing a non-empty 'sql'/,
    );
  });

  it("rejects an entry with whitespace-only sql", () => {
    expect(() =>
      parseDrillProbeQueries(`[{"name": "p1", "sql": "   "}]`),
    ).toThrow(/missing a non-empty 'sql'/);
  });

  it("rejects fractional expectMinRows", () => {
    expect(() =>
      parseDrillProbeQueries(
        `[{"name": "p1", "sql": "SELECT 1", "expectMinRows": 1.5}]`,
      ),
    ).toThrow(/expectMinRows/);
  });

  it("rejects negative expectMinRows", () => {
    expect(() =>
      parseDrillProbeQueries(
        `[{"name": "p1", "sql": "SELECT 1", "expectMinRows": -1}]`,
      ),
    ).toThrow(/expectMinRows/);
  });

  it("accepts expectMinRows of zero (probe is 'does the SQL run', not 'does it return')", () => {
    const probes = parseDrillProbeQueries(
      `[{"name": "p1", "sql": "SELECT 1", "expectMinRows": 0}]`,
    );
    expect(probes[0]?.expectMinRows).toBe(0);
  });
});

describe("evaluateDrillSlos", () => {
  // 1s = 1000ms, 1h = 3_600_000 ms — keep arithmetic visible in the
  // tests so a future tweak to the math is obvious.
  const sec = 1000;
  const hour = 60 * 60 * 1000;

  it("returns no breaches when wall-time and dump age are well under bounds", () => {
    const start = 1_000_000_000_000;
    const finish = start + 60 * sec; // 60s
    const dumpMtime = start - 1 * hour; // 1h old
    const v = evaluateDrillSlos(start, finish, dumpMtime, 1800, 24);
    expect(v.rtoSeconds).toBe(60);
    expect(v.rpoHours).toBe(1);
    expect(v.rtoBreached).toBe(false);
    expect(v.rpoBreached).toBe(false);
  });

  it("flags an RTO breach when wall-time crosses the bound", () => {
    const start = 1_000_000_000_000;
    const finish = start + 1801 * sec; // 1801s — 1s over a 1800s bound
    const dumpMtime = start - 1 * hour;
    const v = evaluateDrillSlos(start, finish, dumpMtime, 1800, 24);
    expect(v.rtoBreached).toBe(true);
    expect(v.rpoBreached).toBe(false);
  });

  it("does NOT flag RTO when wall-time exactly equals the bound", () => {
    const start = 1_000_000_000_000;
    const finish = start + 1800 * sec;
    const dumpMtime = start - 1 * hour;
    const v = evaluateDrillSlos(start, finish, dumpMtime, 1800, 24);
    expect(v.rtoBreached).toBe(false);
  });

  it("flags an RPO breach when dump age crosses the bound", () => {
    const start = 1_000_000_000_000;
    const finish = start + 60 * sec;
    const dumpMtime = start - 25 * hour; // 25h old vs 24h bound
    const v = evaluateDrillSlos(start, finish, dumpMtime, 1800, 24);
    expect(v.rtoBreached).toBe(false);
    expect(v.rpoBreached).toBe(true);
  });

  it("flags both RTO and RPO breaches independently", () => {
    const start = 1_000_000_000_000;
    const finish = start + 2000 * sec;
    const dumpMtime = start - 30 * hour;
    const v = evaluateDrillSlos(start, finish, dumpMtime, 1800, 24);
    expect(v.rtoBreached).toBe(true);
    expect(v.rpoBreached).toBe(true);
  });

  it("treats a dump mtime in the future as zero/negative RPO (no breach)", () => {
    // Edge case: clock skew between the producer host and the verify
    // runner means the dump's mtime can be a few seconds AHEAD of
    // start — that's not a stale-dump signal, so we shouldn't page.
    const start = 1_000_000_000_000;
    const finish = start + 60 * sec;
    const dumpMtime = start + 5 * sec;
    const v = evaluateDrillSlos(start, finish, dumpMtime, 1800, 24);
    expect(v.rpoHours).toBeLessThan(0);
    expect(v.rpoBreached).toBe(false);
  });
});
