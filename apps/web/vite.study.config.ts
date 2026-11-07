import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { alias, dedupe } from "./vite.shared.ts";
export default defineConfig({
  root: "src/study",
  base: "/",
  plugins: [solid()],
  resolve: { alias, dedupe },
  build: { outDir: "../../dist/study", emptyOutDir: true, target: "es2022" },
});
