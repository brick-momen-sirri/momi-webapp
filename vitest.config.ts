// Frontend test runner. Kept separate from vite.config.ts so the dev server
// config stays free of test-only concerns, and because `defineConfig` from
// "vite" does not type the `test` block.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom, not happy-dom: the components under test touch DataTransfer,
    // IntersectionObserver and clipboard APIs, and jsdom's coverage of those is
    // the closer match to a real browser.
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Only frontend tests. The backend runs on node:test via tsx and must not be
    // picked up here -- its integration tests open real SQLite files.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    restoreMocks: true,
    // Surfaces an unhandled rejection in a test rather than letting it pass and
    // fail some later, unrelated test.
    dangerouslyIgnoreUnhandledErrors: false,
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.{test,spec}.{ts,tsx}", "src/test/**", "src/vite-env.d.ts"],
      reporter: ["text-summary", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage/frontend",
      // A regression ratchet, not a target. Set ~3 points below the measured
      // baseline (49.28/46.98/49.95/51.49) because v8 coverage drifts by a few
      // hundredths between runs, and a threshold sitting inside that drift red-builds
      // CI on unrelated changes. Raise these deliberately when coverage improves --
      // never so tight that ordinary refactor churn trips them.
      thresholds: {
        statements: 46,
        branches: 44,
        functions: 46,
        lines: 48,
      },
    },
  },
});
