import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: [
    "reward-wallet.browser.ts",
    "reward-wallet-owner-parity.browser.ts",
    "reward-wallet-verification.browser.ts",
  ],
  workers: 1,
  timeout: 30000,
  outputDir:
    "../../../.local/owner-wallet-verification-cancel-repair-20261111/browser-results",
  reporter: [["list"]],
  use: { browserName: "chromium", headless: true },
});
