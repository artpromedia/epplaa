import { describe, it, expect, vi } from "vitest";
import {
  buildPayload,
  upsertRule,
  listRules,
  main,
  mergeActions,
  MANAGED_NOTIFY_ACTION_ID,
  MANAGED_NOTIFY_ACTION_MARKER,
} from "./syncSentryIssueAlerts.js";
import {
  sentryRuleNameFor,
  type ProductionSecretAlertConfig,
} from "./productionSecretAlerts.config.js";

const sentryAlert: ProductionSecretAlertConfig = {
  messageTag: "clerk_secret_key_missing_for_production",
  summary: "Clerk auth bypass risk",
  severity: "sev-1",
  runbookAnchor: "#clerk_secret_key",
  sentry: { canonical: true, backstop: false },
  logAggregator: { canonical: false, backstop: true },
  emittedBy: "artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts",
};

const dsnAlert: ProductionSecretAlertConfig = {
  messageTag: "sentry_dsn_missing_for_production",
  summary: "Sentry DSN missing",
  severity: "sev-2",
  runbookAnchor: "#sentry_dsn",
  sentry: { canonical: false, backstop: true },
  logAggregator: { canonical: true, backstop: false },
  emittedBy: "artifacts/api-server/src/lib/sentry.ts",
};

const logOnlyAlert: ProductionSecretAlertConfig = {
  messageTag: "log_only_for_test",
  summary: "log-only fixture",
  severity: "sev-2",
  runbookAnchor: "#x",
  sentry: { canonical: false, backstop: false },
  logAggregator: { canonical: true, backstop: false },
  emittedBy: "artifacts/api-server/src/lib/sentry.ts",
};

describe("buildPayload", () => {
  it("renders the rule with the managed name, message filter, and runbook link", () => {
    const payload = buildPayload(sentryAlert, "https://example/runbook.md");
    expect(payload.name).toBe(sentryRuleNameFor(sentryAlert));
    expect(payload.environment).toBe("production");
    // actionMatch MUST be "any" — first-seen and regression are
    // mutually-exclusive Sentry events for the same issue, so "all"
    // would mean the rule never fires. Regression test for code
    // review feedback: the original "all" silently broke paging.
    expect(payload.actionMatch).toBe("any");
    expect(payload.filterMatch).toBe("all");
    expect(payload.frequency).toBe(30);
    expect(payload.filters).toEqual([
      {
        id: "sentry.rules.filters.message.MessageFilter",
        match: "co",
        value: "clerk_secret_key_missing_for_production",
      },
    ]);
    expect(payload.conditions.map((c) => c.id)).toEqual([
      "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition",
      "sentry.rules.conditions.regression_event.RegressionEventCondition",
    ]);
    expect(payload.actions).toHaveLength(1);
    expect(payload.actions[0]!.id).toBe(MANAGED_NOTIFY_ACTION_ID);
    expect(payload.actions[0]![MANAGED_NOTIFY_ACTION_MARKER]).toBe(
      "https://example/runbook.md#clerk_secret_key",
    );
  });
});

describe("mergeActions (operator-added action preservation)", () => {
  const managed = buildPayload(sentryAlert, "https://r/").actions;

  it("returns just the managed action when there is no existing rule", () => {
    expect(mergeActions(managed, undefined)).toEqual(managed);
  });

  it("returns just the managed action when the existing rule has no actions array", () => {
    expect(mergeActions(managed, { id: 1, name: "x" })).toEqual(managed);
    expect(
      mergeActions(managed, { id: 1, name: "x", actions: null }),
    ).toEqual(managed);
  });

  it("preserves operator-added PagerDuty/Slack actions on update", () => {
    const pagerduty = {
      id: "sentry.integrations.pagerduty.notify_action.PagerDutyNotifyServiceAction",
      account: "12345",
      service: "67890",
    };
    const slack = {
      id: "sentry.integrations.slack.notify_action.SlackNotifyServiceAction",
      workspace: "ws-1",
      channel: "#oncall",
    };
    const result = mergeActions(managed, {
      id: 99,
      name: "x",
      actions: [pagerduty, slack],
    });
    // Managed action first, then both operator-added actions verbatim.
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe(MANAGED_NOTIFY_ACTION_ID);
    expect(result[1]).toEqual(pagerduty);
    expect(result[2]).toEqual(slack);
  });

  it("strips a previous copy of OUR managed action so re-syncs don't accumulate duplicates", () => {
    const oldManaged = {
      id: MANAGED_NOTIFY_ACTION_ID,
      [MANAGED_NOTIFY_ACTION_MARKER]: "https://r-old/#x",
    };
    const pagerduty = {
      id: "sentry.integrations.pagerduty.notify_action.PagerDutyNotifyServiceAction",
      account: "1",
      service: "2",
    };
    const result = mergeActions(managed, {
      id: 1,
      name: "x",
      actions: [oldManaged, pagerduty],
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(managed[0]);
    expect(result[1]).toEqual(pagerduty);
    // The old runbook URL must be gone — managed action is fresh.
    const runbooks = result.map(
      (a) => (a as Record<string, unknown>)[MANAGED_NOTIFY_ACTION_MARKER],
    );
    expect(runbooks).not.toContain("https://r-old/#x");
  });

  it("preserves a NotifyEventAction the operator added without our marker (treats it as operator-owned)", () => {
    // An operator-added NotifyEventAction WITHOUT the `runbook`
    // marker field is operator-owned and must be kept — only our
    // own copies (identified by the marker) are stripped.
    const operatorNotify = {
      id: MANAGED_NOTIFY_ACTION_ID,
      // No `runbook` field => operator-owned.
    };
    const result = mergeActions(managed, {
      id: 1,
      name: "x",
      actions: [operatorNotify],
    });
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual(operatorNotify);
  });
});

describe("listRules", () => {
  it("GETs the project rules endpoint with the bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("[]"),
    });
    const out = await listRules(
      "https://sentry.io",
      "epplaa",
      "api-server",
      "tok",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(out).toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://sentry.io/api/0/projects/epplaa/api-server/rules/",
    );
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("throws on non-2xx with the response body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve("forbidden"),
    });
    await expect(
      listRules(
        "https://sentry.io",
        "o",
        "p",
        "t",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl as any,
      ),
    ).rejects.toThrow(/HTTP 403.*forbidden/);
  });

  it("throws when the response body isn't an array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"detail":"not a list"}'),
    });
    await expect(
      listRules(
        "https://sentry.io",
        "o",
        "p",
        "t",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl as any,
      ),
    ).rejects.toThrow(/expected array/);
  });
});

describe("upsertRule", () => {
  const payload = buildPayload(sentryAlert, "https://example/runbook.md");

  it("POSTs to the project rules endpoint when no existing rule matches", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: () => Promise.resolve("{}"),
    });
    const result = await upsertRule(
      "https://sentry.io",
      "epplaa",
      "api-server",
      "tok",
      payload,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(result.ok).toBe(true);
    expect(result.action).toBe("create");
    expect(result.status).toBe(201);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://sentry.io/api/0/projects/epplaa/api-server/rules/",
    );
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.name).toBe(payload.name);
  });

  it("PUTs to the rule-id endpoint when an existing rule matches", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
    });
    const result = await upsertRule(
      "https://sentry.io",
      "epplaa",
      "api-server",
      "tok",
      payload,
      { id: 12345, name: payload.name },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(result.ok).toBe(true);
    expect(result.action).toBe("update");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://sentry.io/api/0/projects/epplaa/api-server/rules/12345/",
    );
    expect(init.method).toBe("PUT");
  });

  it("merges operator-added actions into the PUT body so the release sync doesn't wipe routing", async () => {
    // Simulates the "operator added a PagerDuty + Slack action via the
    // Sentry UI after the first sync" case the runbook documents.
    // The PUT body must contain BOTH our managed notify action AND
    // the operator-added actions, otherwise the release sync would
    // silently strip on-call routing.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
    });
    const pagerduty = {
      id: "sentry.integrations.pagerduty.notify_action.PagerDutyNotifyServiceAction",
      account: "acc",
      service: "svc",
    };
    const slack = {
      id: "sentry.integrations.slack.notify_action.SlackNotifyServiceAction",
      workspace: "ws",
      channel: "#oncall",
    };
    const existing = {
      id: 7,
      name: payload.name,
      actions: [
        // A stale copy of our own action (with the marker) — must be
        // dropped; the new managed action replaces it.
        {
          id: MANAGED_NOTIFY_ACTION_ID,
          [MANAGED_NOTIFY_ACTION_MARKER]: "https://r-old/#x",
        },
        pagerduty,
        slack,
      ],
    };
    await upsertRule(
      "https://sentry.io",
      "o",
      "p",
      "t",
      payload,
      existing,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.actions).toHaveLength(3);
    expect(body.actions[0]).toEqual(payload.actions[0]);
    expect(body.actions).toContainEqual(pagerduty);
    expect(body.actions).toContainEqual(slack);
    // Stale managed action with the old runbook URL must NOT survive.
    const runbookValues: unknown[] = body.actions.map(
      (a: Record<string, unknown>) => a[MANAGED_NOTIFY_ACTION_MARKER],
    );
    expect(runbookValues).not.toContain("https://r-old/#x");
  });

  it("does NOT touch operator actions on CREATE (no existing rule means nothing to preserve)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: () => Promise.resolve("{}"),
    });
    await upsertRule(
      "https://sentry.io",
      "o",
      "p",
      "t",
      payload,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.actions).toEqual(payload.actions);
  });

  it("returns the body and status on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('{"detail":"bad payload"}'),
    });
    const result = await upsertRule(
      "https://sentry.io",
      "o",
      "p",
      "t",
      payload,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(result.ok).toBe(false);
    expect(result.action).toBe("create");
    expect(result.status).toBe(422);
    expect(result.error).toContain("bad payload");
  });

  it("captures fetch-level errors with the original message", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("network down"));
    const result = await upsertRule(
      "https://sentry.io",
      "o",
      "p",
      "t",
      payload,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl as any,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });
});

describe("main", () => {
  it("returns 0 and skips work when no Sentry-routed alerts are declared", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetchImpl = vi.fn();
    const code = await main({
      env: {},
      alerts: [logOnlyAlert],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stdout.some((l) => l.includes("nothing to sync"))).toBe(true);
  });

  it("returns 1 when SENTRY_ORG is missing", async () => {
    const stderr: string[] = [];
    const code = await main({
      env: { SENTRY_PROJECT: "p", SENTRY_AUTH_TOKEN: "t" },
      alerts: [sentryAlert],
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/SENTRY_ORG/);
  });

  it("returns 1 when SENTRY_PROJECT is missing", async () => {
    const stderr: string[] = [];
    const code = await main({
      env: { SENTRY_ORG: "o", SENTRY_AUTH_TOKEN: "t" },
      alerts: [sentryAlert],
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/SENTRY_PROJECT/);
  });

  it("returns 1 when SENTRY_AUTH_TOKEN is missing (and not dry-run)", async () => {
    const stderr: string[] = [];
    const code = await main({
      env: { SENTRY_ORG: "o", SENTRY_PROJECT: "p" },
      alerts: [sentryAlert],
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(1);
    expect(stderr.join("\n")).toMatch(/SENTRY_AUTH_TOKEN/);
  });

  it("dry-run logs payloads without hitting the API", async () => {
    const stdout: string[] = [];
    const fetchImpl = vi.fn();
    const code = await main({
      env: { SENTRY_ORG: "o", SENTRY_PROJECT: "p", DRY_RUN: "1" },
      alerts: [sentryAlert, dsnAlert],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
      stdout: (l) => stdout.push(l),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stdout.some((l) => l.includes("would create"))).toBe(true);
    expect(stdout.some((l) => l.includes("payload:"))).toBe(true);
    expect(stdout.some((l) => l.includes("dry-run complete"))).toBe(true);
  });

  it("creates new rules and updates existing ones based on the listing", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    // First call: GET rules list. Returns one match for the DSN
    // alert (so DSN should be a PUT/update) and nothing for the
    // Clerk alert (so Clerk should be a POST/create).
    const dsnRuleName = sentryRuleNameFor(dsnAlert);
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn().mockImplementation(async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (init?.method === undefined || init.method === "GET") {
        return {
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify([{ id: 99, name: dsnRuleName }]),
            ),
        };
      }
      return {
        ok: true,
        status: init.method === "PUT" ? 200 : 201,
        text: () => Promise.resolve("{}"),
      };
    });
    const code = await main({
      env: {
        SENTRY_ORG: "epplaa",
        SENTRY_PROJECT: "api-server",
        SENTRY_AUTH_TOKEN: "tok",
      },
      alerts: [sentryAlert, dsnAlert],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(0);
    // 1 GET + 2 mutations
    expect(calls).toHaveLength(3);
    expect(calls[0]!.method).toBe("GET");
    // The DSN one (already existed) is a PUT to the rule-id URL.
    const putCall = calls.find((c) => c.method === "PUT");
    expect(putCall).toBeDefined();
    expect(putCall!.url).toContain("/rules/99/");
    // The Clerk one is a POST to the collection URL.
    const postCall = calls.find((c) => c.method === "POST");
    expect(postCall).toBeDefined();
    expect(postCall!.url.endsWith("/rules/")).toBe(true);
    expect(stderr).toEqual([]);
  });

  it("returns 2 and surfaces the error when listing fails", async () => {
    const stderr: string[] = [];
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("oops"),
    });
    const code = await main({
      env: {
        SENTRY_ORG: "o",
        SENTRY_PROJECT: "p",
        SENTRY_AUTH_TOKEN: "t",
      },
      alerts: [sentryAlert],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(2);
    expect(stderr.join("\n")).toMatch(/HTTP 500/);
  });

  it("returns 2 when at least one upsert fails (partial sync)", async () => {
    const stderr: string[] = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url, init) => {
      if (init?.method === undefined || init.method === "GET") {
        return {
          ok: true,
          status: 200,
          text: () => Promise.resolve("[]"),
        };
      }
      return {
        ok: false,
        status: 422,
        text: () => Promise.resolve("bad"),
      };
    });
    const code = await main({
      env: {
        SENTRY_ORG: "o",
        SENTRY_PROJECT: "p",
        SENTRY_AUTH_TOKEN: "t",
      },
      alerts: [sentryAlert],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: fetchImpl as any,
      stdout: () => {},
      stderr: (l) => stderr.push(l),
    });
    expect(code).toBe(2);
    expect(stderr.some((l) => l.includes("FAILED"))).toBe(true);
    expect(stderr.some((l) => l.includes("1 of 1 upserts failed"))).toBe(
      true,
    );
  });
});
