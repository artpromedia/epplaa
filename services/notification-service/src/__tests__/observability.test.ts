import { describe, it, expect } from "vitest";
import { metricsRegistry, notificationsEnqueuedTotal } from "../lib/observability.js";

describe("notification-service observability", () => {
  it("registers the prom-client default + enqueue metric", async () => {
    notificationsEnqueuedTotal.inc({ event_type: "test", outcome: "ok" });
    const text = await metricsRegistry.metrics();
    expect(text).toContain("epplaa_notification_enqueued_total");
  });
});
