import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "live-e2e",
  timeout: 30000,
  workers: 1,
  reporter: [["list"]],
  use: { browserName: "chromium", headless: true },
});
