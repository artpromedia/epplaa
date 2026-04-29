import { createServer } from "node:http";
import { logger } from "./lib/logger";
import { assertRateLimitStoreConfiguredForProduction } from "./middlewares/apiRateLimit";
import {
  assertProductionHostnamePatternConfigured,
  assertRehearsalKillSwitchSafe,
} from "./routes/healthzRehearsal";

// Defense-in-depth: refuse to boot if the staging-only rehearsal
// injector kill switch (HEALTHZ_REHEARSAL_ENABLED=1) is observed in a
// production environment. The route itself is also gated at request
// time, but a copy-paste of staging env vars into production would
// silently expose `/api/_rehearsal/inject-stuck-degraded` and let a
// leaked URL page real on-call. Failing fast here turns a process
// control into a technical control. See
// `docs/runbooks/rate-limit-store.md` (boot-time guard).
//
// IMPORTANT: this check runs before importing `./app` and
// `./lib/socket`. Importing `./app` triggers schema-init and
// scheduler side effects (initAuditChain / initAdminSchema /
// initManufacturerSchema, etc. — see `src/app.ts`). Running the
// guard first means a misconfigured production deploy fails fast
// without spinning up DB/scheduler work it shouldn't be doing.
const rehearsalGuard = assertRehearsalKillSwitchSafe(process.env, logger);
if (!rehearsalGuard.ok) {
  process.exit(1);
}

// Boot-time sanity check (task #84): on production-shaped deploys
// (NODE_ENV=production / REPLIT_DEPLOYMENT=1 / DEPLOYMENT_ENVIRONMENT=production),
// warn loudly if PRODUCTION_HOSTNAME_PATTERN is missing. The hostname
// signal in `assertRehearsalKillSwitchSafe` is the strongest backstop
// against a copy-pasted staging env into production, but it's silently
// absent if no operator ever configured the regex. The runbook
// recommends setting it; this check turns that recommendation into an
// automated boot-time signal so the misconfiguration shows up in
// log aggregators / Sentry instead of waiting for a real outage. The
// outcome is intentionally NOT used to abort boot — the other guard
// layers above still work without the hostname backstop, and crash-
// looping every existing production deploy that never set this env
// var would be more disruptive than the marginal security gain.
assertProductionHostnamePatternConfigured(process.env, logger);

// Boot-time sanity check (task #87): on production-shaped deploys
// (NODE_ENV=production / REPLIT_DEPLOYMENT=1 / DEPLOYMENT_ENVIRONMENT=production),
// warn loudly if RATE_LIMIT_STORE is unset / "memory". The runbook
// (`docs/runbooks/rate-limit-store.md`) explicitly says
// `RATE_LIMIT_STORE=redis` is required for any deploy with more than
// one api-server replica — the in-process bucket is replica-local, so
// each replica owns its own counters and the per-tier rate limit is
// trivially bypassed by spreading traffic across replicas. The check
// turns the runbook recommendation into an automated boot-time signal
// so the misconfiguration shows up in log aggregators / Sentry within
// minutes of the next deploy. Like the hostname-pattern check above,
// the outcome is intentionally NOT used to abort boot — single-replica
// production deploys legitimately run on the in-process bucket and
// crash-looping every existing deploy that hasn't wired Redis would
// be more disruptive than the marginal security gain.
assertRateLimitStoreConfiguredForProduction(process.env, logger);

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Defer importing `app` and `socket` until after the guard has
// passed so importing them (and the schema/scheduler side effects in
// `app.ts`) never happens on a misconfigured production deploy.
const { default: app } = await import("./app");
const { bootstrapSocketServer } = await import("./lib/socket");

// Use a manual http.Server so Socket.IO can attach to the same port.
const httpServer = createServer(app);
bootstrapSocketServer(httpServer);

httpServer.listen(port, () => {
  logger.info({ port }, "Server listening");
});

httpServer.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
