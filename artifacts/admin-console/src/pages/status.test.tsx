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

function jsonResponse(status: number, body: FakeReadyzBody): Response {
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
      constantResponse(503, {
        status: "not_ready",
        replicaId: "replica-B",
        checks: { db: "ok", redis: "failed" },
        failures: { redis: "redis_ping_timeout_after_2000ms" },
        rateLimitStore: "redis",
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
    let call = 0;
    fetchMock.mockImplementation((input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      // Route the dependency-panel endpoints to their canned responses
      // so the readyz alternation below isn't applied to every fetch.
      const canned = defaultHealthResponse(url);
      if (canned) return Promise.resolve(canned);
      call += 1;
      const replicaId = call % 2 === 0 ? "replica-A" : "replica-B";
      return Promise.resolve(
        jsonResponse(200, {
          status: "ready",
          replicaId,
          checks: { db: "ok", redis: "ok" },
          rateLimitStore: "redis",
        }),
      );
    });
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
});
