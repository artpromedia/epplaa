import { defineConfig } from "vitest/config";

/**
 * Vitest config for the @workspace/scripts package. Mirrors the
 * api-server config (node environment, src/**.test.ts include glob)
 * so test discovery is consistent across the monorepo. The root
 * `vitest.config.ts` references this file via its `test.projects`
 * array so `pnpm test` at the repo root runs scripts tests as part
 * of the full suite.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
