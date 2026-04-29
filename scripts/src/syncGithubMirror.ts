/**
 * Push the local `main` branch to the GitHub mirror at
 * https://github.com/artpromedia/epplaa.git so that the GitHub repo
 * reflects whatever HEAD the Replit workspace is on.
 *
 * Why this exists:
 *  The Replit workspace is the source of truth. The GitHub repo is a
 *  one-way mirror used as an off-site backup and for collaboration.
 *  Without this script, future commits made in the workspace never
 *  appear on GitHub until a human runs `git push` by hand. This
 *  script is wired into `scripts/post-merge.sh` so every task merge
 *  into `main` triggers a push within seconds — keeping the mirror
 *  in sync within a few minutes of any new commit landing on `main`.
 *
 * Behaviour:
 *  - Reads `GITHUB_TOKEN` from the environment (the secret the user
 *    already has provisioned). If missing, exits 78 (EX_CONFIG) with
 *    a clear error so the wrapper can decide whether to treat the
 *    misconfig as fatal or skip — and so the failure is *visible* in
 *    the post-merge log instead of silently no-op'ing.
 *  - Resolves the local `main` SHA via `git rev-parse refs/heads/main`.
 *  - Resolves the remote `main` SHA via
 *    `git ls-remote <url> refs/heads/main`. If the remote already
 *    points at the same SHA, exits 0 with a "already in sync" log
 *    line (no push needed — keeps the post-merge cadence cheap).
 *  - Otherwise runs `git push <url> refs/heads/main:refs/heads/main`
 *    using HTTPS basic auth (`x-access-token:$GITHUB_TOKEN`). On
 *    success, prints the pushed range. On any failure (auth, network,
 *    non-fast-forward, missing branch on the local side) exits
 *    non-zero with the underlying git stderr captured into the log.
 *
 * Visibility (the "no silent failures" requirement on the task):
 *  - All failures exit non-zero, which propagates up through
 *    `scripts/post-merge.sh` (`set -e`) and surfaces to the platform
 *    as a failed post-merge step — visible in the merge log the
 *    operator already watches.
 *  - On success, prints `synced <localSha>..<remoteSha> -> main` so
 *    the log line is greppable when verifying the mechanism is alive.
 *
 * Tunable env (defaults shown):
 *   GITHUB_TOKEN              — required. PAT or fine-grained token
 *                                with `contents: write` on the mirror.
 *   GITHUB_MIRROR_URL         — https://github.com/artpromedia/epplaa.git
 *   GITHUB_MIRROR_BRANCH      — main
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run sync-github-mirror
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MIRROR_URL =
  "https://github.com/artpromedia/epplaa.git";
export const DEFAULT_MIRROR_BRANCH = "main";

/** Exit codes — chosen so wrappers can distinguish reasons. */
export const EXIT = {
  OK: 0,
  PUSH_FAILED: 1,
  LOCAL_REF_MISSING: 2,
  REMOTE_LOOKUP_FAILED: 3,
  MISSING_TOKEN: 78, // EX_CONFIG (sysexits.h) — config error.
} as const;

/**
 * Build the HTTPS-with-basic-auth URL git uses for both `ls-remote`
 * and `push`. Keeps the token out of `argv` of any subprocess but
 * still readable in the environment of THIS process — git itself
 * pulls credentials from the URL's userinfo.
 *
 * Exported so the unit test can assert we don't accidentally leak the
 * token into a place we don't expect (and to assert URL-encoding).
 */
export function buildAuthenticatedUrl(
  publicUrl: string,
  token: string,
): string {
  if (!token) throw new Error("token must be non-empty");
  // Spec-correct HTTPS git URL for token auth: username can be
  // anything non-empty (`x-access-token` is GitHub's documented
  // sentinel), password is the token. URL-encode the token so a `:`
  // or `@` in a future token shape can't break parsing.
  const u = new URL(publicUrl);
  if (u.protocol !== "https:") {
    throw new Error(
      `mirror URL must be https:// (got ${u.protocol}) — refusing to send a token over an unencrypted transport`,
    );
  }
  u.username = "x-access-token";
  u.password = encodeURIComponent(token);
  return u.toString();
}

/** Redact the token out of any string before logging it. */
export function redact(s: string, token: string): string {
  if (!token) return s;
  return s.split(token).join("***").split(encodeURIComponent(token)).join("***");
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string): RunResult {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
  };
}

/** Parse the SHA out of `git ls-remote <url> refs/heads/<branch>`. */
export function parseLsRemoteSha(
  stdout: string,
  branch: string,
): string | null {
  // ls-remote prints `<sha>\trefs/heads/<branch>` — possibly with a
  // trailing newline. If the ref doesn't exist on the remote (e.g.
  // mirror is empty), stdout is empty and we return null so the
  // caller knows to push without a "different SHA" framing.
  const wantSuffix = `refs/heads/${branch}`;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split(/\s+/, 2);
    if (ref === wantSuffix && sha && /^[0-9a-f]{40}$/i.test(sha)) {
      return sha.toLowerCase();
    }
  }
  return null;
}

interface MainOptions {
  /** Repo root the script should operate in. Tests override; the CLI
   *  computes this from `import.meta.url`. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/**
 * The actual sync logic, factored out of `main()` so the test can
 * drive it without invoking `process.exit`.
 */
export function syncGithubMirror(
  opts: MainOptions,
): { exit: number; pushed: boolean; localSha: string | null; remoteSha: string | null } {
  const log = opts.log ?? ((l: string) => process.stdout.write(l + "\n"));
  const token = opts.env.GITHUB_TOKEN ?? "";
  const url = opts.env.GITHUB_MIRROR_URL ?? DEFAULT_MIRROR_URL;
  const branch = opts.env.GITHUB_MIRROR_BRANCH ?? DEFAULT_MIRROR_BRANCH;

  if (!token) {
    log(
      "[sync-github-mirror] ERROR: GITHUB_TOKEN is not set — cannot push to the mirror. Set the secret in the workspace and re-run.",
    );
    return { exit: EXIT.MISSING_TOKEN, pushed: false, localSha: null, remoteSha: null };
  }

  const authedUrl = buildAuthenticatedUrl(url, token);

  // Resolve local ref. If the workspace doesn't have a local `main`
  // for any reason (detached HEAD, fresh clone of a different
  // branch), fail loudly rather than silently push the wrong thing.
  const local = run("git", ["rev-parse", "--verify", `refs/heads/${branch}`], opts.cwd);
  if (local.status !== 0) {
    log(
      `[sync-github-mirror] ERROR: local refs/heads/${branch} not found — git rev-parse exited ${local.status}: ${local.stderr.trim()}`,
    );
    return { exit: EXIT.LOCAL_REF_MISSING, pushed: false, localSha: null, remoteSha: null };
  }
  const localSha = local.stdout.trim().toLowerCase();

  // Resolve remote ref. A non-zero exit from ls-remote is
  // network/auth — surface it; an empty stdout (exit 0) means the
  // remote has no such branch yet, which is fine and we'll create it.
  const remote = run("git", ["ls-remote", authedUrl, `refs/heads/${branch}`], opts.cwd);
  if (remote.status !== 0) {
    log(
      `[sync-github-mirror] ERROR: git ls-remote against ${url} failed (exit ${remote.status}): ${redact(remote.stderr.trim(), token)}`,
    );
    return { exit: EXIT.REMOTE_LOOKUP_FAILED, pushed: false, localSha, remoteSha: null };
  }
  const remoteSha = parseLsRemoteSha(remote.stdout, branch);

  if (remoteSha === localSha) {
    log(
      `[sync-github-mirror] already in sync at ${localSha} (${branch} on ${url})`,
    );
    return { exit: EXIT.OK, pushed: false, localSha, remoteSha };
  }

  // Push. We push refs/heads/<branch>:refs/heads/<branch> explicitly
  // (instead of just `<branch>`) so the destination is unambiguous
  // even if HEAD is detached or local config has weird `push.default`.
  // No --force: a non-fast-forward should fail loudly so we notice the
  // workspace's history was rewritten (e.g. someone force-pushed via
  // a different mechanism).
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
  const push = run("git", ["push", authedUrl, refspec], opts.cwd);
  if (push.status !== 0) {
    log(
      `[sync-github-mirror] ERROR: git push to ${url} failed (exit ${push.status}): ${redact(push.stderr.trim(), token)}`,
    );
    return { exit: EXIT.PUSH_FAILED, pushed: false, localSha, remoteSha };
  }

  log(
    `[sync-github-mirror] synced ${remoteSha ?? "(empty)"} -> ${localSha} on ${branch} at ${url}`,
  );
  return { exit: EXIT.OK, pushed: true, localSha, remoteSha };
}

function main(): void {
  // scripts/src/<file>.ts -> repo root is two levels up. Mirror the
  // pattern used by checkSentryMonitorsInSync.ts so this works when
  // executed from any cwd (e.g. via `pnpm --filter`).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const result = syncGithubMirror({ cwd: repoRoot, env: process.env });
  process.exit(result.exit);
}

// Allow `tsx src/syncGithubMirror.ts` to run main, but skip when
// imported by the unit test.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) main();
