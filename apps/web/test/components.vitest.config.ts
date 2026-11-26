import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import { alias, dedupe } from "../vite.shared.ts";

const solidUiSource = "./node_modules/@pirate/web-solid-ui/src";

export default defineConfig({
  plugins: [solid({ ssr: false })],
  resolve: { alias, dedupe },
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: "app-components",
          environment: "jsdom",
          include: ["test/*.test.tsx", "test/reference-machines/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "vendored-vertical-feed",
          environment: "jsdom",
          // Native ESM imports in the worker must resolve Solid's DOM runtime
          // for Kobalte to mount its portalled menus and dialogs.
          execArgv: ["--conditions=browser"],
          setupFiles: [`${solidUiSource}/test/setup.ts`],
          include: [`${solidUiSource}/patterns/engagement/vertical-feed/vertical-feed.test.tsx`],
          exclude: [],
        },
      },
    ],
  },
});
