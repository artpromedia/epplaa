// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
beforeEach(() => {
  fetchMock.mockReset();
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
  return () => Promise.resolve(jsonResponse(status, body));
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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
    render(<StatusPage />);
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
    render(<StatusPage />);
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
    fetchMock.mockImplementation(() => {
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
    render(<StatusPage />);
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
    render(<StatusPage />);
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
    render(<StatusPage />);
    await flushAsync();
    await waitFor(() => {
      expect(screen.getByTestId("replica-replica-A")).toBeTruthy();
    });
    const initialCalls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId("button-refresh-status"));
    await flushAsync();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls);
  });
});
