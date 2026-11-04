import { defineConfig } from "@playwright/test";
const stateDirectory = process.env.PIRATE_WIZARD_BROWSER_STATE_DIR;
if (!stateDirectory)
  throw new Error("Use npm run test:browser for isolated state and cleanup.");
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
      PIRATE_WIZARD_STATE_DIR: stateDirectory,
      INFISICAL_CLIENT_ID: "",
      INFISICAL_CLIENT_SECRET: "",
      INFISICAL_AUTH_MODE: "cli",
      INFISICAL_SITE_URL: "https://infisical.invalid",
      INFISICAL_PROFILE: "",
      HOME: stateDirectory,
      XDG_CONFIG_HOME: stateDirectory,
      XDG_DATA_HOME: stateDirectory,
      CLOUDFLARE_API_TOKEN: "",
      PIRATE_WIZARD_STATE_PASSWORD: "",
    },
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
