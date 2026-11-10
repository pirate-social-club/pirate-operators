import { defineConfig, mergeConfig } from "vite";
import { resolve } from "node:path";
import live from "../vite.live.config.ts";

export default mergeConfig(
  live,
  defineConfig({
    root: "test",
    resolve: {
      alias: {
        "@megaeth-labs/wallet-sdk": resolve(
          "test/reward-wallet-moss.fixture.ts",
        ),
      },
    },
    build: {
      outDir: "../../../.local/wallet-browser-dist",
      rollupOptions: { input: resolve("test/reward-wallet.fixture.html") },
    },
  }),
);
