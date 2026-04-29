// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Behavioural component tests for the admin "MFA setup" panel.
 *
 * Covers the two regressions the new MFA recovery work shipped:
 *
 * 1. The low-codes warning banner flips at the 3 / 0 thresholds. We
 *    render the real `MfaSetup` panel with a stub `useGetMfaStatus`
 *    that returns each threshold and assert the rendered DOM contains
 *    the right banner data-testid (and that nothing renders when the
 *    operator still has 3+ codes left).
 *
 * 2. The "Regenerate backup codes" form is reachable when (and only
 *    when) the operator has an active enrolment. We render the panel,
 *    assert the open button is present, click it, and then assert the
 *    input + submit + cancel controls actually mount. A matching
 *    negative test renders the unenrolled state and asserts none of
 *    those controls appear, so the gating itself is locked in by
 *    behaviour.
 *
 * Mocks the Clerk hook, the React Query client, the typed API hooks,
 * and the toast provider at the import boundary so the test can drive
 * UI state purely via stubbed hook return shapes — no real network,
 * no Clerk session.
 */

vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({
    user: { id: "user_test", primaryEmailAddress: { emailAddress: "test@example.com" } },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const statusHook = vi.fn();

// Per-mutation overrides so a test can swap in a stub that exposes a
// rate-limited `error` shape. Defaults to "no error" so the existing
// banner / regenerate-form tests behave as before.
const mutationStub = (): {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  error: unknown;
} => ({ mutate: vi.fn(), isPending: false, error: null });
const setupMutHook = vi.fn(mutationStub);
const verifyMutHook = vi.fn(mutationStub);
const disableMutHook = vi.fn(mutationStub);
const regenMutHook = vi.fn(mutationStub);

vi.mock("@workspace/api-client-react", () => ({
  useGetMfaStatus: () => statusHook(),
  // Mutation hooks are inert stubs — the recovery flow's success/error
  // branches are covered by the integration test in
  // `artifacts/api-server/src/routes/mfa.regenerate.int.test.ts`. Here
  // we only need them to not throw when the panel wires up its
  // onSuccess/onError handlers, plus expose the per-mutation `error`
  // hook so the rate-limit inline-alert tests can drive that branch.
  useSetupMfaTotp: () => setupMutHook(),
  useVerifyMfaTotp: () => verifyMutHook(),
  useDisableMfaTotp: () => disableMutHook(),
  useRegenerateMfaBackupCodes: () => regenMutHook(),
  parseRateLimitedError: parseRateLimitedErrorMock,
  // The component uses the memoized hook variant in render. Under
  // test it's safe to delegate straight to the same parser — the
  // memoization is exercised by the dedicated unit test in
  // `lib/api-client-react/src/hooks/use-rate-limited-error.test.ts`.
  useRateLimitedError: (err: unknown) => parseRateLimitedErrorMock(err),
  formatRetryAtClockTime: (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
}));

// Mirror the real helper: only treats well-known 429 shapes as
// rate-limited. Tests pass `{ rateLimited: true, retryAt }`
// payloads through the mutation `error` slot so we don't have to
// synthesise a real ApiError + Headers in the test environment.
function parseRateLimitedErrorMock(
  err: unknown,
): { retryAt: Date; retryAfterSeconds: number } | null {
  if (
    err &&
    typeof err === "object" &&
    (err as { rateLimited?: boolean }).rateLimited === true
  ) {
    const retryAt = (err as { retryAt?: Date }).retryAt ?? new Date();
    return { retryAt, retryAfterSeconds: 60 };
  }
  return null;
}

const { MfaSetup } = await import("./mfa-setup");

interface MfaStatusShape {
  enrolled: boolean;
  kind: "totp" | null;
  enrolledAt: string | null;
  lastUsedAt: string | null;
  backupCodesRemaining: number;
  recentlyAsserted: boolean;
  required: boolean;
  requiredReason: string | null;
  velocityNgnMinor: number;
  velocityThresholdNgnMinor: number;
}

function enrolledStatus(remaining: number): MfaStatusShape {
  return {
    enrolled: true,
    kind: "totp",
    enrolledAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-04-01T00:00:00.000Z",
    backupCodesRemaining: remaining,
    recentlyAsserted: true,
    required: true,
    requiredReason: "admin_role",
    velocityNgnMinor: 0,
    velocityThresholdNgnMinor: 100_000_000,
  };
}

function unenrolledStatus(): MfaStatusShape {
  return {
    enrolled: false,
    kind: null,
    enrolledAt: null,
    lastUsedAt: null,
    backupCodesRemaining: 0,
    recentlyAsserted: false,
    required: true,
    requiredReason: "admin_role",
    velocityNgnMinor: 0,
    velocityThresholdNgnMinor: 100_000_000,
  };
}

function setStatus(data: MfaStatusShape | undefined, isLoading = false): void {
  statusHook.mockReturnValue({ data, isLoading, error: undefined });
}

describe("Admin MfaSetup — backup-code warning banner", () => {
  beforeEach(() => {
    statusHook.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("renders no banner when 5 backup codes remain (well above the threshold)", () => {
    setStatus(enrolledStatus(5));
    render(<MfaSetup />);
    expect(screen.queryByTestId("backup-codes-banner-low")).toBeNull();
    expect(screen.queryByTestId("backup-codes-banner-empty")).toBeNull();
    expect(screen.getByTestId("mfa-active-card")).toBeTruthy();
  });

  it("renders no banner at exactly 3 codes (boundary — banner only fires below 3)", () => {
    // Locks in the off-by-one boundary: warning is "<3", so 3 itself
    // must stay silent. A regression that flipped to "<=3" would
    // incorrectly nag operators who still have a healthy buffer.
    setStatus(enrolledStatus(3));
    render(<MfaSetup />);
    expect(screen.queryByTestId("backup-codes-banner-low")).toBeNull();
    expect(screen.queryByTestId("backup-codes-banner-empty")).toBeNull();
    expect(screen.getByTestId("mfa-active-card")).toBeTruthy();
  });

  it("renders the amber 'low' banner when 1-2 codes remain", () => {
    setStatus(enrolledStatus(2));
    render(<MfaSetup />);
    const banner = screen.getByTestId("backup-codes-banner-low");
    expect(banner.textContent).toContain("2 backup codes left");
    expect(screen.queryByTestId("backup-codes-banner-empty")).toBeNull();
  });

  it("uses the singular 'code' label when exactly 1 code remains", () => {
    setStatus(enrolledStatus(1));
    render(<MfaSetup />);
    const banner = screen.getByTestId("backup-codes-banner-low");
    expect(banner.textContent).toContain("1 backup code left");
  });

  it("renders the destructive 'empty' banner when 0 codes remain", () => {
    setStatus(enrolledStatus(0));
    render(<MfaSetup />);
    const banner = screen.getByTestId("backup-codes-banner-empty");
    expect(banner.textContent?.toLowerCase()).toContain("out of backup codes");
    expect(screen.queryByTestId("backup-codes-banner-low")).toBeNull();
  });
});

describe("Admin MfaSetup — regenerate-backup-codes form is surfaced", () => {
  beforeEach(() => {
    statusHook.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("shows the open button when the operator is enrolled", () => {
    setStatus(enrolledStatus(2));
    render(<MfaSetup />);
    expect(screen.getByTestId("button-mfa-regenerate-open")).toBeTruthy();
    expect(screen.queryByTestId("input-mfa-regenerate-code")).toBeNull();
    expect(screen.queryByTestId("button-mfa-regenerate")).toBeNull();
    expect(screen.queryByTestId("button-mfa-regenerate-cancel")).toBeNull();
  });

  it("reveals the input + submit + cancel controls after clicking the open button", () => {
    setStatus(enrolledStatus(2));
    render(<MfaSetup />);
    fireEvent.click(screen.getByTestId("button-mfa-regenerate-open"));
    expect(screen.getByTestId("input-mfa-regenerate-code")).toBeTruthy();
    expect(screen.getByTestId("button-mfa-regenerate")).toBeTruthy();
    expect(screen.getByTestId("button-mfa-regenerate-cancel")).toBeTruthy();
  });

  it("does NOT surface the regenerate form when the operator has no enrolment", () => {
    setStatus(unenrolledStatus());
    render(<MfaSetup />);
    expect(screen.queryByTestId("button-mfa-regenerate-open")).toBeNull();
    expect(screen.queryByTestId("input-mfa-regenerate-code")).toBeNull();
    expect(screen.queryByTestId("button-mfa-regenerate")).toBeNull();
    expect(screen.getByTestId("mfa-enrol-card")).toBeTruthy();
  });
});

describe("Admin MfaSetup — MFA rate-limit inline alerts", () => {
  // The MFA mutation routes return 429 with a Retry-After header
  // when an operator trips the per-hour cap on the server. Each
  // affected section (start setup, verify, disable, regenerate)
  // should surface a friendly inline alert that names the action
  // and shows the local "try again at" time, instead of the
  // generic toast.

  function rateLimitedError(retryAt: Date): { rateLimited: true; retryAt: Date } {
    return { rateLimited: true, retryAt };
  }

  function resetMutations(): void {
    setupMutHook.mockReset().mockImplementation(mutationStub);
    verifyMutHook.mockReset().mockImplementation(mutationStub);
    disableMutHook.mockReset().mockImplementation(mutationStub);
    regenMutHook.mockReset().mockImplementation(mutationStub);
  }

  beforeEach(() => {
    statusHook.mockReset();
    resetMutations();
  });
  afterEach(() => {
    cleanup();
  });

  it("does NOT show any rate-limit alert in the steady state (no mutation errors)", () => {
    setStatus(enrolledStatus(5));
    render(<MfaSetup />);
    expect(screen.queryByTestId("mfa-rate-limit-setup")).toBeNull();
    expect(screen.queryByTestId("mfa-rate-limit-verify")).toBeNull();
    expect(screen.queryByTestId("mfa-rate-limit-disable")).toBeNull();
    expect(screen.queryByTestId("mfa-rate-limit-regenerate")).toBeNull();
  });

  it("renders the setup rate-limit alert when start-setup hits 429", () => {
    setStatus(unenrolledStatus());
    const retryAt = new Date(Date.now() + 60 * 60 * 1000);
    setupMutHook.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      error: rateLimitedError(retryAt),
    });
    render(<MfaSetup />);
    const alert = screen.getByTestId("mfa-rate-limit-setup");
    expect(alert.textContent).toContain("setup");
    const time = screen.getByTestId("mfa-rate-limit-setup-time");
    expect(time.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("renders the disable rate-limit alert when the destructive disable call hits 429", () => {
    setStatus(enrolledStatus(5));
    const retryAt = new Date(Date.now() + 30 * 60 * 1000);
    disableMutHook.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      error: rateLimitedError(retryAt),
    });
    render(<MfaSetup />);
    const alert = screen.getByTestId("mfa-rate-limit-disable");
    expect(alert.textContent).toContain("disable");
    expect(screen.getByTestId("mfa-rate-limit-disable-time")).toBeTruthy();
    // Independent server-side bucket — a regression that collapsed
    // disable + regenerate into the same alert would surface here.
    expect(screen.queryByTestId("mfa-rate-limit-regenerate")).toBeNull();
  });

  it("renders the regenerate alert when the destructive regenerate call hits 429 (form expanded)", () => {
    setStatus(enrolledStatus(2));
    const retryAt = new Date(Date.now() + 45 * 60 * 1000);
    regenMutHook.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      error: rateLimitedError(retryAt),
    });
    render(<MfaSetup />);
    fireEvent.click(screen.getByTestId("button-mfa-regenerate-open"));
    const alert = screen.getByTestId("mfa-rate-limit-regenerate");
    expect(alert.textContent).toContain("regeneration");
  });
});
