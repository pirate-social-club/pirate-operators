import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "study-e2e",
  testMatch: "*.spec.ts",
  timeout: 30000,
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: "../../.local/study-browser-report.json" }],
  ],
  outputDir: "../../.local/study-browser-results",
  use: {
    baseURL: "http://127.0.0.1:4177",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
  },
  webServer: {
    command: "node study-e2e/host.ts",
    url: "http://127.0.0.1:4177",
    reuseExistingServer: false,
    timeout: 20000,
  },
});
