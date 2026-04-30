import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Boot-time wiring tests for `src/index.ts` (task #92).
 *
 * The individual guard functions (`assertRehearsalKillSwitchSafe`,
 * `assertProductionHostnamePatternConfigured`,
 * `assertRateLimitStoreConfiguredForProduction`) are unit-tested in their
 * own files, but the wiring in `src/index.ts` itself — the
 * `if (!result.ok) process.exit(1)` blocks and their order — has no
 * automated coverage. A future refactor that accidentally drops the
 * exit, ignores the outcome, or reorders the guards (e.g. putting an
 * import that triggers DB side-effects before the rehearsal guard)
 * could silently disable the boot-fail behaviour without any unit-test
 * failure.
 *
 * These tests spawn the real `src/index.ts` entrypoint via `tsx` with
 * each misconfigured env permutation and assert both:
 *   - the process exits with the expected code, AND
 *   - the relevant structured-log message tag appears on stdout/stderr
 *     before the exit (proving the GUARD is what made the decision —
 *     not some unrelated downstream failure).
 *
 * They also assert ordering by checking that earlier-failing guards
 * exit BEFORE later guards get a chance to log. If a future refactor
 * reorders the guards or drops an exit, the matching tag will be
 * missing or the wrong tag will appear, and the test will fail loudly.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiServerRoot = path.resolve(__dirname, "..");
const indexPath = path.join(apiServerRoot, "src", "index.ts");
const tsxBin = path.join(apiServerRoot, "node_modules", ".bin", "tsx");

interface BootResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  combined: string;
}

/**
 * Spawn the api-server entrypoint with a controlled env and return the
 * exit code + captured output. We intentionally pass an EMPTY base env
 * (only the keys we explicitly hand in) so a leaked CI env var like
 * `DATABASE_URL` or `RATE_LIMIT_STORE` can't make a guard test pass or
 * fail for the wrong reason. PATH is the only carry-over so tsx can
 * resolve node + its loader.
 */
async function spawnBoot(env: NodeJS.ProcessEnv): Promise<BootResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [indexPath], {
      cwd: apiServerRoot,
      env: {
        // Bare minimum so the OS can find node / tsx. Everything else
        // about the boot environment must be supplied explicitly by the
        // caller so the test isn't accidentally polluted by the host
        // shell's env.
        PATH: process.env.PATH ?? "",
        // The static `import { db } from "../lib/db"` chain in
        // `middlewares/apiRateLimit.ts` (transitively imported by
        // `src/index.ts` for the rate-limit guard helper) runs
        // `lib/db/src/index.ts` at module load, which throws if
        // `DATABASE_URL` is unset. The Pool itself is lazy and never
        // tries to connect until the first query, so a sentinel
        // connection string is enough to unblock module evaluation
        // without a real database. The boot guards under test all
        // run BEFORE any code path that issues a query, so the
        // sentinel is never dialled.
        DATABASE_URL:
          "postgres://boot-guard-test@127.0.0.1:1/never-connected",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    // Hard cap so a hung child (e.g. a future refactor that
    // accidentally lets boot proceed past the guards into the HTTP
    // listener on a misconfigured deploy) fails the test loudly
    // instead of timing out the whole vitest run.
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Boot did not exit within 15s. stdout=\n${stdout}\nstderr=\n${stderr}`,
        ),
      );
    }, 15_000);

    child.on("exit", (code, signal) => {
      clearTimeout(killTimer);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        combined: stdout + stderr,
      });
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

/**
 * Cryptic sentinel value required by the `__EPPLAA_BOOT_GUARDS_ONLY`
 * test affordance in `src/index.ts`. The literal is intentionally
 * verbose (not "1" / "true") so it can't be set in a real deploy by
 * accident or copy-paste from a runbook. Defined here next to the
 * spawn calls that use it, but the source of truth is `src/index.ts`
 * — keep both ends in sync if you ever rotate the sentinel.
 */
const BOOT_GUARDS_ONLY_SENTINEL =
  "test-only-exit-after-boot-guards-do-not-set-in-production";

describe("index.ts boot-time guard wiring", () => {
  it("exits 1 with the rehearsal-kill-switch tag when HEALTHZ_REHEARSAL_ENABLED=1 on a production-shaped deploy", async () => {
    const result = await spawnBoot({
      NODE_ENV: "production",
      HEALTHZ_REHEARSAL_ENABLED: "1",
      // Test affordance present (but unreachable on this path — the
      // rehearsal guard is the FIRST check and exits 1 before we get
      // to it). This doubles as an ordering assertion: if a refactor
      // moved the affordance ahead of the rehearsal guard, this test
      // would observe exit 0 and the missing tag and fail.
      __EPPLAA_BOOT_GUARDS_ONLY: BOOT_GUARDS_ONLY_SENTINEL,
    });

    expect(result.exitCode).toBe(1);
    expect(result.combined).toContain(
      "healthz_rehearsal_kill_switch_on_in_production",
    );
    // Ordering: the rehearsal guard MUST exit before the rate-limit
    // guard runs. If a refactor reordered them, the rate-limit error
    // tag would appear here too.
    expect(result.combined).not.toContain(
      "rate_limit_store_misconfigured_for_production",
    );
  }, 30_000);

  it("exits 1 with the rate-limit-misconfigured tag when RATE_LIMIT_STORE is unset on a production-shaped deploy", async () => {
    const result = await spawnBoot({
      NODE_ENV: "production",
      // Rehearsal kill switch is intentionally OFF — this test
      // exercises the rate-limit guard in isolation. RATE_LIMIT_STORE
      // is intentionally absent (the misconfiguration under test) and
      // the opt-out env var is intentionally absent too (so the guard
      // returns ok=false and the wiring under test must call
      // process.exit(1)).
      __EPPLAA_BOOT_GUARDS_ONLY: BOOT_GUARDS_ONLY_SENTINEL,
    });

    expect(result.exitCode).toBe(1);
    expect(result.combined).toContain(
      "rate_limit_store_misconfigured_for_production",
    );
    // Sanity: the prior guard's tag must NOT be present, otherwise we
    // would be asserting on output from the wrong guard.
    expect(result.combined).not.toContain(
      "healthz_rehearsal_kill_switch_on_in_production",
    );
  }, 30_000);

  it("exits 0 with the opt-out warn tag when RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1 on a production-shaped deploy", async () => {
    const result = await spawnBoot({
      NODE_ENV: "production",
      RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
      // RATE_LIMIT_STORE deliberately unset — the opt-out path is the
      // explicit escape hatch for single-replica production deploys
      // that intentionally run on the in-process bucket. The guard
      // must return ok=true and the wiring must NOT call
      // process.exit(1), so boot proceeds to the test affordance and
      // exits 0.
      __EPPLAA_BOOT_GUARDS_ONLY: BOOT_GUARDS_ONLY_SENTINEL,
      // Opt every carrier out so the carrier-credentials guard
      // (task #99) doesn't preempt the path under test. The carriers'
      // own behaviour is exercised in the dedicated tests below.
      DISABLE_CARRIER_SHIPBUBBLE: "1",
      DISABLE_CARRIER_GIG: "1",
      DISABLE_CARRIER_OKHI: "1",
    });

    expect(result.exitCode).toBe(0);
    expect(result.combined).toContain(
      "rate_limit_store_memory_in_production_via_opt_out",
    );
    // The hard-fail tag must NOT be emitted on the opt-out path —
    // that would mean the guard wired up the wrong branch.
    expect(result.combined).not.toContain(
      "rate_limit_store_misconfigured_for_production",
    );
  }, 30_000);

  it("exits 1 with the carrier-credentials tag when carrier creds are missing on a production-shaped deploy (task #99)", async () => {
    const result = await spawnBoot({
      NODE_ENV: "production",
      // Rate-limit store wired so the prior guard passes and the
      // carrier-credentials guard is what makes the decision.
      RATE_LIMIT_STORE: "redis",
      REDIS_URL: "redis://boot-guard-test@127.0.0.1:1/never-connected",
      __EPPLAA_BOOT_GUARDS_ONLY: BOOT_GUARDS_ONLY_SENTINEL,
      // SHIPBUBBLE_API_KEY / GIG_API_KEY / GIG_USERNAME / OKHI_API_KEY /
      // OKHI_BRANCH_ID intentionally absent — the misconfiguration
      // under test. The opt-out env vars are also absent so the guard
      // must hard-fail rather than silently proceeding.
    });

    expect(result.exitCode).toBe(1);
    expect(result.combined).toContain(
      "carrier_credentials_missing_for_production",
    );
    // Ordering sanity: the prior guards' tags must NOT appear (they
    // would only emit if their own misconfig was present, and would
    // mean the carrier guard isn't the one that made the decision).
    expect(result.combined).not.toContain(
      "rate_limit_store_misconfigured_for_production",
    );
    expect(result.combined).not.toContain(
      "stub_fulfillment_kill_switch_on_in_production",
    );
  }, 30_000);

  it("exits 0 when every carrier is explicitly opted-out on a production-shaped deploy (task #99 opt-out wiring)", async () => {
    const result = await spawnBoot({
      NODE_ENV: "production",
      RATE_LIMIT_STORE: "redis",
      REDIS_URL: "redis://boot-guard-test@127.0.0.1:1/never-connected",
      DISABLE_CARRIER_SHIPBUBBLE: "1",
      DISABLE_CARRIER_GIG: "1",
      DISABLE_CARRIER_OKHI: "1",
      __EPPLAA_BOOT_GUARDS_ONLY: BOOT_GUARDS_ONLY_SENTINEL,
    });

    expect(result.exitCode).toBe(0);
    // The hard-fail tag must NOT be emitted on the all-opted-out
    // path — that would mean the opt-out env vars were ignored.
    expect(result.combined).not.toContain(
      "carrier_credentials_missing_for_production",
    );
  }, 30_000);
});
