import { defineConfig } from "vitest/config";

/**
 * Root vitest config: runs every workspace package's tests together. Each
 * package can ship its own `vitest.config.ts` for environment-specific
 * setup (e.g. jsdom for React SPAs). Use `pnpm test` at the root to run
 * the full suite, or `pnpm --filter @workspace/<pkg> run test` to scope.
 */
export default defineConfig({
  test: {
    projects: [
      "artifacts/*/vitest.config.ts",
      // Pulls in @workspace/scripts so repo-level CLI checks
      // (e.g. checkRateLimitOptOutSunsets, checkSentryMonitorsInSync)
      // are exercised by the root `pnpm test` invocation alongside
      // the artifact suites.
      "scripts/vitest.config.ts",
    ],
  },
});
