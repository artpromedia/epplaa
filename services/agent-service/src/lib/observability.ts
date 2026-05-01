/**
 * Observability bootstrap shared by agent-service entry points.
 *
 *   initOtel()       — start OpenTelemetry NodeSDK (no-op when
 *                      OTEL_EXPORTER_OTLP_ENDPOINT is unset).
 *   metricsRegistry  — prom-client Registry exported for the /metrics
 *                      handler to render.
 *   logger           — pino logger reused everywhere.
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
  name: "agent-service",
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: "epplaa_agent_" });

export const agentRunsTotal = new Counter({
  name: "epplaa_agent_runs_total",
  help: "Number of agent.run() invocations.",
  labelNames: ["agent_id", "outcome"] as const,
  registers: [metricsRegistry],
});

export const agentToolCallsTotal = new Counter({
  name: "epplaa_agent_tool_calls_total",
  help: "Number of agent tool dispatches.",
  labelNames: ["agent_id", "tool_name", "outcome"] as const,
  registers: [metricsRegistry],
});

let sdk: NodeSDK | null = null;

export async function initOtel(): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    logger.info("otel_disabled_no_endpoint");
    return;
  }
  if (sdk) {
    logger.warn("otel_already_initialised");
    return;
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "epplaa-agent-service",
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

  process.on("SIGTERM", () => {
    void sdk
      ?.shutdown()
      .catch((err) =>
        logger.warn({ err: (err as Error).message }, "otel_shutdown_error"),
      );
  });

  logger.info({ endpoint }, "otel_initialised");
}
