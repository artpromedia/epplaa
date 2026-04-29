import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { getHealthCheckQueryOptions } from "../generated/api";

export interface UseRateLimitStoreBannerOptions {
  /**
   * Polling interval in milliseconds. Defaults to 10s, matching the
   * admin console's rate-limit alerts.
   */
  refetchIntervalMs?: number;
}

export interface RateLimitStoreBannerState {
  /** True when the API reports the rate-limit store is degraded. */
  isDegraded: boolean;
  /** True after the user has dismissed the banner for the current incident. */
  isDismissed: boolean;
  /** Hide the banner for the current incident. Resets on the next degradation. */
  dismiss: () => void;
}

const DEFAULT_REFETCH_INTERVAL_MS = 10_000;

/**
 * Polls `/healthz` and reports whether the API rate-limit store is
 * currently degraded. Used by non-admin surfaces (shopper app,
 * manufacturer portal, mobile app) to render a small operator-friendly
 * status banner so end users have visibility when abuse protection has
 * fallen back to in-memory buckets.
 *
 * Dismissal is per-tab/process and resets automatically when the store
 * recovers and then degrades again, so a fresh incident always re-surfaces
 * the banner even if the previous one was dismissed.
 */
export function useRateLimitStoreBanner(
  options: UseRateLimitStoreBannerOptions = {},
): RateLimitStoreBannerState {
  const { refetchIntervalMs = DEFAULT_REFETCH_INTERVAL_MS } = options;

  const { data } = useQuery({
    ...getHealthCheckQueryOptions(),
    refetchInterval: refetchIntervalMs,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  const status = data?.rateLimitStore;
  const isDegraded = status?.state === "degraded";

  const prevStateRef = useRef<"healthy" | "degraded" | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    if (!status) return;
    const prev = prevStateRef.current;
    // Reset dismissal whenever the store transitions back into a degraded
    // state from healthy, so a brand-new incident is surfaced even if the
    // previous one was dismissed.
    if (status.state === "degraded" && prev !== "degraded") {
      setIsDismissed(false);
    }
    prevStateRef.current = status.state;
  }, [status]);

  return {
    isDegraded,
    isDismissed,
    dismiss: () => setIsDismissed(true),
  };
}
