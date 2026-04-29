import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser, UserButton } from "@clerk/clerk-react";
import {
  ShieldAlert,
  ShieldCheck,
  LayoutDashboard,
  Inbox,
  Scale,
  Wallet,
  Ban,
  Users,
  TestTube2,
  KeyRound,
  Activity,
  IdCard,
  Globe2,
  FileLock2,
  ScrollText,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { useAdminMyRoles, useGetMfaStatus } from "@workspace/api-client-react";
import { RateLimitStoreAlerts } from "@/components/rate-limit-store-alerts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import epplaaLogo from "@assets/epplaa-logo-color-nobg.png";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  section?: string;
  /** Only show this nav entry to users holding one of these roles. Omit = all signed-in operators. */
  requireRoles?: readonly string[];
}

// Trust & Safety items are admin-only and must match the API gate in
// artifacts/api-server/src/routes/adminTrustSafety.ts (ADMIN_ONLY).
const ADMIN_ONLY_NAV = ["admin"] as const;

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/cases", label: "Cases", icon: Inbox },
  { href: "/disputes", label: "Disputes", icon: Scale },
  { href: "/kyc", label: "KYC review", icon: IdCard, section: "Trust & Safety", requireRoles: ADMIN_ONLY_NAV },
  { href: "/sanctions", label: "Sanctions", icon: Globe2, requireRoles: ADMIN_ONLY_NAV },
  { href: "/payouts", label: "Payouts", icon: Wallet },
  { href: "/payouts?status=blocked", label: "Blocked payouts", icon: AlertTriangle, requireRoles: ADMIN_ONLY_NAV },
  { href: "/ndpr", label: "NDPR requests", icon: FileLock2, requireRoles: ADMIN_ONLY_NAV },
  { href: "/audit", label: "Audit log", icon: ScrollText, requireRoles: ADMIN_ONLY_NAV },
  { href: "/takedowns", label: "Takedowns", icon: Ban },
  { href: "/users", label: "Users & roles", icon: Users },
  { href: "/scan", label: "Scan bench", icon: TestTube2 },
  { href: "/security", label: "Security", icon: KeyRound },
  { href: "/status", label: "Status", icon: Activity, section: "System" },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { user } = useUser();
  const rolesQuery = useAdminMyRoles({
    query: { staleTime: 30_000 } as never,
  });
  const roles = rolesQuery.data?.roles ?? [];
  const mfaStatusQuery = useGetMfaStatus({ query: { staleTime: 30_000 } as never });
  const mfaStatus = mfaStatusQuery.data;

  // Mirror the backend gate (Clerk `fva` claim via /mfa/status.sessionVerified).
  // Allow /security so the operator can enrol/verify without a self-lockout.
  const onSecurityPage = location.startsWith("/security");
  const mfaWallActive =
    !!mfaStatus &&
    mfaStatus.required &&
    !mfaStatus.sessionVerified &&
    !onSecurityPage;
  if (mfaWallActive) {
    return (
      <MfaEnrollmentWall
        reason={mfaStatus.requiredReason}
        enrolled={mfaStatus.enrolled}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      <aside className="hidden md:flex md:w-60 lg:w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="px-4 py-4 border-b border-sidebar-border flex items-center gap-3">
          <img
            src={epplaaLogo}
            alt="Epplaa"
            className="h-[3.281rem] w-auto"
            data-testid="img-brand-logo"
          />
          <div className="leading-tight border-l border-sidebar-border pl-3">
            <p className="text-xs font-semibold">Admin</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Trust &amp; Safety
            </p>
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {NAV.filter((item) => {
            if (!item.requireRoles) return true;
            // Hide role-gated nav until we know the user's roles to avoid
            // flashing entries that the API would reject anyway.
            if (rolesQuery.isLoading) return false;
            return item.requireRoles.some((r) => roles.includes(r));
          }).map((item, idx, visible) => {
            const active =
              item.href === "/"
                ? location === "/" || location === ""
                : location.startsWith(item.href);
            const Icon = item.icon;
            const prevSection = idx > 0 ? visible[idx - 1].section : undefined;
            const showSection = item.section && item.section !== prevSection;
            return (
              <div key={item.href}>
                {showSection && (
                  <p
                    className="mt-3 mb-1 px-3 text-[10px] uppercase tracking-wider text-muted-foreground"
                    data-testid={`nav-section-${item.section!.toLowerCase()}`}
                  >
                    {item.section}
                  </p>
                )}
                <Link
                  href={item.href}
                  data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-md text-sm hover-elevate",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground/80",
                  )}
                >
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </Link>
              </div>
            );
          })}
        </nav>
        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-2 mb-2">
            <UserButton afterSignOutUrl="/sign-in" />
            <div className="min-w-0 leading-tight">
              <p className="text-xs font-medium truncate">
                {user?.primaryEmailAddress?.emailAddress ?? user?.id ?? "Operator"}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">
                {roles.length === 0
                  ? rolesQuery.isLoading
                    ? "Loading roles…"
                    : "No roles"
                  : roles.join(" · ")}
              </p>
            </div>
          </div>
          {roles.length === 0 && !rolesQuery.isLoading && (
            <p className="text-[10px] text-destructive">
              You have no admin roles. Ask an admin to grant you access.
            </p>
          )}
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden border-b border-border bg-background px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src={epplaaLogo} alt="Epplaa" className="h-[2.344rem] w-auto" />
            <span className="text-xs font-semibold text-muted-foreground border-l border-border pl-2">Admin</span>
          </div>
          <UserButton afterSignOutUrl="/sign-in" />
        </header>

        <main className="flex-1 min-w-0 overflow-x-auto">
          <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-7xl mx-auto w-full">
            <MfaRequiredBanner />
            <RateLimitStoreAlerts />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

// Full-screen takeover when `required && !sessionVerified`. Copy adapts
// to whether the operator already has a factor (then "verify") or not
// (then "enrol"). Offers the in-house TOTP flow plus a Clerk-modal deep
// link to Multi-factor authentication.
function MfaEnrollmentWall({
  reason,
  enrolled,
}: {
  reason: "admin_role" | "high_velocity" | null;
  enrolled: boolean;
}) {
  const clerk = useClerk();
  const handleOpenClerkProfile = () => {
    // `__experimental_startPath` lands the modal on Clerk's MFA page
    // instead of the generic Account tab.
    clerk.openUserProfile({ __experimental_startPath: "/security" });
  };
  const headline = enrolled
    ? "Verify your second factor to continue"
    : "Enrol MFA to continue";
  const subhead =
    reason === "admin_role"
      ? enrolled
        ? "Operator accounts must verify their second factor for the current session before they can act."
        : "Operator accounts must enable a second factor before they can act."
      : enrolled
        ? "Your account crossed the high-velocity threshold and your current session is not MFA-verified."
        : "Your account crossed the high-velocity threshold and now requires MFA.";
  const guidance = enrolled
    ? "Use one of the options below to verify your existing second factor. The back-office unlocks automatically once Clerk records the verification — you'll see this screen disappear within a few seconds."
    : "Pick one of the options below. Once you've added a factor the back-office unlocks automatically — you'll see this screen disappear within a few seconds.";
  return (
    <div
      className="min-h-screen flex items-center justify-center bg-muted px-4"
      data-testid="screen-mfa-required"
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-background shadow-sm p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-full bg-destructive/10 p-2">
            <ShieldAlert className="w-6 h-6 text-destructive" aria-hidden />
          </div>
          <div>
            <h1 className="text-lg font-semibold">{headline}</h1>
            <p className="text-xs text-muted-foreground mt-0.5">{subhead}</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mb-5">{guidance}</p>
        <div className="space-y-2">
          <Button
            asChild
            className="w-full justify-start gap-2"
            data-testid="button-mfa-wall-setup-totp"
          >
            <Link href="/security">
              <ShieldCheck className="w-4 h-4" />
              Set up an authenticator app (TOTP)
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start gap-2"
            onClick={handleOpenClerkProfile}
            data-testid="button-mfa-wall-open-clerk"
          >
            <ExternalLink className="w-4 h-4" />
            Open Clerk profile (passkeys, WebAuthn, additional factors)
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-4">
          Need help? Ask another admin to walk you through enrolment in
          your authenticator app. Backup codes are issued automatically
          and should be stored somewhere safe and offline.
        </p>
      </div>
    </div>
  );
}

// Inline fallback for when the wall stands down (e.g. /security).
// Keyed off `sessionVerified` to match the backend gate.
function MfaRequiredBanner() {
  const [location] = useLocation();
  const statusQuery = useGetMfaStatus({ query: { staleTime: 30_000 } as never });
  const status = statusQuery.data;
  if (!status) return null;
  if (location.startsWith("/security")) return null;
  if (!status.required || status.sessionVerified) return null;
  return (
    <div
      className="mb-4 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
      data-testid="banner-mfa-required"
    >
      <ShieldAlert className="w-5 h-5 mt-0.5 text-destructive shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-destructive">MFA required</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {status.requiredReason === "admin_role"
            ? status.enrolled
              ? "Operators must verify their second factor for the current session before they can act on cases or payouts."
              : "Operators must enable a second factor before they can act on cases or payouts."
            : "Your account crossed the high-velocity threshold and your current session is not MFA-verified."}
        </p>
      </div>
      <Link
        href="/security"
        data-testid="link-mfa-setup"
        className="shrink-0 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-background px-3 py-1.5 text-xs font-medium hover-elevate"
      >
        <ShieldCheck className="w-3.5 h-3.5" />{" "}
        {status.enrolled ? "Verify MFA" : "Set up MFA"}
      </Link>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
