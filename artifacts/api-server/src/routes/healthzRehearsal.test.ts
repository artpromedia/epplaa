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
const { default: rehearsalRouter } = await import("./healthzRehearsal");
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
