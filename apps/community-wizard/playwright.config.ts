import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test",
  testMatch: "*.browser.ts",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:8791" },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:8791",
    reuseExistingServer: false,
    env: {
      PIRATE_WIZARD_PORT: "8791",
      PIRATE_WIZARD_STATE_DIR: `/tmp/pirate-wizard-browser-${process.pid}`,
      INFISICAL_CLIENT_ID: "",
      INFISICAL_CLIENT_SECRET: "",
      CLOUDFLARE_API_TOKEN: "",
    },
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
