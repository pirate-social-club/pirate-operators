// Uses the wizard's already declared, pinned Playwright. No new dependency.
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../apps/community-wizard/package.json", import.meta.url),
);
const { defineConfig } = require("@playwright/test");
export default defineConfig({
  testDir: ".",
  testMatch: "community-wizard-linux-browser.mjs",
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  outputDir: "../.local/wizard-linux-browser-results",
  use: {
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
});
