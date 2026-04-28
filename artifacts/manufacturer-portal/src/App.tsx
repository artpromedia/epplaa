import { ReactNode } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClerkProvider, SignedIn, SignedOut, SignIn, useAuth } from "@clerk/clerk-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import NotFound from "@/pages/not-found";
import { ApiAuthBridge } from "@/lib/auth-bridge";
import { CsrfBridge } from "@/lib/csrf-bridge";
import { PortalShell } from "@/components/portal-shell";
import epplaaLogo from "@assets/epplaa-logo-color-nobg.png";

import DashboardPage from "@/pages/dashboard";
import ApplyPage from "@/pages/apply";
import KycPage from "@/pages/kyc";
import ListingsPage from "@/pages/listings";
import OrdersPage from "@/pages/orders";
import OrderDetailPage from "@/pages/order-detail";
import PayoutsPage from "@/pages/payouts";

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
            className="h-10 w-auto mx-auto mb-3"
            data-testid="img-brand-logo"
          />
          <p className="text-sm font-semibold text-foreground">Manufacturers Portal</p>
          <p className="text-xs text-muted-foreground mt-1">
            Sign in to manage your factory's onboarding, catalog, and orders.
          </p>
        </div>
        <SignIn
          routing="hash"
          fallbackRedirectUrl={import.meta.env.BASE_URL}
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
        <PortalShell>
          <Switch>
            <Route path="/" component={DashboardPage} />
            <Route path="/apply" component={ApplyPage} />
            <Route path="/kyc" component={KycPage} />
            <Route path="/listings" component={ListingsPage} />
            <Route path="/orders" component={OrdersPage} />
            <Route path="/orders/:orderId" component={OrderDetailPage} />
            <Route path="/payouts" component={PayoutsPage} />
            <Route component={NotFound} />
          </Switch>
        </PortalShell>
      </Route>
    </Switch>
  );
}

function MissingClerkKey() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
      <div className="max-w-md text-center space-y-2">
        <h1 className="text-lg font-semibold">Manufacturer portal isn't configured</h1>
        <p className="text-sm text-muted-foreground">
          The <code>VITE_CLERK_PUBLISHABLE_KEY</code> env variable is missing. Set it on the
          <code> manufacturer-portal</code> artifact and reload.
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
