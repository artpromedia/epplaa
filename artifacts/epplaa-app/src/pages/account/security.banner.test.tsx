// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Behavioural component tests for the seller "Security & MFA" page.
 *
 * Covers the two regressions the new MFA recovery work shipped:
 *
 * 1. The low-codes warning banner flips at the 3 / 0 thresholds. We
 *    render the real `Security` page with a stub `useGetMfaStatus`
 *    that returns each threshold and assert the rendered DOM contains
 *    the right banner data-testid (and that nothing renders when the
 *    user still has 3+ codes left).
 *
 * 2. The "Regenerate backup codes" form is reachable from the screen
 *    when (and only when) the user has an active enrolment. We render
 *    the page, assert the open button is present, click it, and then
 *    assert the input + submit + cancel controls actually mount. A
 *    matching negative test renders the unenrolled state and asserts
 *    none of those controls appear, so the gating itself is locked
 *    in by behaviour, not just by a string match on the source file.
 *
 * The page pulls in Clerk, the React Query client, the typed API
 * hooks, the toast provider, the theme context, and the wouter Link
 * inside `PageHeader`. We mock the modules at the import boundary so
 * the test can drive UI state purely via the stubbed hook return
 * shapes — no real network, no Clerk session, no router mount.
 */

// Hoisted mocks — vi.mock factories run before the SUT is imported.
vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({
    user: { id: "user_test", primaryEmailAddress: { emailAddress: "test@example.com" } },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("@/components/page-header", () => ({
  // Stub the header — its real implementation pulls in wouter's Link
  // which needs a Router ancestor we don't want to wire up here.
  PageHeader: ({ title }: { title: string }) => (
    <div data-testid="stub-page-header">{title}</div>
  ),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Status hook is rebound per-test via the mock below. We default it
// to a sensible "loading" shape so a missed reset would surface as a
// loading spinner instead of a stale enrolment.
const statusHook = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetMfaStatus: () => statusHook(),
  // Mutation hooks are inert stubs — the recovery flow's success/error
  // branches are covered by the integration test in
  // `artifacts/api-server/src/routes/mfa.regenerate.int.test.ts`. Here
  // we only need them to not throw when the page wires up its
  // onSuccess/onError handlers.
  useSetupMfaTotp: () => ({ mutate: vi.fn(), isPending: false }),
  useVerifyMfaTotp: () => ({ mutate: vi.fn(), isPending: false }),
  useDisableMfaTotp: () => ({ mutate: vi.fn(), isPending: false }),
  useRegenerateMfaBackupCodes: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Import AFTER the mocks so the SUT picks up the stubs.
const { default: Security } = await import("./security");

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
    required: false,
    requiredReason: null,
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
    required: false,
    requiredReason: null,
    velocityNgnMinor: 0,
    velocityThresholdNgnMinor: 100_000_000,
  };
}

function setStatus(data: MfaStatusShape | undefined, isLoading = false): void {
  statusHook.mockReturnValue({ data, isLoading, error: undefined });
}

describe("Security page — backup-code warning banner", () => {
  beforeEach(() => {
    statusHook.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("renders no banner when 5 backup codes remain (well above the threshold)", () => {
    setStatus(enrolledStatus(5));
    render(<Security />);
    expect(screen.queryByTestId("backup-codes-banner-low")).toBeNull();
    expect(screen.queryByTestId("backup-codes-banner-empty")).toBeNull();
    // Sanity: the active card *is* rendered, so the absence above is
    // because the banner is silent, not because the whole page is.
    expect(screen.getByTestId("mfa-active-card")).toBeTruthy();
  });

  it("renders no banner at exactly 3 codes (boundary — banner only fires below 3)", () => {
    // Locks in the off-by-one boundary: warning is "<3", so 3 itself
    // must stay silent. A regression that flipped to "<=3" would
    // incorrectly nag users who still have a healthy buffer.
    setStatus(enrolledStatus(3));
    render(<Security />);
    expect(screen.queryByTestId("backup-codes-banner-low")).toBeNull();
    expect(screen.queryByTestId("backup-codes-banner-empty")).toBeNull();
    expect(screen.getByTestId("mfa-active-card")).toBeTruthy();
  });

  it("renders the amber 'low' banner when 1-2 codes remain", () => {
    setStatus(enrolledStatus(2));
    render(<Security />);
    const banner = screen.getByTestId("backup-codes-banner-low");
    expect(banner.textContent).toContain("2 backup codes left");
    expect(screen.queryByTestId("backup-codes-banner-empty")).toBeNull();
  });

  it("uses the singular 'code' label when exactly 1 code remains", () => {
    setStatus(enrolledStatus(1));
    render(<Security />);
    const banner = screen.getByTestId("backup-codes-banner-low");
    expect(banner.textContent).toContain("1 backup code left");
  });

  it("renders the red 'empty' banner when 0 codes remain", () => {
    setStatus(enrolledStatus(0));
    render(<Security />);
    const banner = screen.getByTestId("backup-codes-banner-empty");
    expect(banner.textContent?.toLowerCase()).toContain("out of backup codes");
    expect(screen.queryByTestId("backup-codes-banner-low")).toBeNull();
  });
});

describe("Security page — regenerate-backup-codes form is surfaced", () => {
  beforeEach(() => {
    statusHook.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("shows the open button when the user is enrolled", () => {
    setStatus(enrolledStatus(2));
    render(<Security />);
    expect(screen.getByTestId("button-mfa-regenerate-open")).toBeTruthy();
    // Form fields haven't been opened yet — they should NOT be in the
    // DOM until the user clicks the open button.
    expect(screen.queryByTestId("input-mfa-regenerate-code")).toBeNull();
    expect(screen.queryByTestId("button-mfa-regenerate")).toBeNull();
    expect(screen.queryByTestId("button-mfa-regenerate-cancel")).toBeNull();
  });

  it("reveals the input + submit + cancel controls after clicking the open button", () => {
    setStatus(enrolledStatus(2));
    render(<Security />);
    fireEvent.click(screen.getByTestId("button-mfa-regenerate-open"));
    // The full form is now mounted — input for the 6-digit code,
    // submit button, and cancel button all wired up.
    expect(screen.getByTestId("input-mfa-regenerate-code")).toBeTruthy();
    expect(screen.getByTestId("button-mfa-regenerate")).toBeTruthy();
    expect(screen.getByTestId("button-mfa-regenerate-cancel")).toBeTruthy();
  });

  it("does NOT surface the regenerate form when the user has no enrolment", () => {
    setStatus(unenrolledStatus());
    render(<Security />);
    expect(screen.queryByTestId("button-mfa-regenerate-open")).toBeNull();
    expect(screen.queryByTestId("input-mfa-regenerate-code")).toBeNull();
    expect(screen.queryByTestId("button-mfa-regenerate")).toBeNull();
    // The unenrolled enrolment-start card is what the user sees instead.
    expect(screen.getByTestId("mfa-enrol-card")).toBeTruthy();
  });
});
