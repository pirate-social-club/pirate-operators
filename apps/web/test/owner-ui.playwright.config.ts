import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "owner-ui.browser.ts",
  workers: 1,
  timeout: 30000,
  outputDir: "../../../.local/owner-ui-browser-20261111/results",
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
});
