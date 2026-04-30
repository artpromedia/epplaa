import { logger } from "./logger";

/**
 * OpenTelemetry init shim.
 *
 * We deliberately do NOT eagerly require @opentelemetry/sdk-node at import
 * time — pulling that SDK in adds ~2MB to cold start and a transitive web
 * of optional deps that aren't needed when OTel is disabled. Instead, this
 * function dynamically imports the SDK only when an OTLP endpoint is
 * configured.
 *
 * Configuration env:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  e.g. https://otlp-gateway-prod.grafana.net/otlp
 *   OTEL_EXPORTER_OTLP_HEADERS   "authorization=Bearer xxx"
 *   OTEL_SERVICE_NAME            defaults to "epplaa-api"
 *   OTEL_RESOURCE_ATTRIBUTES     "deployment.environment=production"
 *
 * When the SDK is not installed this function logs and returns. Install
 * `@opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node`
 * before enabling in production.
 */
export async function initOtel(): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    logger.info("otel_disabled_no_endpoint");
    return;
  }
  try {
    // Dynamic import via a string variable so TypeScript doesn't try to
    // resolve these modules at compile time. They are an optional runtime
    // dependency — install `@opentelemetry/sdk-node` and
    // `@opentelemetry/auto-instrumentations-node` in production to enable
    // OTLP export. Locally these resolve to undefined and we no-op.
    const sdkModuleName = "@opentelemetry/sdk-node";
    const autoInstrName = "@opentelemetry/auto-instrumentations-node";
    const sdkModule = (await import(sdkModuleName).catch(() => null)) as
      | { NodeSDK: new (cfg: unknown) => { start: () => void; shutdown: () => Promise<void> } }
      | null;
    if (!sdkModule) {
      logger.warn(
        "otel_sdk_not_installed: install @opentelemetry/sdk-node to enable OTLP export",
      );
      return;
    }
    const autoInstr = (await import(autoInstrName).catch(() => null)) as
      | { getNodeAutoInstrumentations: () => unknown[] }
      | null;
    const sdk = new sdkModule.NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME ?? "epplaa-api",
      instrumentations: autoInstr ? autoInstr.getNodeAutoInstrumentations() : [],
    });
    sdk.start();
    process.on("SIGTERM", () => {
      void sdk.shutdown().catch(() => undefined);
    });
    logger.info({ endpoint }, "otel_initialised");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "otel_init_failed");
  }
}
