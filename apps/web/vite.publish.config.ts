// Publication-time renderer: compiles the presentational components for the
// server without hydration markers, for scripts/build.ts to run in Node.
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { alias, dedupe } from "./vite.shared.ts";

export default defineConfig({
  plugins: [solid({ ssr: true, solid: { hydratable: false } })],
  resolve: { alias, dedupe },
  ssr: { noExternal: ["@pirate/web-solid-ui", /^@kobalte\//, /^@solid-primitives\//] },
  build: {
    ssr: "src/publish/render.tsx",
    outDir: "dist/publish",
    emptyOutDir: true,
    target: "node24",
  },
});
