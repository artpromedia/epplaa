import { createServer } from "node:http";
import { logger } from "./lib/logger";
import { assertRehearsalKillSwitchSafe } from "./routes/healthzRehearsal";

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
