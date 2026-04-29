import { SignUp } from "@clerk/clerk-react";
import epplaaLogo from "@assets/epplaa-logo-color-nobg.png";

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10 bg-[var(--color-background)]">
      <div className="mb-6 text-center">
        <img
          src={epplaaLogo}
          alt="Epplaa"
          className="h-[5.625rem] w-auto mx-auto"
          data-testid="img-brand-logo"
        />
        <p className="text-sm text-[var(--color-muted-foreground)] mt-3">Create your account</p>
      </div>
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        fallbackRedirectUrl="/"
      />
    </div>
  );
}
