import type { GatewayName, PaymentGateway } from "./types";

export interface GatewayHealthSnapshot {
  gateway: GatewayName;
  successCount: number;
  failureCount: number;
  successRate: number;
  circuitOpenUntil: Date | null;
}

export interface HealthStore {
  /** Load a snapshot for one gateway (defaulting to zeroes if absent). */
  read(gateway: GatewayName): Promise<GatewayHealthSnapshot>;
  /** Record a success or failure event for a gateway. */
  record(gateway: GatewayName, ok: boolean): Promise<void>;
  /** Open the circuit breaker until the given time. */
  openCircuit(gateway: GatewayName, until: Date): Promise<void>;
}

export interface RouterOptions {
  /** Rolling window failure-rate threshold; above this the circuit opens. */
  failureRateThreshold?: number;
  /** Minimum sample size before the threshold applies. */
  minimumSampleSize?: number;
  /** How long the circuit stays open after tripping. */
  circuitOpenMs?: number;
}

const DEFAULT_OPTIONS: Required<RouterOptions> = {
  failureRateThreshold: 0.4,
  minimumSampleSize: 5,
  circuitOpenMs: 5 * 60 * 1000,
};

/**
 * Routes payment operations to the healthiest gateway with automatic failover
 * when the primary errors. Health is tracked through `HealthStore` so the
 * decision is shared across api-server instances.
 */
export class GatewayRouter {
  private readonly opts: Required<RouterOptions>;

  constructor(
    private readonly primary: PaymentGateway,
    private readonly secondary: PaymentGateway,
    private readonly health: HealthStore,
    opts: RouterOptions = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  /** Pick the gateway to use for a NEW intent (respecting circuit breaker). */
  async pickPrimaryName(): Promise<GatewayName> {
    const primaryHealth = await this.health.read(this.primary.name);
    if (primaryHealth.circuitOpenUntil && primaryHealth.circuitOpenUntil.getTime() > Date.now()) {
      return this.secondary.name;
    }
    if (!this.primary.isConfigured() && this.secondary.isConfigured()) {
      return this.secondary.name;
    }
    return this.primary.name;
  }

  byName(name: GatewayName): PaymentGateway {
    if (name === this.primary.name) return this.primary;
    if (name === this.secondary.name) return this.secondary;
    throw new Error(`unknown_gateway:${name}`);
  }

  primaryGw() {
    return this.primary;
  }

  secondaryGw() {
    return this.secondary;
  }

  /**
   * Run an operation with failover. If the primary throws OR returns
   * `{ ok: false }` AND the secondary is configured, the secondary is tried.
   * Records success/failure in the health store and trips the circuit when
   * failure rate exceeds the threshold.
   */
  async withFailover<T extends { ok: boolean }>(
    primaryName: GatewayName,
    op: (gw: PaymentGateway) => Promise<T>,
  ): Promise<{ result: T; gateway: GatewayName }> {
    const primary = this.byName(primaryName);
    let result: T;
    try {
      result = await op(primary);
    } catch (err) {
      result = { ok: false, errorMessage: (err as Error).message } as unknown as T;
    }
    await this.recordAndMaybeTrip(primary.name, result.ok);
    if (result.ok) return { result, gateway: primary.name };
    const fallback = primary.name === this.primary.name ? this.secondary : this.primary;
    if (!fallback.isConfigured()) return { result, gateway: primary.name };
    let fbResult: T;
    try {
      fbResult = await op(fallback);
    } catch (err) {
      fbResult = { ok: false, errorMessage: (err as Error).message } as unknown as T;
    }
    await this.recordAndMaybeTrip(fallback.name, fbResult.ok);
    return { result: fbResult, gateway: fallback.name };
  }

  /**
   * Record the outcome of a direct (non-failover) gateway call so it
   * feeds the same in-DB `gateway_health` counters and in-process
   * subsystem watcher as the charge path that goes through
   * `withFailover`. Use this from call sites that intentionally
   * bypass failover — e.g. `gw.verify(...)` (must hit the gateway
   * that issued the original charge) and `gw.payout(...)` (must hit
   * the gateway pinned on the payout row). Without this hook, those
   * call sites would silently degrade: a Paystack outage that only
   * stalls the verify or disbursement endpoints would never tick the
   * `paymentGatewayPaystack` failure streak, so the duration-based
   * stuck-degraded alert in `scripts/checkHealthzDegraded.ts` would
   * never fire.
   *
   * Semantics intentionally match `withFailover`'s post-op call to
   * `recordAndMaybeTrip`, including the breaker-trip rule, so the
   * three call surfaces (charge / verify / payout) contribute to the
   * same rolling-window counter.
   */
  async recordDirectCallOutcome(name: GatewayName, ok: boolean): Promise<void> {
    await this.recordAndMaybeTrip(name, ok);
  }

  private async recordAndMaybeTrip(name: GatewayName, ok: boolean): Promise<void> {
    await this.health.record(name, ok);
    const snap = await this.health.read(name);
    const total = snap.successCount + snap.failureCount;
    if (total < this.opts.minimumSampleSize) return;
    const failureRate = snap.failureCount / total;
    if (failureRate >= this.opts.failureRateThreshold) {
      await this.health.openCircuit(name, new Date(Date.now() + this.opts.circuitOpenMs));
    }
  }
}
