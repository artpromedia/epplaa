import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyAuditChainMock = vi.fn<(fromSeq?: number) => Promise<number | null>>();
const captureMessageMock = vi.fn<
  (message: string, options?: unknown) => void
>();

vi.mock("./audit", () => ({
  verifyAuditChain: (fromSeq?: number) => verifyAuditChainMock(fromSeq),
}));

vi.mock("./sentry", () => ({
  captureMessage: (message: string, options?: unknown) =>
    captureMessageMock(message, options),
}));

vi.mock("./logger", () => ({
  logger: {
    warn: () => {},
    error: () => {},
    info: () => {},
  },
}));

const {
  runAuditChainVerification,
  getAuditChainVerifierSnapshot,
  getAuditChainVerifyIntervalMs,
  auditChainVerifyHealthWatcher,
  __resetAuditChainVerifierForTests,
} = await import("./auditChainVerifier");

beforeEach(() => {
  verifyAuditChainMock.mockReset();
  captureMessageMock.mockReset();
  __resetAuditChainVerifierForTests();
  delete process.env.AUDIT_CHAIN_VERIFY_INTERVAL_MS;
});

describe("getAuditChainVerifyIntervalMs", () => {
  it("falls back to 4h default for missing or invalid values", () => {
    // Mirrors the env-var sanitisation contract used by every other
    // alert threshold in this codebase. A typo must not silently turn
    // the alert into a flapping page (sub-minute cadence) or a
    // permanently-silent one (zero/negative).
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    for (const bad of [undefined, "", "not-a-number", "0", "-5", "59999"]) {
      // 59999 < 60000 minimum so it should also fall back — sub-minute
      // chain verifies would slam the DB and aren't a realistic operator
      // intent, so we treat it as a typo.
      expect(
        getAuditChainVerifyIntervalMs({
          AUDIT_CHAIN_VERIFY_INTERVAL_MS: bad as string,
        }),
        `bad=${String(bad)}`,
      ).toBe(FOUR_HOURS);
    }
  });

  it("respects a finite positive override at or above the 60s minimum", () => {
    expect(
      getAuditChainVerifyIntervalMs({
        AUDIT_CHAIN_VERIFY_INTERVAL_MS: "60000",
      }),
    ).toBe(60_000);
    expect(
      getAuditChainVerifyIntervalMs({
        AUDIT_CHAIN_VERIFY_INTERVAL_MS: "1800000",
      }),
    ).toBe(1_800_000);
    // Floats are floored.
    expect(
      getAuditChainVerifyIntervalMs({
        AUDIT_CHAIN_VERIFY_INTERVAL_MS: "60000.9",
      }),
    ).toBe(60_000);
  });
});

describe("runAuditChainVerification", () => {
  const NOW = 1_700_000_000_000;

  it("records success and stays healthy when the chain is intact", async () => {
    verifyAuditChainMock.mockResolvedValueOnce(null);

    const result = await runAuditChainVerification(NOW, "scheduled");

    expect(result.ok).toBe(true);
    expect(result.offendingSeq).toBeNull();
    expect(result.error).toBeNull();
    expect(verifyAuditChainMock).toHaveBeenCalledWith(0);
    expect(captureMessageMock).not.toHaveBeenCalled();

    const snap = getAuditChainVerifierSnapshot();
    expect(snap.state).toBe("healthy");
    expect(snap.lastOffendingSeq).toBeNull();
    expect(snap.lastVerifiedAt).toBe(NOW);
    expect(snap.lastVerifyError).toBeNull();
  });

  it("trips the watcher and pages on a non-null offending seq", async () => {
    // The whole point of the in-prod runner: a tampered row in the
    // live `audit_events` table must page audit/compliance owners on
    // the very next tick rather than waiting up to a week for the
    // backup-verify drill.
    verifyAuditChainMock.mockResolvedValueOnce(42);

    const result = await runAuditChainVerification(NOW, "scheduled");

    expect(result.ok).toBe(false);
    expect(result.offendingSeq).toBe(42);
    expect(result.error).toBeNull();

    const snap = getAuditChainVerifierSnapshot();
    expect(snap.state).toBe("degraded");
    expect(snap.firstFailureAt).toBe(NOW);
    expect(snap.lastOffendingSeq).toBe(42);
    expect(snap.lastVerifyError).toBeNull();

    // Sentry capture: fatal level + stable fingerprint + the
    // subsystem/check tags the audit/compliance owners' alert rule
    // routes on (mirrors exit 8 of verifyBackup.ts in the runbook
    // routing table).
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessageMock.mock.calls[0]!;
    expect(message).toBe("audit_chain_tamper_detected");
    expect(options).toMatchObject({
      level: "fatal",
      tags: {
        subsystem: "auditChain",
        check: "verifyAuditChain",
        source: "scheduled",
      },
      fingerprint: ["audit_chain_tamper_detected"],
      extra: expect.objectContaining({
        offendingSeq: 42,
        verifiedAt: NOW,
      }),
    });
  });

  it("threads the source label through to the Sentry tags + log so on-call can tell apart scheduled vs admin-triggered probes", async () => {
    verifyAuditChainMock.mockResolvedValueOnce(7);

    await runAuditChainVerification(NOW, "admin-endpoint");

    const [, options] = captureMessageMock.mock.calls[0]!;
    expect((options as { tags: { source: string } }).tags.source).toBe(
      "admin-endpoint",
    );
  });

  it("keeps `firstFailureAt` sticky across consecutive tamper detections", async () => {
    // The duration probe pages on `now - firstFailureAt > thresholdMs`.
    // If firstFailureAt advanced on every tick, the streak would
    // never accumulate and the duration alert would never fire.
    verifyAuditChainMock.mockResolvedValue(99);

    await runAuditChainVerification(NOW, "scheduled");
    await runAuditChainVerification(NOW + 60_000, "scheduled");
    await runAuditChainVerification(NOW + 120_000, "scheduled");

    const snap = getAuditChainVerifierSnapshot();
    expect(snap.state).toBe("degraded");
    expect(snap.firstFailureAt).toBe(NOW);
    expect(snap.failureCount).toBe(3);
    expect(snap.lastOffendingSeq).toBe(99);
    // Sentry capture fires on EVERY detection — the stable fingerprint
    // groups them into one Sentry issue, but the underlying capture is
    // still emitted so on-call sees the latest detection timestamp.
    expect(captureMessageMock).toHaveBeenCalledTimes(3);
  });

  it("closes the streak when a subsequent verify comes back clean", async () => {
    // Recovery path: once the chain is found to be intact again the
    // watcher must auto-resolve so the duration alert stops firing
    // without manual intervention. The Sentry issue stays open as
    // the forensic trail; only the in-memory health state recovers.
    verifyAuditChainMock
      .mockResolvedValueOnce(123)
      .mockResolvedValueOnce(null);

    await runAuditChainVerification(NOW, "scheduled");
    expect(getAuditChainVerifierSnapshot().state).toBe("degraded");

    await runAuditChainVerification(NOW + 60_000, "scheduled");
    const snap = getAuditChainVerifierSnapshot();
    expect(snap.state).toBe("healthy");
    expect(snap.firstFailureAt).toBeNull();
    expect(snap.lastRecoveredAt).toBe(NOW + 60_000);
    expect(snap.lastOffendingSeq).toBeNull();
  });

  it("does NOT trip the watcher on a probe error — the chain is unmeasured, not broken", async () => {
    // A DB outage is surfaced by the dbHealthWatcher via /readyz on a
    // separate channel; conflating "we couldn't measure the chain"
    // with "the chain is broken" would erode the alert's signal and
    // cross-page audit/compliance owners for what is actually a
    // platform incident.
    verifyAuditChainMock.mockRejectedValueOnce(new Error("connection terminated"));

    const result = await runAuditChainVerification(NOW, "scheduled");

    expect(result.ok).toBe(false);
    expect(result.offendingSeq).toBeNull();
    expect(result.error).toBe("connection terminated");

    const snap = getAuditChainVerifierSnapshot();
    expect(snap.state).toBe("healthy");
    expect(snap.firstFailureAt).toBeNull();
    expect(snap.lastVerifyError).toBe("connection terminated");
    expect(snap.lastVerifiedAt).toBe(NOW);
    expect(snap.lastOffendingSeq).toBeNull();

    // Critically: NO Sentry capture on a probe error. The
    // captureMessage path is reserved for actual chain breaks.
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("clears `lastVerifyError` once a subsequent verify succeeds", async () => {
    // An operator looking at /healthz mid-incident should see the
    // current error state, not a stale one from a previous transient
    // failure that has since recovered.
    verifyAuditChainMock
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(null);

    await runAuditChainVerification(NOW, "scheduled");
    expect(getAuditChainVerifierSnapshot().lastVerifyError).toBe("transient");

    await runAuditChainVerification(NOW + 60_000, "scheduled");
    expect(getAuditChainVerifierSnapshot().lastVerifyError).toBeNull();
  });
});

describe("getAuditChainVerifierSnapshot defaults", () => {
  it("returns the no-verify-yet shape before any runAuditChainVerification call", () => {
    // /healthz must always be servable, even on the very first
    // request after boot before the first verify has run. The
    // snapshot shape distinguishes "no verify yet" (null fields)
    // from "verified, found N rows healthy".
    const snap = getAuditChainVerifierSnapshot();
    expect(snap.state).toBe("healthy");
    expect(snap.failureCount).toBe(0);
    expect(snap.firstFailureAt).toBeNull();
    expect(snap.lastRecoveredAt).toBeNull();
    expect(snap.lastVerifiedAt).toBeNull();
    expect(snap.lastDurationMs).toBeNull();
    expect(snap.lastOffendingSeq).toBeNull();
    expect(snap.lastVerifyError).toBeNull();
    expect(snap.intervalMs).toBe(4 * 60 * 60 * 1000);
  });

  it("reflects a streak injected via the rehearsal hook even before any verify has run", () => {
    // The rehearsal injector seeds the watcher directly without
    // running a probe. The /healthz response must still surface the
    // injected streak so the duration probe can pick it up — same
    // pattern as the auditDlq watcher.
    auditChainVerifyHealthWatcher.__injectStreak(1_700_000_000_000, 2);
    const snap = getAuditChainVerifierSnapshot();
    expect(snap.state).toBe("degraded");
    expect(snap.firstFailureAt).toBe(1_700_000_000_000);
    expect(snap.failureCount).toBe(2);
    // Verify-result fields stay null because no real verify ran.
    expect(snap.lastVerifiedAt).toBeNull();
    expect(snap.lastOffendingSeq).toBeNull();
  });
});
