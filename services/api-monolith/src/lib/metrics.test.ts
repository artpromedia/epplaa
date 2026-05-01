import { describe, it, expect } from "vitest";
import { registry, httpRequestsTotal, rateLimitDecisionsTotal } from "./metrics";

describe("metrics module", () => {
  it("exposes a Registry that renders Prometheus exposition format", async () => {
    httpRequestsTotal.inc({ method: "GET", route: "/healthz", status_code: "200" });
    rateLimitDecisionsTotal.inc({ limiter: "ip", decision: "allow" });
    const out = await registry.metrics();
    expect(out).toContain("epplaa_http_requests_total");
    expect(out).toContain("epplaa_rate_limit_decisions_total");
    // Default Node metrics are prefixed with `epplaa_` per metrics.ts:
    expect(out).toMatch(/^# HELP epplaa_/m);
  });
});
