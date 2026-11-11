import { defineConfig } from "@playwright/test";

const browser = {
  browserName: "chromium" as const,
  headless: true,
  trace: "retain-on-failure" as const,
  screenshot: "only-on-failure" as const,
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
};

export default defineConfig({
  testDir: "karaoke-e2e",
  testMatch: [
    "learning.spec.ts",
    "outro.spec.ts",
    "learning-v4.spec.ts",
    "resume.spec.ts",
  ],
  timeout: 180000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../../.local/learning-browser-results",
  projects: [
    {
      name: "learning",
      testMatch: ["learning.spec.ts", "outro.spec.ts", "resume.spec.ts"],
      use: { ...browser, baseURL: "http://localhost:4180" },
    },
    {
      // A V4 community: signing in is the publication permission.
      name: "learning-v4",
      testMatch: "learning-v4.spec.ts",
      use: { ...browser, baseURL: "http://localhost:4181" },
    },
  ],
  webServer: [
    {
      command: "KARAOKE_RESULTS_V2=1 node karaoke-e2e/live-host.ts",
      url: "http://localhost:4180/__fixture/manifest",
      reuseExistingServer: false,
      timeout: 90000,
    },
    {
      command:
        "KARAOKE_RESULTS_V4=1 LIVE_HOST_PORT=4181 LIVE_CHAIN_PORT=19147 node karaoke-e2e/live-host.ts",
      url: "http://localhost:4181/__fixture/manifest",
      reuseExistingServer: false,
      timeout: 90000,
    },
  ],
});
