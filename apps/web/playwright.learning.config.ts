import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "karaoke-e2e",
  testMatch: ["learning.spec.ts", "outro.spec.ts"],
  timeout: 180000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../.local/learning-browser-results",
  use: {
    baseURL: "http://localhost:4180",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
  },
  webServer: {
    command: "KARAOKE_RESULTS_V2=1 node karaoke-e2e/live-host.ts",
    url: "http://localhost:4180/__fixture/manifest",
    reuseExistingServer: false,
    timeout: 90000,
  },
});
