import { logger } from "./logger";

/**
 * OpenTelemetry init.
 *
 * Behaviour:
 *   - When OTEL_EXPORTER_OTLP_ENDPOINT is unset → no-op (dev/test default).
 *   - When set → start NodeSDK with OTLP/HTTP trace + metric exporters and
 *     all auto-instrumentations.
 *
 * The SDK packages are now real `dependencies` (see package.json). Earlier
 * iterations dynamic-imported them so the SDK was a soft dep — that meant
 * production silently emitted nothing if the install missed them. Phase
 * D1 of the v4.2 amendment ships them as required.
 *
 * Configuration env:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  e.g. http://otel-collector.observability:4318
 *   OTEL_EXPORTER_OTLP_HEADERS   "authorization=Bearer xxx"
 *   OTEL_SERVICE_NAME            defaults to "epplaa-api"
 *   OTEL_RESOURCE_ATTRIBUTES     "deployment.environment=production"
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

let sdkInstance: NodeSDK | null = null;

export async function initOtel(): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    logger.info("otel_disabled_no_endpoint");
    return;
  }

  if (sdkInstance) {
    logger.warn("otel_already_initialised");
    return;
  }

  try {
    const resource = new Resource({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "epplaa-api",
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
        process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV ?? "development",
    });

    sdkInstance = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 30_000,
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Pino's pino-http already produces structured request logs; the
          // HTTP auto-instrumentation creates the correlated span we want
          // for trace exemplars without needing a log-injection plugin.
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });

    sdkInstance.start();

    process.on("SIGTERM", () => {
      void sdkInstance
        ?.shutdown()
        .catch((err) =>
          logger.warn({ err: (err as Error).message }, "otel_shutdown_error"),
        );
    });

    logger.info({ endpoint }, "otel_initialised");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "otel_init_failed");
  }
}
