import { useState } from "react";
import { Link } from "wouter";
import { ShieldCheck, ChevronRight, UserX, Flag, Clock, AlertOctagon } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useSafety, reportReasonLabel, type MyTakedown } from "@/lib/safety-context";
import { PageHeader } from "@/components/page-header";

export default function SafetyHub() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { reports, blocked, takedowns, unblockSeller, appealTakedown } = useSafety();

  const subtle = isDark ? "text-white/55" : "text-stone-500";
  const card = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Trust & safety" backHref="/profile" />

      <div className="px-4 pb-24 space-y-6">
        <div
          className={`rounded-2xl border p-4 ${
            isDark
              ? "bg-emerald-400/10 border-emerald-400/30"
              : "bg-emerald-50 border-emerald-200"
          }`}
        >
          <div className="flex items-center gap-3">
            <ShieldCheck
              className={`w-6 h-6 ${
                isDark ? "text-emerald-300" : "text-emerald-700"
              }`}
            />
            <div>
              <p className="font-bold">Buyer protection is on</p>
              <p
                className={`text-xs ${
                  isDark ? "text-emerald-200" : "text-emerald-700"
                }`}
              >
                Refunds, chargebacks, and dispute review on every order.
              </p>
            </div>
          </div>
        </div>

        <Section title="Removed content" subtle={subtle}>
          {takedowns.length === 0 ? (
            <EmptyHint
              isDark={isDark}
              icon={<AlertOctagon className="w-4 h-4" />}
              text="No takedowns. Your listings, streams, and messages are all in good standing."
            />
          ) : (
            <div className={`rounded-xl border overflow-hidden ${card}`}>
              {takedowns.map((t, idx) => (
                <TakedownRow
                  key={t.id}
                  takedown={t}
                  isDark={isDark}
                  subtle={subtle}
                  isFirst={idx === 0}
                  onAppeal={appealTakedown}
                />
              ))}
            </div>
          )}
        </Section>

        <Section title="Your reports" subtle={subtle}>
          {reports.length === 0 ? (
            <EmptyHint
              isDark={isDark}
              icon={<Flag className="w-4 h-4" />}
              text="You haven't reported anything yet."
            />
          ) : (
            <div className={`rounded-xl border overflow-hidden ${card}`}>
              {reports.map((r, idx) => (
                <div
                  key={r.id}
                  data-testid={`safety-report-${r.id}`}
                  className={`p-3 flex items-start gap-3 ${
                    idx > 0
                      ? isDark
                        ? "border-t border-white/10"
                        : "border-t border-stone-200"
                      : ""
                  }`}
                >
                  <div
                    className={`w-9 h-9 rounded-full shrink-0 flex items-center justify-center ${
                      isDark ? "bg-[#FF8855]/20" : "bg-[#E6502E]/15"
                    }`}
                  >
                    <Flag
                      className={`w-4 h-4 ${
                        isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate">
                      {r.targetLabel}
                    </p>
                    <p className={`text-xs ${subtle}`}>
                      {reportReasonLabel(r.reason)} · {r.targetKind}
                    </p>
                    <div className="flex items-center gap-1 mt-1 flex-wrap">
                      <Clock
                        className={`w-3 h-3 ${
                          isDark ? "text-white/40" : "text-stone-400"
                        }`}
                      />
                      <span
                        className={`text-[10px] uppercase tracking-wider font-bold ${
                          r.status === "resolved"
                            ? "text-emerald-500"
                            : r.status === "dismissed"
                              ? subtle
                              : isDark
                                ? "text-[#5BA3F5]"
                                : "text-[#1B2A4A]"
                        }`}
                      >
                        {r.status.replace(/_/g, " ")}
                      </span>
                      {r.caseId && (
                        <span
                          data-testid={`safety-report-case-${r.id}`}
                          className={`text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${
                            isDark
                              ? "bg-white/10 text-white/70"
                              : "bg-stone-200 text-stone-700"
                          }`}
                          title={`Case ${r.caseId}`}
                        >
                          case {(r.caseStatus ?? "open").replace(/_/g, " ")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Blocked sellers" subtle={subtle}>
          {blocked.length === 0 ? (
            <EmptyHint
              isDark={isDark}
              icon={<UserX className="w-4 h-4" />}
              text="No blocked sellers. You can block from any product page."
            />
          ) : (
            <div className={`rounded-xl border overflow-hidden ${card}`}>
              {blocked.map((b, idx) => (
                <div
                  key={b.sellerName}
                  className={`p-3 flex items-center justify-between ${
                    idx > 0
                      ? isDark
                        ? "border-t border-white/10"
                        : "border-t border-stone-200"
                      : ""
                  }`}
                >
                  <div>
                    <p className="text-sm font-bold">{b.sellerName}</p>
                    <p className={`text-xs ${subtle}`}>
                      Blocked {new Date(b.atIso).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    onClick={() => unblockSeller(b.sellerName)}
                    data-testid={`button-unblock-${b.sellerName}`}
                    className={`text-xs font-bold px-3 py-1.5 rounded-full border ${
                      isDark
                        ? "border-white/20 text-white/80 hover:bg-white/10"
                        : "border-stone-300 text-stone-700 hover:bg-stone-100"
                    }`}
                  >
                    Unblock
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Resources" subtle={subtle}>
          <div className={`rounded-xl border ${card}`}>
            <ResourceLink
              isDark={isDark}
              label="Community guidelines"
              detail="What's allowed on Epplaa Live."
              href="/safety"
            />
            <Divider isDark={isDark} />
            <ResourceLink
              isDark={isDark}
              label="Spotting counterfeit goods"
              detail="A 3 minute read for buyers."
              href="/safety"
            />
            <Divider isDark={isDark} />
            <ResourceLink
              isDark={isDark}
              label="Talk to support"
              detail="WhatsApp our trust team 24/7."
              href="/inbox"
            />
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  subtle,
  children,
}: {
  title: string;
  subtle: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3
        className={`text-sm font-bold mb-3 uppercase tracking-wider ${subtle}`}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyHint({
  isDark,
  icon,
  text,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  text: string;
}) {
  return (
    <div
      className={`rounded-xl border-dashed border-2 p-4 flex items-center gap-2 text-xs ${
        isDark
          ? "border-white/10 text-white/50"
          : "border-stone-300 text-stone-500"
      }`}
    >
      {icon}
      <span>{text}</span>
    </div>
  );
}

function ResourceLink({
  isDark,
  label,
  detail,
  href,
}: {
  isDark: boolean;
  label: string;
  detail: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center justify-between p-4 ${
        isDark ? "hover:bg-white/5" : "hover:bg-stone-50"
      }`}
      data-testid={`link-resource-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div>
        <p className="text-sm font-bold">{label}</p>
        <p className={`text-xs ${isDark ? "text-white/50" : "text-stone-500"}`}>
          {detail}
        </p>
      </div>
      <ChevronRight
        className={`w-4 h-4 ${isDark ? "text-white/30" : "text-stone-400"}`}
      />
    </Link>
  );
}

/**
 * Per-takedown row in the "Removed content" section. Shows the
 * machine reason code as a human label, an expandable appeal form
 * when the seller wants to contest the takedown, and a status pill
 * when an appeal is already in flight.
 *
 * The appeal CTA is hidden when:
 *   - the linked moderation case is `in_review` (an appeal is
 *     already with the operator queue), OR
 *   - the case is `closed` after a re-decision (no further appeal
 *     option in this iteration — Trust & Safety closure is final
 *     unless support escalates manually).
 */
function TakedownRow({
  takedown,
  isDark,
  subtle,
  isFirst,
  onAppeal,
}: {
  takedown: MyTakedown;
  isDark: boolean;
  subtle: string;
  isFirst: boolean;
  onAppeal: (id: string, reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const reasonLabel = humanizeReasonCode(takedown.reasonCode);
  const appealInFlight =
    takedown.caseStatus === "in_review" ||
    takedown.caseStatus === "open" ||
    takedown.caseStatus === "triage";
  const appealClosed = takedown.caseStatus === "closed";
  const canAppeal = !appealInFlight && !appealClosed && !submitted;

  return (
    <div
      data-testid={`safety-takedown-${takedown.id}`}
      className={`p-3 ${
        isFirst
          ? ""
          : isDark
            ? "border-t border-white/10"
            : "border-t border-stone-200"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-9 h-9 rounded-full shrink-0 flex items-center justify-center ${
            isDark ? "bg-amber-400/20" : "bg-amber-500/15"
          }`}
        >
          <AlertOctagon
            className={`w-4 h-4 ${isDark ? "text-amber-300" : "text-amber-700"}`}
          />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold truncate">
            Your {takedown.targetKind} was removed
          </p>
          <p className={`text-xs ${subtle}`}>
            Reason: {reasonLabel}
          </p>
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            <Clock
              className={`w-3 h-3 ${
                isDark ? "text-white/40" : "text-stone-400"
              }`}
            />
            <span
              className={`text-[10px] uppercase tracking-wider font-bold ${subtle}`}
            >
              {new Date(takedown.createdAtIso).toLocaleDateString()}
            </span>
            {appealInFlight && (
              <span
                data-testid={`safety-takedown-appeal-status-${takedown.id}`}
                className={`text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${
                  isDark
                    ? "bg-[#5BA3F5]/20 text-[#5BA3F5]"
                    : "bg-[#1B2A4A]/10 text-[#1B2A4A]"
                }`}
              >
                appeal in review
              </span>
            )}
            {appealClosed && (
              <span
                className={`text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${
                  isDark
                    ? "bg-white/10 text-white/70"
                    : "bg-stone-200 text-stone-700"
                }`}
              >
                appeal closed
              </span>
            )}
          </div>
        </div>
        {canAppeal && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            data-testid={`button-appeal-${takedown.id}`}
            className={`text-xs font-bold px-3 py-1.5 rounded-full border ${
              isDark
                ? "border-white/20 text-white/80 hover:bg-white/10"
                : "border-stone-300 text-stone-700 hover:bg-stone-100"
            }`}
          >
            {open ? "Cancel" : "Appeal"}
          </button>
        )}
      </div>
      {open && canAppeal && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const r = reason.trim();
            if (!r) {
              setError("Please describe why this should be reinstated.");
              return;
            }
            setError(null);
            setSubmitting(true);
            onAppeal(takedown.id, r)
              .then(() => {
                setSubmitted(true);
                setOpen(false);
                setReason("");
              })
              .catch((err: unknown) => {
                const msg =
                  err instanceof Error ? err.message : "Could not submit appeal.";
                setError(msg);
              })
              .finally(() => setSubmitting(false));
          }}
        >
          <textarea
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Explain why this takedown is incorrect."
            rows={3}
            data-testid={`textarea-appeal-${takedown.id}`}
            className={`w-full text-sm rounded-lg border p-2 ${
              isDark
                ? "bg-white/5 border-white/15 text-white placeholder:text-white/30"
                : "bg-white border-stone-300 text-stone-900 placeholder:text-stone-400"
            }`}
          />
          {error && (
            <p className="text-xs text-red-500" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              data-testid={`button-submit-appeal-${takedown.id}`}
              className={`text-xs font-bold px-4 py-2 rounded-full ${
                isDark
                  ? "bg-[#FF8855] text-stone-900 disabled:opacity-50"
                  : "bg-[#E6502E] text-white disabled:opacity-50"
              }`}
            >
              {submitting ? "Submitting…" : "Submit appeal"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function humanizeReasonCode(code: string): string {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) return "policy violation";
  return trimmed.replace(/[_-]+/g, " ");
}

function Divider({ isDark }: { isDark: boolean }) {
  return (
    <div
      className={isDark ? "h-px bg-white/10" : "h-px bg-stone-200"}
      role="separator"
    />
  );
}
