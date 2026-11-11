import { defineConfig, mergeConfig } from "vite";
import { resolve } from "node:path";
import live from "../vite.live.config.ts";

export default mergeConfig(
  live,
  defineConfig({
    root: "test",
    build: {
      outDir: "../../../.local/owner-ui-browser-20261111/browser-dist",
      rollupOptions: { input: resolve("test/owner-ui.fixture.html") },
    },
  }),
);
