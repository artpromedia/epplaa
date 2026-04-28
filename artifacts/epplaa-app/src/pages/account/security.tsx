import { useState } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  KeyRound,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useUser } from "@clerk/clerk-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type MfaSetupResult,
  type MfaStatus,
  useGetMfaStatus,
  useSetupMfaTotp,
  useVerifyMfaTotp,
  useDisableMfaTotp,
} from "@workspace/api-client-react";
import { useTheme } from "@/lib/theme-context";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";

const MFA_STATUS_KEY = ["/api/mfa/status"];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function downloadBackupCodes(codes: string[]) {
  const text = [
    "Epplaa — MFA backup codes",
    "Generated: " + new Date().toISOString(),
    "",
    "Each code can be used ONCE if you lose access to your authenticator.",
    "Store this file somewhere safe and offline.",
    "",
    ...codes.map((c, i) => `${String(i + 1).padStart(2, "0")}. ${c}`),
    "",
  ].join("\n");
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `epplaa-mfa-backup-codes-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function Security() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { user } = useUser();
  const qc = useQueryClient();
  const { toast } = useToast();

  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-300";
  const subtle = isDark ? "text-white/60" : "text-stone-500";

  const statusQuery = useGetMfaStatus();
  const status = statusQuery.data;

  const [setupResult, setSetupResult] = useState<MfaSetupResult | null>(null);
  const [activateCode, setActivateCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [copiedCodes, setCopiedCodes] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: MFA_STATUS_KEY });

  const setupMut = useSetupMfaTotp({
    mutation: {
      onSuccess: (data) => {
        setSetupResult(data);
        setActivateCode("");
      },
      onError: () =>
        toast({
          title: "Couldn't start setup",
          description: "Try again in a moment.",
        }),
    },
  });

  const verifyMut = useVerifyMfaTotp({
    mutation: {
      onSuccess: () => {
        invalidate();
        setSetupResult(null);
        setActivateCode("");
        toast({
          title: "MFA enabled",
          description: "Your authenticator is now active.",
        });
      },
      onError: () =>
        toast({
          title: "Code rejected",
          description: "Double-check the 6 digits and try again.",
        }),
    },
  });

  const disableMut = useDisableMfaTotp({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDisableCode("");
        toast({
          title: "MFA disabled",
          description: "TOTP has been removed.",
        });
      },
      onError: () =>
        toast({
          title: "Couldn't disable MFA",
          description: "Verify a fresh code first.",
        }),
    },
  });

  const reAssertMut = useVerifyMfaTotp({
    mutation: {
      onSuccess: () => disableMut.mutate(),
      onError: () =>
        toast({
          title: "Code rejected",
          description: "That code didn't match — try a fresh one.",
        }),
    },
  });

  const accountLabel =
    user?.primaryEmailAddress?.emailAddress ?? user?.id ?? "Account";

  return (
    <div className="flex flex-col h-full w-full" data-testid="page-security">
      <PageHeader title="Security & MFA" backHref="/account/settings" />
      <div className="px-4 pb-24 space-y-5">
        {statusQuery.isLoading || !status ? (
          <div
            className={`rounded-xl border p-4 flex items-center gap-2 text-sm ${cardClass}`}
          >
            <Loader2 className="w-4 h-4 animate-spin" /> Loading status…
          </div>
        ) : (
          <StatusBanner status={status} isDark={isDark} />
        )}

        {status && !status.enrolled && !setupResult && (
          <section
            className={`rounded-xl border p-4 space-y-3 ${cardClass}`}
            data-testid="mfa-enrol-card"
          >
            <div className="flex items-center gap-2">
              <KeyRound className="w-5 h-5" />
              <h2 className="font-bold">Set up authenticator app</h2>
            </div>
            <p className={`text-sm ${subtle}`}>
              We'll show a QR code you can scan with 1Password, Authy, Google
              Authenticator, or any other TOTP app. You'll then enter a 6-digit
              code and save 10 one-time backup codes.
            </p>
            <button
              onClick={() => setupMut.mutate({ data: { accountLabel } })}
              disabled={setupMut.isPending}
              className={`w-full py-3 rounded-full font-bold flex items-center justify-center gap-2 ${
                isDark
                  ? "bg-[#FF8855] text-white"
                  : "bg-[#E6502E] text-white"
              } disabled:opacity-50`}
              data-testid="button-mfa-start"
            >
              {setupMut.isPending && (
                <Loader2 className="w-4 h-4 animate-spin" />
              )}
              Start setup
            </button>
          </section>
        )}

        {setupResult && (
          <section
            className={`rounded-xl border p-4 space-y-4 ${cardClass}`}
            data-testid="mfa-enrol-active-card"
          >
            <div>
              <p className="text-xs uppercase tracking-wider font-bold">
                Step 1
              </p>
              <h2 className="font-bold mb-2">Scan with your authenticator</h2>
              <div className="flex flex-col sm:flex-row gap-4 items-start">
                <img
                  src={setupResult.qrCodeDataUrl}
                  alt="MFA QR code"
                  width={192}
                  height={192}
                  className="rounded bg-white p-2 border border-stone-300"
                  data-testid="img-mfa-qr"
                />
                <div className="flex-1 min-w-0 space-y-2">
                  <p className={`text-sm ${subtle}`}>
                    Can't scan? Use this secret:
                  </p>
                  <div className="flex items-center gap-2">
                    <code
                      className={`flex-1 min-w-0 truncate rounded px-2 py-1 text-xs font-mono ${
                        isDark
                          ? "bg-white/10 text-white"
                          : "bg-stone-100 text-stone-900"
                      }`}
                      data-testid="text-mfa-secret"
                    >
                      {setupResult.secret}
                    </code>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            setupResult.secret,
                          );
                          setCopiedSecret(true);
                          setTimeout(() => setCopiedSecret(false), 1500);
                        } catch {
                          // ignore
                        }
                      }}
                      className={`shrink-0 p-2 rounded ${
                        isDark
                          ? "bg-white/10 hover:bg-white/15"
                          : "bg-stone-200 hover:bg-stone-300"
                      }`}
                      aria-label="Copy secret"
                    >
                      {copiedSecret ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div
              className={`pt-4 border-t ${isDark ? "border-white/10" : "border-stone-200"}`}
            >
              <p className="text-xs uppercase tracking-wider font-bold">
                Step 2
              </p>
              <h2 className="font-bold mb-2">Enter the 6-digit code</h2>
              <form
                className="flex gap-2 items-center"
                onSubmit={(e) => {
                  e.preventDefault();
                  const code = activateCode.replace(/\D/g, "").slice(0, 6);
                  if (code.length !== 6) return;
                  verifyMut.mutate({
                    data: { code, mode: "activate" },
                  });
                }}
              >
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="123 456"
                  value={activateCode}
                  onChange={(e) =>
                    setActivateCode(
                      e.target.value.replace(/\D/g, "").slice(0, 6),
                    )
                  }
                  className={`flex-1 max-w-[180px] font-mono text-lg tracking-widest rounded-lg px-3 py-2 ${
                    isDark
                      ? "bg-white/10 border border-white/10 text-white"
                      : "bg-white border border-stone-300 text-stone-900"
                  }`}
                  data-testid="input-mfa-activate-code"
                />
                <button
                  type="submit"
                  disabled={
                    verifyMut.isPending || activateCode.length !== 6
                  }
                  className={`px-4 py-2 rounded-full font-bold flex items-center gap-2 ${
                    isDark
                      ? "bg-[#FF8855] text-white"
                      : "bg-[#E6502E] text-white"
                  } disabled:opacity-50`}
                  data-testid="button-mfa-activate"
                >
                  {verifyMut.isPending && (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  )}
                  Verify
                </button>
              </form>
            </div>

            <BackupCodeSheet
              isDark={isDark}
              codes={setupResult.backupCodes}
              copied={copiedCodes}
              onCopy={async () => {
                try {
                  await navigator.clipboard.writeText(
                    setupResult.backupCodes.join("\n"),
                  );
                  setCopiedCodes(true);
                  setTimeout(() => setCopiedCodes(false), 1500);
                } catch {
                  // ignore
                }
              }}
            />

            <button
              type="button"
              onClick={() => {
                setSetupResult(null);
                setActivateCode("");
              }}
              className={`text-sm ${subtle} underline`}
              data-testid="button-mfa-cancel-setup"
            >
              Cancel setup
            </button>
          </section>
        )}

        {status && status.enrolled && !setupResult && (
          <section
            className={`rounded-xl border p-4 space-y-3 ${cardClass}`}
            data-testid="mfa-active-card"
          >
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-500" />
              <h2 className="font-bold">Authenticator app is active</h2>
            </div>
            <dl className="text-sm space-y-1.5">
              <Row label="Backup codes left" subtle={subtle}>
                <span data-testid="text-backup-remaining">
                  {status.backupCodesRemaining}
                </span>
              </Row>
              <Row label="Enrolled" subtle={subtle}>
                {formatDate(status.enrolledAt)}
              </Row>
              <Row label="Last used" subtle={subtle}>
                {formatDate(status.lastUsedAt)}
              </Row>
            </dl>

            <div
              className={`pt-3 border-t space-y-2 ${
                isDark ? "border-white/10" : "border-stone-200"
              }`}
            >
              <p className={`text-xs ${subtle}`}>
                Removing your authenticator weakens your account. Enter a fresh
                6-digit code to confirm.
              </p>
              <form
                className="flex gap-2 items-center"
                onSubmit={(e) => {
                  e.preventDefault();
                  const code = disableCode.replace(/\D/g, "").slice(0, 6);
                  if (code.length !== 6) return;
                  reAssertMut.mutate({
                    data: { code, mode: "assert" },
                  });
                }}
              >
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="6-digit code"
                  value={disableCode}
                  onChange={(e) =>
                    setDisableCode(
                      e.target.value.replace(/\D/g, "").slice(0, 6),
                    )
                  }
                  className={`flex-1 max-w-[180px] font-mono tracking-widest rounded-lg px-3 py-2 ${
                    isDark
                      ? "bg-white/10 border border-white/10 text-white"
                      : "bg-white border border-stone-300 text-stone-900"
                  }`}
                  data-testid="input-mfa-disable-code"
                />
                <button
                  type="submit"
                  disabled={
                    reAssertMut.isPending ||
                    disableMut.isPending ||
                    disableCode.length !== 6
                  }
                  className="px-4 py-2 rounded-full font-bold bg-red-600 text-white flex items-center gap-2 disabled:opacity-50"
                  data-testid="button-mfa-disable"
                >
                  {(reAssertMut.isPending || disableMut.isPending) && (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  )}
                  Disable MFA
                </button>
              </form>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  subtle,
  children,
}: {
  label: string;
  subtle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt className={subtle}>{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function StatusBanner({
  status,
  isDark,
}: {
  status: MfaStatus;
  isDark: boolean;
}) {
  if (status.enrolled) {
    return (
      <div
        className={`rounded-xl border p-4 flex items-start gap-3 ${
          isDark
            ? "border-emerald-500/30 bg-emerald-500/10"
            : "border-emerald-500/30 bg-emerald-500/10"
        }`}
        data-testid="mfa-status-banner-active"
      >
        <ShieldCheck className="w-5 h-5 text-emerald-500 mt-0.5" />
        <div>
          <p className="font-bold">MFA is active</p>
          <p className={`text-sm ${isDark ? "text-white/70" : "text-stone-600"}`}>
            Your account is protected by an authenticator app.
          </p>
        </div>
      </div>
    );
  }
  if (status.required) {
    return (
      <div
        className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 flex items-start gap-3"
        data-testid="mfa-status-banner-required"
      >
        <ShieldAlert className="w-5 h-5 text-red-500 mt-0.5" />
        <div>
          <p className="font-bold">MFA is required</p>
          <p className={`text-sm ${isDark ? "text-white/70" : "text-stone-600"}`}>
            {status.requiredReason === "admin_role"
              ? "Operator accounts require an authenticator app."
              : "Your sales volume crossed the high-velocity threshold — payouts now need MFA."}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div
      className={`rounded-xl border p-4 flex items-start gap-3 ${
        isDark ? "border-white/10 bg-white/5" : "border-stone-300 bg-white"
      }`}
      data-testid="mfa-status-banner-optional"
    >
      <ShieldAlert
        className={`w-5 h-5 mt-0.5 ${isDark ? "text-white/70" : "text-stone-600"}`}
      />
      <div>
        <p className="font-bold">MFA is optional</p>
        <p className={`text-sm ${isDark ? "text-white/70" : "text-stone-600"}`}>
          We'll require it if you cross the high-velocity threshold (
          {(status.velocityThresholdNgnMinor / 100).toLocaleString()} NGN /
          30d). Set it up now to avoid being locked out.
        </p>
      </div>
    </div>
  );
}

function BackupCodeSheet({
  isDark,
  codes,
  copied,
  onCopy,
}: {
  isDark: boolean;
  codes: string[];
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div
      className={`pt-4 border-t ${isDark ? "border-white/10" : "border-stone-200"}`}
    >
      <p className="text-xs uppercase tracking-wider font-bold">Step 3</p>
      <h2 className="font-bold mb-2">Save your backup codes (shown once)</h2>
      <div
        className={`rounded-lg border p-3 ${
          isDark
            ? "border-amber-500/30 bg-amber-500/10"
            : "border-amber-500/40 bg-amber-50"
        }`}
      >
        <ul
          className="grid grid-cols-2 sm:grid-cols-5 gap-1 font-mono text-xs"
          data-testid="list-backup-codes"
        >
          {codes.map((c) => (
            <li
              key={c}
              className={`rounded px-2 py-1 text-center ${
                isDark ? "bg-white/5" : "bg-white"
              }`}
            >
              {c}
            </li>
          ))}
        </ul>
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={() => downloadBackupCodes(codes)}
            className={`text-sm font-medium px-3 py-1.5 rounded flex items-center gap-1 ${
              isDark
                ? "bg-white/10 hover:bg-white/15"
                : "bg-stone-200 hover:bg-stone-300"
            }`}
            data-testid="button-download-backup"
          >
            <Download className="w-4 h-4" /> Download
          </button>
          <button
            type="button"
            onClick={onCopy}
            className={`text-sm font-medium px-3 py-1.5 rounded flex items-center gap-1 ${
              isDark
                ? "bg-white/10 hover:bg-white/15"
                : "bg-stone-200 hover:bg-stone-300"
            }`}
          >
            {copied ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
            {copied ? "Copied" : "Copy all"}
          </button>
        </div>
      </div>
    </div>
  );
}
