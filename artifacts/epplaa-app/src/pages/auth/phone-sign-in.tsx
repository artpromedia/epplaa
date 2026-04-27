import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useSignIn } from "@clerk/clerk-react";
import { startOtp, verifyOtp } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

type Step = "phone" | "code";

export default function PhoneSignInPage() {
  const { setActive } = useClerk();
  const { signIn, isLoaded: signInReady } = useSignIn();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("+234");
  const [channel, setChannel] = useState<"sms" | "whatsapp">("whatsapp");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onStart() {
    if (!phone.startsWith("+") || phone.length < 7) {
      toast({ title: "Enter a valid phone", description: "Use international format e.g. +2348012345678." });
      return;
    }
    setBusy(true);
    try {
      const r = await startOtp({ phone, channel });
      setDevCode(r.devCode ?? null);
      setStep("code");
      toast({
        title: "Code sent",
        description: r.devCode ? `Dev code: ${r.devCode}` : `Check your ${channel === "sms" ? "SMS" : "WhatsApp"}.`,
      });
    } catch (err) {
      toast({ title: "Could not send code", description: (err as Error).message ?? "Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function onVerify() {
    if (code.length < 4) {
      toast({ title: "Enter the code", description: "It is 6 digits." });
      return;
    }
    setBusy(true);
    try {
      const r = await verifyOtp({ phone, code });
      if (r.ok && r.ticket) {
        if (!signInReady || !signIn) {
          toast({ title: "Sign-in not ready", description: "Reload the page and try again." });
          return;
        }
        // Exchange the Clerk sign-in token (ticket) for a session, then
        // make that session active. `setActive` cannot accept the raw token.
        const attempt = await signIn.create({ strategy: "ticket", ticket: r.ticket });
        if (attempt.status === "complete" && attempt.createdSessionId) {
          await setActive({ session: attempt.createdSessionId });
          navigate("/");
        } else {
          toast({
            title: "Sign-in incomplete",
            description: `Status: ${attempt.status}. Please try again.`,
          });
        }
      } else if (r.ok) {
        toast({
          title: "Verified",
          description: "Phone confirmed. Continue with email sign-in to finish.",
        });
        navigate("/sign-in");
      } else {
        toast({ title: "Wrong or expired code", description: "Request a new one." });
      }
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (/wrong_code|401/.test(msg)) {
        toast({ title: "Wrong or expired code", description: "Request a new one." });
      } else if (/consumed|expired|400/.test(msg)) {
        toast({ title: "Code already used or expired", description: "Request a new code." });
      } else {
        toast({ title: "Verification failed", description: msg || "Try again." });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10 bg-[var(--color-background)]">
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-black tracking-tight text-[var(--color-primary)]">Epplaa</h1>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-1">Sign in with your phone</p>
      </div>

      <div className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-5 space-y-4">
        {step === "phone" && (
          <>
            <label className="block text-sm font-medium">Phone number</label>
            <input
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+2348012345678"
              className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 outline-none focus:border-[var(--color-primary)]"
              data-testid="input-phone"
            />
            <fieldset className="flex gap-2 pt-2">
              {(["whatsapp", "sms"] as const).map((c) => (
                <label
                  key={c}
                  className={`flex-1 cursor-pointer rounded-lg border px-3 py-2 text-center text-sm capitalize ${
                    channel === c
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                      : "border-[var(--color-border)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="channel"
                    value={c}
                    checked={channel === c}
                    onChange={() => setChannel(c)}
                    className="sr-only"
                    data-testid={`radio-channel-${c}`}
                  />
                  {c}
                </label>
              ))}
            </fieldset>
            <button
              onClick={onStart}
              disabled={busy}
              className="w-full rounded-full bg-[var(--color-primary)] py-2 font-bold text-white disabled:opacity-50"
              data-testid="button-send-code"
            >
              {busy ? "Sending…" : "Send code"}
            </button>
          </>
        )}

        {step === "code" && (
          <>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              We sent a 6-digit code to <span className="font-semibold">{phone}</span>.
            </p>
            {devCode && (
              <p className="text-xs rounded bg-[var(--color-primary)]/10 px-3 py-2 text-[var(--color-primary)]">
                Dev code: <code>{devCode}</code>
              </p>
            )}
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D+/g, "").slice(0, 6))}
              placeholder="123456"
              className="w-full rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-2 text-center text-lg tracking-[0.5em] outline-none focus:border-[var(--color-primary)]"
              data-testid="input-code"
            />
            <button
              onClick={onVerify}
              disabled={busy}
              className="w-full rounded-full bg-[var(--color-primary)] py-2 font-bold text-white disabled:opacity-50"
              data-testid="button-verify-code"
            >
              {busy ? "Verifying…" : "Verify and continue"}
            </button>
            <button
              onClick={() => setStep("phone")}
              className="w-full text-xs text-[var(--color-muted-foreground)] underline"
              data-testid="button-change-phone"
            >
              Use a different number
            </button>
          </>
        )}

        <div className="pt-2 text-center text-xs text-[var(--color-muted-foreground)]">
          Prefer email? <Link href="/sign-in" className="underline">Sign in with email</Link>.
        </div>
      </div>
    </div>
  );
}
