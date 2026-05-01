/**
 * Prometheus /metrics endpoint via prom-client.
 *
 * Two parallel metric pipelines deliberately:
 *   - OTel SDK (lib/otel.ts) → OTLP → Prometheus remote-write via the
 *     OTel collector. Captures auto-instrumented HTTP/DB spans and any
 *     manual `@opentelemetry/api` Meter usage.
 *   - prom-client (this file) → /metrics scraped by ServiceMonitor.
 *     Captures default Node process metrics plus the request-level RED
 *     metrics declared below.
 *
 * Keeping both is intentional: the OTel pipeline gives us trace
 * exemplars in Tempo; the prom-client one gives Grafana dashboards and
 * AlertManager rules a stable, low-cardinality scrape target that's
 * resilient to OTel collector outages.
 */

import type { RequestHandler } from "express";
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "epplaa_" });

export const httpRequestsTotal = new Counter({
  name: "epplaa_http_requests_total",
  help: "Total HTTP requests processed.",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "epplaa_http_request_duration_seconds",
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const rateLimitDecisionsTotal = new Counter({
  name: "epplaa_rate_limit_decisions_total",
  help: "Rate-limit decisions emitted by IP and API limiters.",
  labelNames: ["limiter", "decision"] as const,
  registers: [registry],
});

/**
 * Middleware: wraps every Express request to record method, route, and
 * status_code. Routed via Express's `req.route` (only populated after
 * matching), so the label is the *registered route pattern* not the raw
 * URL — keeping cardinality bounded.
 */
export const httpMetricsMiddleware: RequestHandler = (req, res, next) => {
  const end = httpRequestDurationSeconds.startTimer();
  res.on("finish", () => {
    const route = (req.route?.path as string | undefined) ?? "unmatched";
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
};

/**
 * Express handler for `/metrics`. Mount before route auth so Prometheus
 * can scrape without a Clerk session, but bind it to the loopback or
 * NetworkPolicy-restricted side of the cluster so it isn't exposed at
 * the public ingress.
 */
export const metricsHandler: RequestHandler = async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.end(await registry.metrics());
};
