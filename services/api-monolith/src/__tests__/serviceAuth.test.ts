import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { optionalServiceAuth, requireEffectiveUserId } from "../lib/serviceAuth";

const STRONG_TOKEN = "a".repeat(48);

function mockReq(headers: Record<string, string> = {}, auth?: { userId?: string }): Request {
  const req = {
    headers,
  } as unknown as Request & { auth?: unknown };
  // Mirror @clerk/express getAuth(req) — getAuth reads req.auth.
  if (auth) (req as { auth?: unknown }).auth = auth;
  return req;
}

function mockRes(): {
  res: Response;
  status: number | null;
  body: unknown;
} {
  const out: { res: Response; status: number | null; body: unknown } = {
    res: {} as Response,
    status: null,
    body: null,
  };
  out.res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: unknown) {
      out.body = payload;
      return this;
    },
  } as unknown as Response;
  return out;
}

const originalToken = process.env.AGENT_SERVICE_TOKEN;
beforeEach(() => {
  delete process.env.AGENT_SERVICE_TOKEN;
});
afterAll(() => {
  if (originalToken === undefined) delete process.env.AGENT_SERVICE_TOKEN;
  else process.env.AGENT_SERVICE_TOKEN = originalToken;
});

describe("optionalServiceAuth", () => {
  it("does nothing when AGENT_SERVICE_TOKEN is unset", () => {
    const req = mockReq({ authorization: `Bearer ${STRONG_TOKEN}`, "x-agent-service-id": "buyer-concierge" });
    const next = (() => {}) as NextFunction;
    optionalServiceAuth(req, mockRes().res, next);
    expect(req.serviceCaller).toBeUndefined();
  });

  it("ignores tokens shorter than the minimum length even if they match", () => {
    process.env.AGENT_SERVICE_TOKEN = "short";
    const req = mockReq({ authorization: `Bearer short`, "x-agent-service-id": "buyer-concierge" });
    optionalServiceAuth(req, mockRes().res, () => {});
    expect(req.serviceCaller).toBeUndefined();
  });

  it("attaches serviceCaller when the token matches and x-agent-service-id is present", () => {
    process.env.AGENT_SERVICE_TOKEN = STRONG_TOKEN;
    const req = mockReq({
      authorization: `Bearer ${STRONG_TOKEN}`,
      "x-agent-service-id": "buyer-concierge",
      "x-agent-session-id": "sess-1",
      "x-on-behalf-of-user-id": "user_42",
    });
    optionalServiceAuth(req, mockRes().res, () => {});
    expect(req.serviceCaller).toEqual({
      agentId: "buyer-concierge",
      sessionId: "sess-1",
      onBehalfOfUserId: "user_42",
    });
  });

  it("rejects a wrong token via timing-safe compare without crashing", () => {
    process.env.AGENT_SERVICE_TOKEN = STRONG_TOKEN;
    const req = mockReq({
      authorization: `Bearer ${"b".repeat(48)}`,
      "x-agent-service-id": "buyer-concierge",
    });
    optionalServiceAuth(req, mockRes().res, () => {});
    expect(req.serviceCaller).toBeUndefined();
  });

  it("requires x-agent-service-id even when the token matches", () => {
    process.env.AGENT_SERVICE_TOKEN = STRONG_TOKEN;
    const req = mockReq({ authorization: `Bearer ${STRONG_TOKEN}` });
    optionalServiceAuth(req, mockRes().res, () => {});
    expect(req.serviceCaller).toBeUndefined();
  });
});

describe("requireEffectiveUserId", () => {
  it("returns the on-behalf-of user when serviceCaller is set", () => {
    const req = mockReq();
    req.serviceCaller = {
      agentId: "buyer-concierge",
      sessionId: "s",
      onBehalfOfUserId: "user_42",
    };
    const m = mockRes();
    expect(requireEffectiveUserId(req, m.res)).toBe("user_42");
    expect(m.status).toBeNull();
  });

  it("falls through to Clerk userId when serviceCaller is unset", () => {
    // Without clerkMiddleware initialised, getUserId returns null and
    // the helper 401s. We assert that branch — the positive Clerk path
    // is exercised end-to-end by the existing route tests.
    const req = mockReq({}, { userId: "user_clerk" });
    const m = mockRes();
    expect(requireEffectiveUserId(req, m.res)).toBeNull();
    expect(m.status).toBe(401);
  });

  it("writes 401 when no caller identity is present", () => {
    const req = mockReq();
    const m = mockRes();
    expect(requireEffectiveUserId(req, m.res)).toBeNull();
    expect(m.status).toBe(401);
    expect(m.body).toMatchObject({ error: "unauthorized" });
  });
});
