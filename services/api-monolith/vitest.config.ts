import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts",
        "src/lib/seed*.ts",
      ],
      thresholds: {
        // Project-wide service-tier thresholds. Per-PR "changed-line" 80%
        // gate is enforced in CI by parsing the json-summary diff.
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
    },
  },
  resolve: {
    alias: {
      "@workspace/db": path.resolve(__dirname, "..", "..", "packages", "db", "src"),
    },
  },
});
