import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

const injectStreakMock = vi.fn();
const resetMock = vi.fn();

vi.mock("../middlewares/apiRateLimit", () => ({
  __getRedisFailureWatcherForRehearsal: () => ({
    __injectStreak: (...args: unknown[]) => injectStreakMock(...args),
    __reset: () => resetMock(),
  }),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    warn: () => {},
    error: () => {},
    info: () => {},
  },
}));

const { dbHealthWatcher } = await import("../lib/subsystemHealth");
const {
  default: rehearsalRouter,
  assertRehearsalKillSwitchSafe,
  assertProductionHostnamePatternConfigured,
} = await import("./healthzRehearsal");
const { csrfMiddleware } = await import("../middlewares/csrf");

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(rehearsalRouter);
  return app;
}

const VALID_TOKEN = "rehearsal-token-very-long-value-1234567890";
const NOW = 1_700_000_000_000;

beforeEach(() => {
  injectStreakMock.mockReset();
  resetMock.mockReset();
  dbHealthWatcher.__reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.HEALTHZ_REHEARSAL_ENABLED;
  delete process.env.HEALTHZ_REHEARSAL_TOKEN;
});

describe("POST /_rehearsal/inject-stuck-degraded — kill switch", () => {
  it("returns 404 when HEALTHZ_REHEARSAL_ENABLED is unset (route invisible in production)", async () => {
    // Default: env unset. The endpoint must be invisible to anyone
    // scanning a production host so a leaked URL can't induce a real
    // page on the on-call channel.
    const res = await request(buildApp())
      .post("/_rehearsal/inject-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({ subsystem: "rateLimitStore", firstFailureAt: NOW - 1000 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect(injectStreakMock).not.toHaveBeenCalled();
  });

  it("returns 404 when HEALTHZ_REHEARSAL_ENABLED is anything other than '1'", async () => {
    // Belt-and-braces — a typo like "true" or "yes" must NOT enable
    // the route. Only the literal string "1" opts in.
    for (const bogus of ["true", "yes", "on", "0", " 1 ", "1 "]) {
      process.env.HEALTHZ_REHEARSAL_ENABLED = bogus;
      process.env.HEALTHZ_REHEARSAL_TOKEN = VALID_TOKEN;
      const res = await request(buildApp())
        .post("/_rehearsal/inject-stuck-degraded")
        .set("X-Rehearsal-Token", VALID_TOKEN)
        .send({ subsystem: "rateLimitStore", firstFailureAt: NOW - 1000 });
      expect(res.status, `bogus=${bogus}`).toBe(404);
    }
  });
});

describe("POST /_rehearsal/inject-stuck-degraded — token gate", () => {
  beforeEach(() => {
    process.env.HEALTHZ_REHEARSAL_ENABLED = "1";
    process.env.HEALTHZ_REHEARSAL_TOKEN = VALID_TOKEN;
  });

  it("returns 401 when X-Rehearsal-Token header is missing", async () => {
    const res = await request(buildApp())
      .post("/_rehearsal/inject-stuck-degraded")
      .send({ subsystem: "rateLimitStore", firstFailureAt: NOW - 1000 });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    expect(injectStreakMock).not.toHaveBeenCalled();
  });

  it("returns 401 when X-Rehearsal-Token does not match", async () => {
    const res = await request(buildApp())
      .post("/_rehearsal/inject-stuck-degraded")
      .set("X-Rehearsal-Token", "wrong-token")
      .send({ subsystem: "rateLimitStore", firstFailureAt: NOW - 1000 });
    expect(res.status).toBe(401);
    expect(injectStreakMock).not.toHaveBeenCalled();
  });

  it("returns 401 when token has same prefix but wrong length (not a substring match)", async () => {
    // Substring-equality bugs are a classic auth pitfall. The handler
    // uses timingSafeEqual which requires equal lengths — verify a
    // truncated token is rejected even though it shares a prefix.
    const res = await request(buildApp())
      .post("/_rehearsal/inject-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN.slice(0, 10))
      .send({ subsystem: "rateLimitStore", firstFailureAt: NOW - 1000 });
    expect(res.status).toBe(401);
    expect(injectStreakMock).not.toHaveBeenCalled();
  });

  it("returns 503 when enabled but server is misconfigured (no token)", async () => {
    // If someone flips HEALTHZ_REHEARSAL_ENABLED on a host that
    // doesn't have HEALTHZ_REHEARSAL_TOKEN set, the safe behaviour
    // is to refuse the request, not to wave it through.
    delete process.env.HEALTHZ_REHEARSAL_TOKEN;
    const res = await request(buildApp())
      .post("/_rehearsal/inject-stuck-degraded")
      .set("X-Rehearsal-Token", "anything")
      .send({ subsystem: "rateLimitStore", firstFailureAt: NOW - 1000 });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("rehearsal_misconfigured");
    expect(injectStreakMock).not.toHaveBeenCalled();
  });
});

describe("POST /_rehearsal/inject-stuck-degraded — body validation", () => {
  beforeEach(() => {
    process.env.HEALTHZ_REHEARSAL_ENABLED = "1";
    process.env.HEALTHZ_REHEARSAL_TOKEN = VALID_TOKEN;
  });

  it("rejects an unknown subsystem", async () => {
    const res = await request(buildApp())
      .post("/_rehearsal/inject-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({ subsystem: "audit_chain", firstFailureAt: NOW - 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_subsystem");
    expect(injectStreakMock).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric firstFailureAt", async () => {
    for (const bad of [undefined, null, "not-a-number", NaN]) {
      const res = await request(buildApp())
        .post("/_rehearsal/inject-stuck-degraded")
        .set("X-Rehearsal-Token", VALID_TOKEN)
        .send({ subsystem: "rateLimitStore", firstFailureAt: bad });
      expect(res.status, `bad=${String(bad)}`).toBe(400);
      expect(res.body.error).toBe("invalid_firstFailureAt");
    }
    expect(injectStreakMock).not.toHaveBeenCalled();
  });

  it("rejects a future firstFailureAt so the rehearsal never silently fails to page", async () => {
    // A future timestamp would clamp to durationMs=0 in the probe and
    // exit 0 — the rehearsal would falsely "pass" while testing
    // nothing. Reject up front instead.
    const res = await request(buildApp())
      .post("/_rehearsal/inject-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({ subsystem: "rateLimitStore", firstFailureAt: NOW + 60_000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_firstFailureAt");
    expect(res.body.detail).toMatch(/in the past/);
    expect(injectStreakMock).not.toHaveBeenCalled();
  });
});

describe("POST /_rehearsal/inject-stuck-degraded — happy paths", () => {
  beforeEach(() => {
    process.env.HEALTHZ_REHEARSAL_ENABLED = "1";
    process.env.HEALTHZ_REHEARSAL_TOKEN = VALID_TOKEN;
  });

  it("seeds the rate-limit watcher and echoes the computed durationMs", async () => {
    const firstFailureAt = NOW - 600_000; // 10 minutes ago
    const res = await request(buildApp())
      .post("/_rehearsal/inject-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({
        subsystem: "rateLimitStore",
        firstFailureAt,
        failureCount: 7,
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "injected",
      subsystem: "rateLimitStore",
      firstFailureAt,
      failureCount: 7,
      durationMs: 600_000,
    });
    expect(injectStreakMock).toHaveBeenCalledWith(firstFailureAt, 7);
  });

  it("seeds the db watcher and reflects in the dbHealthWatcher snapshot", async () => {
    // db is not mocked — we route through the real
    // SubsystemFailureWatcher and assert via getSnapshot so the
    // round-trip into /healthz is exercised end-to-end.
    const firstFailureAt = NOW - 7 * 60 * 1000; // 7 minutes
    const res = await request(buildApp())
      .post("/_rehearsal/inject-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({ subsystem: "db", firstFailureAt, failureCount: 3 });
    expect(res.status).toBe(200);
    const snap = dbHealthWatcher.getSnapshot();
    expect(snap.state).toBe("degraded");
    expect(snap.firstFailureAt).toBe(firstFailureAt);
    expect(snap.failureCount).toBe(3);
  });

  it("defaults failureCount to 1 when omitted or non-positive", async () => {
    for (const fc of [undefined, 0, -5, "nope"]) {
      const res = await request(buildApp())
        .post("/_rehearsal/inject-stuck-degraded")
        .set("X-Rehearsal-Token", VALID_TOKEN)
        .send({
          subsystem: "rateLimitStore",
          firstFailureAt: NOW - 1_000,
          failureCount: fc,
        });
      expect(res.status, `fc=${String(fc)}`).toBe(200);
      expect(res.body.failureCount).toBe(1);
    }
  });
});

describe("POST /_rehearsal/clear-stuck-degraded", () => {
  beforeEach(() => {
    process.env.HEALTHZ_REHEARSAL_ENABLED = "1";
    process.env.HEALTHZ_REHEARSAL_TOKEN = VALID_TOKEN;
  });

  it("returns 404 with kill switch off so production cleanup can't resurrect a forgotten rehearsal", async () => {
    delete process.env.HEALTHZ_REHEARSAL_ENABLED;
    const res = await request(buildApp())
      .post("/_rehearsal/clear-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({ subsystem: "rateLimitStore" });
    expect(res.status).toBe(404);
  });

  it("clears the rate-limit watcher", async () => {
    const res = await request(buildApp())
      .post("/_rehearsal/clear-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({ subsystem: "rateLimitStore" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "cleared", subsystem: "rateLimitStore" });
    expect(resetMock).toHaveBeenCalledOnce();
  });

  it("clears the db watcher (round-trip with inject seeds then clear restores healthy)", async () => {
    // Exercise the full inject -> clear cycle the rehearsal workflow
    // performs, asserting via the real watcher snapshot. After clear,
    // the snapshot must return to its pre-rehearsal `healthy` state
    // so we don't leave staging falsely degraded.
    await request(buildApp())
      .post("/_rehearsal/inject-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({ subsystem: "db", firstFailureAt: NOW - 600_000 });
    expect(dbHealthWatcher.getSnapshot().state).toBe("degraded");

    const res = await request(buildApp())
      .post("/_rehearsal/clear-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({ subsystem: "db" });
    expect(res.status).toBe(200);
    expect(dbHealthWatcher.getSnapshot()).toEqual({
      state: "healthy",
      failureCount: 0,
      firstFailureAt: null,
      lastRecoveredAt: null,
    });
  });

  it("rejects an unknown subsystem on clear", async () => {
    const res = await request(buildApp())
      .post("/_rehearsal/clear-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({ subsystem: "audit_chain" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_subsystem");
    expect(resetMock).not.toHaveBeenCalled();
  });
});

// Integration: full app middleware stack
//
// The route handler-level tests above mount only the rehearsal router,
// which means they do NOT exercise the global CSRF middleware. The
// rehearsal endpoints are mutating POSTs called by a GitHub Actions
// cron with no browser cookies — so without an explicit CSRF
// exemption, every workflow run would 403 before the in-handler token
// guard could run, and the rehearsal would never reach the probe step.
//
// This block stands up an Express app that mirrors the real app.ts
// middleware ordering for the parts that affect the rehearsal path:
// cookie-parser -> express.json -> csrfMiddleware -> mounted under
// the same /api prefix as production. It then asserts the rehearsal
// endpoints are reachable through the CSRF guard, and that the
// in-handler token guard still runs on top.
function buildAppWithCsrf(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(csrfMiddleware());
  app.use("/api", rehearsalRouter);
  return app;
}

describe("integration: rehearsal endpoints behind real CSRF middleware", () => {
  beforeEach(() => {
    process.env.HEALTHZ_REHEARSAL_ENABLED = "1";
    process.env.HEALTHZ_REHEARSAL_TOKEN = VALID_TOKEN;
  });

  it("CSRF middleware must NOT block /api/_rehearsal/* (no cookie, no header) — workflow has no browser session", async () => {
    // The GitHub Actions cron sends no csrf_token cookie and no
    // X-CSRF-Token header. If the middleware blocked us here we'd
    // return 403 csrf_failed and the rehearsal would silently never
    // reach the probe step. Asserting the request makes it through
    // the CSRF layer (and then succeeds against the rehearsal token
    // guard) is exactly the regression check.
    const res = await request(buildAppWithCsrf())
      .post("/api/_rehearsal/inject-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({
        subsystem: "rateLimitStore",
        firstFailureAt: NOW - 600_000,
        failureCount: 3,
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("injected");
    expect(injectStreakMock).toHaveBeenCalled();
  });

  it("the in-handler X-Rehearsal-Token guard still rejects unauthenticated requests through the CSRF exemption", async () => {
    // CSRF exemption must not become a backdoor: requests that
    // bypass CSRF still need to satisfy the rehearsal token guard.
    // Without this assertion, a future change that accidentally
    // dropped the token check would only be caught by the
    // route-level tests above, which can't tell apart "route
    // exempt from CSRF" from "route reachable at all".
    const res = await request(buildAppWithCsrf())
      .post("/api/_rehearsal/inject-stuck-degraded")
      .send({
        subsystem: "rateLimitStore",
        firstFailureAt: NOW - 600_000,
      });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    expect(injectStreakMock).not.toHaveBeenCalled();
  });

  it("clear endpoint is also exempt from CSRF so the always-run cleanup step can succeed", async () => {
    // The workflow's `if: ${{ always() }}` cleanup step has the same
    // no-cookie shape as the inject step. If the clear endpoint
    // weren't also CSRF-exempt, a successful inject + probe would
    // be followed by a 403'd clear, leaving staging in a synthetic
    // degraded state (which would then cause the per-minute probe
    // workflow to start paging on-call for real).
    const res = await request(buildAppWithCsrf())
      .post("/api/_rehearsal/clear-stuck-degraded")
      .set("X-Rehearsal-Token", VALID_TOKEN)
      .send({ subsystem: "rateLimitStore" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cleared");
  });

  it("a sibling /api/* mutating route still requires CSRF (proves the exemption is scoped, not a blanket bypass)", async () => {
    // Defence-in-depth check: if someone widened the EXEMPT_PATH_PREFIXES
    // entry from /api/_rehearsal to /api or /, every mutating route
    // in the app would suddenly be CSRF-free. Mount a dummy POST at
    // a non-rehearsal path, confirm the middleware still 403s it.
    const app = buildAppWithCsrf();
    app.post("/api/non-rehearsal-mutation", (_req, res) => {
      res.json({ ok: true });
    });
    const res = await request(app)
      .post("/api/non-rehearsal-mutation")
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_failed");
  });
});

describe("assertRehearsalKillSwitchSafe — boot-time guard", () => {
  // The boot-time guard turns the runbook's "enable on staging only -
  // never production" sentence into a technical control: if the env
  // ever drifts (e.g. a copy-paste of staging env vars into a prod
  // deploy), the api-server refuses to start instead of silently
  // exposing /api/_rehearsal/inject-stuck-degraded. We verify both the
  // staging-allowed path (must not block) and the production-rejected
  // path (must block + log a clear error explaining why).

  type ErrorCall = [obj: unknown, msg: string];
  function buildLogSink(): {
    error: (obj: unknown, msg: string) => void;
    calls: ErrorCall[];
  } {
    const calls: ErrorCall[] = [];
    return {
      error: (obj, msg) => {
        calls.push([obj, msg]);
      },
      calls,
    };
  }

  it("allows boot when HEALTHZ_REHEARSAL_ENABLED=1 in a non-production environment (staging)", () => {
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      { NODE_ENV: "staging", HEALTHZ_REHEARSAL_ENABLED: "1" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("allows boot when HEALTHZ_REHEARSAL_ENABLED=1 with NODE_ENV=development", () => {
    // Local-dev parity with staging — the kill switch is allowed
    // anywhere that isn't literally NODE_ENV=production.
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      { NODE_ENV: "development", HEALTHZ_REHEARSAL_ENABLED: "1" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("allows boot in production when HEALTHZ_REHEARSAL_ENABLED is unset (the common, correct case)", () => {
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("allows boot in production when HEALTHZ_REHEARSAL_ENABLED is anything other than '1'", () => {
    // Mirrors the request-time guard: only the literal "1" trips the
    // boot guard, so a leftover `HEALTHZ_REHEARSAL_ENABLED=0` doesn't
    // block legitimate prod deploys.
    const log = buildLogSink();
    for (const bogus of ["0", "true", "false", "yes", "no", "on", "off", " 1 "]) {
      const result = assertRehearsalKillSwitchSafe(
        { NODE_ENV: "production", HEALTHZ_REHEARSAL_ENABLED: bogus },
        log,
      );
      expect(result.ok, `bogus=${bogus}`).toBe(true);
    }
    expect(log.calls).toEqual([]);
  });

  it("REJECTS boot when HEALTHZ_REHEARSAL_ENABLED=1 with NODE_ENV=production", () => {
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      { NODE_ENV: "production", HEALTHZ_REHEARSAL_ENABLED: "1" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The error message must be actionable enough that an operator
    // reading the crash log knows exactly which env var to unset and
    // where to read more.
    expect(result.reason).toMatch(/HEALTHZ_REHEARSAL_ENABLED/);
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/staging-only/i);
    expect(result.reason).toMatch(/runbook|rate-limit-store/i);

    // The structured log must surface the offending env so the
    // pager-page recipient can confirm the misconfiguration without
    // shelling onto the box.
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    expect(obj).toMatchObject({
      node_env: "production",
      healthz_rehearsal_enabled: "1",
      production_signals: ["node_env"],
    });
    expect(msg).toMatch(/healthz_rehearsal_kill_switch_on_in_production/);
  });

  // ---------------------------------------------------------------
  // Hostname / region / deployment-env backstops (task #81).
  //
  // The original guard only fired on NODE_ENV=production. A
  // misconfigured deploy that runs with NODE_ENV=staging (or unset)
  // AND HEALTHZ_REHEARSAL_ENABLED=1 would silently expose the
  // injector even though the host is reachable as production. These
  // tests exercise the additional production signals: an
  // operator-configured production-hostname regex, the platform-set
  // REPLIT_DEPLOYMENT flag, and a generic DEPLOYMENT_ENVIRONMENT
  // env var.
  // ---------------------------------------------------------------

  it("allows boot on a staging hostname when PRODUCTION_HOSTNAME_PATTERN is configured", () => {
    // The hostname check is opt-in: an operator configures the
    // regex of *production* hostnames, and any host that doesn't
    // match (e.g. staging) is allowed. Verify a staging hostname is
    // not falsely tripped by a well-formed pattern.
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      {
        NODE_ENV: "staging",
        HEALTHZ_REHEARSAL_ENABLED: "1",
        HOSTNAME: "api.staging.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("REJECTS boot when HOSTNAME matches PRODUCTION_HOSTNAME_PATTERN even with NODE_ENV unset", () => {
    // The whole point of the hostname backstop: NODE_ENV is unset
    // (or "staging") yet the host is the real production host. The
    // guard must still fire because the injector would be reachable
    // on a real production URL.
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      {
        HEALTHZ_REHEARSAL_ENABLED: "1",
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/HOSTNAME=api\.epplaa\.com/);
    expect(result.reason).toMatch(/PRODUCTION_HOSTNAME_PATTERN/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      hostname: "api.epplaa.com",
      production_signals: ["hostname"],
    });
  });

  it("REJECTS boot when HOSTNAME matches PRODUCTION_HOSTNAME_PATTERN even with NODE_ENV=staging (operator typo backstop)", () => {
    // The most adversarial case for a pure NODE_ENV check: a deploy
    // that's been mislabelled NODE_ENV=staging (e.g. someone typo'd
    // the env file during a rotation) but is actually serving the
    // production host. The hostname signal must still trip the guard.
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      {
        NODE_ENV: "staging",
        HEALTHZ_REHEARSAL_ENABLED: "1",
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(result.ok).toBe(false);
  });

  it("hostname check is a no-op when PRODUCTION_HOSTNAME_PATTERN is unset (existing deploys keep working without configuration)", () => {
    // Backwards-compat: a deploy that hasn't (yet) configured the
    // hostname pattern must not start failing — it only opts in to
    // the extra check by setting the env var.
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      {
        NODE_ENV: "staging",
        HEALTHZ_REHEARSAL_ENABLED: "1",
        HOSTNAME: "api.epplaa.com",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("hostname check tolerates a missing HOSTNAME env var", () => {
    // Some container runtimes don't set HOSTNAME. The check must
    // not throw — it should just skip the hostname signal and rely
    // on the other signals.
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      {
        NODE_ENV: "staging",
        HEALTHZ_REHEARSAL_ENABLED: "1",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("logs an error and disables the hostname check when PRODUCTION_HOSTNAME_PATTERN is an invalid regex", () => {
    // A typo in the regex (unbalanced bracket) shouldn't crash a
    // legitimate boot — but we MUST surface the misconfiguration
    // because it silently disables a defense-in-depth layer the
    // operator thought they had configured.
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      {
        NODE_ENV: "staging",
        HEALTHZ_REHEARSAL_ENABLED: "1",
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "[invalid(regex",
      },
      log,
    );
    expect(result.ok).toBe(true);
    // One error-level log surfaces the bad pattern; nothing else.
    expect(log.calls).toHaveLength(1);
    const [, msg] = log.calls[0]!;
    expect(msg).toMatch(/production_hostname_pattern_invalid/);
  });

  it("REJECTS boot when REPLIT_DEPLOYMENT=1 (Replit production deployment signal)", () => {
    // The Replit platform sets REPLIT_DEPLOYMENT=1 on production
    // deployments (vs. dev workspaces). Even if NODE_ENV is unset
    // the guard must trip on this signal alone.
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      {
        HEALTHZ_REHEARSAL_ENABLED: "1",
        REPLIT_DEPLOYMENT: "1",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/REPLIT_DEPLOYMENT=1/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      replit_deployment: "1",
      production_signals: ["replit_deployment"],
    });
  });

  it("allows boot when REPLIT_DEPLOYMENT is anything other than '1' (dev workspace)", () => {
    // In a Replit dev workspace REPLIT_DEPLOYMENT is unset or "0".
    // Only the literal "1" trips the signal.
    const log = buildLogSink();
    for (const bogus of [undefined, "", "0", "true", "yes"]) {
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: "development",
        HEALTHZ_REHEARSAL_ENABLED: "1",
      };
      if (bogus !== undefined) env.REPLIT_DEPLOYMENT = bogus;
      const result = assertRehearsalKillSwitchSafe(env, log);
      expect(result.ok, `bogus=${String(bogus)}`).toBe(true);
    }
    expect(log.calls).toEqual([]);
  });

  it("REJECTS boot when DEPLOYMENT_ENVIRONMENT=production", () => {
    // Generic deployment-env env var that some IaC stacks set
    // independently of NODE_ENV. Trips the guard on its own.
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      {
        HEALTHZ_REHEARSAL_ENABLED: "1",
        DEPLOYMENT_ENVIRONMENT: "production",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/DEPLOYMENT_ENVIRONMENT=production/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      deployment_environment: "production",
      production_signals: ["deployment_environment"],
    });
  });

  it("allows boot when DEPLOYMENT_ENVIRONMENT is staging/preview/etc (not production)", () => {
    const log = buildLogSink();
    for (const value of ["staging", "preview", "development", "qa", ""]) {
      const result = assertRehearsalKillSwitchSafe(
        {
          NODE_ENV: "staging",
          HEALTHZ_REHEARSAL_ENABLED: "1",
          DEPLOYMENT_ENVIRONMENT: value,
        },
        log,
      );
      expect(result.ok, `value=${value}`).toBe(true);
    }
    expect(log.calls).toEqual([]);
  });

  it("aggregates multiple production signals into a single structured log so on-call sees every offender at once", () => {
    // If more than one signal is true (e.g. NODE_ENV=production AND
    // REPLIT_DEPLOYMENT=1 AND hostname matches), the guard must list
    // ALL of them in one error so the operator doesn't have to
    // re-deploy and re-fail to discover the next signal.
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      {
        NODE_ENV: "production",
        HEALTHZ_REHEARSAL_ENABLED: "1",
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
        REPLIT_DEPLOYMENT: "1",
        DEPLOYMENT_ENVIRONMENT: "production",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/REPLIT_DEPLOYMENT=1/);
    expect(result.reason).toMatch(/DEPLOYMENT_ENVIRONMENT=production/);
    expect(result.reason).toMatch(/HOSTNAME=api\.epplaa\.com/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      production_signals: [
        "node_env",
        "replit_deployment",
        "deployment_environment",
        "hostname",
      ],
    });
  });

  it("kill switch off short-circuits all signal detection (no log spam for healthy production deploys)", () => {
    // The common case: a real production deploy with every
    // production signal lit but HEALTHZ_REHEARSAL_ENABLED unset.
    // The guard must return ok with no log output — otherwise every
    // production boot would emit an error line about the rehearsal
    // injector, which is just noise.
    const log = buildLogSink();
    const result = assertRehearsalKillSwitchSafe(
      {
        NODE_ENV: "production",
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
        REPLIT_DEPLOYMENT: "1",
        DEPLOYMENT_ENVIRONMENT: "production",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });
});

describe("assertProductionHostnamePatternConfigured — production hostname pattern presence check", () => {
  // The hostname signal in `assertRehearsalKillSwitchSafe` is the
  // strongest backstop against a copy-pasted staging env file ending
  // up on a production deploy — but it's silently disabled if no
  // operator ever set `PRODUCTION_HOSTNAME_PATTERN`. The runbook
  // recommends configuring it on production deploys; this check turns
  // that recommendation into an automated boot-time signal so a
  // misconfigured deploy shows up in log aggregators / Sentry within
  // minutes instead of the next real outage.
  //
  // The check intentionally determines production-ness via the OTHER
  // production signals (NODE_ENV / REPLIT_DEPLOYMENT /
  // DEPLOYMENT_ENVIRONMENT) — using the hostname pattern itself would
  // be circular.

  type WarnCall = [obj: unknown, msg: string];
  function buildWarnSink(): {
    warn: (obj: unknown, msg: string) => void;
    calls: WarnCall[];
  } {
    const calls: WarnCall[] = [];
    return {
      warn: (obj, msg) => {
        calls.push([obj, msg]);
      },
      calls,
    };
  }

  it("does nothing on a non-production deploy (staging) with no hostname pattern set", () => {
    // The pattern is optional on staging — the check must not warn,
    // otherwise every staging boot would emit noise about a
    // production-only configuration.
    const log = buildWarnSink();
    const result = assertProductionHostnamePatternConfigured(
      { NODE_ENV: "staging" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a development deploy", () => {
    // Local dev parity — never warn outside production-shaped envs.
    const log = buildWarnSink();
    const result = assertProductionHostnamePatternConfigured(
      { NODE_ENV: "development" },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("does nothing on a Replit dev workspace (REPLIT_DEPLOYMENT unset/0) with no pattern", () => {
    // REPLIT_DEPLOYMENT=0 / unset means "Replit dev workspace, not a
    // production deployment" — the pattern is not required.
    const log = buildWarnSink();
    for (const value of [undefined, "", "0", "true"]) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
      if (value !== undefined) env.REPLIT_DEPLOYMENT = value;
      const result = assertProductionHostnamePatternConfigured(env, log);
      expect(result.ok, `value=${String(value)}`).toBe(true);
    }
    expect(log.calls).toEqual([]);
  });

  it("WARNS when NODE_ENV=production and PRODUCTION_HOSTNAME_PATTERN is unset", () => {
    // The original task case: a production-shaped deploy ships
    // without the hostname backstop configured. The check must
    // surface a loud structured warning so an operator notices
    // before the next real outage proves the layer was missing.
    const log = buildWarnSink();
    const result = assertProductionHostnamePatternConfigured(
      { NODE_ENV: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/PRODUCTION_HOSTNAME_PATTERN/);
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/runbook|rate-limit-store/i);
    expect(log.calls).toHaveLength(1);
    const [obj, msg] = log.calls[0]!;
    // The structured log must surface the offending env vars so an
    // operator reading a Sentry warning can confirm the
    // misconfiguration without shelling onto the box.
    expect(obj).toMatchObject({
      node_env: "production",
      production_hostname_pattern: null,
      production_signals: ["node_env"],
    });
    // Dedicated message identifier so log aggregators / Sentry
    // alerts can be wired up exactly to this event.
    expect(msg).toMatch(/production_hostname_pattern_missing/);
  });

  it("WARNS when REPLIT_DEPLOYMENT=1 alone triggers production-shape detection", () => {
    // A deploy with NODE_ENV unset / staging but the Replit platform
    // marker set is still production-shaped. The hostname pattern is
    // still required for the backstop layer.
    const log = buildWarnSink();
    const result = assertProductionHostnamePatternConfigured(
      { REPLIT_DEPLOYMENT: "1" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/REPLIT_DEPLOYMENT=1/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      replit_deployment: "1",
      production_signals: ["replit_deployment"],
    });
  });

  it("WARNS when DEPLOYMENT_ENVIRONMENT=production alone triggers production-shape detection", () => {
    const log = buildWarnSink();
    const result = assertProductionHostnamePatternConfigured(
      { DEPLOYMENT_ENVIRONMENT: "production" },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/DEPLOYMENT_ENVIRONMENT=production/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      deployment_environment: "production",
      production_signals: ["deployment_environment"],
    });
  });

  it("aggregates every production signal into a single warning so on-call sees them all at once", () => {
    // If multiple signals are lit, the warning must list every one
    // — otherwise an operator who fixes the first signal would have
    // to redeploy and re-read logs to discover the next.
    const log = buildWarnSink();
    const result = assertProductionHostnamePatternConfigured(
      {
        NODE_ENV: "production",
        REPLIT_DEPLOYMENT: "1",
        DEPLOYMENT_ENVIRONMENT: "production",
      },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/NODE_ENV=production/);
    expect(result.reason).toMatch(/REPLIT_DEPLOYMENT=1/);
    expect(result.reason).toMatch(/DEPLOYMENT_ENVIRONMENT=production/);
    expect(log.calls).toHaveLength(1);
    const [obj] = log.calls[0]!;
    expect(obj).toMatchObject({
      production_signals: [
        "node_env",
        "replit_deployment",
        "deployment_environment",
      ],
    });
  });

  it("does NOT warn when PRODUCTION_HOSTNAME_PATTERN is configured on a production deploy (the healthy path)", () => {
    // The common, correct case: a real production deploy with the
    // hostname backstop configured. Must return ok with zero log
    // output — the check is meant to be silent on a healthy boot.
    const log = buildWarnSink();
    const result = assertProductionHostnamePatternConfigured(
      {
        NODE_ENV: "production",
        REPLIT_DEPLOYMENT: "1",
        DEPLOYMENT_ENVIRONMENT: "production",
        HOSTNAME: "api.epplaa.com",
        PRODUCTION_HOSTNAME_PATTERN: "^api\\.epplaa\\.com$",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("treats a whitespace-only PRODUCTION_HOSTNAME_PATTERN as missing", () => {
    // A pattern that's just spaces / tabs is functionally unset —
    // `compileHostnamePattern` ignores it and the hostname signal is
    // silently disabled. Surface it the same way as a missing var.
    const log = buildWarnSink();
    for (const value of [" ", "  ", "\t", "\n"]) {
      const result = assertProductionHostnamePatternConfigured(
        {
          NODE_ENV: "production",
          PRODUCTION_HOSTNAME_PATTERN: value,
        },
        log,
      );
      expect(result.ok, `value=${JSON.stringify(value)}`).toBe(false);
    }
    expect(log.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("treats an empty-string PRODUCTION_HOSTNAME_PATTERN as missing", () => {
    // Equivalent to unset for the purposes of the hostname check —
    // surface it as a missing-config warning rather than silently
    // accepting it.
    const log = buildWarnSink();
    const result = assertProductionHostnamePatternConfigured(
      {
        NODE_ENV: "production",
        PRODUCTION_HOSTNAME_PATTERN: "",
      },
      log,
    );
    expect(result.ok).toBe(false);
  });

  it("does NOT re-validate the regex (malformed-pattern logging is owned by compileHostnamePattern)", () => {
    // A typo in the regex (e.g. unbalanced bracket) is already logged
    // by compileHostnamePattern as `healthz_rehearsal_invalid_hostname_pattern`
    // when assertRehearsalKillSwitchSafe runs. Re-emitting a warning
    // here would be duplicate noise. From the perspective of THIS
    // check, "operator set the env var" is enough — the malformed-
    // regex log is the actionable signal.
    const log = buildWarnSink();
    const result = assertProductionHostnamePatternConfigured(
      {
        NODE_ENV: "production",
        PRODUCTION_HOSTNAME_PATTERN: "[invalid(regex",
      },
      log,
    );
    expect(result.ok).toBe(true);
    expect(log.calls).toEqual([]);
  });

  it("ignores REPLIT_DEPLOYMENT values other than the literal '1'", () => {
    // Mirrors the kill-switch guard's strictness — only the literal
    // "1" trips the production-deployment signal.
    const log = buildWarnSink();
    for (const bogus of ["0", "true", "false", "yes", " 1 "]) {
      const result = assertProductionHostnamePatternConfigured(
        { REPLIT_DEPLOYMENT: bogus },
        log,
      );
      expect(result.ok, `bogus=${bogus}`).toBe(true);
    }
    expect(log.calls).toEqual([]);
  });

  it("ignores DEPLOYMENT_ENVIRONMENT values other than the literal 'production'", () => {
    // Mirrors the kill-switch guard: only the lowercase literal
    // matches. Casing drift (e.g. "Production", "PROD") is the
    // operator's responsibility to normalise upstream.
    const log = buildWarnSink();
    for (const value of ["staging", "preview", "Production", "PROD", "qa"]) {
      const result = assertProductionHostnamePatternConfigured(
        { DEPLOYMENT_ENVIRONMENT: value },
        log,
      );
      expect(result.ok, `value=${value}`).toBe(true);
    }
    expect(log.calls).toEqual([]);
  });
});
