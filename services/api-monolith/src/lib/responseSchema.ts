import type { Response } from "express";
import { logger } from "./logger";

/**
 * Minimal structural type covering the surface of a Zod schema we use here:
 * just `safeParse`. Keeping it structural means this helper does not need a
 * direct dependency on the `zod` package and can stay in the api-server
 * package without dragging another runtime in.
 */
type SafeParser<T> = {
  safeParse: (value: unknown) =>
    | { success: true; data: T }
    | { success: false; error: { issues: unknown[] } };
};

/**
 * Validate a response payload against the OpenAPI-generated Zod schema for
 * the route, then send it. If the payload drifts from the contract (a
 * field is renamed, removed, or returned with the wrong type), the request
 * fails with a 500 `response_contract_violation` instead of leaking the
 * broken shape to SPA clients that read the payload through the generated
 * types. The validated `data` is what gets serialised, so any extra fields
 * the handler accidentally added are stripped before they hit the wire.
 *
 * Returns `true` when the response was validated and sent, `false` when a
 * validation failure was reported. Callers do not need to inspect the
 * return value but it is occasionally useful in tests.
 */
export function sendValidated<T>(
  res: Response,
  schema: SafeParser<T>,
  payload: unknown,
  status: number = 200,
): boolean {
  const result = schema.safeParse(payload);
  if (!result.success) {
    logger.error(
      { issues: result.error.issues, status },
      "response_contract_violation",
    );
    res.status(500).json({
      error: "response_contract_violation",
      ...(process.env.NODE_ENV === "production"
        ? {}
        : { issues: result.error.issues }),
    });
    return false;
  }
  res.status(status).json(result.data);
  return true;
}
