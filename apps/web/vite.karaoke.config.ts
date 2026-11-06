import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { alias, dedupe } from "./vite.shared.ts";

// Standalone Karaoke acceptance build; not a release entrypoint.
export default defineConfig({
  root: "src/karaoke",
  base: "/",
  plugins: [tailwindcss(), solid()],
  resolve: { alias, dedupe },
  build: { outDir: "../../dist/karaoke", emptyOutDir: true, target: "es2022" },
});
