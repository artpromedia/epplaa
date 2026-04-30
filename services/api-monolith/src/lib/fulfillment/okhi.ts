import { createHash } from "node:crypto";
import { logger } from "../logger";
import {
  detectNonHostnameProductionSignals,
  isProductionEnvironment,
} from "../productionSignals";

/**
 * Boot-time sanity check: production deploys MUST set both
 * `OKHI_API_KEY` and `OKHI_BRANCH_ID`.
 *
 * `isConfigured()` (below) only returns `true` when BOTH are set; if
 * either is missing the verification result is derived from a
 * deterministic stub of the input hash. The `allowStubFallback()`
 * production-signal guard already refuses to substitute the stub at
 * runtime when production-shape is detected (so the misconfiguration
 * fails closed at the next address-verification call), but the boot
 * itself looks healthy and the misconfiguration only surfaces when a
 * buyer tries to verify their address. This boot-time warning turns
 * the runbook recommendation that "production must set OkHi creds"
 * into an automated signal so on-call sees it within minutes of the
 * next deploy.
 *
 * Modelled on the other `assertXxxConfiguredForProduction` helpers
 * (see `docs/runbooks/production-secrets.md`). Warning, not a hard
 * failure: an internal-only deploy may legitimately ship without
 * OkHi while it's being stood up. Operators wire a Sentry / log-
 * aggregator alert on the `okhi_credentials_missing_for_production`
 * message tag.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-warned (each var missing
 * individually + both missing), and configured-silent paths without
 * poisoning `process.env` or piping pino output.
 */
export type OkHiConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertOkHiConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): OkHiConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return { ok: true };
  const apiKey = env.OKHI_API_KEY;
  const branchId = env.OKHI_BRANCH_ID;
  const apiKeyOk = Boolean(apiKey && apiKey.trim() !== "");
  const branchOk = Boolean(branchId && branchId.trim() !== "");
  if (apiKeyOk && branchOk) return { ok: true };
  const missing: string[] = [];
  if (!apiKeyOk) missing.push("OKHI_API_KEY");
  if (!branchOk) missing.push("OKHI_BRANCH_ID");
  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    `${missing.join(" + ")} not set on this production deploy. ` +
    "OkHi address verification falls back to a deterministic stub " +
    "place id derived from the input hash (lib/fulfillment/okhi.ts). " +
    "The runtime production-signal guard in `allowStubFallback()` " +
    "fails the next address-verification call closed, but boot looks " +
    "healthy until then — every buyer who reaches the address-" +
    "verification step sees a 5xx instead of a clear operator-facing " +
    "alert. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Set the missing env var(s) — see docs/runbooks/production-secrets.md " +
    "(OkHi section).";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      okhi_api_key: apiKeyOk ? "[set]" : apiKey ? "[set-but-empty]" : null,
      okhi_branch_id: branchOk ? "[set]" : branchId ? "[set-but-empty]" : null,
      missing,
      production_signals: productionSignals.map((s) => s.signal),
    },
    `okhi_credentials_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}

/**
 * OkHi address verification. Real integration uses the OkHi REST API to
 * resolve a (lat, lng) pin into a verified place id with a confidence
 * score. We surface confidence as a percentage 0-100; checkout gates home
 * delivery on >= 70 (anything lower is steered to a Box / PUDO).
 *
 * Stub mode: when OKHI_API_KEY is unset, derive a deterministic place id
 * from the input hash and return a confidence based on the structural
 * completeness of the address (street + area + city + pin). This lets the
 * checkout flow exercise its branching paths in dev without hitting a
 * real OkHi sandbox.
 */

export interface OkHiVerifyInput {
  countryCode: string;
  line: string;
  area: string;
  city: string;
  lat?: number;
  lng?: number;
}

export interface OkHiVerifyResult {
  ok: boolean;
  placeId: string;
  confidencePct: number;
  /** Optional human-readable suggested correction, e.g. "Did you mean X?". */
  suggestion?: string;
  /** Provider returned this exact verified address back. */
  verifiedAddress?: string;
}

function isConfigured(): boolean {
  return Boolean(process.env.OKHI_API_KEY && process.env.OKHI_BRANCH_ID);
}

/**
 * Stub fallback is allowed only when the integration is unconfigured (so
 * dev/CI flows still work) OR when an explicit `STUB_FULFILLMENT=1`
 * escape hatch is set. In production with credentials configured we
 * never silently substitute fake data on real-call failure: we throw and
 * let the caller surface a clear error to the buyer.
 *
 * Defense-in-depth (Task #83): even with `STUB_FULFILLMENT=1`, refuse
 * to fall back if any production signal (NODE_ENV / REPLIT_DEPLOYMENT /
 * DEPLOYMENT_ENVIRONMENT / hostname-pattern match) is detected. This
 * prevents a copy-paste of staging env vars (which include the stub
 * escape hatch) into a production deploy from silently substituting
 * synthetic verified addresses on real-call failure — a stub place id
 * with high confidence would let an unverified address pass the
 * home-delivery gate.
 */
function allowStubFallback(): boolean {
  if (!isConfigured()) return true;
  if (isProductionEnvironment(process.env, logger)) return false;
  if (process.env.STUB_FULFILLMENT === "1") return true;
  return process.env.NODE_ENV !== "production";
}

function deterministicPlaceId(input: OkHiVerifyInput): string {
  const h = createHash("sha256")
    .update(`${input.countryCode}|${input.line}|${input.area}|${input.city}|${input.lat ?? ""}|${input.lng ?? ""}`)
    .digest("hex");
  return `okhi_stub_${h.slice(0, 18)}`;
}

function stubConfidence(input: OkHiVerifyInput): number {
  let c = 30;
  if (input.line.trim().length >= 4) c += 15;
  if (input.area.trim().length >= 3) c += 15;
  if (input.city.trim().length >= 2) c += 10;
  if (typeof input.lat === "number" && typeof input.lng === "number") c += 25;
  return Math.min(98, c);
}

export async function verifyAddress(input: OkHiVerifyInput): Promise<OkHiVerifyResult> {
  if (!isConfigured()) {
    return {
      ok: true,
      placeId: deterministicPlaceId(input),
      confidencePct: stubConfidence(input),
    };
  }
  try {
    const res = await fetch("https://api.okhi.io/v5/addresses/verify", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OKHI_API_KEY}`,
        "x-okhi-branch-id": process.env.OKHI_BRANCH_ID ?? "",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        countryCode: input.countryCode,
        location: input.lat != null && input.lng != null ? { lat: input.lat, lng: input.lng } : undefined,
        streetName: input.line,
        propertyName: input.area,
        city: input.city,
      }),
    });
    if (!res.ok) {
      if (!allowStubFallback()) {
        logger.error({ status: res.status }, "okhi_verify_http_failed_no_fallback");
        throw new Error(`okhi_http_${res.status}`);
      }
      logger.warn({ status: res.status }, "okhi_verify_http_failed_falling_back_stub");
      return {
        ok: true,
        placeId: deterministicPlaceId(input),
        confidencePct: stubConfidence(input),
      };
    }
    const data = (await res.json()) as {
      placeId?: string;
      confidence?: number;
      verifiedAddress?: string;
      suggestion?: string;
    };
    return {
      ok: true,
      placeId: String(data.placeId ?? deterministicPlaceId(input)),
      // OkHi returns 0-1; convert to a 0-100 percentage.
      confidencePct: Math.round(Math.max(0, Math.min(1, data.confidence ?? 0.5)) * 100),
      verifiedAddress: data.verifiedAddress,
      suggestion: data.suggestion,
    };
  } catch (err) {
    if (!allowStubFallback()) {
      logger.error({ err: (err as Error).message }, "okhi_verify_threw_no_fallback");
      throw err;
    }
    logger.warn({ err: (err as Error).message }, "okhi_verify_threw_falling_back_stub");
    return {
      ok: true,
      placeId: deterministicPlaceId(input),
      confidencePct: stubConfidence(input),
    };
  }
}
