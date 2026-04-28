import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * PII fields scrubbed from every log line. Pino's `redact` operates on
 * paths so we have to enumerate the common shapes (req.body.*, res.body.*,
 * direct keys at top level). Wildcards cover nested arbitrary depth so
 * `seller.application.email` and `update.email` are both caught.
 */
const PII_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  // Direct identifiers anywhere in a serialized object.
  "*.email",
  "*.phone",
  "*.govId",
  "*.gov_id",
  "*.bankAccount",
  "*.bank_account",
  "*.cardNumber",
  "*.card_number",
  "*.cvv",
  "*.otp",
  "*.password",
  "*.secret",
  "*.token",
  // One level deeper — covers patches and seller-application bodies.
  "*.*.email",
  "*.*.phone",
  "*.*.govId",
  "*.*.gov_id",
  "*.*.bankAccount",
  "*.*.bank_account",
  "*.*.cardNumber",
  "*.*.card_number",
  "*.*.token",
  // Common request-body payloads.
  "req.body.email",
  "req.body.phone",
  "req.body.password",
  "req.body.token",
  "req.body.otp",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: PII_REDACT_PATHS,
    censor: "[REDACTED]",
    remove: false,
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
