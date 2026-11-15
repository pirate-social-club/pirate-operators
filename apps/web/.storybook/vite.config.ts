import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { alias, dedupe } from "../vite.shared.ts";

// Adapted from c7cb8783's isolated Storybook Vite configuration.
// Reuse decentralized production resolution; do not load a release entry.
export default defineConfig({
  plugins: [tailwindcss(), solid({ ssr: false })],
  resolve: { alias, dedupe },
});
