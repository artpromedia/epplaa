import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // The app builds with @vitejs/plugin-react which applies the automatic
  // JSX runtime (no in-scope `React` needed). vitest doesn't load that
  // plugin, so without an explicit jsx setting esbuild falls back to the
  // classic runtime and renders of any source-tree component throw
  // "React is not defined". Mirroring the runtime here keeps test
  // imports of real .tsx files working without source-level changes.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    globals: false,
  },
  resolve: {
    // The lib is resolved to source via the alias below. When source
    // files in the lib import react peer deps, vitest needs to find a
    // single, deduplicated instance — otherwise React context (e.g.
    // QueryClientProvider) silently uses two different copies.
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Mirror the `@assets` alias from `vite.config.ts` so source-tree
      // components that import attached binary assets (logos, etc.) can
      // be rendered inside vitest without the test resolver throwing.
      "@assets": path.resolve(__dirname, "..", "..", "attached_assets"),
      "@workspace/api-client-react": path.resolve(
        __dirname,
        "..",
        "..",
        "lib",
        "api-client-react",
        "src",
      ),
    },
  },
});
