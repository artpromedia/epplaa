import { useState } from "react";
import { Link } from "wouter";
import {
  Shield,
  Download,
  Trash2,
  Lock,
  FileText,
  Pencil,
  ArrowLeft,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";
import {
  useListNdprRequests,
  useRequestNdprExport,
  useRequestNdprErase,
  useRequestNdprPortability,
  useRequestNdprRectify,
  useRequestNdprRestrict,
  useCancelNdprRequest,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export default function Privacy() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { toast } = useToast();
  const qc = useQueryClient();

  const cardBorder = isDark
    ? "border-white/10 bg-white/5"
    : "border-stone-300 bg-white";
  const subtle = isDark ? "text-white/60" : "text-stone-500";

  const list = useListNdprRequests();
  const requests = list.data ?? [];

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["/api/ndpr/requests"] });

  const exportMut = useRequestNdprExport({ mutation: { onSuccess: invalidate } });
  const portabilityMut = useRequestNdprPortability({ mutation: { onSuccess: invalidate } });
  const eraseMut = useRequestNdprErase({ mutation: { onSuccess: invalidate } });
  const restrictMut = useRequestNdprRestrict({ mutation: { onSuccess: invalidate } });
  const rectifyMut = useRequestNdprRectify({ mutation: { onSuccess: invalidate } });
  const cancelMut = useCancelNdprRequest({ mutation: { onSuccess: invalidate } });

  const [showRectify, setShowRectify] = useState(false);
  const [rectifyDisplayName, setRectifyDisplayName] = useState("");
  const [rectifyPhone, setRectifyPhone] = useState("");
  const [confirmErase, setConfirmErase] = useState(false);

  function busy() {
    return (
      exportMut.isPending ||
      portabilityMut.isPending ||
      eraseMut.isPending ||
      restrictMut.isPending ||
      rectifyMut.isPending ||
      cancelMut.isPending
    );
  }

  function safe(fn: () => Promise<unknown>, ok: string) {
    fn()
      .then(() => toast({ title: ok }))
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : "Try again";
        toast({ title: "Couldn't complete", description: detail });
      });
  }

  return (
    <div className={isDark ? "bg-[#1a0e08] text-white min-h-screen" : "bg-stone-50 text-stone-900 min-h-screen"}>
      <PageHeader title="Privacy & data" backHref="/account/settings" />
      <div className="max-w-md mx-auto px-4 py-4 space-y-4 pb-24">
        <div className={`rounded-xl border p-4 ${cardBorder}`}>
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 mt-0.5 text-orange-500" />
            <div>
              <p className="font-bold text-sm">Your data, your rights</p>
              <p className={`text-xs ${subtle} mt-1`}>
                Under the Nigeria Data Protection Regulation (NDPR) you can
                export, correct, restrict, or delete your personal data at any
                time. Financial records are retained for 7 years to comply
                with FIRS requirements.
              </p>
            </div>
          </div>
        </div>

        <div className={`rounded-xl border divide-y ${cardBorder} ${isDark ? "divide-white/10" : "divide-stone-200"}`}>
          <ActionRow
            icon={<Download className="w-4 h-4" />}
            title="Export my data"
            sub="Receive a copy of every record we hold on you."
            buttonLabel="Request export"
            disabled={busy()}
            onClick={() =>
              safe(() => exportMut.mutateAsync(), "Export started — check back shortly")
            }
            isDark={isDark}
            testId="action-export"
          />
          <ActionRow
            icon={<FileText className="w-4 h-4" />}
            title="Portability"
            sub="Same data in machine-readable JSON for transfer to another platform."
            buttonLabel="Generate"
            disabled={busy()}
            onClick={() =>
              safe(() => portabilityMut.mutateAsync(), "Portability bundle queued")
            }
            isDark={isDark}
            testId="action-portability"
          />
          <ActionRow
            icon={<Pencil className="w-4 h-4" />}
            title="Rectify a record"
            sub="Update incorrect personal details (name, phone)."
            buttonLabel={showRectify ? "Hide" : "Edit"}
            disabled={busy()}
            onClick={() => setShowRectify((v) => !v)}
            isDark={isDark}
            testId="action-rectify"
          />
          {showRectify && (
            <div className="p-4 space-y-2">
              <input
                type="text"
                placeholder="New display name (optional)"
                value={rectifyDisplayName}
                onChange={(e) => setRectifyDisplayName(e.target.value)}
                className={`w-full text-sm rounded-md px-3 py-2 ${
                  isDark
                    ? "bg-white/10 border border-white/10 placeholder:text-white/30"
                    : "bg-white border border-stone-300 placeholder:text-stone-400"
                }`}
                data-testid="input-rectify-display-name"
              />
              <input
                type="tel"
                placeholder="New phone (E.164, optional)"
                value={rectifyPhone}
                onChange={(e) => setRectifyPhone(e.target.value)}
                className={`w-full text-sm rounded-md px-3 py-2 ${
                  isDark
                    ? "bg-white/10 border border-white/10 placeholder:text-white/30"
                    : "bg-white border border-stone-300 placeholder:text-stone-400"
                }`}
                data-testid="input-rectify-phone"
              />
              <button
                onClick={() => {
                  const patch: Record<string, string> = {};
                  if (rectifyDisplayName.trim()) patch.displayName = rectifyDisplayName.trim();
                  if (rectifyPhone.trim()) patch.phone = rectifyPhone.trim();
                  if (Object.keys(patch).length === 0) {
                    toast({ title: "Nothing to update" });
                    return;
                  }
                  safe(
                    () => rectifyMut.mutateAsync({ data: { patch } }),
                    "Updated and audited",
                  );
                  setShowRectify(false);
                  setRectifyDisplayName("");
                  setRectifyPhone("");
                }}
                disabled={busy()}
                className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-sm font-bold py-2 rounded-md"
                data-testid="button-submit-rectify"
              >
                Save changes
              </button>
            </div>
          )}
          <ActionRow
            icon={<Lock className="w-4 h-4" />}
            title="Restrict processing"
            sub="Pause non-essential processing while a dispute is open."
            buttonLabel="Restrict"
            disabled={busy()}
            onClick={() =>
              safe(
                () => restrictMut.mutateAsync({ data: { lift: false } }),
                "Processing restricted",
              )
            }
            isDark={isDark}
            testId="action-restrict"
          />
          <ActionRow
            icon={<RefreshCw className="w-4 h-4" />}
            title="Resume processing"
            sub="Lift a previous restriction."
            buttonLabel="Resume"
            disabled={busy()}
            onClick={() =>
              safe(
                () => restrictMut.mutateAsync({ data: { lift: true } }),
                "Processing resumed",
              )
            }
            isDark={isDark}
            testId="action-unrestrict"
          />
        </div>

        <div className={`rounded-xl border p-4 ${cardBorder}`}>
          <div className="flex items-start gap-3 mb-3">
            <Trash2 className="w-5 h-5 mt-0.5 text-red-500" />
            <div>
              <p className="font-bold text-sm">Erase my account</p>
              <p className={`text-xs ${subtle} mt-1`}>
                We schedule a 30-day grace period before final deletion.
                Financial rows are retained but anonymised; PII is purged.
              </p>
            </div>
          </div>
          {!confirmErase ? (
            <button
              onClick={() => setConfirmErase(true)}
              className={`w-full text-sm font-bold py-2 rounded-md ${
                isDark
                  ? "bg-red-500/10 text-red-300 hover:bg-red-500/15 border border-red-500/30"
                  : "bg-red-50 text-red-800 hover:bg-red-100 border border-red-200"
              }`}
              data-testid="button-erase"
            >
              Schedule erasure
            </button>
          ) : (
            <div className="space-y-2">
              <div className={`flex items-start gap-2 text-xs ${subtle}`}>
                <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                <span>This cannot be undone after the 30-day grace period.</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmErase(false)}
                  className={`flex-1 text-sm font-bold py-2 rounded-md ${
                    isDark ? "bg-white/10" : "bg-stone-200"
                  }`}
                  data-testid="button-cancel-erase"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    safe(() => eraseMut.mutateAsync(), "Erasure scheduled");
                    setConfirmErase(false);
                  }}
                  className="flex-1 bg-red-500 hover:bg-red-600 text-white text-sm font-bold py-2 rounded-md"
                  data-testid="button-confirm-erase"
                >
                  Confirm erasure
                </button>
              </div>
            </div>
          )}
        </div>

        <div>
          <p className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}>
            Request history
          </p>
          {list.isLoading ? (
            <div className={`text-xs ${subtle}`}>Loading…</div>
          ) : requests.length === 0 ? (
            <div className={`rounded-xl border p-6 text-center ${cardBorder}`}>
              <p className={`text-sm ${subtle}`}>No requests yet</p>
            </div>
          ) : (
            <div className={`rounded-xl border divide-y overflow-hidden ${cardBorder} ${isDark ? "divide-white/10" : "divide-stone-200"}`}>
              {requests.map((r) => (
                <div key={r.id} className="p-3" data-testid={`ndpr-row-${r.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold capitalize">{r.kind}</p>
                      <p className={`text-[11px] ${subtle}`}>
                        {new Date(r.createdAtIso).toLocaleString()}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                        r.status === "completed" || r.status === "ready"
                          ? isDark
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-emerald-100 text-emerald-800"
                          : r.status === "cancelled"
                            ? isDark
                              ? "bg-stone-500/15 text-stone-300"
                              : "bg-stone-200 text-stone-800"
                            : isDark
                              ? "bg-amber-500/15 text-amber-300"
                              : "bg-amber-100 text-amber-800"
                      }`}
                    >
                      {r.status}
                    </span>
                  </div>
                  {r.kind === "erase" && r.status === "scheduled" && (
                    <button
                      onClick={() =>
                        safe(
                          () => cancelMut.mutateAsync({ id: r.id }),
                          "Erasure cancelled",
                        )
                      }
                      className={`mt-2 w-full text-xs py-1.5 rounded-md font-bold ${
                        isDark
                          ? "bg-white/10 hover:bg-white/15"
                          : "bg-stone-200 hover:bg-stone-300"
                      }`}
                      data-testid={`button-cancel-${r.id}`}
                    >
                      Cancel erasure
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <p className={`text-[11px] ${subtle} text-center`}>
          Questions? <Link href="/safety" className="underline">Contact our DPO</Link>.
        </p>
      </div>
    </div>
  );
}

function ActionRow({
  icon,
  title,
  sub,
  buttonLabel,
  onClick,
  disabled,
  isDark,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  buttonLabel: string;
  onClick: () => void;
  disabled: boolean;
  isDark: boolean;
  testId: string;
}) {
  return (
    <div className="p-4 flex items-center gap-3">
      <div className={isDark ? "text-white/60" : "text-stone-500"}>{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold">{title}</p>
        <p className={`text-xs ${isDark ? "text-white/50" : "text-stone-500"}`}>
          {sub}
        </p>
      </div>
      <button
        onClick={onClick}
        disabled={disabled}
        className={`text-xs font-bold py-1.5 px-3 rounded-md whitespace-nowrap disabled:opacity-50 ${
          isDark ? "bg-white/10 hover:bg-white/15" : "bg-stone-200 hover:bg-stone-300"
        }`}
        data-testid={testId}
      >
        {buttonLabel}
      </button>
    </div>
  );
}
