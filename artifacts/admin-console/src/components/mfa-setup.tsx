import { useState } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  KeyRound,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useUser } from "@clerk/clerk-react";
import {
  type MfaSetupResult,
  type MfaStatus,
  useGetMfaStatus,
  useSetupMfaTotp,
  useVerifyMfaTotp,
  useDisableMfaTotp,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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

export function MfaSetup() {
  const { user } = useUser();
  const qc = useQueryClient();
  const { toast } = useToast();
  const statusQuery = useGetMfaStatus();
  const status = statusQuery.data;

  const [setupResult, setSetupResult] = useState<MfaSetupResult | null>(null);
  const [activateCode, setActivateCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [copiedSecret, setCopiedSecret] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: MFA_STATUS_KEY });

  const setupMut = useSetupMfaTotp({
    mutation: {
      onSuccess: (data) => {
        setSetupResult(data);
        setActivateCode("");
      },
      onError: () => {
        toast({
          title: "Could not start MFA setup",
          description: "Try again in a moment.",
        });
      },
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
      onError: () => {
        toast({
          title: "Code rejected",
          description: "Double-check the 6-digit code on your authenticator.",
        });
      },
    },
  });

  const disableMut = useDisableMfaTotp({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDisableCode("");
        toast({
          title: "MFA disabled",
          description: "TOTP has been removed from this account.",
        });
      },
      onError: () => {
        toast({
          title: "Could not disable MFA",
          description: "Verify a fresh code first, then try again.",
        });
      },
    },
  });

  const reAssertMut = useVerifyMfaTotp({
    mutation: {
      onSuccess: () => {
        disableMut.mutate();
      },
      onError: () => {
        toast({
          title: "Code rejected",
          description: "That code didn't match — try a fresh one.",
        });
      },
    },
  });

  if (statusQuery.isLoading) {
    return (
      <Card>
        <CardContent className="py-10 flex items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading status…
        </CardContent>
      </Card>
    );
  }

  if (statusQuery.error || !status) {
    return (
      <Alert variant="destructive">
        <XCircle className="h-4 w-4" />
        <AlertTitle>Couldn't load MFA status</AlertTitle>
        <AlertDescription>
          Refresh the page. If this keeps happening, sign out and back in.
        </AlertDescription>
      </Alert>
    );
  }

  const accountLabel =
    user?.primaryEmailAddress?.emailAddress ?? user?.id ?? "Operator";

  return (
    <div className="space-y-6">
      <StatusSummary status={status} />

      {!status.enrolled && !setupResult && (
        <Card data-testid="mfa-enrol-card">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="w-4 h-4" /> Set up authenticator app
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Use any TOTP app (1Password, Authy, Google Authenticator, etc.).
              You'll scan a QR code, enter a 6-digit code, then save 10 backup
              codes.
            </p>
            <Button
              onClick={() => setupMut.mutate({ data: { accountLabel } })}
              disabled={setupMut.isPending}
              data-testid="button-mfa-start"
            >
              {setupMut.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Start setup
            </Button>
          </CardContent>
        </Card>
      )}

      {setupResult && (
        <Card data-testid="mfa-enrol-active-card">
          <CardHeader>
            <CardTitle className="text-base">
              1. Scan with your authenticator
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-4 items-start">
              <img
                src={setupResult.qrCodeDataUrl}
                alt="MFA QR code"
                width={192}
                height={192}
                className="rounded border border-border bg-white p-2"
                data-testid="img-mfa-qr"
              />
              <div className="flex-1 min-w-0 space-y-2">
                <p className="text-sm text-muted-foreground">
                  Can't scan? Enter this secret manually:
                </p>
                <div className="flex items-center gap-2">
                  <code
                    className="flex-1 min-w-0 truncate rounded bg-muted px-2 py-1 text-xs font-mono"
                    data-testid="text-mfa-secret"
                  >
                    {setupResult.secret}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(setupResult.secret);
                        setCopiedSecret(true);
                        setTimeout(() => setCopiedSecret(false), 1500);
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    {copiedSecret ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>

            <div className="border-t border-border pt-4 space-y-2">
              <h3 className="text-sm font-medium">2. Enter the 6-digit code</h3>
              <form
                className="flex flex-col sm:flex-row gap-2 sm:items-center"
                onSubmit={(e) => {
                  e.preventDefault();
                  const code = activateCode.replace(/\D/g, "").slice(0, 6);
                  if (code.length !== 6) return;
                  verifyMut.mutate({
                    data: { code, mode: "activate" },
                  });
                }}
              >
                <Input
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
                  className="font-mono text-lg tracking-widest sm:max-w-[180px]"
                  data-testid="input-mfa-activate-code"
                />
                <Button
                  type="submit"
                  disabled={
                    verifyMut.isPending || activateCode.length !== 6
                  }
                  data-testid="button-mfa-activate"
                >
                  {verifyMut.isPending && (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  )}
                  Verify and enable
                </Button>
              </form>
            </div>

            <BackupCodeSheet codes={setupResult.backupCodes} />

            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSetupResult(null);
                setActivateCode("");
              }}
            >
              Cancel setup
            </Button>
          </CardContent>
        </Card>
      )}

      {status.enrolled && !setupResult && (
        <Card data-testid="mfa-active-card">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-500" />
              Authenticator app
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Row label="Status">
                <Badge variant="secondary">Active</Badge>
              </Row>
              <Row label="Backup codes left">
                <span data-testid="text-backup-remaining">
                  {status.backupCodesRemaining}
                </span>
              </Row>
              <Row label="Enrolled">{formatDate(status.enrolledAt)}</Row>
              <Row label="Last used">{formatDate(status.lastUsedAt)}</Row>
            </dl>

            <div className="border-t border-border pt-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                Removing your authenticator weakens your account. Re-verify a
                fresh 6-digit code below to disable.
              </p>
              <form
                className="flex flex-col sm:flex-row gap-2 sm:items-center"
                onSubmit={(e) => {
                  e.preventDefault();
                  const code = disableCode.replace(/\D/g, "").slice(0, 6);
                  if (code.length !== 6) return;
                  reAssertMut.mutate({
                    data: { code, mode: "assert" },
                  });
                }}
              >
                <Input
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
                  className="font-mono tracking-widest sm:max-w-[180px]"
                  data-testid="input-mfa-disable-code"
                />
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={
                    reAssertMut.isPending ||
                    disableMut.isPending ||
                    disableCode.length !== 6
                  }
                  data-testid="button-mfa-disable"
                >
                  {(reAssertMut.isPending || disableMut.isPending) && (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  )}
                  Disable MFA
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-2 border-b border-border/40 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function StatusSummary({ status }: { status: MfaStatus }) {
  if (status.enrolled) {
    return (
      <Alert data-testid="mfa-status-alert-active">
        <ShieldCheck className="h-4 w-4 text-emerald-500" />
        <AlertTitle>MFA is active</AlertTitle>
        <AlertDescription>
          You are protected by an authenticator app.
        </AlertDescription>
      </Alert>
    );
  }
  if (status.required) {
    return (
      <Alert variant="destructive" data-testid="mfa-status-alert-required">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>MFA is required for this account</AlertTitle>
        <AlertDescription>
          {status.requiredReason === "admin_role"
            ? "Operators must have an authenticator app to take action in this console."
            : "Your seller volume crossed the high-velocity threshold — payouts and money-moving actions need MFA."}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert data-testid="mfa-status-alert-optional">
      <ShieldAlert className="h-4 w-4" />
      <AlertTitle>MFA is optional</AlertTitle>
      <AlertDescription>
        Set it up now to be ready when your account crosses the high-velocity
        threshold.
      </AlertDescription>
    </Alert>
  );
}

function BackupCodeSheet({ codes }: { codes: string[] }) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
      <h3 className="text-sm font-medium flex items-center gap-2">
        <Download className="w-4 h-4" /> 3. Save your backup codes (shown once)
      </h3>
      <p className="text-xs text-muted-foreground">
        Each code works exactly once if you lose your authenticator. Store them
        somewhere safe — we cannot show them again.
      </p>
      <ul
        className="grid grid-cols-2 sm:grid-cols-5 gap-1 font-mono text-xs"
        data-testid="list-backup-codes"
      >
        {codes.map((c) => (
          <li
            key={c}
            className="rounded bg-background border border-border px-2 py-1 text-center"
          >
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 items-center">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => downloadBackupCodes(codes)}
          data-testid="button-download-backup"
        >
          <Download className="w-4 h-4 mr-1" /> Download .txt
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(codes.join("\n"));
              setAcknowledged(true);
            } catch {
              // ignore
            }
          }}
        >
          <Copy className="w-4 h-4 mr-1" />
          {acknowledged ? "Copied" : "Copy all"}
        </Button>
      </div>
    </div>
  );
}
