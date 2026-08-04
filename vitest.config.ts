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
  },
});
