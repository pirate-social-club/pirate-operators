import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "karaoke-e2e",
  testMatch: "*.spec.ts",
  timeout: 30000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../.local/karaoke-browser-results",
  use: {
    baseURL: "http://127.0.0.1:4178",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  webServer: {
    command: "node karaoke-e2e/host.ts",
    url: "http://127.0.0.1:4178",
    reuseExistingServer: false,
    timeout: 20000,
  },
});
