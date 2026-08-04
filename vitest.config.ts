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
      // A regression ratchet, not a target. The 2026-08-04 risk-focused pass
      // measured 57.12/52.84/57.44/59.17. These floors remain 3-4 points below
      // that run so ordinary v8 drift and honest refactors do not encourage
      // coverage theatre, while still preventing a return to the old baseline.
      // See docs/COVERAGE_STRATEGY.md for per-risk-module review expectations.
      thresholds: {
        statements: 53,
        branches: 49,
        functions: 53,
        lines: 55,
      },
    },
  },
});
