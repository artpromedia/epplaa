import { describe, it, expect, beforeEach, vi } from "vitest";
import { MfaAbuseWatcher } from "./mfaAbuseWatcher";

interface CapturedAlert {
  message: string;
  options?: unknown;
}

function makeWatcher(opts?: {
  threshold?: number;
  windowMs?: number;
  cooldownMs?: number;
}): { watcher: MfaAbuseWatcher; alerts: CapturedAlert[] } {
  const alerts: CapturedAlert[] = [];
  const watcher = new MfaAbuseWatcher({
    threshold: opts?.threshold ?? 3,
    windowMs: opts?.windowMs ?? 15 * 60 * 1000,
    cooldownMs: opts?.cooldownMs ?? 30 * 60 * 1000,
    capture: (message, options) => {
      alerts.push({ message, options });
    },
  });
  return { watcher, alerts };
}

const baseEvent = {
  identity: "user:u_123",
  route: "/api/me/mfa/verify",
  name: "mfa_verify",
  tier: "buyer",
};

beforeEach(() => {
  vi.useRealTimers();
});

describe("MfaAbuseWatcher — threshold / window semantics", () => {
  it("does not alert below threshold", () => {
    const { watcher, alerts } = makeWatcher({ threshold: 3 });
    const t0 = 1_700_000_000_000;
    watcher.record(baseEvent, t0);
    watcher.record(baseEvent, t0 + 1000);
    expect(alerts).toEqual([]);
  });

  it("alerts on the first record that crosses threshold within the window", () => {
    const { watcher, alerts } = makeWatcher({ threshold: 3 });
    const t0 = 1_700_000_000_000;
    watcher.record(baseEvent, t0);
    watcher.record(baseEvent, t0 + 1000);
    expect(alerts).toEqual([]);
    watcher.record(baseEvent, t0 + 2000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toBe("mfa_rate_limit_burst_detected");
  });

  it("includes structured tags + extra + per-identity fingerprint", () => {
    const { watcher, alerts } = makeWatcher({ threshold: 2 });
    const t0 = 1_700_000_000_000;
    watcher.record(baseEvent, t0);
    watcher.record(baseEvent, t0 + 100);
    expect(alerts).toHaveLength(1);
    const opts = alerts[0]!.options as {
      level: string;
      tags: Record<string, string>;
      extra: Record<string, unknown>;
      fingerprint: string[];
    };
    expect(opts.level).toBe("warning");
    expect(opts.tags).toMatchObject({
      subsystem: "rate_limit",
      alert: "mfa_rate_limit_burst",
      tier: "buyer",
      limiter: "mfa_verify",
    });
    expect(opts.extra).toMatchObject({
      identity: "user:u_123",
      route: "/api/me/mfa/verify",
      count: 2,
      threshold: 2,
    });
    expect(opts.fingerprint).toEqual(["mfa_rate_limit_burst", "user:u_123"]);
  });

  it("drops entries that age out of the window before re-alerting", () => {
    const { watcher, alerts } = makeWatcher({
      threshold: 3,
      windowMs: 60_000,
      cooldownMs: 1_000,
    });
    const t0 = 1_700_000_000_000;
    // Two entries deep in the past, then one well outside the window.
    // The third record's cutoff (now - windowMs = t0+10_000) sweeps
    // both past entries out (the implementation drops `<= cutoff`),
    // leaving only the new entry in the bucket — count goes from 2
    // back down to 1.
    watcher.record(baseEvent, t0);
    watcher.record(baseEvent, t0 + 5_000);
    watcher.record(baseEvent, t0 + 70_000);
    expect(alerts).toEqual([]);
    // Two more bursts inside the active window finally cross threshold.
    watcher.record(baseEvent, t0 + 71_000);
    expect(alerts).toEqual([]);
    watcher.record(baseEvent, t0 + 72_000);
    expect(alerts).toHaveLength(1);
  });
});

describe("MfaAbuseWatcher — cooldown / dedupe", () => {
  it("re-alerts once the cooldown lapses for the same identity", () => {
    const { watcher, alerts } = makeWatcher({
      threshold: 2,
      windowMs: 60 * 60 * 1000,
      cooldownMs: 10_000,
    });
    const t0 = 1_700_000_000_000;
    watcher.record(baseEvent, t0);
    watcher.record(baseEvent, t0 + 100);
    expect(alerts).toHaveLength(1);
    // Inside cooldown — additional records do not re-alert.
    watcher.record(baseEvent, t0 + 1000);
    watcher.record(baseEvent, t0 + 5000);
    expect(alerts).toHaveLength(1);
    // Past cooldown + still over threshold — re-alerts exactly once.
    watcher.record(baseEvent, t0 + 11_000);
    expect(alerts).toHaveLength(2);
  });

  it("tracks cooldown independently per identity", () => {
    const { watcher, alerts } = makeWatcher({
      threshold: 2,
      cooldownMs: 60_000,
    });
    const t0 = 1_700_000_000_000;
    watcher.record({ ...baseEvent, identity: "user:a" }, t0);
    watcher.record({ ...baseEvent, identity: "user:a" }, t0 + 1);
    watcher.record({ ...baseEvent, identity: "user:b" }, t0 + 2);
    watcher.record({ ...baseEvent, identity: "user:b" }, t0 + 3);
    expect(alerts).toHaveLength(2);
    const fingerprints = alerts.map(
      (a) =>
        (a.options as { fingerprint: string[] }).fingerprint[1] as string,
    );
    expect(fingerprints.sort()).toEqual(["user:a", "user:b"]);
  });
});

describe("MfaAbuseWatcher — sweep / memory safety", () => {
  it("drops buckets whose entries have all aged out and whose cooldown lapsed", () => {
    const { watcher } = makeWatcher({
      threshold: 2,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    const t0 = 1_700_000_000_000;
    watcher.record(baseEvent, t0);
    expect(watcher.getSnapshot().trackedIdentities).toBe(1);
    // Sweep at t0 + windowMs + cooldownMs evicts the empty bucket.
    watcher.sweep(t0 + 120_001);
    expect(watcher.getSnapshot().trackedIdentities).toBe(0);
  });

  it("retains buckets within their cooldown so a slow attacker can't trivially re-trigger the alert", () => {
    const { watcher } = makeWatcher({
      threshold: 2,
      windowMs: 60_000,
      cooldownMs: 60 * 60 * 1000,
    });
    const t0 = 1_700_000_000_000;
    watcher.record(baseEvent, t0);
    watcher.record(baseEvent, t0 + 1);
    expect(watcher.getSnapshot().trackedIdentities).toBe(1);
    // Sweep AFTER the entries age out but BEFORE the cooldown lapses.
    watcher.sweep(t0 + 120_000);
    expect(watcher.getSnapshot().trackedIdentities).toBe(1);
  });
});

describe("MfaAbuseWatcher — defensive posture", () => {
  it("swallows errors from the capture sink instead of propagating", () => {
    const calls: string[] = [];
    const watcher = new MfaAbuseWatcher({
      threshold: 1,
      capture: (message) => {
        calls.push(message);
        throw new Error("boom");
      },
    });
    expect(() => watcher.record(baseEvent)).not.toThrow();
    expect(calls).toEqual(["mfa_rate_limit_burst_detected"]);
  });
});
