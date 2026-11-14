import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { alias, dedupe } from "./vite.shared.ts";
export default defineConfig({
  root: "src/study",
  base: "/",
  plugins: [tailwindcss(), solid()],
  resolve: { alias, dedupe },
  build: { outDir: "../../dist/study", emptyOutDir: true, target: "es2022" },
});
