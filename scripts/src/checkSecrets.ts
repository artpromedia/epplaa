/**
 * Wrapper around the gitleaks binary so devs can run secret scanning the
 * same way CI does — without copy-pasting the Action invocation.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx src/checkSecrets.ts
 *
 * Behaviour:
 *  - Looks for a `gitleaks` binary on PATH. If missing, prints the install
 *    instructions and exits non-zero so the script can be wired into a
 *    pre-commit hook (.husky/pre-commit) without silently passing.
 *  - Scans the entire working tree against `.gitleaks.toml`.
 *  - Exits with the gitleaks exit code so a pre-commit hook can block
 *    the commit on detection.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CONFIG = path.join(REPO_ROOT, ".gitleaks.toml");

function which(bin: string): string | null {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (probe.status === 0) return probe.stdout.split("\n")[0]?.trim() || null;
  return null;
}

function main(): void {
  if (!existsSync(CONFIG)) {
    console.error(`Missing config at ${CONFIG}`);
    process.exit(2);
  }
  const bin = which("gitleaks");
  if (!bin) {
    console.error(
      "gitleaks not found on PATH. Install: https://github.com/gitleaks/gitleaks?tab=readme-ov-file#installing",
    );
    process.exit(127);
  }
  const args = [
    "detect",
    "--source",
    REPO_ROOT,
    "--config",
    CONFIG,
    "--no-git",
    "--redact",
  ];
  const r = spawnSync(bin, args, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

main();
