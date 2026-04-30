import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the daily PUDO manifest delivery cron. We mock the
 * db module + the manifest builder so the test never opens a real
 * Postgres connection — Vitest is configured to alias `@workspace/db`
 * to `lib/db/src` which would otherwise blow up on `DATABASE_URL`
 * import-time check.
 *
 * The mocked db is a tiny in-memory store that supports just enough
 * of the chainable Drizzle API for delivery.ts to exercise its
 * happy-path / dedupe / failure / terminal-failure branches.
 */

interface PartnerRow {
  code: string;
  name: string;
  active: number;
  manifestTimezone: string;
  deliveryMethod: "none" | "email" | "sftp";
  manifestEmail: string;
  sftpHost: string;
  sftpPort: number;
  sftpUsername: string;
  sftpPasswordEnvVar: string;
  sftpKeyEnvVar: string;
  sftpRemoteDir: string;
}

interface RunRow {
  id: string;
  partnerCode: string;
  forDate: string;
  shipmentCount: number;
  contentHash: string;
  destination: string;
  deliveryMethod: string;
  status: string;
  attempts: number;
  lastError: string;
  deliveredAt: Date | null;
  createdAt: Date;
}

// `vi.mock` factories are hoisted to the top of the module, so they
// can't close over module-level let/const. We stash the in-memory
// store on globalThis instead, which is initialised before the
// factory runs and the test body uses the same handle.
interface DeliveryTestState {
  partners: PartnerRow[];
  runs: RunRow[];
}
const STATE_KEY = "__pudoDeliveryTestState__";
type GlobalWithState = typeof globalThis & { [STATE_KEY]?: DeliveryTestState };
const g = globalThis as GlobalWithState;
g[STATE_KEY] = { partners: [], runs: [] };
const state = g[STATE_KEY]!;
const { partners, runs } = state;

vi.mock("../db", () => {
  const PARTNERS_TABLE = Symbol("pudoPartnersTable");
  const RUNS_TABLE = Symbol("pudoManifestRunsTable");
  // The factory is hoisted to the top of the module (before our
  // `globalThis[...] = { partners, runs }` initialiser runs), so we
  // resolve the shared in-memory store lazily on every call —
  // never at factory-construction time.
  const getState = (): { partners: unknown[]; runs: Record<string, unknown>[] } => {
    const s = (globalThis as Record<string, unknown>)["__pudoDeliveryTestState__"] as
      | { partners: unknown[]; runs: Record<string, unknown>[] }
      | undefined;
    if (!s) throw new Error("delivery test state not initialised");
    return s;
  };

  function chainableSelect(rows: unknown[]) {
    const builder: Record<string, unknown> = {
      from: () => builder,
      where: () => builder,
      limit: () => Promise.resolve(rows),
      orderBy: () => Promise.resolve(rows),
      then: (resolve: (v: unknown) => unknown) => resolve(rows),
    };
    return builder;
  }

  const db = {
    select: () => ({
      from: (table: symbol) => {
        const s = getState();
        if (table === PARTNERS_TABLE) return chainableSelect(s.partners);
        if (table === RUNS_TABLE) return chainableSelect(s.runs);
        return chainableSelect([]);
      },
    }),
    insert: (_table: symbol) => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
          const s = getState();
          const existing = s.runs.find(
            (r) => r.partnerCode === row.partnerCode && r.forDate === row.forDate,
          );
          if (existing) {
            Object.assign(existing, set);
          } else {
            s.runs.push({
              ...row,
              deliveredAt: row.deliveredAt ?? null,
              createdAt: row.createdAt ?? new Date(),
            });
          }
          return Promise.resolve();
        },
      }),
    }),
    update: (_table: symbol) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const s = getState();
          const target = s.runs[s.runs.length - 1];
          if (target) Object.assign(target, patch);
          return Promise.resolve();
        },
      }),
    }),
    execute: () => Promise.resolve(),
  };
  return {
    db,
    schema: {
      pudoPartnersTable: PARTNERS_TABLE,
      pudoManifestRunsTable: RUNS_TABLE,
    },
  };
});

vi.mock("./manifest", () => ({
  buildManifestCsv: vi.fn(async (partnerCode: string) => ({
    csv: `header\n${partnerCode}-row\n`,
    shipmentCount: 1,
    contentHash: `hash-${partnerCode}`,
    locationIds: [`loc-${partnerCode}`],
  })),
}));

vi.mock("../ids", () => ({
  newManifestRunId: vi.fn(() => `run-${Math.random().toString(36).slice(2, 8)}`),
}));

vi.mock("../sentry", () => ({
  captureMessage: vi.fn(),
}));

vi.mock("../alerts/subsystemAlertNotifier", () => ({
  WebhookSubsystemAlertNotifier: class {
    notifyDegraded = vi.fn();
  },
}));

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Imports must come after vi.mock so the mocks resolve.
import {
  MAX_ATTEMPTS_PER_DAY,
  localPartsInZone,
  shouldDeliverNow,
  runDailyPudoManifestDelivery,
  type DeliveryDeps,
} from "./delivery";

function basePartner(overrides: Partial<PartnerRow> = {}): PartnerRow {
  return {
    code: "pargo",
    name: "Pargo",
    active: 1,
    manifestTimezone: "Africa/Lagos",
    deliveryMethod: "email",
    manifestEmail: "ops@pargo.com",
    sftpHost: "",
    sftpPort: 22,
    sftpUsername: "",
    sftpPasswordEnvVar: "",
    sftpKeyEnvVar: "",
    sftpRemoteDir: "/",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DeliveryDeps> = {}): DeliveryDeps {
  return {
    emailTransport: vi.fn(async () => ({ ok: true, destination: "email:ops@pargo.com" })),
    sftpTransport: vi.fn(async () => ({ ok: true, destination: "sftp:host:/dir" })),
    alertNotifier: { notifyDegraded: vi.fn() },
    capture: vi.fn(),
    now: () => new Date("2026-04-29T08:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  partners.length = 0;
  runs.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("localPartsInZone", () => {
  it("returns ISO-8601 date parts in the requested zone", () => {
    // 2026-04-29T05:00:00Z is 06:00 in Africa/Lagos (UTC+1).
    const r = localPartsInZone(new Date("2026-04-29T05:00:00Z"), "Africa/Lagos");
    expect(r).toEqual({ date: "2026-04-29", hour: 6 });
  });

  it("crosses the date boundary correctly for non-UTC zones", () => {
    // Midnight UTC is 02:00 next-day in Africa/Cairo (UTC+2)? Cairo
    // is +2/+3; this asserts the date string we'll write to for_date.
    const r = localPartsInZone(new Date("2026-04-29T22:30:00Z"), "Africa/Cairo");
    expect(r.date).toBe("2026-04-30");
  });

  it("throws clearly on an invalid timezone instead of silently bucketing as UTC", () => {
    expect(() => localPartsInZone(new Date(), "Not/A_Zone")).toThrowError(
      /invalid_timezone/,
    );
  });
});

describe("shouldDeliverNow", () => {
  it("delivers once partner-local time has crossed 06:00", () => {
    const partner = basePartner();
    expect(
      shouldDeliverNow(partner, new Date("2026-04-29T05:00:00Z")), // 06:00 Lagos
    ).toBe(true);
    expect(
      shouldDeliverNow(partner, new Date("2026-04-29T15:00:00Z")), // 16:00 Lagos
    ).toBe(true);
  });

  it("waits before partner-local 06:00", () => {
    const partner = basePartner();
    expect(
      shouldDeliverNow(partner, new Date("2026-04-29T04:30:00Z")), // 05:30 Lagos
    ).toBe(false);
  });

  it("skips inactive partners regardless of clock", () => {
    expect(
      shouldDeliverNow(basePartner({ active: 0 }), new Date("2026-04-29T15:00:00Z")),
    ).toBe(false);
  });

  it("skips pull-mode partners regardless of clock", () => {
    expect(
      shouldDeliverNow(
        basePartner({ deliveryMethod: "none" }),
        new Date("2026-04-29T15:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("runDailyPudoManifestDelivery", () => {
  it("delivers an active partner inside their delivery window and records the run", async () => {
    partners.push(basePartner());
    const deps = makeDeps();
    const result = await runDailyPudoManifestDelivery(deps);

    expect(result).toEqual({ attempted: 1, delivered: 1, skipped: 0, failed: 0 });
    expect(deps.emailTransport).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      partnerCode: "pargo",
      status: "sent",
      attempts: 1,
      destination: "email:ops@pargo.com",
      contentHash: "hash-pargo",
    });
    expect(runs[0].deliveredAt).toBeInstanceOf(Date);
  });

  it("does NOT deliver before the partner's local 06:00", async () => {
    partners.push(basePartner());
    const deps = makeDeps({ now: () => new Date("2026-04-29T04:30:00Z") });
    const result = await runDailyPudoManifestDelivery(deps);

    expect(result.attempted).toBe(0);
    expect(deps.emailTransport).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });

  it("short-circuits when the same contentHash was already sent today", async () => {
    partners.push(basePartner());
    runs.push({
      id: "preexisting",
      partnerCode: "pargo",
      forDate: "2026-04-29",
      shipmentCount: 1,
      contentHash: "hash-pargo",
      destination: "email:ops@pargo.com",
      deliveryMethod: "email",
      status: "sent",
      attempts: 1,
      lastError: "",
      deliveredAt: new Date("2026-04-29T06:00:00Z"),
      createdAt: new Date("2026-04-29T06:00:00Z"),
    });
    const deps = makeDeps();
    const result = await runDailyPudoManifestDelivery(deps);

    expect(result).toEqual({ attempted: 1, delivered: 0, skipped: 1, failed: 0 });
    // Critical: the transport must NOT be called when the dedupe
    // hash matches — that's the entire point of the contentHash.
    expect(deps.emailTransport).not.toHaveBeenCalled();
  });

  it("leaves the run queued and alerts when the transport fails (will retry next tick)", async () => {
    partners.push(basePartner());
    const deps = makeDeps({
      emailTransport: vi.fn(async () => ({
        ok: false,
        destination: "email:ops@pargo.com",
        errorCode: "smtp_5xx",
        errorMessage: "Postmark 503",
      })),
    });
    const result = await runDailyPudoManifestDelivery(deps);

    expect(result).toEqual({ attempted: 1, delivered: 0, skipped: 0, failed: 1 });
    expect(runs[0]).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "smtp_5xx: Postmark 503",
    });
    expect(deps.alertNotifier.notifyDegraded).toHaveBeenCalledTimes(1);
    expect(deps.capture).toHaveBeenCalledWith(
      "pudo_manifest_delivery_failed_will_retry",
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("transitions to terminal 'failed' after MAX_ATTEMPTS_PER_DAY consecutive failures", async () => {
    partners.push(basePartner());
    runs.push({
      id: "preexisting",
      partnerCode: "pargo",
      forDate: "2026-04-29",
      shipmentCount: 1,
      contentHash: "hash-pargo",
      destination: "email:ops@pargo.com",
      deliveryMethod: "email",
      status: "queued",
      attempts: MAX_ATTEMPTS_PER_DAY - 1, // next attempt hits the cap
      lastError: "smtp_5xx: previous",
      deliveredAt: null,
      createdAt: new Date("2026-04-29T06:00:00Z"),
    });
    const deps = makeDeps({
      emailTransport: vi.fn(async () => ({
        ok: false,
        destination: "email:ops@pargo.com",
        errorCode: "smtp_5xx",
        errorMessage: "Postmark 503",
      })),
    });
    const result = await runDailyPudoManifestDelivery(deps);

    expect(result.failed).toBe(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].attempts).toBe(MAX_ATTEMPTS_PER_DAY);
    expect(deps.capture).toHaveBeenCalledWith(
      "pudo_manifest_delivery_failed_terminal",
      expect.objectContaining({ level: "error" }),
    );
  });

  it("does not retry once the day's run is already in terminal 'failed'", async () => {
    // After we give up for the day, the next tick must short-circuit
    // until the calendar rolls over — otherwise on-call would be
    // paged every 15 minutes for an issue they've already triaged.
    partners.push(basePartner());
    runs.push({
      id: "preexisting",
      partnerCode: "pargo",
      forDate: "2026-04-29",
      shipmentCount: 1,
      contentHash: "hash-pargo",
      destination: "email:ops@pargo.com",
      deliveryMethod: "email",
      status: "failed",
      attempts: MAX_ATTEMPTS_PER_DAY,
      lastError: "smtp_5xx: gave up",
      deliveredAt: null,
      createdAt: new Date("2026-04-29T06:00:00Z"),
    });
    const deps = makeDeps();
    const result = await runDailyPudoManifestDelivery(deps);

    expect(result).toEqual({ attempted: 1, delivered: 0, skipped: 1, failed: 0 });
    expect(deps.emailTransport).not.toHaveBeenCalled();
    expect(runs[0].status).toBe("failed"); // unchanged
  });

  it("routes to the SFTP transport when the partner is configured for sftp", async () => {
    partners.push(
      basePartner({
        deliveryMethod: "sftp",
        sftpHost: "sftp.paxi.example",
        sftpUsername: "epplaa",
        sftpPasswordEnvVar: "PAXI_SFTP_PASSWORD",
      }),
    );
    const deps = makeDeps();
    const result = await runDailyPudoManifestDelivery(deps);

    expect(result.delivered).toBe(1);
    expect(deps.sftpTransport).toHaveBeenCalledTimes(1);
    expect(deps.emailTransport).not.toHaveBeenCalled();
    expect(runs[0].destination).toBe("sftp:host:/dir");
  });
});
