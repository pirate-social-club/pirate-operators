import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { alias, dedupe } from "../vite.shared.ts";

export default defineConfig({
  plugins: [solid({ ssr: false })],
  resolve: { alias, dedupe },
  test: {
    environment: "jsdom",
    maxWorkers: 1,
    fileParallelism: false,
    include: ["test/*.test.tsx", "test/reference-machines/**/*.test.ts"],
  },
});
