// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Tests for MfaEnrollmentWall: shell renders wall when
// `required && !sessionVerified` outside `/security`. Mocks
// `/mfa/status` so each branch is reachable.

const openUserProfile = vi.fn();
const mfaStatusHook = vi.fn();
const locationHook = vi.fn();

vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({
    user: { id: "user_test", primaryEmailAddress: { emailAddress: "op@example.com" } },
  }),
  useClerk: () => ({ openUserProfile }),
  UserButton: () => null,
}));

vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useLocation: () => locationHook(),
    Link: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => (
      <a {...rest}>{children}</a>
    ),
  };
});

vi.mock("@workspace/api-client-react", () => ({
  useAdminMyRoles: () => ({ data: { roles: ["admin"] }, isLoading: false }),
  useGetMfaStatus: () => mfaStatusHook(),
  // The shell's <RateLimitStoreAlerts /> child uses these — return inert
  // shapes so the panel renders nothing and stays out of these assertions.
  getHealthCheckQueryOptions: () => ({ queryKey: ["healthz"] }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, error: undefined }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const { AdminShell } = await import("./admin-shell");

interface MfaStatusShape {
  enrolled: boolean;
  required: boolean;
  requiredReason: "admin_role" | "high_velocity" | null;
  kind: "totp" | null;
  enrolledAt: string | null;
  lastUsedAt: string | null;
  backupCodesRemaining: number;
  recentlyAsserted: boolean;
  sessionVerified: boolean;
  velocityNgnMinor: number;
  velocityThresholdNgnMinor: number;
}

function status(over: Partial<MfaStatusShape>): MfaStatusShape {
  return {
    enrolled: false,
    required: true,
    requiredReason: "admin_role",
    kind: null,
    enrolledAt: null,
    lastUsedAt: null,
    backupCodesRemaining: 0,
    recentlyAsserted: false,
    sessionVerified: false,
    velocityNgnMinor: 0,
    velocityThresholdNgnMinor: 1_000_000_00,
    ...over,
  };
}

function setMfa(data: MfaStatusShape | undefined): void {
  mfaStatusHook.mockReturnValue({ data, isLoading: false, error: undefined });
}

function setRoute(path: string): void {
  locationHook.mockReturnValue([path, () => undefined] as never);
}

beforeEach(() => {
  openUserProfile.mockReset();
  mfaStatusHook.mockReset();
  locationHook.mockReset();
  setRoute("/");
});

afterEach(() => {
  cleanup();
});

describe("AdminShell MFA enrolment wall", () => {
  it("does not render the wall while /mfa/status is still loading", () => {
    setMfa(undefined);
    render(<AdminShell><div data-testid="child">child</div></AdminShell>);
    expect(screen.queryByTestId("screen-mfa-required")).toBeNull();
    expect(screen.getByTestId("child")).toBeTruthy();
  });

  it("does not render the wall when the Clerk session is MFA-verified (even with no local TOTP row)", () => {
    setMfa(status({ enrolled: false, sessionVerified: true, requiredReason: "admin_role" }));
    render(<AdminShell><div data-testid="child">child</div></AdminShell>);
    expect(screen.queryByTestId("screen-mfa-required")).toBeNull();
    expect(screen.getByTestId("child")).toBeTruthy();
  });

  it("does not render the wall for a non-required user", () => {
    setMfa(status({ required: false, enrolled: false, sessionVerified: false, requiredReason: null }));
    render(<AdminShell><div data-testid="child">child</div></AdminShell>);
    expect(screen.queryByTestId("screen-mfa-required")).toBeNull();
    expect(screen.getByTestId("child")).toBeTruthy();
  });

  it("renders the wall (and not children) when required and Clerk session is unverified", () => {
    setMfa(status({ enrolled: false, sessionVerified: false, required: true, requiredReason: "admin_role" }));
    render(<AdminShell><div data-testid="child">child</div></AdminShell>);
    const wall = screen.getByTestId("screen-mfa-required");
    expect(wall.textContent).toContain("Enrol MFA to continue");
    expect(screen.queryByTestId("child")).toBeNull();
  });

  it("walls out a locally-enrolled operator with an unverified Clerk session, switching copy to 'Verify'", () => {
    setMfa(status({
      enrolled: true,
      sessionVerified: false,
      kind: "totp",
      enrolledAt: "2026-01-01T00:00:00Z",
      requiredReason: "admin_role",
    }));
    render(<AdminShell><div data-testid="child">child</div></AdminShell>);
    const wall = screen.getByTestId("screen-mfa-required");
    expect(wall.textContent).toContain("Verify your second factor");
    expect(wall.textContent).toContain("verify their second factor");
    expect(screen.queryByTestId("child")).toBeNull();
  });

  it("surfaces the admin-role copy when requiredReason is admin_role", () => {
    setMfa(status({ requiredReason: "admin_role" }));
    render(<AdminShell><div /></AdminShell>);
    const wall = screen.getByTestId("screen-mfa-required");
    expect(wall.textContent).toContain("Operator accounts");
  });

  it("surfaces the high-velocity copy when requiredReason is high_velocity", () => {
    setMfa(status({ requiredReason: "high_velocity" }));
    render(<AdminShell><div /></AdminShell>);
    const wall = screen.getByTestId("screen-mfa-required");
    expect(wall.textContent).toContain("high-velocity threshold");
  });

  it("Clerk CTA deep-links to the MFA section via __experimental_startPath, not the generic profile", () => {
    setMfa(status({}));
    render(<AdminShell><div /></AdminShell>);
    const totpLink = screen.getByTestId("button-mfa-wall-setup-totp");
    expect(totpLink.tagName).toBe("A");
    expect(totpLink.getAttribute("href")).toBe("/security");

    const clerkButton = screen.getByTestId("button-mfa-wall-open-clerk");
    fireEvent.click(clerkButton);
    expect(openUserProfile).toHaveBeenCalledTimes(1);
    const callArg = openUserProfile.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(callArg?.__experimental_startPath).toBe("/security");
  });

  it("/security is an escape hatch: wall stands down so the operator can enrol", () => {
    setMfa(status({}));
    setRoute("/security");
    render(<AdminShell><div data-testid="security-page-child">security</div></AdminShell>);
    expect(screen.queryByTestId("screen-mfa-required")).toBeNull();
    expect(screen.getByTestId("security-page-child")).toBeTruthy();
  });
});
