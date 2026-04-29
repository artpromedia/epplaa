// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Behavioural component tests for the admin shell's
 * `RateLimitStoreAlerts` panel.
 *
 * The panel polls /healthz and is responsible for:
 *   1. Showing a sticky banner whenever the rate-limit store is
 *      degraded, regardless of which page the operator is on.
 *   2. Firing a destructive toast on the healthy → degraded transition
 *      (and on first observation if already degraded).
 *   3. Firing a success toast and showing a transient recovery banner
 *      on the degraded → healthy transition, but only when
 *      `lastRecoveredAt` advances (so a stale healthy snapshot
 *      doesn't masquerade as a fresh recovery event).
 *   4. Deduping: notifications must NOT re-fire on every poll.
 *
 * We mock the typed health-check query at the import boundary so we
 * can drive state transitions deterministically: each render reads a
 * fresh value from the `healthHook` mock, so re-rendering with a
 * mutated mock simulates the next poll.
 */

const toastSpy = vi.fn();

vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({
    user: { id: "user_test", primaryEmailAddress: { emailAddress: "test@example.com" } },
  }),
  UserButton: () => null,
}));

vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    Link: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => (
      <a {...rest}>{children}</a>
    ),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const healthHook = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useAdminMyRoles: () => ({ data: { roles: [] }, isLoading: false }),
  useGetMfaStatus: () => ({ data: undefined, isLoading: false, error: undefined }),
  // Sentinel — the mocked useQuery below ignores the actual queryKey
  // and queryFn, and reads from `healthHook` instead. We only return
  // an object so consumers can spread `...getHealthCheckQueryOptions()`.
  getHealthCheckQueryOptions: () => ({ queryKey: ["healthz"] }),
}));

vi.mock("@tanstack/react-query", () => ({
  // Synchronously surface whatever `healthHook()` returns as `data`.
  // Re-rendering with a mutated `healthHook` mock simulates the next
  // /healthz poll for the SUT.
  useQuery: () => ({
    data: healthHook(),
    isLoading: false,
    error: undefined,
  }),
}));

const { RateLimitStoreAlerts } = await import("./rate-limit-store-alerts");

interface RateLimitStoreShape {
  kind: "memory" | "redis";
  state: "healthy" | "degraded";
  failureCount: number;
  firstFailureAt: number | null;
  lastRecoveredAt: number | null;
}

function healthy(lastRecoveredAt: number | null = null): RateLimitStoreShape {
  return {
    kind: "redis",
    state: "healthy",
    failureCount: 0,
    firstFailureAt: null,
    lastRecoveredAt,
  };
}

function degraded(failureCount = 5): RateLimitStoreShape {
  return {
    kind: "redis",
    state: "degraded",
    failureCount,
    firstFailureAt: 1_700_000_000_000,
    lastRecoveredAt: null,
  };
}

function setHealth(rateLimitStore: RateLimitStoreShape | undefined): void {
  healthHook.mockReturnValue(
    rateLimitStore === undefined
      ? undefined
      : { status: "ok", rateLimitStore },
  );
}

describe("RateLimitStoreAlerts — sticky banner surfaces degraded state on every page", () => {
  beforeEach(() => {
    healthHook.mockReset();
    toastSpy.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("renders nothing while /healthz hasn't loaded", () => {
    setHealth(undefined);
    render(<RateLimitStoreAlerts />);
    expect(screen.queryByTestId("banner-rate-limit-degraded")).toBeNull();
    expect(screen.queryByTestId("banner-rate-limit-recovered")).toBeNull();
  });

  it("renders nothing while the store is healthy and there is no recent recovery", () => {
    setHealth(healthy());
    render(<RateLimitStoreAlerts />);
    expect(screen.queryByTestId("banner-rate-limit-degraded")).toBeNull();
    expect(screen.queryByTestId("banner-rate-limit-recovered")).toBeNull();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("shows the sticky degraded banner with the failure count whenever state is degraded", () => {
    setHealth(degraded(7));
    render(<RateLimitStoreAlerts />);
    const banner = screen.getByTestId("banner-rate-limit-degraded");
    expect(banner.textContent).toContain("Rate-limit store degraded");
    expect(banner.textContent).toContain("7");
    expect(banner.textContent).toContain("redis");
  });

  it("operator can dismiss the degraded banner; it stays dismissed while still degraded", () => {
    setHealth(degraded(3));
    const { rerender } = render(<RateLimitStoreAlerts />);
    expect(screen.getByTestId("banner-rate-limit-degraded")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-rate-limit-degraded-dismiss"));
    expect(screen.queryByTestId("banner-rate-limit-degraded")).toBeNull();

    // Next poll still degraded — banner must stay hidden after dismiss.
    setHealth(degraded(4));
    rerender(<RateLimitStoreAlerts />);
    expect(screen.queryByTestId("banner-rate-limit-degraded")).toBeNull();
  });
});

describe("RateLimitStoreAlerts — transition toasts (and dedupe)", () => {
  beforeEach(() => {
    healthHook.mockReset();
    toastSpy.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("fires a destructive toast when the store transitions healthy → degraded", () => {
    setHealth(healthy());
    const { rerender } = render(<RateLimitStoreAlerts />);
    expect(toastSpy).not.toHaveBeenCalled();

    setHealth(degraded(2));
    rerender(<RateLimitStoreAlerts />);

    expect(toastSpy).toHaveBeenCalledTimes(1);
    const call = toastSpy.mock.calls[0]![0] as {
      variant?: string;
      title?: string;
      description?: string;
    };
    expect(call.variant).toBe("destructive");
    expect(call.title).toBe("Rate-limit store degraded");
    expect(call.description).toContain("just went degraded");
    expect(call.description).toContain("2");
  });

  it("fires a destructive toast on first observation if the store is already degraded (operator just opened the console)", () => {
    setHealth(degraded(9));
    render(<RateLimitStoreAlerts />);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const call = toastSpy.mock.calls[0]![0] as { description?: string };
    expect(call.description).toContain("currently degraded");
  });

  it("does NOT re-fire the degraded toast on subsequent polls while still degraded (dedupe)", () => {
    setHealth(degraded(2));
    const { rerender } = render(<RateLimitStoreAlerts />);
    expect(toastSpy).toHaveBeenCalledTimes(1);

    // Three more poll-driven re-renders, still degraded with mutating
    // failure counts. None of these should trip another toast.
    for (const failures of [3, 4, 5]) {
      setHealth(degraded(failures));
      rerender(<RateLimitStoreAlerts />);
    }
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it("fires a recovery toast and shows the recovery banner when degraded → healthy AND lastRecoveredAt advances", () => {
    setHealth(degraded(4));
    const { rerender } = render(<RateLimitStoreAlerts />);
    expect(toastSpy).toHaveBeenCalledTimes(1);

    setHealth(healthy(1_700_000_500_000));
    rerender(<RateLimitStoreAlerts />);

    expect(toastSpy).toHaveBeenCalledTimes(2);
    const recoverCall = toastSpy.mock.calls[1]![0] as {
      variant?: string;
      title?: string;
      description?: string;
    };
    // Recovery toast is the default (non-destructive) variant.
    expect(recoverCall.variant).toBeUndefined();
    expect(recoverCall.title).toBe("Rate-limit store recovered");
    expect(screen.getByTestId("banner-rate-limit-recovered")).toBeTruthy();
    expect(screen.queryByTestId("banner-rate-limit-degraded")).toBeNull();
  });

  it("does NOT fire a recovery toast if state flips healthy but lastRecoveredAt is null (transient or stale snapshot)", () => {
    setHealth(degraded(2));
    const { rerender } = render(<RateLimitStoreAlerts />);
    expect(toastSpy).toHaveBeenCalledTimes(1);

    // Healthy snapshot but lastRecoveredAt never advanced — this is the
    // exact stale-snapshot case the dedupe rule guards against.
    setHealth(healthy(null));
    rerender(<RateLimitStoreAlerts />);

    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("banner-rate-limit-recovered")).toBeNull();
  });

  it("does NOT re-fire the recovery toast on subsequent healthy polls (dedupe)", () => {
    setHealth(degraded(2));
    const { rerender } = render(<RateLimitStoreAlerts />);
    setHealth(healthy(1_700_000_500_000));
    rerender(<RateLimitStoreAlerts />);
    expect(toastSpy).toHaveBeenCalledTimes(2);

    // Two more healthy polls with the SAME lastRecoveredAt — no new
    // toasts; the recovery event is already handled.
    setHealth(healthy(1_700_000_500_000));
    rerender(<RateLimitStoreAlerts />);
    setHealth(healthy(1_700_000_500_000));
    rerender(<RateLimitStoreAlerts />);
    expect(toastSpy).toHaveBeenCalledTimes(2);
  });

  it("re-arms: a second healthy → degraded → healthy cycle fires a fresh pair of toasts", () => {
    setHealth(healthy());
    const { rerender } = render(<RateLimitStoreAlerts />);
    setHealth(degraded(2));
    rerender(<RateLimitStoreAlerts />);
    setHealth(healthy(1_700_000_500_000));
    rerender(<RateLimitStoreAlerts />);
    expect(toastSpy).toHaveBeenCalledTimes(2);

    // Second incident.
    setHealth(degraded(3));
    rerender(<RateLimitStoreAlerts />);
    expect(toastSpy).toHaveBeenCalledTimes(3);
    expect((toastSpy.mock.calls[2]![0] as { variant?: string }).variant).toBe(
      "destructive",
    );

    setHealth(healthy(1_700_001_000_000));
    rerender(<RateLimitStoreAlerts />);
    expect(toastSpy).toHaveBeenCalledTimes(4);
    expect((toastSpy.mock.calls[3]![0] as { title?: string }).title).toBe(
      "Rate-limit store recovered",
    );
  });

  it("auto-dismisses the recovery banner after 30s", () => {
    vi.useFakeTimers();
    try {
      setHealth(degraded(2));
      const { rerender } = render(<RateLimitStoreAlerts />);
      setHealth(healthy(1_700_000_500_000));
      rerender(<RateLimitStoreAlerts />);
      expect(screen.getByTestId("banner-rate-limit-recovered")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(screen.queryByTestId("banner-rate-limit-recovered")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
