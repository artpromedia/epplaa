import { SignUp } from "@clerk/clerk-react";

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10 bg-[var(--color-background)]">
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-black tracking-tight text-[var(--color-primary)]">Epplaa</h1>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-1">Create your account</p>
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
