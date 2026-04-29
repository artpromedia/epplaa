import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Database, X } from "lucide-react";
import { getHealthCheckQueryOptions } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export function RateLimitStoreAlerts() {
  const { toast } = useToast();
  const { data } = useQuery({
    ...getHealthCheckQueryOptions(),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
  const status = data?.rateLimitStore;

  const prevStateRef = useRef<"healthy" | "degraded" | null>(null);
  const prevRecoveredAtRef = useRef<number | null>(null);
  const [degradedDismissed, setDegradedDismissed] = useState(false);
  const [recoveredAt, setRecoveredAt] = useState<number | null>(null);

  useEffect(() => {
    if (!status) return;
    const prevState = prevStateRef.current;
    const prevRecoveredAt = prevRecoveredAtRef.current;

    if (status.state === "degraded" && prevState !== "degraded") {
      setDegradedDismissed(false);
      setRecoveredAt(null);
      toast({
        variant: "destructive",
        title: "Rate-limit store degraded",
        description:
          prevState === null
            ? `${status.kind} backend is currently degraded (${status.failureCount} consecutive failures). On-call should investigate.`
            : `${status.kind} backend just went degraded (${status.failureCount} consecutive failures). On-call should investigate.`,
      });
    }

    if (
      prevState === "degraded" &&
      status.state === "healthy" &&
      status.lastRecoveredAt !== null &&
      status.lastRecoveredAt !== prevRecoveredAt
    ) {
      setDegradedDismissed(false);
      setRecoveredAt(status.lastRecoveredAt);
      toast({
        title: "Rate-limit store recovered",
        description: `${status.kind} backend is healthy again. The alert banner will clear automatically.`,
      });
    }

    prevStateRef.current = status.state;
    prevRecoveredAtRef.current = status.lastRecoveredAt;
  }, [status, toast]);

  useEffect(() => {
    if (recoveredAt === null) return;
    const timer = setTimeout(() => setRecoveredAt(null), 30_000);
    return () => clearTimeout(timer);
  }, [recoveredAt]);

  if (!status) return null;

  if (status.state === "degraded" && !degradedDismissed) {
    return (
      <div
        className="mb-4 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        data-testid="banner-rate-limit-degraded"
        role="alert"
      >
        <Database className="w-5 h-5 mt-0.5 text-destructive shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-destructive">
            Rate-limit store degraded
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            The {status.kind} backend has failed {status.failureCount}{" "}
            consecutive health checks. Rate-limiting may be falling back to
            the in-memory bucket. Page on-call if this persists.
          </p>
        </div>
        <Link
          href="/"
          data-testid="link-rate-limit-degraded-details"
          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-background px-3 py-1.5 text-xs font-medium hover-elevate"
        >
          View details
        </Link>
        <button
          type="button"
          onClick={() => setDegradedDismissed(true)}
          data-testid="button-rate-limit-degraded-dismiss"
          aria-label="Dismiss rate-limit store alert"
          className="shrink-0 inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover-elevate"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  if (status.state === "healthy" && recoveredAt !== null) {
    return (
      <div
        className="mb-4 flex items-start gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm"
        data-testid="banner-rate-limit-recovered"
        role="status"
      >
        <CheckCircle2 className="w-5 h-5 mt-0.5 text-emerald-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-emerald-700">
            Rate-limit store recovered
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            The {status.kind} backend is healthy again. This banner will
            clear automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRecoveredAt(null)}
          data-testid="button-rate-limit-recovered-dismiss"
          aria-label="Dismiss rate-limit store recovery notice"
          className="shrink-0 inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover-elevate"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return null;
}
