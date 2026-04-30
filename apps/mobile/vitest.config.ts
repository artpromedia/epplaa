import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.{ts,tsx}"],
    globals: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "@workspace/api-client-react": path.resolve(
        __dirname,
        "..",
        "..",
        "packages",
        "api-client-react",
        "src",
      ),
    },
  },
});
