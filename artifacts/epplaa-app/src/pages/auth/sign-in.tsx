import { SignIn } from "@clerk/clerk-react";
import { Link, useLocation } from "wouter";
import epplaaLogo from "@assets/epplaa-logo-color-nobg.png";

export default function SignInPage() {
  const [location] = useLocation();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10 bg-[var(--color-background)]">
      <div className="mb-6 text-center">
        <img
          src={epplaaLogo}
          alt="Epplaa"
          className="h-[5.625rem] w-auto mx-auto"
          data-testid="img-brand-logo"
        />
        <p className="text-sm text-[var(--color-muted-foreground)] mt-3">Sign in to start shopping live</p>
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
