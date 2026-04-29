import { describe, it, expect } from "vitest";
import {
  DEFAULT_DEPLOY_CONFIG_GLOB,
  DEFAULT_INVENTORY_PATH,
  decideOutcome,
  exitCodeFor,
  isProductionEnvTable,
  main,
  matchesGlob,
  scanDeployConfigForOptOut,
  type DeployState,
  type GitRunner,
} from "./checkRateLimitOptOutPrInventory";

/** A minimal deploy-config TOML matching the shape in
 *  `artifacts/api-server/.replit-artifact/artifact.toml`. The
 *  `optOut` arg controls whether the boot opt-out env var is set
 *  inside `[services.production.run.env]`. */
function deployConfig({
  optOut,
  optOutValue = "1",
  optOutTable = "[services.production.run.env]",
  extraTrailingEnv = "",
}: {
  optOut: boolean;
  optOutValue?: string;
  optOutTable?: string;
  extraTrailingEnv?: string;
}): string {
  const lines = [
    'kind = "api"',
    'title = "API Server"',
    "",
    "[[services]]",
    "localPort = 8080",
    'name = "API Server"',
    "",
    "[services.production]",
    "",
    "[services.production.build.env]",
    'NODE_ENV = "production"',
    "",
    optOutTable,
    'PORT = "8080"',
    'NODE_ENV = "production"',
  ];
  if (optOut) {
    lines.push(`RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION = "${optOutValue}"`);
  }
  if (extraTrailingEnv !== "") {
    lines.push(extraTrailingEnv);
  }
  return lines.join("\n") + "\n";
}

describe("isProductionEnvTable", () => {
  it("matches services.production.run.env", () => {
    expect(isProductionEnvTable("services.production.run.env")).toBe(true);
  });

  it("matches services.production.build.env", () => {
    // We accept any `[services.production.<segment>.env]` shape so a
    // future deploy-config tweak that relocates the env var doesn't
    // silently bypass the gate.
    expect(isProductionEnvTable("services.production.build.env")).toBe(true);
  });

  it("rejects non-production tables", () => {
    expect(isProductionEnvTable("services.development.run.env")).toBe(false);
    expect(isProductionEnvTable("services.staging.run.env")).toBe(false);
  });

  it("rejects tables that don't end in `.env`", () => {
    expect(isProductionEnvTable("services.production.run")).toBe(false);
    expect(isProductionEnvTable("services.production")).toBe(false);
  });

  it("rejects unrelated tables that happen to contain the word `env`", () => {
    expect(isProductionEnvTable("env")).toBe(false);
    expect(isProductionEnvTable("services.env.production")).toBe(false);
  });
});

describe("scanDeployConfigForOptOut", () => {
  it("flags the canonical opt-out assignment in services.production.run.env", () => {
    const text = deployConfig({ optOut: true });
    const result = scanDeployConfigForOptOut(text);
    expect(result.isOptedOut).toBe(true);
    expect(result.matchedTable).toBe("services.production.run.env");
  });

  it("does not flag a deploy config that has no opt-out env var", () => {
    const text = deployConfig({ optOut: false });
    expect(scanDeployConfigForOptOut(text).isOptedOut).toBe(false);
  });

  it("does not flag values other than the literal '1' (mirrors the runtime's strict matching)", () => {
    for (const v of ["0", "true", "yes", "01", " 1 ", ""]) {
      const text = deployConfig({ optOut: true, optOutValue: v });
      expect(scanDeployConfigForOptOut(text).isOptedOut, `value=${v}`).toBe(false);
    }
  });

  it("treats single-quoted '1' the same as double-quoted (TOML literal string)", () => {
    const text = deployConfig({ optOut: false }) +
      "[services.production.run.env]\n" +
      "RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION = '1'\n";
    expect(scanDeployConfigForOptOut(text).isOptedOut).toBe(true);
  });

  it("does not flag the env var when it appears under a non-production table", () => {
    const text = deployConfig({
      optOut: true,
      optOutTable: "[services.development.run.env]",
    });
    expect(scanDeployConfigForOptOut(text).isOptedOut).toBe(false);
  });

  it("ignores commented-out assignments", () => {
    const text =
      "[services.production.run.env]\n" +
      '# RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION = "1"\n';
    expect(scanDeployConfigForOptOut(text).isOptedOut).toBe(false);
  });

  it("ignores a value of `1` without quotes (TOML number, not string — runtime check is string-only)", () => {
    const text =
      "[services.production.run.env]\n" +
      "RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION = 1\n";
    expect(scanDeployConfigForOptOut(text).isOptedOut).toBe(false);
  });

  it("does not bleed across `[[…]]` array-of-tables resets", () => {
    // After a `[[services]]` header, a subsequent assignment is no
    // longer in scope of the prior single-bracket table — so the
    // env var defined under `[services.production.run.env]` and then
    // a follow-up `[[services]]` shouldn't keep evaluating later
    // assignments under the production env scope.
    const text =
      "[services.production.run.env]\n" +
      'PORT = "8080"\n' +
      "[[services]]\n" +
      'RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION = "1"\n';
    expect(scanDeployConfigForOptOut(text).isOptedOut).toBe(false);
  });

  it("tolerates extra whitespace around `=`", () => {
    const text =
      "[services.production.run.env]\n" +
      'RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION   =   "1"\n';
    expect(scanDeployConfigForOptOut(text).isOptedOut).toBe(true);
  });
});

describe("matchesGlob", () => {
  it("matches the default deploy config glob", () => {
    expect(
      matchesGlob(
        "artifacts/api-server/.replit-artifact/artifact.toml",
        DEFAULT_DEPLOY_CONFIG_GLOB,
      ),
    ).toBe(true);
  });

  it("does not match unrelated paths under artifacts/", () => {
    expect(
      matchesGlob("artifacts/api-server/src/index.ts", DEFAULT_DEPLOY_CONFIG_GLOB),
    ).toBe(false);
  });

  it("does not greedily match nested artifact directories", () => {
    // `*` should match a single path segment, not multiple.
    expect(
      matchesGlob(
        "artifacts/api-server/sub/.replit-artifact/artifact.toml",
        DEFAULT_DEPLOY_CONFIG_GLOB,
      ),
    ).toBe(false);
  });
});

describe("decideOutcome", () => {
  const baseInput = {
    baseRef: "origin/main",
    headRef: "HEAD",
    inventoryPath: DEFAULT_INVENTORY_PATH,
  };

  it("returns ok when no deploy configs were touched", () => {
    const r = decideOutcome({
      ...baseInput,
      inventoryEdited: false,
      deploys: [],
    });
    expect(r.outcome).toBe("ok");
    expect(r.newlyOptedOut).toEqual([]);
  });

  it("returns ok when a touched deploy is already opted-out at BASE (no change)", () => {
    const deploys: DeployState[] = [
      {
        path: "artifacts/api-server/.replit-artifact/artifact.toml",
        isOptedOutAtHead: true,
        isOptedOutAtBase: true,
      },
    ];
    const r = decideOutcome({
      ...baseInput,
      inventoryEdited: false,
      deploys,
    });
    expect(r.outcome).toBe("ok");
    expect(r.newlyOptedOut).toEqual([]);
  });

  it("returns ok when a touched deploy is graduating off the opt-out (HEAD!=1, BASE==1)", () => {
    // The runtime check is on the HEAD value, so a deploy that no
    // longer sets the env var doesn't need an inventory edit by
    // *this* gate (the rehearsal catches stale rows separately).
    const deploys: DeployState[] = [
      {
        path: "artifacts/api-server/.replit-artifact/artifact.toml",
        isOptedOutAtHead: false,
        isOptedOutAtBase: true,
      },
    ];
    const r = decideOutcome({
      ...baseInput,
      inventoryEdited: false,
      deploys,
    });
    expect(r.outcome).toBe("ok");
  });

  it("returns ok when newly opted-in AND the inventory was edited in the same PR", () => {
    const deploys: DeployState[] = [
      {
        path: "artifacts/api-server/.replit-artifact/artifact.toml",
        isOptedOutAtHead: true,
        isOptedOutAtBase: false,
      },
    ];
    const r = decideOutcome({
      ...baseInput,
      inventoryEdited: true,
      deploys,
    });
    expect(r.outcome).toBe("ok");
    expect(r.newlyOptedOut).toHaveLength(1);
    expect(r.reason).toContain("paired change confirmed");
  });

  it("fails when newly opted-in and inventory NOT edited", () => {
    const deploys: DeployState[] = [
      {
        path: "artifacts/api-server/.replit-artifact/artifact.toml",
        isOptedOutAtHead: true,
        isOptedOutAtBase: false,
      },
    ];
    const r = decideOutcome({
      ...baseInput,
      inventoryEdited: false,
      deploys,
    });
    expect(r.outcome).toBe("missing_inventory_edit");
    expect(r.newlyOptedOut).toHaveLength(1);
    expect(r.reason).toContain(
      "artifacts/api-server/.replit-artifact/artifact.toml",
    );
    expect(r.reason).toContain(DEFAULT_INVENTORY_PATH);
  });

  it("lists every newly-opted-in deploy when more than one is changed in the same PR", () => {
    const deploys: DeployState[] = [
      {
        path: "artifacts/api-server/.replit-artifact/artifact.toml",
        isOptedOutAtHead: true,
        isOptedOutAtBase: false,
      },
      {
        path: "artifacts/internal-admin/.replit-artifact/artifact.toml",
        isOptedOutAtHead: true,
        isOptedOutAtBase: false,
      },
    ];
    const r = decideOutcome({
      ...baseInput,
      inventoryEdited: false,
      deploys,
    });
    expect(r.outcome).toBe("missing_inventory_edit");
    expect(r.newlyOptedOut).toHaveLength(2);
    expect(r.reason).toContain("artifacts/api-server");
    expect(r.reason).toContain("artifacts/internal-admin");
  });
});

describe("exitCodeFor", () => {
  it("maps outcomes to the documented exit codes", () => {
    expect(exitCodeFor("ok")).toBe(0);
    expect(exitCodeFor("probe_error")).toBe(1);
    expect(exitCodeFor("missing_inventory_edit")).toBe(2);
  });
});

describe("main (CLI entrypoint)", () => {
  /** Builds a runWith helper that drives main() with mocked git +
   *  filesystem so the test never has to spawn a subprocess or read
   *  the real disk. */
  function runWith({
    env,
    changedFiles,
    headFiles,
    baseFiles,
    gitError,
  }: {
    env: NodeJS.ProcessEnv;
    changedFiles: string[];
    headFiles: Record<string, string>;
    baseFiles: Record<string, string>;
    gitError?: Error;
  }) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const git: GitRunner = (args) => {
      if (gitError && args[0] === "diff") throw gitError;
      if (args[0] === "diff" && args[1] === "--name-only") {
        return changedFiles.join("\n") + "\n";
      }
      if (args[0] === "show") {
        const ref = args[1] ?? "";
        const colon = ref.indexOf(":");
        const filePath = colon === -1 ? "" : ref.slice(colon + 1);
        if (Object.prototype.hasOwnProperty.call(baseFiles, filePath)) {
          return baseFiles[filePath]!;
        }
        // Mirror real git: `git show base:missing` exits non-zero.
        throw new Error(`fatal: path '${filePath}' does not exist in base`);
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    };
    return {
      stdout,
      stderr,
      run: () =>
        main({
          env,
          git,
          readHeadFile: (p) => {
            if (Object.prototype.hasOwnProperty.call(headFiles, p)) {
              return headFiles[p]!;
            }
            throw new Error(`ENOENT: ${p}`);
          },
          headFileExists: (p) =>
            Object.prototype.hasOwnProperty.call(headFiles, p),
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        }),
    };
  }

  it("exits 1 with a structured stderr line when BASE_REF is not set", async () => {
    const { run, stderr } = runWith({
      env: {},
      changedFiles: [],
      headFiles: {},
      baseFiles: {},
    });
    expect(await run()).toBe(1);
    const line = JSON.parse(stderr[0]!);
    expect(line.outcome).toBe("probe_error");
    expect(line.error).toContain("BASE_REF");
  });

  it("exits 1 when `git diff` itself fails", async () => {
    const { run, stderr } = runWith({
      env: { BASE_REF: "origin/main" },
      changedFiles: [],
      headFiles: {},
      baseFiles: {},
      gitError: new Error("fatal: ambiguous argument"),
    });
    expect(await run()).toBe(1);
    const line = JSON.parse(stderr[0]!);
    expect(line.outcome).toBe("probe_error");
    expect(line.error).toContain("git diff");
  });

  it("exits 0 when no deploy config files were touched", async () => {
    const { run, stdout } = runWith({
      env: { BASE_REF: "origin/main" },
      changedFiles: ["README.md", "scripts/src/foo.ts"],
      headFiles: {},
      baseFiles: {},
    });
    expect(await run()).toBe(0);
    const line = JSON.parse(stdout[0]!);
    expect(line.outcome).toBe("ok");
    expect(line.deploys).toEqual([]);
  });

  it("exits 2 when a touched deploy newly sets the opt-out without an inventory edit", async () => {
    const filePath = "artifacts/api-server/.replit-artifact/artifact.toml";
    const { run, stdout } = runWith({
      env: { BASE_REF: "origin/main" },
      changedFiles: [filePath],
      headFiles: { [filePath]: deployConfig({ optOut: true }) },
      baseFiles: { [filePath]: deployConfig({ optOut: false }) },
    });
    expect(await run()).toBe(2);
    const line = JSON.parse(stdout[0]!);
    expect(line.outcome).toBe("missing_inventory_edit");
    expect(line.newlyOptedOut[0].path).toBe(filePath);
    expect(line.inventoryEdited).toBe(false);
  });

  it("exits 0 when a touched deploy newly sets the opt-out AND the inventory was edited in the same PR", async () => {
    const filePath = "artifacts/api-server/.replit-artifact/artifact.toml";
    const { run, stdout } = runWith({
      env: { BASE_REF: "origin/main" },
      changedFiles: [filePath, DEFAULT_INVENTORY_PATH],
      headFiles: { [filePath]: deployConfig({ optOut: true }) },
      baseFiles: { [filePath]: deployConfig({ optOut: false }) },
    });
    expect(await run()).toBe(0);
    const line = JSON.parse(stdout[0]!);
    expect(line.outcome).toBe("ok");
    expect(line.inventoryEdited).toBe(true);
  });

  it("exits 0 when a deploy's opt-out was already set at BASE and is still set at HEAD (no opt-out status change)", async () => {
    const filePath = "artifacts/api-server/.replit-artifact/artifact.toml";
    const { run, stdout } = runWith({
      env: { BASE_REF: "origin/main" },
      changedFiles: [filePath],
      // HEAD adds an unrelated env line; opt-out value is unchanged.
      headFiles: {
        [filePath]:
          deployConfig({ optOut: true }) + 'EXTRA_VAR = "foo"\n',
      },
      baseFiles: { [filePath]: deployConfig({ optOut: true }) },
    });
    expect(await run()).toBe(0);
    const line = JSON.parse(stdout[0]!);
    expect(line.outcome).toBe("ok");
    expect(line.deploys[0].isOptedOutAtHead).toBe(true);
    expect(line.deploys[0].isOptedOutAtBase).toBe(true);
  });

  it("exits 0 when a deploy is graduating off the opt-out (env var removed) without an inventory edit", async () => {
    // The runbook documents this as the canonical pass-through for
    // the gate: a deploy that no longer opts-out doesn't need an
    // inventory row added in the same PR. The drift rehearsal catches
    // a stale row separately.
    const filePath = "artifacts/api-server/.replit-artifact/artifact.toml";
    const { run, stdout } = runWith({
      env: { BASE_REF: "origin/main" },
      changedFiles: [filePath],
      headFiles: { [filePath]: deployConfig({ optOut: false }) },
      baseFiles: { [filePath]: deployConfig({ optOut: true }) },
    });
    expect(await run()).toBe(0);
    const line = JSON.parse(stdout[0]!);
    expect(line.outcome).toBe("ok");
    expect(line.deploys[0].isOptedOutAtHead).toBe(false);
    expect(line.deploys[0].isOptedOutAtBase).toBe(true);
  });

  it("treats a newly-added deploy config file (missing at BASE) as not previously opted out", async () => {
    const filePath = "artifacts/internal-admin/.replit-artifact/artifact.toml";
    // baseFiles deliberately does NOT include the path — the mock
    // git runner throws for `git show base:newpath`, mirroring real
    // git, and the script swallows that into `baseText=""`.
    const { run, stdout } = runWith({
      env: { BASE_REF: "origin/main" },
      changedFiles: [filePath],
      headFiles: { [filePath]: deployConfig({ optOut: true }) },
      baseFiles: {},
    });
    expect(await run()).toBe(2);
    const line = JSON.parse(stdout[0]!);
    expect(line.outcome).toBe("missing_inventory_edit");
    expect(line.deploys[0].isOptedOutAtHead).toBe(true);
    expect(line.deploys[0].isOptedOutAtBase).toBe(false);
  });

  it("respects DEPLOY_CONFIG_PATHS to pin a custom set of deploy configs", async () => {
    const customPath = "deploys/api-canary.toml";
    const { run, stdout } = runWith({
      env: {
        BASE_REF: "origin/main",
        DEPLOY_CONFIG_PATHS: customPath,
      },
      changedFiles: [
        customPath,
        // Default-glob-matching path is now ignored because the
        // operator pinned a different list.
        "artifacts/api-server/.replit-artifact/artifact.toml",
      ],
      headFiles: { [customPath]: deployConfig({ optOut: true }) },
      baseFiles: {},
    });
    expect(await run()).toBe(2);
    const line = JSON.parse(stdout[0]!);
    expect(line.deploys).toHaveLength(1);
    expect(line.deploys[0].path).toBe(customPath);
  });
});
