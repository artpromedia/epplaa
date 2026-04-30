import { AlertTriangle, X } from "lucide-react";
import { useRateLimitStoreBanner } from "@workspace/api-client-react";
import { useTheme } from "@/lib/theme-context";

/**
 * Small dismissible status banner shown to shoppers when the API
 * reports its rate-limit store as degraded. Copy is intentionally
 * generic — no internal terminology like "Redis" or "rate-limit
 * bucket" — so end users get useful context without leaking ops
 * details.
 *
 * The polling/dismissal logic lives in the shared
 * `useRateLimitStoreBanner` hook so this banner stays consistent
 * with the manufacturer portal and the mobile app.
 */
export function SystemStatusBanner() {
  const { isDegraded, isDismissed, dismiss } = useRateLimitStoreBanner();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  if (!isDegraded || isDismissed) return null;

  return (
    <div
      role="status"
      data-testid="banner-system-status-degraded"
      className={`flex items-start gap-2 px-3 py-2 text-xs border-b ${
        isDark
          ? "bg-[#FF8855]/10 border-[#FF8855]/30 text-[#FFD9C4]"
          : "bg-[#FFE7D7] border-[#E6502E]/30 text-[#7A2A14]"
      }`}
    >
      <AlertTriangle
        className={`h-4 w-4 mt-0.5 shrink-0 ${
          isDark ? "text-[#FF8855]" : "text-[#E6502E]"
        }`}
      />
      <p className="flex-1 leading-snug">
        Some actions may be slower than usual — we&rsquo;re working on it.
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss status notice"
        data-testid="button-system-status-dismiss"
        className={`shrink-0 inline-flex items-center justify-center rounded-md p-1 ${
          isDark
            ? "text-[#FFD9C4]/80 hover:text-white hover:bg-white/10"
            : "text-[#7A2A14]/80 hover:text-[#7A2A14] hover:bg-black/5"
        }`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
