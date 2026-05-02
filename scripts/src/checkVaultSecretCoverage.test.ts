import { describe, it, expect } from "vitest";
import {
  evaluateCoverage,
  extractEnvRefs,
  extractVaultBackedEnvVars,
  filterSecretShaped,
} from "./checkVaultSecretCoverage";
import { SECRET_NAME_PATTERNS } from "./vaultSecretCoverage.config";

describe("extractVaultBackedEnvVars", () => {
  it("extracts env-var names from the values.yaml flow-mapping format", () => {
    const yaml = `
vault:
  enabled: true
  secrets:
    - name: api-monolith-core
      keys:
        - DATABASE_URL: { remoteKey: epplaa/api-monolith, property: database_url }
        - SESSION_SECRET: { remoteKey: epplaa/api-monolith, property: session_secret }
    - name: api-monolith-providers
      keys:
        - PAYSTACK_SECRET_KEY: { remoteKey: epplaa/api-monolith-providers, property: paystack_secret_key }
`;
    expect([...extractVaultBackedEnvVars(yaml)].sort()).toEqual([
      "DATABASE_URL",
      "PAYSTACK_SECRET_KEY",
      "SESSION_SECRET",
    ]);
  });

  it("ignores non-secret block-style YAML lines (does not pick up `enabled: true`)", () => {
    const yaml = `
vault:
  enabled: true
  refreshInterval: 1h
  secrets:
    - name: core
      keys:
        - DATABASE_URL: { remoteKey: a, property: b }
`;
    const out = extractVaultBackedEnvVars(yaml);
    expect(out.has("DATABASE_URL")).toBe(true);
    // `enabled` is not anchored to a leading dash + uppercase identifier,
    // so it must not be picked up.
    expect(out.has("enabled")).toBe(false);
    expect(out.has("ENABLED")).toBe(false);
  });

  it("returns an empty set when no Vault-backed entries are present", () => {
    expect(extractVaultBackedEnvVars(`config: {}`).size).toBe(0);
  });

  it("tolerates unusual indentation as long as the line shape matches", () => {
    const yaml = `        - DATABASE_URL: { remoteKey: a, property: b }`;
    expect([...extractVaultBackedEnvVars(yaml)]).toEqual(["DATABASE_URL"]);
  });

  it("only matches uppercase-leading identifiers (filters out yaml flow keys)", () => {
    // `remoteKey` and `property` themselves match `^\s*-\s*\w+:\s*{` only
    // if they were on their own line; the line-shape regex requires the
    // identifier start with an uppercase letter, so flow-style sub-keys
    // can never collide.
    const yaml = `
- DATABASE_URL: { remoteKey: a, property: b }
- remoteKey: xxx
- property: yyy
`;
    const out = extractVaultBackedEnvVars(yaml);
    expect(out.has("DATABASE_URL")).toBe(true);
    expect(out.has("remoteKey")).toBe(false);
    expect(out.has("property")).toBe(false);
  });
});

describe("extractEnvRefs", () => {
  it("extracts a single process.env reference", () => {
    expect([...extractEnvRefs(`const x = process.env.DATABASE_URL`)]).toEqual([
      "DATABASE_URL",
    ]);
  });

  it("deduplicates repeated references (set semantics)", () => {
    const src = `process.env.X; process.env.X; process.env.Y;`;
    expect([...extractEnvRefs(src)].sort()).toEqual(["X", "Y"]);
  });

  it("only matches uppercase-leading identifiers (skips obj.process.env.foo style)", () => {
    expect(extractEnvRefs(`process.env.foo`).size).toBe(0);
    expect(extractEnvRefs(`process.env.fooBar`).size).toBe(0);
  });

  it("returns an empty set when there are no references", () => {
    expect(extractEnvRefs(`const x = 1;`).size).toBe(0);
  });

  it("handles digits and underscores in env-var names", () => {
    expect([...extractEnvRefs(`process.env.AWS_S3_REGION`)]).toEqual([
      "AWS_S3_REGION",
    ]);
    expect([...extractEnvRefs(`process.env.X_2_Y`)]).toEqual(["X_2_Y"]);
  });
});

describe("filterSecretShaped", () => {
  it("keeps names matching any of the secret patterns", () => {
    const names = new Set([
      "DATABASE_URL",
      "PAYSTACK_SECRET_KEY",
      "POSTMARK_API_TOKEN",
      "FLUTTERWAVE_WEBHOOK_HASH",
      "SENTRY_DSN",
      "NODE_ENV",
      "PORT",
    ]);
    expect([...filterSecretShaped(names, SECRET_NAME_PATTERNS)].sort()).toEqual([
      "FLUTTERWAVE_WEBHOOK_HASH",
      "PAYSTACK_SECRET_KEY",
      "POSTMARK_API_TOKEN",
      "SENTRY_DSN",
    ]);
  });

  it("includes the explicit SESSION_SECRET match", () => {
    const out = filterSecretShaped(new Set(["SESSION_SECRET"]), SECRET_NAME_PATTERNS);
    expect(out.has("SESSION_SECRET")).toBe(true);
  });

  it("treats DATABASE_URL as non-secret-shaped (it's a connection URL — handled separately)", () => {
    // DATABASE_URL is wired through Vault via `core` regardless, but
    // the pattern set deliberately doesn't match `_URL$` because
    // most _URL env vars (OTEL_EXPORTER_OTLP_ENDPOINT, READYZ_CLERK_URL)
    // are NOT credentials and would create false positives.
    const out = filterSecretShaped(new Set(["DATABASE_URL"]), SECRET_NAME_PATTERNS);
    expect(out.has("DATABASE_URL")).toBe(false);
  });

  it("returns an empty set when no name matches", () => {
    expect(filterSecretShaped(new Set(["NODE_ENV", "PORT"]), SECRET_NAME_PATTERNS).size).toBe(0);
  });
});

describe("evaluateCoverage", () => {
  it("returns no missing names when every secret is Vault-backed", () => {
    const r = evaluateCoverage(
      new Set(["A_KEY", "B_TOKEN"]),
      new Set(["A_KEY", "B_TOKEN"]),
      [],
    );
    expect(r.missing).toEqual([]);
    expect(r.covered).toEqual(["A_KEY", "B_TOKEN"]);
    expect(r.allowlisted).toEqual([]);
  });

  it("classifies allowlisted names as allowlisted, not missing", () => {
    const r = evaluateCoverage(
      new Set(["TUNING_KEY"]),
      new Set(),
      [{ name: "TUNING_KEY", reason: "duration knob" }],
    );
    expect(r.missing).toEqual([]);
    expect(r.allowlisted).toEqual(["TUNING_KEY"]);
  });

  it("flags a name that's neither Vault-backed nor allowlisted", () => {
    const r = evaluateCoverage(
      new Set(["NEW_PROVIDER_API_KEY"]),
      new Set(["A_KEY"]),
      [{ name: "TUNING_KEY", reason: "x" }],
    );
    expect(r.missing).toEqual(["NEW_PROVIDER_API_KEY"]);
  });

  it("prefers Vault-backed classification over allowlist when both apply", () => {
    // If a name lands in both, count it as covered. The allowlist is a
    // lower-trust escape hatch; once Vault wiring exists, the allowlist
    // entry is dead weight (the next operator should remove it). Either
    // way we shouldn't double-count.
    const r = evaluateCoverage(
      new Set(["X_KEY"]),
      new Set(["X_KEY"]),
      [{ name: "X_KEY", reason: "stale" }],
    );
    expect(r.covered).toEqual(["X_KEY"]);
    expect(r.allowlisted).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it("returns missing names in sorted order for stable CI output", () => {
    const r = evaluateCoverage(
      new Set(["Z_KEY", "A_KEY", "M_KEY"]),
      new Set(),
      [],
    );
    expect(r.missing).toEqual(["A_KEY", "M_KEY", "Z_KEY"]);
  });

  it("handles the empty input case", () => {
    const r = evaluateCoverage(new Set(), new Set(), []);
    expect(r).toEqual({ missing: [], allowlisted: [], covered: [] });
  });
});
