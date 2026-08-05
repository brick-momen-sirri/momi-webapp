import { defineConfig, devices } from "@playwright/test";

const webPort = 18_190;
const apiPort = 13_339;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    channel: process.platform === "win32" && !process.env.CI ? "msedge" : undefined,
  },
  webServer: {
    command: "node e2e/productionGatewayFixture.mjs",
    url: `http://127.0.0.1:${webPort}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      E2E_API_PORT: String(apiPort),
      E2E_WEB_PORT: String(webPort),
    },
  },
});
