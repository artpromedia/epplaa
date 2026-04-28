import { useRef, useState } from "react";
import { ArrowLeft, ShieldCheck, Upload, CheckCircle2, AlertCircle, FileText, ChevronRight } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";
import {
  useGetKycStatus,
  useStartKycVerification,
  useSubmitKycVerification,
  useClaimKycDocument,
  useUploadKycDocument,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const TIER_REQUIREMENTS: Record<2 | 3, { kind: string; label: string }[]> = {
  2: [
    { kind: "gov_id", label: "Government-issued ID" },
    { kind: "bank_verification", label: "Bank verification (BVN / statement)" },
  ],
  3: [
    { kind: "gov_id", label: "Government-issued ID" },
    { kind: "bank_verification", label: "Bank verification (BVN / statement)" },
    { kind: "cac", label: "CAC business certificate" },
    { kind: "ubo", label: "Ultimate beneficial owner declaration" },
  ],
};

const ALLOWED_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_BYTES = 6 * 1024 * 1024;

function formatNgnMinor(minor: number): string {
  const major = Math.floor(minor / 100);
  return `₦${major.toLocaleString("en-NG")}`;
}

export default function SellerKyc() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingKind, setPendingKind] = useState<string | null>(null);

  const status = useGetKycStatus();
  const data = status.data;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["/api/kyc/me"] });

  const claimMut = useClaimKycDocument({ mutation: { onSuccess: invalidate } });
  const uploadMut = useUploadKycDocument({ mutation: { onSuccess: invalidate } });
  const startMut = useStartKycVerification({ mutation: { onSuccess: invalidate } });
  const submitMut = useSubmitKycVerification({ mutation: { onSuccess: invalidate } });

  const cardBorder = isDark ? "border-white/10 bg-white/5" : "border-stone-300 bg-white";
  const subtle = isDark ? "text-white/60" : "text-stone-500";

  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
      reader.onload = () => {
        const result = String(reader.result ?? "");
        const idx = result.indexOf(",");
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.readAsDataURL(file);
    });
  }

  async function pickAndUpload(kind: string, file: File) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast({ title: "Unsupported file", description: "Use JPG, PNG or PDF" });
      return;
    }
    if (file.size > MAX_BYTES) {
      toast({ title: "File too large", description: "Max 6 MB" });
      return;
    }
    try {
      const claim = await claimMut.mutateAsync({
        data: {
          kind,
          contentType: file.type,
          filename: file.name,
          sizeBytes: file.size,
        },
      });
      const blobBase64 = await readFileAsBase64(file);
      await uploadMut.mutateAsync({
        id: claim.id,
        data: { blobBase64 },
      });
      toast({ title: "Document uploaded — pending review" });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Try again",
      });
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const kind = pendingKind;
    setPendingKind(null);
    e.target.value = "";
    if (file && kind) {
      void pickAndUpload(kind, file);
    }
  }

  function trigger(kind: string) {
    setPendingKind(kind);
    fileInputRef.current?.click();
  }

  async function startTier(target: 2 | 3) {
    try {
      await startMut.mutateAsync({ data: { kind: "gov_id", tier: target } });
      toast({ title: `Tier ${target} verification opened` });
    } catch (err) {
      toast({
        title: "Couldn't start verification",
        description: err instanceof Error ? err.message : "Try again",
      });
    }
  }

  async function submitForReview(verificationId: string) {
    try {
      await submitMut.mutateAsync({ id: verificationId });
      toast({ title: "Submitted for compliance review" });
    } catch (err) {
      toast({
        title: "Couldn't submit",
        description: err instanceof Error ? err.message : "Try again",
      });
    }
  }

  if (status.isLoading || !data) {
    return (
      <div className={isDark ? "bg-[#1a0e08] text-white min-h-screen" : "bg-stone-50 text-stone-900 min-h-screen"}>
        <PageHeader title="KYC" backHref="/seller/earnings" />
        <div className="p-4 text-center text-sm">Loading…</div>
      </div>
    );
  }

  const currentTier = data.kycTier;
  const requiredTier = data.requiredKycTier;
  const targetTier = (Math.max(requiredTier, currentTier === 3 ? 3 : currentTier + 1) as 1 | 2 | 3);
  const reqs = targetTier >= 2 ? TIER_REQUIREMENTS[(targetTier as 2 | 3)] : [];
  const docKindsApproved = new Set(
    data.documents.filter((d) => d.status === "approved" || d.status === "uploaded").map((d) => d.kind),
  );
  const missing = reqs.filter((r) => !docKindsApproved.has(r.kind));
  const openVerification = data.verifications.find(
    (v) => v.status !== "approved" && v.status !== "rejected",
  );

  return (
    <div className={isDark ? "bg-[#1a0e08] text-white min-h-screen" : "bg-stone-50 text-stone-900 min-h-screen"}>
      <PageHeader title="KYC verification" backHref="/seller/earnings" />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,application/pdf"
        onChange={onFileChange}
        className="hidden"
        data-testid="input-kyc-file"
      />
      <div className="max-w-md mx-auto px-4 py-4 space-y-4 pb-24">
        <div className={`rounded-xl border p-4 ${cardBorder}`}>
          <div className="flex items-center gap-3 mb-3">
            <ShieldCheck className="w-6 h-6 text-orange-500" />
            <div>
              <p className="text-xs uppercase tracking-wider font-bold opacity-60">Current tier</p>
              <p className="text-2xl font-bold">Tier {currentTier}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className={subtle}>Rolling 30-day GMV</p>
              <p className="font-bold">{formatNgnMinor(data.rolling30dGmvMinor)}</p>
            </div>
            <div>
              <p className={subtle}>Required tier</p>
              <p className="font-bold">Tier {requiredTier}</p>
            </div>
          </div>
          {requiredTier > currentTier && (
            <div className={`mt-3 text-xs rounded-md px-3 py-2 ${isDark ? "bg-amber-500/10 text-amber-300 border border-amber-500/30" : "bg-amber-50 text-amber-800 border border-amber-200"}`}>
              <AlertCircle className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
              Your sales have crossed the Tier {requiredTier} threshold. Payouts are paused until you complete verification.
            </div>
          )}
        </div>

        <div className={`rounded-xl border p-4 ${cardBorder}`}>
          <p className="text-xs font-bold uppercase tracking-wider mb-3">Tier thresholds</p>
          <ul className="space-y-2 text-xs">
            <li className="flex items-center justify-between">
              <span>Tier 1 — basic account</span>
              <span className={subtle}>up to {formatNgnMinor(data.thresholds.tier2Minor - 1)}</span>
            </li>
            <li className="flex items-center justify-between">
              <span>Tier 2 — verified seller</span>
              <span className={subtle}>{formatNgnMinor(data.thresholds.tier2Minor)} – {formatNgnMinor(data.thresholds.tier3Minor - 1)}</span>
            </li>
            <li className="flex items-center justify-between">
              <span>Tier 3 — registered business</span>
              <span className={subtle}>{formatNgnMinor(data.thresholds.tier3Minor)}+</span>
            </li>
          </ul>
        </div>

        {targetTier > currentTier && (
          <div className={`rounded-xl border p-4 ${cardBorder}`}>
            <p className="text-xs font-bold uppercase tracking-wider mb-3">
              Documents required for Tier {targetTier}
            </p>
            <div className="space-y-2">
              {reqs.map((r) => {
                const have = docKindsApproved.has(r.kind);
                return (
                  <div
                    key={r.kind}
                    className={`flex items-center gap-3 p-2 rounded-md ${isDark ? "bg-white/5" : "bg-stone-100"}`}
                    data-testid={`kyc-doc-${r.kind}`}
                  >
                    {have ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    ) : (
                      <FileText className={`w-4 h-4 shrink-0 ${subtle}`} />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold">{r.label}</p>
                      <p className={`text-[11px] ${subtle}`}>JPG, PNG or PDF · max 6 MB</p>
                    </div>
                    <button
                      onClick={() => trigger(r.kind)}
                      disabled={claimMut.isPending || uploadMut.isPending}
                      className={`text-xs font-bold py-1.5 px-3 rounded-md disabled:opacity-50 ${
                        have
                          ? isDark
                            ? "bg-white/10"
                            : "bg-stone-200"
                          : "bg-orange-500 text-white hover:bg-orange-600"
                      }`}
                      data-testid={`button-upload-${r.kind}`}
                    >
                      <Upload className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
                      {have ? "Replace" : "Upload"}
                    </button>
                  </div>
                );
              })}
            </div>
            {!openVerification ? (
              <button
                onClick={() => startTier(targetTier as 2 | 3)}
                disabled={startMut.isPending}
                className="mt-3 w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-sm font-bold py-2 rounded-md"
                data-testid="button-start-verification"
              >
                Open Tier {targetTier} verification
              </button>
            ) : missing.length === 0 && openVerification.status === "open" ? (
              <button
                onClick={() => submitForReview(openVerification.id)}
                disabled={submitMut.isPending}
                className="mt-3 w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-sm font-bold py-2 rounded-md"
                data-testid="button-submit-verification"
              >
                Submit for review
              </button>
            ) : (
              <p className={`mt-3 text-xs text-center ${subtle}`}>
                {openVerification.status === "pending_review"
                  ? "Pending compliance review — typically 1–3 business days."
                  : `${missing.length} document${missing.length === 1 ? "" : "s"} still required.`}
              </p>
            )}
          </div>
        )}

        {data.documents.length > 0 && (
          <div className={`rounded-xl border ${cardBorder}`}>
            <p className="text-xs font-bold uppercase tracking-wider px-4 pt-4 pb-2">
              Document history
            </p>
            <div className={`divide-y ${isDark ? "divide-white/10" : "divide-stone-200"}`}>
              {data.documents.map((d) => (
                <div key={d.id} className="px-4 py-3 flex items-center gap-3" data-testid={`kyc-doc-row-${d.id}`}>
                  <FileText className={`w-4 h-4 ${subtle}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate">{d.filename}</p>
                    <p className={`text-[11px] ${subtle}`}>
                      {d.kind} · {new Date(d.createdAtIso).toLocaleDateString()}
                    </p>
                  </div>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                      d.status === "approved"
                        ? isDark
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-emerald-100 text-emerald-800"
                        : d.status === "rejected"
                          ? isDark
                            ? "bg-red-500/15 text-red-300"
                            : "bg-red-100 text-red-800"
                          : isDark
                            ? "bg-amber-500/15 text-amber-300"
                            : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {d.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <a
          href="/account/privacy"
          className={`flex items-center justify-between rounded-xl border p-4 ${cardBorder}`}
          data-testid="link-privacy"
        >
          <div>
            <p className="text-sm font-bold">Manage your data</p>
            <p className={`text-xs ${subtle}`}>Export, rectify or erase under NDPR.</p>
          </div>
          <ChevronRight className={`w-5 h-5 ${subtle}`} />
        </a>
      </div>
    </div>
  );
}
