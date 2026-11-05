// Local acceptance. Requires a prior `npm run build`, Docker, and Chromium for
// @playwright/test 1.63.0 (`npx playwright install chromium`, or point
// PLAYWRIGHT_BROWSERS_PATH at an existing matching install).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  timeout: 30_000,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: { browserName: "chromium", headless: true },
  webServer: {
    command: "node scripts/fixture-host.ts",
    url: "http://localhost:4173/",
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
