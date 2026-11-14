// Coordinator-run only after a granted serial gate; never started by this lane.
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
    include: [
      "test/learning-source-recording-recovery.test.tsx",
      "test/learning-source-karaoke-playback.test.tsx",
      "test/learning-source-completion.test.tsx",
      "test/learning-karaoke-page-recovery.test.tsx",
    ],
  },
});
