import { SignIn } from "@clerk/clerk-react";
import { Link, useLocation } from "wouter";

export default function SignInPage() {
  const [location] = useLocation();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10 bg-[var(--color-background)]">
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-black tracking-tight text-[var(--color-primary)]">Epplaa</h1>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-1">Sign in to start shopping live</p>
      </div>
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        forceRedirectUrl={location.startsWith("/sign-in") ? "/" : location}
        fallbackRedirectUrl="/"
      />
      <Link
        href="/phone-sign-in"
        className="mt-4 text-sm font-medium text-[var(--color-primary)] underline"
        data-testid="link-phone-sign-in"
      >
        Sign in with phone instead
      </Link>
    </div>
  );
}
