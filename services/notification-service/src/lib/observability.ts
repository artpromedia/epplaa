/**
 * Observability bootstrap for notification-service.
 * Mirrors the agent-service shape; consolidate to a shared @workspace/otel
 * package once the service-extraction sprint lands a second consumer.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from "@opentelemetry/semantic-conventions/incubating";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { collectDefaultMetrics, Counter, Registry } from "prom-client";
import pino from "pino";

export const logger = pino({
  name: "notification-service",
  level: process.env.LOG_LEVEL ?? "info",
  formatters: { level: (label) => ({ level: label }) },
});

export const metricsRegistry = new Registry();
collectDefaultMetrics({
  register: metricsRegistry,
  prefix: "epplaa_notification_",
});

export const notificationsEnqueuedTotal = new Counter({
  name: "epplaa_notification_enqueued_total",
  help: "Notifications accepted via /v1/notifications/enqueue.",
  labelNames: ["event_type", "outcome"] as const,
  registers: [metricsRegistry],
});

let sdk: NodeSDK | null = null;

export async function initOtel(): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    logger.info("otel_disabled_no_endpoint");
    return;
  }
  if (sdk) return;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "epplaa-notification-service",
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
      process.env.NODE_ENV === "production"
        ? "production"
        : process.env.NODE_ENV ?? "development",
  });

  sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  sdk.start();
  logger.info({ endpoint }, "otel_initialised");
}
