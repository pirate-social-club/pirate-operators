import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
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
