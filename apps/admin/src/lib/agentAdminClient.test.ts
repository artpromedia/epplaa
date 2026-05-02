// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentAdminError,
  activatePrompt,
  createPrompt,
  getAgentAdminToken,
  getPrompt,
  listPrompts,
  setAgentAdminToken,
} from "./agentAdminClient";

const ORIGINAL_FETCH = globalThis.fetch;

function mockSessionStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, v);
    },
  };
}

beforeEach(() => {
  Object.defineProperty(window, "sessionStorage", {
    value: mockSessionStorage(),
    configurable: true,
  });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("agentAdminClient — token storage", () => {
  it("round-trips the token through sessionStorage", () => {
    expect(getAgentAdminToken()).toBeNull();
    setAgentAdminToken("secret-123");
    expect(getAgentAdminToken()).toBe("secret-123");
  });

  it("clears the token when set to null or empty", () => {
    setAgentAdminToken("secret");
    setAgentAdminToken(null);
    expect(getAgentAdminToken()).toBeNull();
    setAgentAdminToken("again");
    setAgentAdminToken("");
    expect(getAgentAdminToken()).toBeNull();
  });
});

describe("agentAdminClient — fetch wrapper", () => {
  it("throws AgentAdminError(401) when no token is set, without calling fetch", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(listPrompts()).rejects.toBeInstanceOf(AgentAdminError);
    await expect(listPrompts()).rejects.toMatchObject({ status: 401 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("attaches the Bearer header on every call", async () => {
    setAgentAdminToken("tk-42");
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ prompts: [] }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await listPrompts();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tk-42");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("surfaces the server-provided error code via AgentAdminError", async () => {
    setAgentAdminToken("tk");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "ref_exists" }), { status: 409 })) as unknown as typeof fetch;

    await expect(
      createPrompt({ ref: "x", family: "f", version: "1", systemPrompt: "p" }),
    ).rejects.toMatchObject({ status: 409, message: "ref_exists" });
  });

  it("encodes the ref param when fetching a single prompt", async () => {
    setAgentAdminToken("tk");
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ref: "p", family: "f", version: "1", systemPrompt: "x", isActive: true, createdBy: null, createdAt: "2026-05-02T00:00:00Z", activatedAt: null }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await getPrompt("prompts/buyer-concierge/v2");

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toMatch(/\/admin\/prompts\/prompts%2Fbuyer-concierge%2Fv2$/);
  });

  it("posts to the activate endpoint with method POST and no body", async () => {
    setAgentAdminToken("tk");
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ref: "p", family: "f", version: "1", systemPrompt: "x", isActive: true, createdBy: null, createdAt: "2026-05-02T00:00:00Z", activatedAt: "2026-05-02T00:00:00Z" }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await activatePrompt("prompts/x/v1");

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/activate$/);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});
