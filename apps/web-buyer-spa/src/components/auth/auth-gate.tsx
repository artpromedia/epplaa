import { ReactNode } from "react";
import { useAuth } from "@clerk/clerk-react";
import { useLocation, Redirect } from "wouter";

const PUBLIC_PREFIXES = ["/sign-in", "/sign-up", "/phone-sign-in"];

export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [location] = useLocation();
  const isPublic = PUBLIC_PREFIXES.some((p) => location.startsWith(p));

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-[var(--color-muted-foreground)]">
        Loading...
      </div>
    );
  }
  if (!isSignedIn && !isPublic) return <Redirect to="/sign-in" />;
  if (isSignedIn && isPublic) return <Redirect to="/" />;
  return <>{children}</>;
}
