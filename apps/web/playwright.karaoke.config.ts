import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "karaoke-e2e",
  testMatch: "*.spec.ts",
  timeout: 60000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../.local/karaoke-browser-results",
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "playback",
      testMatch: "karaoke.spec.ts",
      use: {
        baseURL: "http://127.0.0.1:4178",
        launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
      },
    },
    {
      name: "capture",
      testMatch: "capture.spec.ts",
      use: {
        baseURL: "http://127.0.0.1:4179",
        permissions: ["microphone"],
        launchOptions: {
          args: [
            "--autoplay-policy=no-user-gesture-required",
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
          ],
        },
      },
    },
    {
      name: "live",
      testMatch: "live.spec.ts",
      use: {
        baseURL: "http://localhost:4180",
        permissions: ["microphone"],
        launchOptions: {
          args: [
            "--autoplay-policy=no-user-gesture-required",
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
          ],
        },
      },
    },
  ],
  webServer: [
    {
      command: "node karaoke-e2e/host.ts",
      url: "http://127.0.0.1:4178",
      reuseExistingServer: false,
      timeout: 20000,
    },
    {
      command: "node karaoke-e2e/capture-host.ts",
      url: "http://127.0.0.1:4179/__fixture/instrumental.wav",
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      // Serves dist/live, so `vite build --config vite.live.config.ts` runs first.
      command: "KARAOKE_RESULTS_V2=1 node karaoke-e2e/live-host.ts",
      url: "http://localhost:4180/__fixture/manifest",
      reuseExistingServer: false,
      timeout: 90000,
    },
  ],
});
