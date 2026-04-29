import { describe, it, expect, vi } from "vitest";
import {
  buildPayload,
  upsertMonitor,
  main,
} from "./syncSentryMonitors.js";
import type { SentryMonitorConfig } from "./sentryMonitors.config.js";

const monitor: SentryMonitorConfig = {
  slug: "example",
  name: "Example",
  workflowFile: ".github/workflows/example.yml",
  schedule: "*/5 * * * *",
  scheduleType: "crontab",
  timezone: "UTC",
  checkinMarginMinutes: 5,
  maxRuntimeMinutes: 10,
  failureIssueThreshold: 1,
  recoveryThreshold: 1,
  environment: "production",
  runbookSection: "docs/runbooks/example.md",
};

describe("buildPayload", () => {
  it("maps the monitor config into the Sentry API shape", () => {
    expect(buildPayload(monitor, "api-server")).toEqual({
      name: "Example",
      slug: "example",
      type: "cron_job",
      project: "api-server",
      config: {
        schedule_type: "crontab",
        schedule: "*/5 * * * *",
        timezone: "UTC",
        checkin_margin: 5,
        max_runtime: 10,
        failure_issue_threshold: 1,
        recovery_threshold: 1,
      },
    });
  });

  it("omits `project` when no project slug is provided", () => {
    const payload = buildPayload(monitor, undefined);
    expect(payload).not.toHaveProperty("project");
  });

  it("omits `project` for an empty project slug (treats it as unset)", () => {
    const payload = buildPayload(monitor, "");
    expect(payload).not.toHaveProperty("project");
  });
});

describe("upsertMonitor", () => {
  it("PUTs to the slug-scoped monitors endpoint with the auth bearer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
    });
    const result = await upsertMonitor(
      "https://sentry.io",
      "epplaa",
      "tok_abc",
      buildPayload(monitor, "api-server"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://sentry.io/api/0/organizations/epplaa/monitors/example/",
    );
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer tok_abc");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.config.schedule).toBe("*/5 * * * *");
  });

  it("returns the body and status on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('{"detail":"Forbidden"}'),
    });
    const result = await upsertMonitor(
      "https://sentry.io",
      "epplaa",
      "tok_abc",
      buildPayload(monitor, undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain("Forbidden");
  });

  it("returns a fetch-failed error when the network call rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ENETUNREACH"));
    const result = await upsertMonitor(
      "https://sentry.io",
      "epplaa",
      "tok_abc",
      buildPayload(monitor, undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENETUNREACH");
  });

  it("strips trailing slashes from the base URL so the path isn't doubled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
    });
    await upsertMonitor(
      "https://sentry.example.com//",
      "org",
      "tok",
      buildPayload(monitor, undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://sentry.example.com/api/0/organizations/org/monitors/example/",
    );
  });
});

describe("main", () => {
  it("returns 1 when SENTRY_ORG is missing", async () => {
    const stderr: string[] = [];
    const code = await main({
      env: {},
      monitors: [monitor],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: vi.fn() as any,
      stdout: () => {},
      stderr: (line) => stderr.push(line),
    });
    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes("SENTRY_ORG"))).toBe(true);
  });

  it("returns 1 when the auth token is missing and DRY_RUN is off", async () => {
    const stderr: string[] = [];
    const code = await main({
      env: { SENTRY_ORG: "epplaa" },
      monitors: [monitor],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: vi.fn() as any,
      stdout: () => {},
      stderr: (line) => stderr.push(line),
    });
    expect(code).toBe(1);
    expect(stderr.some((l) => l.includes("SENTRY_AUTH_TOKEN"))).toBe(true);
  });

  it("logs payloads and exits 0 in dry-run without calling fetch", async () => {
    const stdout: string[] = [];
    const fetchImpl = vi.fn();
    const code = await main({
      env: { SENTRY_ORG: "epplaa", DRY_RUN: "1" },
      monitors: [monitor],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stdout.some((l) => l.includes("would PUT monitor"))).toBe(true);
    expect(stdout.some((l) => l.includes('"slug":"example"'))).toBe(true);
  });

  it("returns 0 when every upsert succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
    });
    const stdout: string[] = [];
    const code = await main({
      env: {
        SENTRY_ORG: "epplaa",
        SENTRY_AUTH_TOKEN: "tok",
        SENTRY_PROJECT: "api-server",
      },
      monitors: [monitor, { ...monitor, slug: "second", name: "Second" }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stdout.some((l) => l.includes("2 monitor(s) upserted"))).toBe(true);
  });

  it("returns 2 when at least one upsert fails (others still attempted)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("{}"),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
    const stderr: string[] = [];
    const code = await main({
      env: { SENTRY_ORG: "epplaa", SENTRY_AUTH_TOKEN: "tok" },
      monitors: [monitor, { ...monitor, slug: "second", name: "Second" }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
      stdout: () => {},
      stderr: (line) => stderr.push(line),
    });
    expect(code).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stderr.some((l) => l.includes("FAILED second"))).toBe(true);
  });
});
