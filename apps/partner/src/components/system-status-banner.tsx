import { AlertTriangle, X } from "lucide-react";
import { useRateLimitStoreBanner } from "@workspace/api-client-react";

/**
 * Small dismissible status banner shown to manufacturer portal users
 * when the API reports its rate-limit store as degraded. Copy is
 * intentionally generic — no internal terminology like "Redis" or
 * "rate-limit bucket" — so end users get useful context without
 * leaking ops details.
 *
 * The polling/dismissal logic lives in the shared
 * `useRateLimitStoreBanner` hook so this banner stays consistent
 * with the shopper app and the mobile app.
 */
export function SystemStatusBanner() {
  const { isDegraded, isDismissed, dismiss } = useRateLimitStoreBanner();

  if (!isDegraded || isDismissed) return null;

  return (
    <div
      role="status"
      data-testid="banner-system-status-degraded"
      className="mb-4 flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />
      <p className="flex-1 leading-snug text-amber-900 dark:text-amber-200">
        Some actions may be slower than usual — we&rsquo;re working on it.
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss status notice"
        data-testid="button-system-status-dismiss"
        className="shrink-0 inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover-elevate"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
