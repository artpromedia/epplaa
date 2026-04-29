import { defineConfig } from "vitest/config";

/**
 * Vitest project for the shared OpenAPI client. Covers the
 * auth/CSRF wiring inside `custom-fetch.ts` that every artifact
 * relies on (e.g. mutating-method header attachment, transparent
 * retry on `csrf_failed`).
 */
export default defineConfig({
  test: {
    name: "api-client-react",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
