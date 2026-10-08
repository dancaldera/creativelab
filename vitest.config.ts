import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const resolve = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Test against package *source* so a failing test never depends on a stale build.
      // Tests inside packages/ need the Node surface (filesystem, SQLite); the desktop
      // app is resolved to the browser-safe surface by its own Vite config, so tests that
      // import app code get the isomorphic subset.
      "@creativelab/core": resolve("./packages/core/src/index.ts"),
      "@creativelab/media": resolve("./packages/media/src/index.ts"),
      "@creativelab/providers": resolve("./packages/providers/src/index.ts"),
      "@creativelab/render": resolve("./packages/render/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tools/*/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/src-tauri/**"],
    environment: "node",
    reporters: ["default"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
