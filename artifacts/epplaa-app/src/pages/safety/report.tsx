import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Flag, ShieldCheck, AlertTriangle } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import {
  REPORT_REASONS,
  ReportReason,
  ReportTargetKind,
  useSafety,
} from "@/lib/safety-context";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";

export default function ReportPage() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { submitReport } = useSafety();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const search = useSearch();

  const params = useMemo(() => new URLSearchParams(search), [search]);
  const targetKind = (params.get("kind") ?? "product") as ReportTargetKind;
  const targetId = params.get("id") ?? "unknown";
  const targetLabel = params.get("label") ?? "this item";
  const sellerName = params.get("seller") ?? undefined;
  const backHref = params.get("back") ?? "/safety";

  const [reason, setReason] = useState<ReportReason | null>(null);
  const [notes, setNotes] = useState("");
  const [blockOnSubmit, setBlockOnSubmit] = useState(false);

  const subtle = isDark ? "text-white/60" : "text-stone-600";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) return;
    submitReport({
      targetKind,
      targetId,
      targetLabel,
      reason,
      notes,
      blockSeller: blockOnSubmit,
      sellerName,
    });
    toast({
      title: "Report submitted",
      description: "Our trust team will review within 24 hours.",
    });
    setLocation("/safety");
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Report" backHref={backHref} />

      <form
        onSubmit={handleSubmit}
        className="px-4 pb-32 space-y-5"
        data-testid="form-report"
      >
        <div
          className={`rounded-2xl border p-4 ${
            isDark
              ? "bg-[#FF8855]/10 border-[#FF8855]/30"
              : "bg-[#E6502E]/10 border-[#E6502E]/30"
          }`}
        >
          <div className="flex items-center gap-3">
            <Flag
              className={`w-5 h-5 ${
                isDark ? "text-[#FF8855]" : "text-[#E6502E]"
              }`}
            />
            <div>
              <p className="font-bold">Reporting</p>
              <p className={`text-xs ${subtle}`} data-testid="report-target-label">
                {targetKind} · {targetLabel}
              </p>
            </div>
          </div>
        </div>

        <div>
          <p
            className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}
          >
            Reason
          </p>
          <div className="space-y-2">
            {REPORT_REASONS.map((r) => {
              const picked = reason === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setReason(r.id)}
                  data-testid={`reason-${r.id}`}
                  className={`w-full text-left rounded-xl border p-3 transition-all ${
                    picked
                      ? isDark
                        ? "border-[#FF8855] bg-[#FF8855]/10"
                        : "border-[#E6502E] bg-[#E6502E]/10"
                      : isDark
                        ? "border-white/10 bg-white/5"
                        : "border-stone-300 bg-white"
                  }`}
                >
                  <p className="text-sm font-bold">{r.label}</p>
                  <p className={`text-xs ${subtle}`}>{r.detail}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label
            htmlFor="report-notes"
            className={`block text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}
          >
            Tell us more (optional)
          </label>
          <textarea
            id="report-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="What happened? Include timestamps if from a live."
            data-testid="input-report-notes"
            className={`w-full rounded-xl px-3 py-2 text-sm border outline-none ${
              isDark
                ? "bg-white/5 border-white/10 text-white placeholder-white/30"
                : "bg-white border-stone-300 text-stone-900 placeholder-stone-400"
            }`}
          />
        </div>

        {sellerName && (
          <label
            className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer ${
              isDark ? "bg-white/5 border-white/10" : "bg-white border-stone-300"
            }`}
          >
            <input
              type="checkbox"
              checked={blockOnSubmit}
              onChange={(e) => setBlockOnSubmit(e.target.checked)}
              data-testid="checkbox-block-seller"
              className="mt-1"
            />
            <div>
              <p className="text-sm font-bold">Also block {sellerName}</p>
              <p className={`text-xs ${subtle}`}>
                You won't see their listings or live shows again.
              </p>
            </div>
          </label>
        )}

        <div
          className={`flex items-start gap-2 text-xs ${subtle}`}
          aria-live="polite"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            False reports may affect your account. Reports are anonymous to the
            seller.
          </span>
        </div>
      </form>

      <div
        className={`absolute bottom-0 left-0 right-0 p-4 backdrop-blur-xl border-t z-20 ${
          isDark
            ? "bg-[#0F1525]/90 border-white/10"
            : "bg-[#fbeed3]/90 border-stone-400/55"
        }`}
      >
        <button
          onClick={(e) => {
            e.preventDefault();
            handleSubmit(e as unknown as React.FormEvent);
          }}
          disabled={!reason}
          data-testid="button-submit-report"
          className={`w-full h-13 rounded-xl text-white font-black text-base flex items-center justify-center gap-2 transition-all ${
            reason
              ? isDark
                ? "bg-gradient-to-r from-[#FF8855] to-[#FF6B35] shadow-[0_0_18px_rgba(255,136,85,0.4)]"
                : "bg-gradient-to-r from-[#E6502E] to-[#C4441E] shadow-md"
              : "bg-stone-400 cursor-not-allowed"
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          Submit report
        </button>
      </div>
    </div>
  );
}
