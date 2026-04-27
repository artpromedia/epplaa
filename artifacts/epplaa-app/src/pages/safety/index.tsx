import { Link } from "wouter";
import { ShieldCheck, ChevronRight, UserX, Flag, Clock } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useSafety, reportReasonLabel } from "@/lib/safety-context";
import { PageHeader } from "@/components/page-header";

export default function SafetyHub() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { reports, blocked, unblockSeller } = useSafety();

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
                    <div className="flex items-center gap-1 mt-1">
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

function Divider({ isDark }: { isDark: boolean }) {
  return (
    <div
      className={isDark ? "h-px bg-white/10" : "h-px bg-stone-200"}
      role="separator"
    />
  );
}
