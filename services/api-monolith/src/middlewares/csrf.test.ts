import { describe, it, expect } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { csrfMiddleware, csrfTokenIssuer, __test__ } from "./csrf";

function buildApp(): express.Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.get("/api/csrf-token", csrfTokenIssuer);
  app.use(csrfMiddleware());
  app.post("/api/echo", (req, res) => {
    res.json({ ok: true, body: req.body });
  });
  app.get("/api/echo", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("csrf double-submit", () => {
  it("issues a token on /api/csrf-token", async () => {
    const app = buildApp();
    const r = await request(app).get("/api/csrf-token");
    expect(r.status).toBe(200);
    expect(r.body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(r.headers["set-cookie"]?.[0]).toMatch(/csrf_token=/);
  });

  it("blocks POST without matching header+cookie", async () => {
    const app = buildApp();
    const r = await request(app).post("/api/echo").send({ x: 1 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("csrf_failed");
  });

  it("allows POST when cookie + x-csrf-token match", async () => {
    const app = buildApp();
    const issue = await request(app).get("/api/csrf-token");
    const cookie = issue.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
    const token = issue.body.csrfToken;
    const r = await request(app)
      .post("/api/echo")
      .set("Cookie", cookie)
      .set("x-csrf-token", token)
      .send({ x: 1 });
    expect(r.status).toBe(200);
    expect(r.body.body).toEqual({ x: 1 });
  });

  it("ignores GET requests", async () => {
    const app = buildApp();
    const r = await request(app).get("/api/echo");
    expect(r.status).toBe(200);
  });

  it("skips when Authorization: Bearer is set (Clerk JWT path)", async () => {
    const app = buildApp();
    const r = await request(app)
      .post("/api/echo")
      .set("Authorization", "Bearer token-xyz")
      .send({ x: 1 });
    expect(r.status).toBe(200);
  });

  it("safeEqual rejects mismatched lengths in constant time", () => {
    expect(__test__.safeEqual("abc", "abcd")).toBe(false);
    expect(__test__.safeEqual("abcd", "abcd")).toBe(true);
    expect(__test__.safeEqual("abcd", "abce")).toBe(false);
  });

  it("recognises exempt prefixes", () => {
    expect(__test__.isExempt("/api/webhooks/paystack")).toBe(true);
    expect(__test__.isExempt("/api/health")).toBe(true);
    expect(__test__.isExempt("/api/orders")).toBe(false);
    // The staging-only stuck-degraded rehearsal injector is called
    // from a GitHub Actions cron with no browser cookies — it has to
    // be exempt from CSRF or the workflow 403s before its own
    // X-Rehearsal-Token guard runs. Asserted here so a future
    // refactor of EXEMPT_PATH_PREFIXES doesn't silently regress
    // the rehearsal pipeline.
    expect(__test__.isExempt("/api/_rehearsal/inject-stuck-degraded")).toBe(true);
    expect(__test__.isExempt("/api/_rehearsal/clear-stuck-degraded")).toBe(true);
  });
});
