import { ReactNode } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClerkProvider, SignedIn, SignedOut, SignIn, useAuth } from "@clerk/clerk-react";
import epplaaLogo from "@assets/epplaa-logo-color-nobg.png";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import NotFound from "@/pages/not-found";
import { ApiAuthBridge } from "@/lib/auth-bridge";
import { CsrfBridge } from "@/lib/csrf-bridge";
import "@/lib/api-init";
import { AdminShell } from "@/components/admin-shell";

import DashboardPage from "@/pages/dashboard";
import CasesPage from "@/pages/cases";
import CaseDetailPage from "@/pages/case-detail";
import DisputesPage from "@/pages/disputes";
import PayoutsPage from "@/pages/payouts";
import TakedownsPage from "@/pages/takedowns";
import UsersPage from "@/pages/users";
import ScanBenchPage from "@/pages/scan-bench";
import SecurityPage from "@/pages/security";
import StatusPage from "@/pages/status";
import KycPage from "@/pages/kyc";
import SanctionsPage from "@/pages/sanctions";
import NdprPage from "@/pages/ndpr";
import AuditPage from "@/pages/audit";
import { RequireRoles } from "@/components/require-roles";

const ADMIN_ONLY = ["admin"] as const;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

function SignInPage() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-muted px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <img
            src={epplaaLogo}
            alt="Epplaa"
            className="h-[4.688rem] w-auto mx-auto mb-3"
            data-testid="img-brand-logo"
          />
          <p className="text-sm font-semibold text-foreground">Admin Console</p>
          <p className="text-xs text-muted-foreground mt-1">
            Sign in with your operator account. MFA is required.
          </p>
        </div>
        <SignIn
          routing="hash"
          afterSignInUrl={import.meta.env.BASE_URL}
          appearance={{ elements: { rootBox: "mx-auto" } }}
        />
      </div>
    </div>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [location] = useLocation();
  const isPublic = location.startsWith("/sign-in");

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (!isSignedIn && !isPublic) return <Redirect to="/sign-in" />;
  if (isSignedIn && isPublic) return <Redirect to="/" />;
  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/sign-in" component={SignInPage} />
      <Route>
        <AdminShell>
          <Switch>
            <Route path="/" component={DashboardPage} />
            <Route path="/cases" component={CasesPage} />
            <Route path="/cases/:id" component={CaseDetailPage} />
            <Route path="/disputes" component={DisputesPage} />
            <Route path="/kyc">
              <RequireRoles roles={ADMIN_ONLY}>
                <KycPage />
              </RequireRoles>
            </Route>
            <Route path="/sanctions">
              <RequireRoles roles={ADMIN_ONLY}>
                <SanctionsPage />
              </RequireRoles>
            </Route>
            <Route path="/payouts" component={PayoutsPage} />
            <Route path="/ndpr">
              <RequireRoles roles={ADMIN_ONLY}>
                <NdprPage />
              </RequireRoles>
            </Route>
            <Route path="/audit">
              <RequireRoles roles={ADMIN_ONLY}>
                <AuditPage />
              </RequireRoles>
            </Route>
            <Route path="/takedowns" component={TakedownsPage} />
            <Route path="/users" component={UsersPage} />
            <Route path="/scan" component={ScanBenchPage} />
            <Route path="/security" component={SecurityPage} />
            <Route path="/status" component={StatusPage} />
            <Route component={NotFound} />
          </Switch>
        </AdminShell>
      </Route>
    </Switch>
  );
}

function MissingClerkKey() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
      <div className="max-w-md text-center space-y-2">
        <h1 className="text-lg font-semibold">Admin console isn't configured</h1>
        <p className="text-sm text-muted-foreground">
          The <code>VITE_CLERK_PUBLISHABLE_KEY</code> env variable is missing.
          Set it on the <code>admin-console</code> artifact and reload.
        </p>
      </div>
    </div>
  );
}

function App() {
  if (!CLERK_PUBLISHABLE_KEY) return <MissingClerkKey />;
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} afterSignOutUrl="/sign-in">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SignedIn>
            <ApiAuthBridge />
            <CsrfBridge />
          </SignedIn>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <SignedIn>
              <AuthGate>
                <Router />
              </AuthGate>
            </SignedIn>
            <SignedOut>
              <Switch>
                <Route path="/sign-in" component={SignInPage} />
                <Route>
                  <Redirect to="/sign-in" />
                </Route>
              </Switch>
            </SignedOut>
          </WouterRouter>
          <Toaster />
          <SonnerToaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default App;
