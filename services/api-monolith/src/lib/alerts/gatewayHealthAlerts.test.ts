import { describe, it, expect, beforeEach } from "vitest";
import { createGatewayCircuitMonitor } from "./gatewayHealthAlerts";
import type {
  SubsystemAlertNotifier,
  SubsystemDegradedEvent,
  SubsystemRecoveredEvent,
} from "./subsystemAlertNotifier";

interface RecorderNotifier extends SubsystemAlertNotifier {
  degraded: SubsystemDegradedEvent[];
  recovered: SubsystemRecoveredEvent[];
}

function makeNotifier(): RecorderNotifier {
  const degraded: SubsystemDegradedEvent[] = [];
  const recovered: SubsystemRecoveredEvent[] = [];
  return {
    degraded,
    recovered,
    notifyDegraded(e) {
      degraded.push(e);
    },
    notifyRecovered(e) {
      recovered.push(e);
    },
  };
}

describe("GatewayCircuitMonitor — degraded transitions", () => {
  let notifier: RecorderNotifier;
  let now: number;
  beforeEach(() => {
    notifier = makeNotifier();
    now = 1_700_000_000_000;
  });

  it("pages once on closed→open transition (no prior breaker)", () => {
    const monitor = createGatewayCircuitMonitor({ notifier, cooldownMs: 60_000 });
    monitor.notifyCircuitOpened("paystack", null, now + 5 * 60_000, now);
    expect(notifier.degraded).toHaveLength(1);
    expect(notifier.degraded[0]!.subsystem).toBe(
      "payment-gateway:paystack",
    );
    expect(notifier.degraded[0]!.label).toBe("paystack payment gateway");
    expect(notifier.degraded[0]!.details).toMatchObject({
      gateway: "paystack",
    });
  });

  it("does NOT re-page when an already-open breaker is extended", () => {
    const monitor = createGatewayCircuitMonitor({ notifier, cooldownMs: 60_000 });
    monitor.notifyCircuitOpened("paystack", null, now + 5 * 60_000, now);
    // Router re-trips inside the same incident — extending the until.
    // Pretend 30s pass; the breaker is still open so this is an
    // extension, not a new transition.
    monitor.notifyCircuitOpened(
      "paystack",
      now + 5 * 60_000,
      now + 30_000 + 5 * 60_000,
      now + 30_000,
    );
    expect(notifier.degraded).toHaveLength(1);
  });

  it("does NOT re-page within the cooldown window after recovery", () => {
    const monitor = createGatewayCircuitMonitor({ notifier, cooldownMs: 60_000 });
    monitor.notifyCircuitOpened("paystack", null, now + 5 * 60_000, now);
    expect(notifier.degraded).toHaveLength(1);
    // 6 minutes pass — breaker has expired. Success arrives → recover.
    const recoverAt = now + 6 * 60_000;
    monitor.observeRecord("paystack", true, now + 5 * 60_000, recoverAt);
    expect(notifier.recovered).toHaveLength(1);
    // 10 seconds later breaker re-opens. Should be suppressed by the
    // cooldown — operators are not paged again for a flapping breaker.
    monitor.notifyCircuitOpened(
      "paystack",
      null,
      recoverAt + 10_000 + 5 * 60_000,
      recoverAt + 10_000,
    );
    expect(notifier.degraded).toHaveLength(1);
  });

  it("re-pages once the cooldown window has elapsed", () => {
    const monitor = createGatewayCircuitMonitor({ notifier, cooldownMs: 60_000 });
    monitor.notifyCircuitOpened("paystack", null, now + 5 * 60_000, now);
    // Recover.
    const recoverAt = now + 6 * 60_000;
    monitor.observeRecord("paystack", true, now + 5 * 60_000, recoverAt);
    // Wait past the cooldown (61s) before opening again.
    const reopenAt = recoverAt + 61_000;
    monitor.notifyCircuitOpened(
      "paystack",
      null,
      reopenAt + 5 * 60_000,
      reopenAt,
    );
    expect(notifier.degraded).toHaveLength(2);
  });

  it("tracks state per gateway independently", () => {
    const monitor = createGatewayCircuitMonitor({ notifier, cooldownMs: 60_000 });
    monitor.notifyCircuitOpened("paystack", null, now + 5 * 60_000, now);
    // Opening flutterwave a few seconds later is a separate incident
    // and should page even though paystack just paged.
    monitor.notifyCircuitOpened(
      "flutterwave",
      null,
      now + 5_000 + 5 * 60_000,
      now + 5_000,
    );
    expect(notifier.degraded).toHaveLength(2);
    expect(notifier.degraded.map((e) => e.subsystem)).toEqual([
      "payment-gateway:paystack",
      "payment-gateway:flutterwave",
    ]);
  });

  it("treats a globally-already-open breaker as an extension on first observation", () => {
    // The local cache hasn't seen this breaker before (process just
    // booted) but the DB row says it's already open. The monitor must
    // NOT page — that would double-page on every replica restart
    // during an ongoing incident.
    const monitor = createGatewayCircuitMonitor({ notifier, cooldownMs: 60_000 });
    monitor.notifyCircuitOpened(
      "paystack",
      now + 60_000, // existing "until" still in the future
      now + 6 * 60_000,
      now,
    );
    expect(notifier.degraded).toEqual([]);
  });

  it("DOES page when the prior breaker has already expired", () => {
    // Prior breaker was open but expired before this trip — that's a
    // genuine new incident even though the row had a non-null value.
    const monitor = createGatewayCircuitMonitor({ notifier, cooldownMs: 60_000 });
    monitor.notifyCircuitOpened(
      "paystack",
      now - 60_000, // expired a minute ago
      now + 5 * 60_000,
      now,
    );
    expect(notifier.degraded).toHaveLength(1);
  });
});

describe("GatewayCircuitMonitor — recovery transitions", () => {
  let notifier: RecorderNotifier;
  let now: number;
  beforeEach(() => {
    notifier = makeNotifier();
    now = 1_700_000_000_000;
  });

  it("does NOT page recovery when we never paged degraded", () => {
    const monitor = createGatewayCircuitMonitor({ notifier });
    monitor.observeRecord("paystack", true, null, now);
    expect(notifier.recovered).toEqual([]);
  });

  it("does NOT page recovery while the breaker is still open", () => {
    const monitor = createGatewayCircuitMonitor({ notifier });
    monitor.notifyCircuitOpened("paystack", null, now + 5 * 60_000, now);
    // 1 minute later — breaker still open. A success here is a fluke;
    // the breaker hasn't actually recovered.
    monitor.observeRecord(
      "paystack",
      true,
      now + 5 * 60_000,
      now + 60_000,
    );
    expect(notifier.recovered).toEqual([]);
  });

  it("pages recovery on the first success after the breaker expires", () => {
    const monitor = createGatewayCircuitMonitor({ notifier });
    monitor.notifyCircuitOpened("paystack", null, now + 5 * 60_000, now);
    // 6 minutes later — breaker expired. Success arrives.
    const recoverAt = now + 6 * 60_000;
    monitor.observeRecord("paystack", true, now + 5 * 60_000, recoverAt);
    expect(notifier.recovered).toHaveLength(1);
    expect(notifier.recovered[0]!.subsystem).toBe(
      "payment-gateway:paystack",
    );
    expect(notifier.recovered[0]!.durationMs).toBe(6 * 60_000);
  });

  it("does NOT re-page recovery on subsequent successes", () => {
    const monitor = createGatewayCircuitMonitor({ notifier });
    monitor.notifyCircuitOpened("paystack", null, now + 5 * 60_000, now);
    const recoverAt = now + 6 * 60_000;
    monitor.observeRecord("paystack", true, now + 5 * 60_000, recoverAt);
    // Many subsequent successes don't re-page.
    monitor.observeRecord("paystack", true, null, recoverAt + 1_000);
    monitor.observeRecord("paystack", true, null, recoverAt + 2_000);
    expect(notifier.recovered).toHaveLength(1);
  });

  it("does NOT page recovery on a failed op (only successes count)", () => {
    const monitor = createGatewayCircuitMonitor({ notifier });
    monitor.notifyCircuitOpened("paystack", null, now + 5 * 60_000, now);
    const t = now + 6 * 60_000; // breaker expired
    monitor.observeRecord("paystack", false, now + 5 * 60_000, t);
    expect(notifier.recovered).toEqual([]);
  });
});

describe("GatewayCircuitMonitor — notifier failures don't break the caller", () => {
  it("swallows notifier exceptions on degraded path", () => {
    const broken: SubsystemAlertNotifier = {
      notifyDegraded() {
        throw new Error("transport down");
      },
      notifyRecovered() {},
    };
    const monitor = createGatewayCircuitMonitor({ notifier: broken });
    expect(() =>
      monitor.notifyCircuitOpened("paystack", null, Date.now() + 60_000),
    ).not.toThrow();
  });

  it("swallows notifier exceptions on recovery path", () => {
    const recorder = makeNotifier();
    const broken: SubsystemAlertNotifier = {
      notifyDegraded(e) {
        recorder.degraded.push(e);
      },
      notifyRecovered() {
        throw new Error("transport down");
      },
    };
    const monitor = createGatewayCircuitMonitor({ notifier: broken });
    const t = 1_700_000_000_000;
    monitor.notifyCircuitOpened("paystack", null, t + 5 * 60_000, t);
    expect(() =>
      monitor.observeRecord(
        "paystack",
        true,
        t + 5 * 60_000,
        t + 6 * 60_000,
      ),
    ).not.toThrow();
  });
});
