// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Stub admin-shell to avoid the `@assets` Vite alias used by the sidebar.
vi.mock("@/components/admin-shell", () => ({
  PageHeader: ({
    title,
    description,
    actions,
  }: {
    title: string;
    description?: string;
    actions?: ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {actions}
    </div>
  ),
}));

const fetchMock = vi.fn();

/**
 * Pre-canned responses for the dependency-panel endpoints so they
 * don't blow up during the readyz-focused tests below. Each test
 * file overrides individual entries via `setHealthResponse(...)` to
 * exercise the panel-specific paths.
 */
const healthResponses: Record<string, () => Response> = {};
function setHealthResponse(urlSuffix: string, factory: () => Response): void {
  healthResponses[urlSuffix] = factory;
}
function clearHealthResponses(): void {
  for (const k of Object.keys(healthResponses)) delete healthResponses[k];
}

function defaultHealthResponse(url: string): Response | null {
  for (const [suffix, factory] of Object.entries(healthResponses)) {
    if (url.includes(suffix)) return factory();
  }
  return null;
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  clearHealthResponses();
  // Sane defaults: panels load with healthy data so the readyz
  // assertions below aren't polluted by background polling errors.
  setHealthResponse("/api/healthz", () =>
    jsonOk({
      status: "ok",
      rateLimitStore: {
        kind: "memory",
        state: "healthy",
        failureCount: 0,
        firstFailureAt: null,
        lastRecoveredAt: null,
      },
    }),
  );
  setHealthResponse("/api/admin/payment-gateway-health", () => jsonOk([]));
  setHealthResponse("/api/admin/db-health", () =>
    jsonOk({
      replicaId: "replica-A",
      state: "healthy",
      sampleCount: 5,
      p50LatencyMs: 4,
      p95LatencyMs: 12,
      lastProbedAtIso: new Date().toISOString(),
      lastSuccessAtIso: new Date().toISOString(),
      lastError: null,
    }),
  );
  setHealthResponse("/api/admin/queue-health", () =>
    jsonOk({
      state: "healthy",
      pendingCount: 0,
      processingCount: 0,
      failedCount: 0,
      oldestPendingAtIso: null,
      oldestProcessingAtIso: null,
      sampledAtIso: new Date().toISOString(),
    }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const { default: StatusPage } = await import("./status");

interface FakeReadyzBody {
  status: "ready" | "not_ready";
  replicaId: string;
  checks: Record<string, "ok" | "failed" | "skipped">;
  failures?: Record<string, string>;
  rateLimitStore?: "memory" | "redis";
}

interface FakeHealthzSubsystem {
  state: "healthy" | "degraded";
  failureCount: number;
  firstFailureAt: number | null;
  lastRecoveredAt: number | null;
}

interface FakeHealthzBody {
  status: string;
  replicaId: string;
  subsystems: Record<string, FakeHealthzSubsystem>;
  rateLimitStore?: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Fresh Response per call — Response bodies are single-use and the panel
// fires multiple parallel probes per poll cycle.
function constantResponse(status: number, body: FakeReadyzBody) {
  // Routes /readyz to the supplied body; everything else falls back to
  // the per-test `healthResponses` map so the dependency panels keep
  // loading sane defaults instead of receiving a readyz body.
  return (input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/readyz")) {
      return Promise.resolve(jsonResponse(status, body));
    }
    const canned = defaultHealthResponse(url);
    if (canned) return Promise.resolve(canned);
    return Promise.resolve(jsonResponse(status, body));
  };
}

/**
 * Per-URL routing helper for tests that need to vary the /healthz or
 * /payment-gateway-health body across calls (e.g. the stuck-degraded
 * streak tests below, which switch healthz from healthy to failing
 * mid-test). For static panel responses, prefer `setHealthResponse(...)`
 * in `beforeEach` — `dispatchByUrl` is just for the dynamic cases.
 * Falls back to the canned `healthResponses` map when a handler is not
 * supplied so dependency panels keep loading sane defaults.
 */
function dispatchByUrl(handlers: {
  readyz: () => Promise<Response> | Response;
  healthz?: () => Promise<Response> | Response;
  gateways?: () => Promise<Response> | Response;
}) {
  return (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/api/admin/payment-gateway-health")) {
      if (handlers.gateways) return Promise.resolve(handlers.gateways());
      const canned = defaultHealthResponse(url);
      return Promise.resolve(canned ?? jsonResponse(200, []));
    }
    if (url.includes("/api/healthz")) {
      if (handlers.healthz) return Promise.resolve(handlers.healthz());
      const canned = defaultHealthResponse(url);
      return Promise.resolve(
        canned ?? jsonResponse(200, { status: "ok", subsystems: {} }),
      );
    }
    if (url.includes("/api/readyz")) return Promise.resolve(handlers.readyz());
    const canned = defaultHealthResponse(url);
    if (canned) return Promise.resolve(canned);
    return Promise.resolve(handlers.readyz());
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderWithQuery(ui: ReactNode) {
  // Each render gets a fresh QueryClient so cached responses from the
  // previous test don't bleed into the next one. Retries off so a
  // mocked failure doesn't waste a beat re-trying inside the test.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("StatusPage", () => {
  it("renders a Ready row for a healthy replica", async () => {
    fetchMock.mockImplementation(
      dispatchByUrl({
        readyz: () =>
          jsonResponse(200, {
            status: "ready",
            replicaId: "replica-A",
            checks: { db: "ok", redis: "ok" },
            rateLimitStore: "redis",
          } satisfies FakeReadyzBody),
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("replica-replica-A")).toBeTruthy();
    });
    const badge = screen.getByTestId("replica-status-replica-A");
    expect(badge.textContent).toContain("Ready");
    expect(screen.getByTestId("check-replica-A-db").textContent).toContain(
      "db: ok",
    );
    expect(screen.getByTestId("check-replica-A-redis").textContent).toContain(
      "redis: ok",
    );
    expect(screen.getByTestId("replica-rls-replica-A").textContent).toContain(
      "rateLimitStore: redis",
    );
  });

  it("renders a Degraded row with failures when /readyz returns 503", async () => {
    fetchMock.mockImplementation(
      dispatchByUrl({
        readyz: () =>
          jsonResponse(503, {
            status: "not_ready",
            replicaId: "replica-B",
            checks: { db: "ok", redis: "failed" },
            failures: { redis: "redis_ping_timeout_after_2000ms" },
            rateLimitStore: "redis",
          } satisfies FakeReadyzBody),
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("replica-replica-B")).toBeTruthy();
    });
    expect(screen.getByTestId("replica-status-replica-B").textContent).toContain(
      "Degraded",
    );
    const failuresBlock = screen.getByTestId("failures-replica-B");
    expect(failuresBlock.textContent).toContain("redis");
    expect(failuresBlock.textContent).toContain(
      "redis_ping_timeout_after_2000ms",
    );
    expect(screen.getByTestId("tile-degraded").textContent).toMatch(/[1-9]/);
  });

  it("groups results by replicaId when the LB samples two different replicas", async () => {
    // Use dispatchByUrl so the alternation only applies to /readyz —
    // dependency-panel polling falls back to the canned defaults set up
    // in beforeEach via setHealthResponse(...).
    let readyzCall = 0;
    fetchMock.mockImplementation(
      dispatchByUrl({
        readyz: () => {
          readyzCall += 1;
          const replicaId = readyzCall % 2 === 0 ? "replica-A" : "replica-B";
          return jsonResponse(200, {
            status: "ready",
            replicaId,
            checks: { db: "ok", redis: "ok" },
            rateLimitStore: "redis",
          } satisfies FakeReadyzBody);
        },
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.queryByTestId("replica-replica-A")).toBeTruthy();
      expect(screen.queryByTestId("replica-replica-B")).toBeTruthy();
    });
    expect(screen.getByTestId("tile-replicas").textContent).toContain("2");
    expect(screen.getByTestId("tile-healthy").textContent).toContain("2");
  });

  it("shows a network-error banner when /readyz cannot be reached at all", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("status-network-error")).toBeTruthy();
    });
    expect(screen.getByTestId("status-network-error").textContent).toContain(
      "network down",
    );
  });

  it("re-polls when the operator clicks Refresh now", async () => {
    fetchMock.mockImplementation(
      dispatchByUrl({
        readyz: () =>
          jsonResponse(200, {
            status: "ready",
            replicaId: "replica-A",
            checks: { db: "ok", redis: "ok" },
            rateLimitStore: "redis",
          } satisfies FakeReadyzBody),
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("replica-replica-A")).toBeTruthy();
    });
    const initialCalls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId("button-refresh-status"));
    await flushAsync();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it("renders the Database panel with healthy state and p50/p95 latency", async () => {
    setHealthResponse("/api/admin/db-health", () =>
      jsonOk({
        replicaId: "replica-A",
        state: "healthy",
        sampleCount: 5,
        p50LatencyMs: 7,
        p95LatencyMs: 18,
        lastProbedAtIso: new Date().toISOString(),
        lastSuccessAtIso: new Date().toISOString(),
        lastError: null,
      }),
    );
    fetchMock.mockImplementation(
      constantResponse(200, {
        status: "ready",
        replicaId: "replica-A",
        checks: { db: "ok", redis: "ok" },
        rateLimitStore: "redis",
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("db-health-panel")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByTestId("db-health-state").textContent).toContain(
        "healthy",
      );
    });
    expect(screen.getByTestId("db-health-replica").textContent).toContain(
      "replica-A",
    );
    expect(screen.getByTestId("db-health-p50").textContent).toContain("7");
    expect(screen.getByTestId("db-health-p95").textContent).toContain("18");
    expect(screen.getByTestId("db-health-sample-count").textContent).toContain(
      "5",
    );
  });

  it("renders the Database panel as degraded with the failing probe error", async () => {
    setHealthResponse("/api/admin/db-health", () =>
      jsonOk({
        replicaId: "replica-B",
        state: "degraded",
        sampleCount: 3,
        p50LatencyMs: 9,
        p95LatencyMs: 410,
        lastProbedAtIso: new Date().toISOString(),
        lastSuccessAtIso: new Date().toISOString(),
        lastError: "ECONNRESET",
      }),
    );
    fetchMock.mockImplementation(
      constantResponse(200, {
        status: "ready",
        replicaId: "replica-A",
        checks: { db: "ok", redis: "ok" },
        rateLimitStore: "redis",
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("db-health-state").textContent).toContain(
        "degraded",
      );
    });
    expect(screen.getByTestId("db-health-last-error").textContent).toContain(
      "ECONNRESET",
    );
    expect(screen.getByTestId("db-health-p95").textContent).toContain("410");
  });

  it("renders the Background queue panel with healthy state and zero counts", async () => {
    fetchMock.mockImplementation(
      constantResponse(200, {
        status: "ready",
        replicaId: "replica-A",
        checks: { db: "ok", redis: "ok" },
        rateLimitStore: "redis",
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("queue-health-panel")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByTestId("queue-health-state").textContent).toContain(
        "healthy",
      );
    });
    expect(screen.getByTestId("queue-health-pending").textContent).toContain(
      "0",
    );
    expect(screen.getByTestId("queue-health-failed").textContent).toContain(
      "0",
    );
  });

  it("renders the Background queue panel as degraded with failed-row count and oldest pending timestamp", async () => {
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    setHealthResponse("/api/admin/queue-health", () =>
      jsonOk({
        state: "degraded",
        pendingCount: 12,
        processingCount: 1,
        failedCount: 3,
        oldestPendingAtIso: stale,
        oldestProcessingAtIso: new Date(Date.now() - 30_000).toISOString(),
        sampledAtIso: new Date().toISOString(),
      }),
    );
    fetchMock.mockImplementation(
      constantResponse(200, {
        status: "ready",
        replicaId: "replica-A",
        checks: { db: "ok", redis: "ok" },
        rateLimitStore: "redis",
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("queue-health-state").textContent).toContain(
        "degraded",
      );
    });
    expect(screen.getByTestId("queue-health-failed").textContent).toContain(
      "3",
    );
    expect(screen.getByTestId("queue-health-pending").textContent).toContain(
      "12",
    );
    // Timestamp rendering uses formatRelativeFlexible — the oldest
    // pending should at least mention minutes-ago.
    expect(
      screen.getByTestId("queue-health-oldest-pending").textContent,
    ).toMatch(/m ago|h ago/);
  });

  it("renders a healthz failure-streak block on the replica card with the offending subsystem and duration", async () => {
    // db has been degraded for ~30s — below the 5m page threshold, so the
    // card should show the streak as informational (no pageable badge).
    const dbFirstFailureAt = Date.now() - 30_000;
    fetchMock.mockImplementation(
      dispatchByUrl({
        readyz: () =>
          jsonResponse(503, {
            status: "not_ready",
            replicaId: "replica-A",
            checks: { db: "failed", redis: "ok" },
            failures: { db: "db_timeout_after_2000ms" },
            rateLimitStore: "redis",
          } satisfies FakeReadyzBody),
        healthz: () =>
          jsonResponse(200, {
            status: "ok",
            replicaId: "replica-A",
            subsystems: {
              db: {
                state: "degraded",
                failureCount: 4,
                firstFailureAt: dbFirstFailureAt,
                lastRecoveredAt: null,
              },
              rateLimitStore: {
                state: "healthy",
                failureCount: 0,
                firstFailureAt: null,
                lastRecoveredAt: null,
              },
            },
          } satisfies FakeHealthzBody),
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("streaks-replica-A")).toBeTruthy();
    });
    // Only the degraded subsystem is listed, not the healthy one.
    expect(screen.getByTestId("streak-replica-A-db")).toBeTruthy();
    expect(screen.queryByTestId("streak-replica-A-rateLimitStore")).toBeNull();
    // Duration label reflects the streak age and names the subsystem.
    const dbRow = screen.getByTestId("streak-replica-A-db");
    expect(dbRow.textContent).toContain("db");
    expect(dbRow.textContent).toMatch(/stuck-degraded for \d+s/);
    // Below the page threshold, so neither the per-streak nor the
    // per-card pageable badges fire.
    expect(
      screen.queryByTestId("streak-pageable-replica-A-db"),
    ).toBeNull();
    expect(
      screen.queryByTestId("replica-stuck-degraded-replica-A"),
    ).toBeNull();
    expect(screen.queryByTestId("stuck-degraded-banner")).toBeNull();
    expect(screen.getByTestId("tile-stuck-degraded").textContent).toContain("0");
  });

  it("flags a streak that has crossed the duration probe's page threshold", async () => {
    // rateLimitStore stuck-degraded for 7 minutes — past the 5 minute
    // checkHealthzDegraded threshold. Even though /readyz is still OK
    // (memory store fallback keeps the replica ready), the panel must
    // make it obvious the duration probe would page now.
    const stuckFirstFailureAt = Date.now() - 7 * 60 * 1000;
    fetchMock.mockImplementation(
      dispatchByUrl({
        readyz: () =>
          jsonResponse(200, {
            status: "ready",
            replicaId: "replica-X",
            checks: { db: "ok", redis: "ok" },
            rateLimitStore: "redis",
          } satisfies FakeReadyzBody),
        healthz: () =>
          jsonResponse(200, {
            status: "ok",
            replicaId: "replica-X",
            subsystems: {
              rateLimitStore: {
                state: "degraded",
                failureCount: 42,
                firstFailureAt: stuckFirstFailureAt,
                lastRecoveredAt: null,
              },
              db: {
                state: "healthy",
                failureCount: 0,
                firstFailureAt: null,
                lastRecoveredAt: null,
              },
            },
          } satisfies FakeHealthzBody),
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("streaks-replica-X")).toBeTruthy();
    });
    // Per-streak pageable badge fires.
    expect(
      screen.getByTestId("streak-pageable-replica-X-rateLimitStore"),
    ).toBeTruthy();
    // Per-card badge in the header so on-call sees it without scrolling.
    expect(
      screen.getByTestId("replica-stuck-degraded-replica-X").textContent,
    ).toContain("Stuck-degraded");
    // Top-level banner + tile reflect the page-worthy streak.
    expect(screen.getByTestId("stuck-degraded-banner").textContent).toContain(
      "stuck-degraded",
    );
    expect(screen.getByTestId("tile-stuck-degraded").textContent).toContain(
      "1",
    );
    // Duration formatting drops to minutes for streaks longer than 60s.
    const row = screen.getByTestId("streak-replica-X-rateLimitStore");
    expect(row.textContent).toMatch(/stuck-degraded for 7m/);
  });

  it("drops a previously-degraded streak when /healthz stops responding for longer than the stale window", async () => {
    // Pin time so we can deterministically cross the 60s stale window.
    const t0 = new Date("2026-04-29T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    const dbFirstFailureAt = t0 - 30_000;

    // Phase 1: healthz reports a degraded subsystem so the streak row
    // gets recorded in component state.
    let healthzShouldFail = false;
    fetchMock.mockImplementation(
      dispatchByUrl({
        readyz: () =>
          jsonResponse(200, {
            status: "ready",
            replicaId: "replica-A",
            checks: { db: "ok", redis: "ok" },
            rateLimitStore: "redis",
          } satisfies FakeReadyzBody),
        healthz: () => {
          if (healthzShouldFail) return Promise.reject(new Error("healthz down"));
          return jsonResponse(200, {
            status: "ok",
            replicaId: "replica-A",
            subsystems: {
              db: {
                state: "degraded",
                failureCount: 4,
                firstFailureAt: dbFirstFailureAt,
                lastRecoveredAt: null,
              },
            },
          } satisfies FakeHealthzBody);
        },
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("streaks-replica-A")).toBeTruthy();
    });

    // Phase 2: /healthz starts failing while /readyz keeps succeeding.
    // Jump past REPLICA_STALE_AFTER_MS (60s) and trigger another poll
    // via the operator's Refresh button.
    healthzShouldFail = true;
    vi.setSystemTime(t0 + 90_000);
    fireEvent.click(screen.getByTestId("button-refresh-status"));
    await flushAsync();

    // The stale streak must age out even though no successful healthz
    // sample arrived to evict it implicitly.
    await waitFor(() => {
      expect(screen.queryByTestId("streaks-replica-A")).toBeNull();
    });
    expect(screen.queryByTestId("streak-replica-A-db")).toBeNull();
    expect(screen.getByTestId("tile-stuck-degraded").textContent).toContain("0");
  });

  it("does not render a streak block when every healthz subsystem is healthy", async () => {
    fetchMock.mockImplementation(
      dispatchByUrl({
        readyz: () =>
          jsonResponse(200, {
            status: "ready",
            replicaId: "replica-A",
            checks: { db: "ok", redis: "ok" },
            rateLimitStore: "redis",
          } satisfies FakeReadyzBody),
        healthz: () =>
          jsonResponse(200, {
            status: "ok",
            replicaId: "replica-A",
            subsystems: {
              db: {
                state: "healthy",
                failureCount: 0,
                firstFailureAt: null,
                lastRecoveredAt: Date.now() - 60_000,
              },
              rateLimitStore: {
                state: "healthy",
                failureCount: 0,
                firstFailureAt: null,
                lastRecoveredAt: null,
              },
            },
          } satisfies FakeHealthzBody),
      }),
    );
    renderWithQuery(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("replica-replica-A")).toBeTruthy();
    });
    expect(screen.queryByTestId("streaks-replica-A")).toBeNull();
    expect(
      screen.queryByTestId("replica-stuck-degraded-replica-A"),
    ).toBeNull();
    expect(screen.queryByTestId("stuck-degraded-banner")).toBeNull();
  });
});
