import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const dbExecuteMock = vi.fn();
const pingRedisMock = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    execute: (...args: unknown[]) => dbExecuteMock(...args),
  },
}));

vi.mock("../middlewares/apiRateLimit", () => ({
  getRateLimitStoreKind: () => "redis",
  pingRateLimitRedis: (...args: unknown[]) => pingRedisMock(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    warn: () => {},
    error: () => {},
    info: () => {},
  },
}));

const { default: healthRouter } = await import("./health");

function buildApp(): Express {
  const app = express();
  app.use(healthRouter);
  return app;
}

beforeEach(() => {
  dbExecuteMock.mockReset();
  pingRedisMock.mockReset();
});

describe("GET /healthz (liveness)", () => {
  it("returns 200 with rateLimitStore kind even when dependencies are down", async () => {
    // Liveness should never reach the DB or Redis — verify by making
    // both mocks throw and asserting healthz still returns 200.
    dbExecuteMock.mockRejectedValue(new Error("nope"));
    pingRedisMock.mockResolvedValue({ ok: false, error: "nope" });
    const res = await request(buildApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", rateLimitStore: "redis" });
    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(pingRedisMock).not.toHaveBeenCalled();
  });
});

describe("GET /readyz (readiness)", () => {
  it("returns 200 ready when DB and Redis are reachable", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks).toEqual({ db: "ok", redis: "ok" });
    expect(res.body.failures).toBeUndefined();
    expect(res.body.rateLimitStore).toBe("redis");
  });

  it("returns 200 ready and skips Redis when memory store is configured", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks).toEqual({ db: "ok", redis: "skipped" });
  });

  it("returns 503 not_ready with failure detail when DB is unreachable", async () => {
    dbExecuteMock.mockRejectedValueOnce(new Error("ECONNREFUSED 5432"));
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.db).toBe("failed");
    expect(res.body.checks.redis).toBe("ok");
    expect(res.body.failures.db).toContain("ECONNREFUSED");
  });

  it("returns 503 not_ready with failure detail when Redis ping fails", async () => {
    dbExecuteMock.mockResolvedValueOnce({ rows: [] });
    pingRedisMock.mockResolvedValueOnce({
      ok: false,
      error: "redis_ping_timeout_after_2000ms",
    });
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.db).toBe("ok");
    expect(res.body.checks.redis).toBe("failed");
    expect(res.body.failures.redis).toBe("redis_ping_timeout_after_2000ms");
  });

  it("reports both dependencies as failed when DB and Redis are both down", async () => {
    dbExecuteMock.mockRejectedValueOnce(new Error("db gone"));
    pingRedisMock.mockResolvedValueOnce({ ok: false, error: "redis gone" });
    const res = await request(buildApp()).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ db: "failed", redis: "failed" });
    expect(res.body.failures).toEqual({
      db: expect.stringContaining("db gone"),
      redis: "redis gone",
    });
  });

  it("treats a hung DB query as a failure via timeout", async () => {
    process.env.READYZ_DB_TIMEOUT_MS = "50";
    vi.resetModules();
    const { default: freshRouter } = await import("./health");
    const app = express();
    app.use(freshRouter);
    dbExecuteMock.mockImplementationOnce(() => new Promise(() => {}));
    pingRedisMock.mockResolvedValueOnce({ ok: true });
    const res = await request(app).get("/readyz");
    delete process.env.READYZ_DB_TIMEOUT_MS;
    expect(res.status).toBe(503);
    expect(res.body.checks.db).toBe("failed");
    expect(res.body.failures.db).toMatch(/db_timeout_after_\d+ms/);
  });

  it("ignores a malformed READYZ_DB_TIMEOUT_MS and uses the safe default", async () => {
    // Without sanitisation, Number("not-a-number") -> NaN -> setTimeout
    // fires immediately on every call and turns every probe into a 503.
    // The route must fall back to the 2s default when the env value is
    // missing, NaN, zero, or negative.
    for (const bogus of ["not-a-number", "0", "-5", ""]) {
      process.env.READYZ_DB_TIMEOUT_MS = bogus;
      vi.resetModules();
      const { default: freshRouter } = await import("./health");
      const app = express();
      app.use(freshRouter);
      dbExecuteMock.mockResolvedValueOnce({ rows: [] });
      pingRedisMock.mockResolvedValueOnce({ ok: true });
      const res = await request(app).get("/readyz");
      expect(res.status, `bogus=${bogus}`).toBe(200);
      expect(res.body.checks.db).toBe("ok");
    }
    delete process.env.READYZ_DB_TIMEOUT_MS;
  });
});
